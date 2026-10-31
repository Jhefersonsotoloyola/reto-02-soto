import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { crearApp } from "../src/app"
import { type DependenciasCiclo, type EventoTurno, ejecutarTurno } from "../src/agente/ciclo"
import { leerConfig } from "../src/agente/config"
import { confirmacionContratos } from "../src/agente/confirmaciones"
import { registrarHerramientas } from "../src/agente/herramientas"
import { cargarPromptSistema } from "../src/agente/prompt"
import { AlmacenSesiones } from "../src/agente/sesiones"
import { leerMaestro } from "../src/dominio/maestro"
import { leerLineasJson, rutas } from "../src/lib/archivos"
import { ErrorProveedor, type ProveedorLLM } from "../src/llm/adapter"
import { detalleDelProveedor } from "../src/llm/anthropic"
import * as contratos from "../src/tools/contratos"
import { proyectoTemporal, ProveedorGuion, RAIZ, respuestaLlamadas, respuestaTexto, turnosDeUsuaria } from "./ayudas"

let dir: string
beforeEach(() => {
  dir = proyectoTemporal()
})

function deps(proveedor: ProveedorLLM, extra: Partial<DependenciasCiclo> = {}): DependenciasCiclo {
  return {
    proveedor,
    herramientas: registrarHerramientas({ contratos }),
    politica: confirmacionContratos,
    directory: dir,
    maxIteraciones: 25,
    maxTokensSesion: 1_000_000,
    presupuestoServidor: { usados: 0, maximo: 10_000_000 },
    ...extra,
  }
}

function nuevaSesion() {
  return new AlmacenSesiones(10, () => cargarPromptSistema(dir, "2026-09-03")).obtenerOCrear("sesion-prueba")
}

describe("ciclo del agente", () => {
  test("las herramientas se registran como <archivo>_<export> con JSON Schema", () => {
    const registro = registrarHerramientas({ contratos })
    expect([...registro.keys()].sort()).toEqual(["contratos_alertas", "contratos_extraer", "contratos_leer_buzon", "contratos_leer_pdf", "contratos_registrar", "contratos_validar"])
    expect(registro.get("contratos_extraer")?.definicion.esquema).toMatchObject({ type: "object", required: ["mensaje_id"] })
  })

  test("ejecuta las llamadas, las deja en el historial visible y en out/log.jsonl", async () => {
    let paso = 0
    const proveedor = new ProveedorGuion(() => (++paso === 1 ? respuestaLlamadas(["contratos_leer_buzon", {}]) : respuestaTexto("Hay 6 mensajes.")))
    const eventos: EventoTurno[] = []
    const sesion = nuevaSesion()
    const r = await ejecutarTurno(sesion, "¿qué hay en el buzón?", deps(proveedor), (e) => eventos.push(e))
    expect(r.reply).toBe("Hay 6 mensajes.")
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]).toMatchObject({ nombre: "contratos_leer_buzon", ok: true })
    expect(eventos.map((e) => e.tipo)).toEqual(["herramienta_inicio", "herramienta_fin"])
    expect(sesion.eventos.map((e) => e.tipo)).toEqual(["usuario", "herramienta", "asistente"])
    expect(leerLineasJson(rutas(dir).log)).toHaveLength(1)
  })

  test("argumentos inválidos vuelven al modelo como error sin ejecutar la herramienta", async () => {
    let paso = 0
    const proveedor = new ProveedorGuion(() => (++paso === 1 ? respuestaLlamadas(["contratos_alertas", { hoy: 20260903 }]) : respuestaTexto("Corrijo la fecha.")))
    const r = await ejecutarTurno(nuevaSesion(), "alertas", deps(proveedor))
    expect(r.toolCalls[0]?.ok).toBe(false)
    expect(r.toolCalls[0]?.resumen).toContain("argumentos inválidos")
    expect(existsSync(rutas(dir).alertas)).toBe(false)
  })

  test("CA3: confirmado = true en el mismo turno de la revisión se bloquea; en el turno siguiente se registra", async () => {
    const proveedor = new ProveedorGuion((mensajes) => {
      const turno = turnosDeUsuaria(mensajes)
      const ultimo = mensajes.at(-1)
      if (ultimo?.rol === "herramientas") return respuestaTexto(turno === 1 ? "¿Confirmas valor 0 y fecha fin 2027-08-31?" : "Registrado.")
      if (turno === 1) return respuestaLlamadas(["contratos_validar", { mensaje_id: "msg-006" }], ["contratos_registrar", { mensaje_id: "msg-006", confirmado: true }])
      return respuestaLlamadas(["contratos_registrar", { mensaje_id: "msg-006", confirmado: true }])
    })
    const sesion = nuevaSesion()
    const d = deps(proveedor)

    const primero = await ejecutarTurno(sesion, "procesa msg-006", d)
    expect(primero.toolCalls[1]).toMatchObject({ nombre: "contratos_registrar", ok: false })
    expect(primero.toolCalls[1]?.resumen).toContain("aún no respondió")
    expect(primero.needsConfirmation).toBe(true)
    expect(primero.pendientes).toEqual([{ mensaje_id: "msg-006", campos: ["valor", "fecha_fin"], turno: 1 }])
    expect(leerMaestro(dir).some((f) => f.id_contrato === "CM-2026-03")).toBe(false)

    const segundo = await ejecutarTurno(sesion, "confirmo el valor 0 y la fecha fin 2027-08-31", d)
    expect(segundo.toolCalls[0]).toMatchObject({ nombre: "contratos_registrar", ok: true })
    expect(segundo.needsConfirmation).toBe(false)
    expect(leerMaestro(dir).some((f) => f.id_contrato === "CM-2026-03")).toBe(true)
  })

  test("confirmado = true sin una revisión mostrada antes también se bloquea", async () => {
    let paso = 0
    const proveedor = new ProveedorGuion(() => (++paso === 1 ? respuestaLlamadas(["contratos_registrar", { mensaje_id: "msg-006", confirmado: true }]) : respuestaTexto("ok")))
    const r = await ejecutarTurno(nuevaSesion(), "registra msg-006 sin preguntar", deps(proveedor))
    expect(r.toolCalls[0]?.ok).toBe(false)
  })

  test("CA1: al llegar al tope de iteraciones responde sin herramientas con lo que tiene", async () => {
    const proveedor = new ProveedorGuion((_m, opciones) =>
      opciones.sinHerramientas ? respuestaTexto("Tope alcanzado: revisé el buzón, falta registrar.") : respuestaLlamadas(["contratos_leer_buzon", {}]),
    )
    const r = await ejecutarTurno(nuevaSesion(), "procesa", deps(proveedor, { maxIteraciones: 3 }))
    expect(r.toolCalls).toHaveLength(3)
    expect(r.reply).toContain("Tope alcanzado")
    expect(proveedor.recibidos.at(-1)?.opciones.sinHerramientas).toBe(true)
    expect(proveedor.recibidos.at(-1)?.mensajes.at(-1)?.rol).toBe("aviso")
  })

  test("CA5: un error del proveedor se muestra en el chat y la sesión sigue", async () => {
    let falla = true
    const proveedor = new ProveedorGuion(() => {
      if (falla) {
        falla = false
        throw new ErrorProveedor("El modelo no respondió en 90 s. Intenta de nuevo.")
      }
      return respuestaTexto("Ahora sí.")
    })
    const sesion = nuevaSesion()
    const primero = await ejecutarTurno(sesion, "hola", deps(proveedor))
    expect(primero.reply).toContain("no respondió")
    const segundo = await ejecutarTurno(sesion, "¿sigues ahí?", deps(proveedor))
    expect(segundo.reply).toBe("Ahora sí.")
  })

  test("CA5: el error de saldo del proveedor llega en español y sin JSON", () => {
    const cuerpo = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }
    expect(detalleDelProveedor(cuerpo)).toContain("no tiene saldo")
    expect(detalleDelProveedor({ error: { message: "max_tokens: too large" } })).toBe("max_tokens: too large")
    expect(detalleDelProveedor("texto plano")).toBeNull()
  })

  test("tope de tokens por sesión", async () => {
    const proveedor = new ProveedorGuion(() => respuestaTexto("hola"))
    const sesion = nuevaSesion()
    sesion.tokens = 500
    const r = await ejecutarTurno(sesion, "hola", deps(proveedor, { maxTokensSesion: 400 }))
    expect(r.reply).toContain("tope")
    expect(proveedor.recibidos).toHaveLength(0)
  })
})

