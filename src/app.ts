import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { type DependenciasCiclo, type EventoTurno, ejecutarTurno } from "./agente/ciclo"
import type { Config } from "./agente/config"
import { confirmacionContratos } from "./agente/confirmaciones"
import { registrarHerramientas } from "./agente/herramientas"
import { cargarPromptSistema } from "./agente/prompt"
import { AlmacenSesiones, type Sesion } from "./agente/sesiones"
import { rutas } from "./lib/archivos"
import type { ProveedorLLM } from "./llm/adapter"
import * as contratos from "./tools/contratos"

export interface OpcionesApp {
  /** Raíz del proyecto: de aquí salen agent/, src/knowledge/, fixtures/, out/ y web/. */
  raiz: string
  config: Config
  /** null cuando no hay clave: la app arranca igual y el chat responde 503 con un mensaje claro. */
  proveedor: ProveedorLLM | null
}

const ESTATICOS: Record<string, string> = {
  "/": "web/index.html",
  "/app.js": "web/app.js",
  "/styles.css": "web/styles.css",
  "/favicon.svg": "web/favicon.svg",
  "/vendor/marked.js": "node_modules/marked/lib/marked.esm.js",
  "/vendor/purify.js": "node_modules/dompurify/dist/purify.es.mjs",
}

const ChatSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  message: z.string().trim().min(1).max(4000),
})

function json(datos: unknown, status = 200): Response {
  return Response.json(datos, { status, headers: { "cache-control": "no-store" } })
}

/** API HTTP del agente. No abre puertos: `server.ts` la monta con Bun.serve y las pruebas la llaman directo. */
export function crearApp({ raiz, config, proveedor }: OpcionesApp) {
  const herramientas = registrarHerramientas({ contratos })
  const sesiones = new AlmacenSesiones(config.MAX_SESIONES, () => cargarPromptSistema(raiz))
  const presupuestoServidor = { usados: 0, maximo: config.MAX_TOKENS_SERVIDOR }
  const r = rutas(raiz)
  const archivosOut: Record<string, string> = { alertas: r.alertas, maestro: r.maestro, historial: r.historial, procesados: r.procesados, log: r.log }

  function dependencias(modelo: ProveedorLLM): DependenciasCiclo {
    return {
      proveedor: modelo,
      herramientas,
      politica: confirmacionContratos,
      directory: raiz,
      maxIteraciones: config.MAX_ITERACIONES,
      maxTokensSesion: config.MAX_TOKENS_SESION,
      presupuestoServidor,
    }
  }

  function streamDeTurno(sesion: Sesion, mensaje: string, modelo: ProveedorLLM): Response {
    const codificador = new TextEncoder()
    const flujo = new ReadableStream<Uint8Array>({
      async start(controlador) {
        const escribir = (texto: string) => {
          try {
            controlador.enqueue(codificador.encode(texto))
          } catch {
            // La pestaña se cerró: el turno termina igual y queda guardado en la sesión.
          }
        }
        const enviar = (evento: string, datos: unknown) => escribir(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`)
        const latido = setInterval(() => escribir(": latido\n\n"), 10_000)
        try {
          enviar("fin", await ejecutarTurno(sesion, mensaje, dependencias(modelo), (e: EventoTurno) => enviar(e.tipo, e)))
        } finally {
          clearInterval(latido)
          sesion.ocupada = false
          try {
            controlador.close()
          } catch {
            // ya estaba cerrado
          }
        }
      },
    })
    return new Response(flujo, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } })
  }

  async function chat(peticion: Request): Promise<Response> {
    if (!proveedor) return json({ error: "El servidor no tiene ANTHROPIC_API_KEY configurada. Defínela en .env y reinicia." }, 503)
    const cuerpo = ChatSchema.safeParse(await peticion.json().catch(() => null))
    if (!cuerpo.success) return json({ error: "Cuerpo inválido: se espera { sessionId, message }." }, 400)
    const sesion = sesiones.obtenerOCrear(cuerpo.data.sessionId)
    if (sesion.ocupada) return json({ error: "Esta sesión todavía está procesando el mensaje anterior." }, 409)
    sesion.ocupada = true
    if (peticion.headers.get("accept")?.includes("text/event-stream")) return streamDeTurno(sesion, cuerpo.data.message, proveedor)
    try {
      return json(await ejecutarTurno(sesion, cuerpo.data.message, dependencias(proveedor)))
    } finally {
      sesion.ocupada = false
    }
  }

  function verSesion(id: string): Response {
    const sesion = sesiones.obtener(id)
    if (!sesion) return json({ error: "La sesión no existe (puede que el servidor se haya reiniciado)." }, 404)
    return json({ id, creada: sesion.creada, turno: sesion.turno, tokens: sesion.tokens, eventos: sesion.eventos, pendientes: [...sesion.pendientes.values()] })
  }

  function verArchivo(nombre: string): Response {
    const ruta = archivosOut[nombre]
    if (!ruta) return json({ error: `archivo desconocido: ${nombre}` }, 404)
    if (!existsSync(ruta)) return new Response(null, { status: 204 })
    return new Response(Bun.file(ruta), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } })
  }

  /** Deja la demo como recién instalada: borra out/ (el maestro vuelve a copiarse del fixture) y las sesiones. */
  function reiniciar(): Response {
    if (sesiones.hayTurnoEnCurso()) return json({ error: "Hay un turno en curso; espera a que termine." }, 409)
    rmSync(r.out, { recursive: true, force: true })
    sesiones.vaciar()
    return json({ ok: true })
  }

  function salud(): Response {
    return json({
      ok: true,
      provider: proveedor?.nombre ?? config.LLM_PROVIDER,
      model: proveedor?.modelo ?? config.LLM_MODEL,
      configurado: proveedor !== null,
      accesoProtegido: Boolean(config.ACCESS_KEY),
      herramientas: [...herramientas.keys()],
    })
  }

  async function enrutar(peticion: Request): Promise<Response> {
    const { pathname } = new URL(peticion.url)
    const estatico = ESTATICOS[pathname]
    if (peticion.method === "GET" && estatico) return new Response(Bun.file(join(raiz, estatico)))
    if (pathname === "/api/health") return salud()
    if (!pathname.startsWith("/api/")) return new Response("No encontrado", { status: 404 })
    if (config.ACCESS_KEY && peticion.headers.get("x-access-key") !== config.ACCESS_KEY) return json({ error: "Clave de acceso incorrecta." }, 401)
    if (peticion.method === "POST" && pathname === "/api/chat") return chat(peticion)
    if (peticion.method === "POST" && pathname === "/api/reset") return reiniciar()
    const sesion = /^\/api\/sessions\/([A-Za-z0-9_-]{1,64})$/.exec(pathname)
    if (peticion.method === "GET" && sesion?.[1]) return verSesion(sesion[1])
    const archivo = /^\/api\/archivos\/([a-z]+)$/.exec(pathname)
    if (peticion.method === "GET" && archivo?.[1]) return verArchivo(archivo[1])
    return json({ error: "Ruta no encontrada." }, 404)
  }

  return {
    async fetch(peticion: Request): Promise<Response> {
      try {
        return await enrutar(peticion)
      } catch (error) {
        console.error("Error no controlado:", error instanceof Error ? error.message : error)
        return json({ error: "Error interno del servidor." }, 500)
      }
    },
  }
}
