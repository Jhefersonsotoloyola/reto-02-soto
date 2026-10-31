import { registrarEnLog } from "../lib/herramienta"
import { leerRespuesta, type RespuestaHerramienta } from "../lib/respuesta"
import type { LlamadaHerramienta, ProveedorLLM, RespuestaModelo, ResultadoHerramienta, Uso } from "../llm/adapter"
import type { PoliticaConfirmacion, RevisionPendiente } from "./confirmaciones"
import type { HerramientaRegistrada } from "./herramientas"
import type { RegistroLlamada, Sesion } from "./sesiones"

export interface Presupuesto {
  usados: number
  maximo: number
}

export interface DependenciasCiclo {
  proveedor: ProveedorLLM
  herramientas: Map<string, HerramientaRegistrada>
  politica: PoliticaConfirmacion
  directory: string
  maxIteraciones: number
  maxTokensSesion: number
  /** Compartido por todas las sesiones del servidor. */
  presupuestoServidor: Presupuesto
}

/** Lo que el front recibe en vivo mientras el turno avanza. */
export type EventoTurno =
  | { tipo: "herramienta_inicio"; id: string; nombre: string; argumentos: unknown }
  | { tipo: "herramienta_fin"; llamada: RegistroLlamada }
  | { tipo: "nota"; texto: string }
  | { tipo: "error"; texto: string }

export interface ResultadoTurno {
  reply: string
  toolCalls: RegistroLlamada[]
  needsConfirmation: boolean
  pendientes: RevisionPendiente[]
  tokensSesion: number
  iteraciones: number
}

const MAX_RESULTADO_VISIBLE = 6000

function ahora(): string {
  return new Date().toISOString()
}

function tokensDe(uso: Uso): number {
  return uso.entrada + uso.salida + uso.cacheLeida + uso.cacheEscrita
}

function leerSeguro(contenido: string): RespuestaHerramienta {
  try {
    return leerRespuesta(contenido)
  } catch {
    return { ok: false, error: "la herramienta devolvió una respuesta ilegible" }
  }
}

async function ejecutarLlamada(llamada: LlamadaHerramienta, sesion: Sesion, deps: DependenciasCiclo) {
  const inicio = performance.now()
  const ctx = { directory: deps.directory, sessionId: sesion.id }
  const bloqueo = deps.politica.bloquear(llamada, sesion.pendientes, sesion.turno)
  let contenido: string
  if (bloqueo) {
    contenido = JSON.stringify({ ok: false, error: bloqueo })
    registrarEnLog(ctx, { herramienta: llamada.nombre, mensaje_id: null, ok: false, resumen: bloqueo })
  } else {
    const herramienta = deps.herramientas.get(llamada.nombre)
    contenido = herramienta
      ? await herramienta.ejecutar(llamada.argumentos, ctx)
      : JSON.stringify({ ok: false, error: `herramienta desconocida: ${llamada.nombre}` })
  }
  const respuesta = leerSeguro(contenido)
  if (!bloqueo) deps.politica.actualizar(llamada, respuesta, sesion.pendientes, sesion.turno)
  const registro: RegistroLlamada = {
    id: llamada.id,
    nombre: llamada.nombre,
    argumentos: llamada.argumentos,
    ok: respuesta.ok,
    resumen: respuesta.ok ? respuesta.resumen : respuesta.error,
    resultado: contenido.length > MAX_RESULTADO_VISIBLE ? `${contenido.slice(0, MAX_RESULTADO_VISIBLE)}…` : contenido,
    ms: Math.round(performance.now() - inicio),
  }
  const resultado: ResultadoHerramienta = { id: llamada.id, contenido, esError: !respuesta.ok }
  return { resultado, registro }
}

function llamadaTruncada(llamada: LlamadaHerramienta) {
  const error = "la llamada llegó cortada por el límite de tokens de salida; vuelve a intentarla"
  const contenido = JSON.stringify({ ok: false, error })
  const registro: RegistroLlamada = { id: llamada.id, nombre: llamada.nombre, argumentos: llamada.argumentos, ok: false, resumen: error, resultado: contenido, ms: 0 }
  return { resultado: { id: llamada.id, contenido, esError: true }, registro }
}

/** Devuelve un aviso si ya no hay tokens disponibles para esta sesión o para el servidor. */
function sinPresupuesto(sesion: Sesion, deps: DependenciasCiclo): string | null {
  if (sesion.tokens >= deps.maxTokensSesion) return `Esta sesión alcanzó su tope de ${deps.maxTokensSesion.toLocaleString("es-CO")} tokens. Abre una sesión nueva para continuar.`
  if (deps.presupuestoServidor.usados >= deps.presupuestoServidor.maximo) return "El servidor alcanzó su tope de uso del modelo. Avisa a quien administra la demo."
  return null
}