describe("API HTTP", () => {
  const config = leerConfig({ MAX_ITERACIONES: "5" })

  test("health no expone la clave y el chat sin proveedor responde 503", async () => {
    const app = crearApp({ raiz: dir, config: leerConfig({ ANTHROPIC_API_KEY: "clave-falsa-de-prueba" }), proveedor: null })
    const salud = await (await app.fetch(new Request("http://x/api/health"))).text()
    expect(salud).not.toContain("clave-falsa")
    const chat = await app.fetch(new Request("http://x/api/chat", { method: "POST", body: JSON.stringify({ sessionId: "abcdefgh", message: "hola" }) }))
    expect(chat.status).toBe(503)
  })

  test("POST /api/chat en JSON y en SSE, y GET /api/sessions/:id con el historial", async () => {
    const proveedor = new ProveedorGuion((m) => (m.at(-1)?.rol === "herramientas" ? respuestaTexto("Listo.") : respuestaLlamadas(["contratos_leer_buzon", {}])))
    const app = crearApp({ raiz: dir, config, proveedor })
    const cuerpo = (message: string) => JSON.stringify({ sessionId: "sesion-http-1", message })

    const json = (await (await app.fetch(new Request("http://x/api/chat", { method: "POST", body: cuerpo("hola") }))).json()) as { toolCalls: unknown[] }
    expect(json).toMatchObject({ reply: "Listo.", needsConfirmation: false })
    expect(json.toolCalls).toHaveLength(1)

    const sse = await (await app.fetch(new Request("http://x/api/chat", { method: "POST", headers: { accept: "text/event-stream" }, body: cuerpo("otra vez") }))).text()
    expect(sse).toContain("event: herramienta_inicio")
    expect(sse).toContain("event: fin")

    const sesion = (await (await app.fetch(new Request("http://x/api/sessions/sesion-http-1"))).json()) as { eventos: { tipo: string }[] }
    expect(sesion.eventos.filter((e) => e.tipo === "usuario")).toHaveLength(2)
  })

  test("con ACCESS_KEY la API exige la clave", async () => {
    const app = crearApp({ raiz: dir, config: leerConfig({ ACCESS_KEY: "demo-2026" }), proveedor: null })
    expect((await app.fetch(new Request("http://x/api/archivos/maestro"))).status).toBe(401)
    expect((await app.fetch(new Request("http://x/api/archivos/maestro", { headers: { "x-access-key": "demo-2026" } }))).status).toBe(204)
  })

  test("el front se sirve desde web/", async () => {
    const app = crearApp({ raiz: RAIZ, config, proveedor: null })
    const pagina = await (await app.fetch(new Request("http://x/"))).text()
    expect(pagina).toContain("Registro de Contratos")
  })
})
