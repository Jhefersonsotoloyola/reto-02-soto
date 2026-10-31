import Anthropic from "@anthropic-ai/sdk"
import {
  type DefinicionHerramienta,
  ErrorProveedor,
  type Mensaje,
  type MotivoFin,
  type OpcionesEnvio,
  type ProveedorLLM,
  type RespuestaModelo,
} from "./adapter"

type BetaMensaje = Anthropic.Beta.BetaMessageParam
type BetaBloque = Anthropic.Beta.BetaContentBlockParam

export interface ConfigAnthropic {
  apiKey: string
  modelo: string
  maxTokens: number
  timeoutMs: number
  esfuerzo: "low" | "medium" | "high"
}

function aBloquesAsistente(m: Extract<Mensaje, { rol: "asistente" }>): BetaBloque[] {
  // La respuesta original se reenvía sin cambios: incluye bloques de razonamiento que la API exige intactos.
  if (Array.isArray(m.nativo)) return m.nativo as BetaBloque[]
  return [
    ...(m.texto ? [{ type: "text" as const, text: m.texto }] : []),
    ...m.llamadas.map((l) => ({ type: "tool_use" as const, id: l.id, name: l.nombre, input: l.argumentos })),
  ]
}

function aMensajeAnthropic(m: Mensaje): BetaMensaje {
  switch (m.rol) {
    case "usuario":
      return { role: "user", content: m.texto }
    case "asistente":
      return { role: "assistant", content: aBloquesAsistente(m) }
    case "herramientas":
      return {
        role: "user",
        content: m.resultados.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.contenido, is_error: r.esError })),
      }
    case "aviso":
      return { role: "system", content: m.texto }
  }
}

function aMotivoFin(stop: Anthropic.Beta.BetaStopReason | null): MotivoFin {
  if (stop === "tool_use") return "herramientas"
  if (stop === "max_tokens" || stop === "model_context_window_exceeded") return "limite_tokens"
  if (stop === "refusal") return "rechazo"
  return "fin"
}

function traducirError(error: unknown, timeoutMs: number): ErrorProveedor {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ErrorProveedor(`El modelo no respondió en ${Math.round(timeoutMs / 1000)} s. Intenta de nuevo.`)
  if (error instanceof Anthropic.APIConnectionError) return new ErrorProveedor("No hay conexión con el proveedor del modelo. Revisa la red e intenta de nuevo.")
  if (error instanceof Anthropic.AuthenticationError) return new ErrorProveedor("El proveedor rechazó la clave de API configurada en el servidor (ANTHROPIC_API_KEY).")
  if (error instanceof Anthropic.RateLimitError) return new ErrorProveedor("El proveedor está limitando las solicitudes. Espera un minuto e intenta de nuevo.")
  if (error instanceof Anthropic.BadRequestError) return new ErrorProveedor(`El proveedor rechazó la solicitud: ${error.message}`)
  if (error instanceof Anthropic.APIError) return new ErrorProveedor(`El proveedor respondió con un error (${error.status ?? "sin código"}). Intenta de nuevo en unos minutos.`)
  return new ErrorProveedor(`Error inesperado al llamar al modelo: ${error instanceof Error ? error.message : String(error)}`)
}

/** Implementación de `ProveedorLLM` para Claude (Messages API, SDK oficial). */
export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = "anthropic"
  readonly modelo: string
  private readonly cliente: Anthropic

  constructor(private readonly config: ConfigAnthropic) {
    this.modelo = config.modelo
    this.cliente = new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 2 })
  }

  async enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio = {}): Promise<RespuestaModelo> {
    try {
      const respuesta = await this.cliente.beta.messages.create({
        model: this.config.modelo,
        max_tokens: this.config.maxTokens,
        // Si un clasificador de seguridad declina, la API reintenta con el modelo de respaldo recomendado.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: this.config.esfuerzo },
        // Caché automática del prefijo (herramientas + sistema + historial): cada iteración relee lo anterior a 0.1x.
        cache_control: { type: "ephemeral" },
        system: sistema,
        tools: herramientas.map((h) => ({
          name: h.nombre,
          description: h.descripcion,
          input_schema: { type: "object" as const, ...h.esquema },
        })),
        tool_choice: opciones.sinHerramientas ? { type: "none" } : { type: "auto" },
        messages: mensajes.map(aMensajeAnthropic),
      })
      const texto = respuesta.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim()
      const llamadas = respuesta.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, nombre: b.name, argumentos: b.input }] : []))
      return {
        texto,
        llamadas,
        fin: aMotivoFin(respuesta.stop_reason),
        uso: {
          entrada: respuesta.usage.input_tokens,
          salida: respuesta.usage.output_tokens,
          cacheLeida: respuesta.usage.cache_read_input_tokens ?? 0,
          cacheEscrita: respuesta.usage.cache_creation_input_tokens ?? 0,
        },
        nativo: respuesta.content,
      }
    } catch (error) {
      throw traducirError(error, this.config.timeoutMs)
    }
  }
}