async function consultar(sesion: Sesion, deps: DependenciasCiclo, sinHerramientas: boolean): Promise<RespuestaModelo> {
  const definiciones = [...deps.herramientas.values()].map((h) => h.definicion)
  const respuesta = await deps.proveedor.enviar(sesion.sistema, sesion.mensajes, definiciones, { sinHerramientas })
  sesion.tokens += tokensDe(respuesta.uso)
  deps.presupuestoServidor.usados += tokensDe(respuesta.uso)
  sesion.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, nativo: respuesta.nativo })
  return respuesta
}

/** CA1: al llegar al tope, una última llamada sin herramientas para que el agente diga qué hizo y qué falta. */
async function cerrarPorTope(sesion: Sesion, deps: DependenciasCiclo): Promise<string> {
  sesion.mensajes.push({
    rol: "aviso",
    texto: `Alcanzaste el tope de ${deps.maxIteraciones} iteraciones con herramientas en este turno. Responde ahora sin llamar herramientas: resume lo que quedó hecho, solo con datos de los resultados, y lo que falta.`,
  })
  try {
    const respuesta = await consultar(sesion, deps, true)
    return respuesta.texto || `Llegué al tope de ${deps.maxIteraciones} iteraciones. Revisa las llamadas a herramientas de este turno para ver lo procesado.`
  } catch (error) {
    sesion.mensajes.pop() // el aviso no puede quedar suelto antes del próximo mensaje de la usuaria
    throw error
  }
}

async function bucle(sesion: Sesion, deps: DependenciasCiclo, llamadas: RegistroLlamada[], alEvento: (e: EventoTurno) => void) {
  for (let iteracion = 1; iteracion <= deps.maxIteraciones; iteracion++) {
    const aviso = sinPresupuesto(sesion, deps)
    if (aviso) return { texto: aviso, iteraciones: iteracion - 1 }
    const respuesta = await consultar(sesion, deps, false)
    if (respuesta.fin === "rechazo") return { texto: "El modelo declinó responder esta solicitud. Reformúlala o abre una sesión nueva.", iteraciones: iteracion }
    if (respuesta.llamadas.length === 0) {
      const cortada = respuesta.fin === "limite_tokens" ? "\n\n_(La respuesta se cortó por longitud.)_" : ""
      return { texto: `${respuesta.texto}${cortada}`, iteraciones: iteracion }
    }
    if (respuesta.texto) alEvento({ tipo: "nota", texto: respuesta.texto })
    const resultados: ResultadoHerramienta[] = []
    for (const llamada of respuesta.llamadas) {
      // Secuencial a propósito: dos registros en paralelo escribirían el mismo maestro.
      alEvento({ tipo: "herramienta_inicio", id: llamada.id, nombre: llamada.nombre, argumentos: llamada.argumentos })
      const { resultado, registro } = respuesta.fin === "limite_tokens" ? llamadaTruncada(llamada) : await ejecutarLlamada(llamada, sesion, deps)
      resultados.push(resultado)
      llamadas.push(registro)
      sesion.eventos.push({ tipo: "herramienta", llamada: registro, ts: ahora() })
      alEvento({ tipo: "herramienta_fin", llamada: registro })
    }
    sesion.mensajes.push({ rol: "herramientas", resultados })
  }
  return { texto: await cerrarPorTope(sesion, deps), iteraciones: deps.maxIteraciones }
}

/**
 * Un turno del agente: mensaje de la usuaria → modelo → herramientas → … → respuesta.
 * Un error del proveedor o de una herramienta se muestra en el chat; la sesión sigue viva.
 */
export async function ejecutarTurno(sesion: Sesion, texto: string, deps: DependenciasCiclo, alEvento: (e: EventoTurno) => void = () => {}): Promise<ResultadoTurno> {
  sesion.turno += 1
  sesion.eventos.push({ tipo: "usuario", texto, ts: ahora() })
  sesion.mensajes.push({ rol: "usuario", texto })
  const llamadas: RegistroLlamada[] = []
  let reply: string
  let iteraciones = 0
  try {
    const resultado = await bucle(sesion, deps, llamadas, alEvento)
    reply = resultado.texto.trim() || "(El modelo no devolvió texto; revisa las llamadas a herramientas.)"
    iteraciones = resultado.iteraciones
  } catch (error) {
    reply = `⚠️ ${error instanceof Error ? error.message : String(error)}`
    sesion.eventos.push({ tipo: "error", texto: reply, ts: ahora() })
    alEvento({ tipo: "error", texto: reply })
  }
  const pendientes = [...sesion.pendientes.values()]
  sesion.eventos.push({ tipo: "asistente", texto: reply, ts: ahora(), pideConfirmacion: pendientes.length > 0 })
  return { reply, toolCalls: llamadas, needsConfirmation: pendientes.length > 0, pendientes, tokensSesion: sesion.tokens, iteraciones }
}
