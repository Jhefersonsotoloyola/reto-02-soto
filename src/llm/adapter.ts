// Interfaz propia del proveedor de modelo. El ciclo del agente solo conoce estos tipos:
// cambiar de proveedor es escribir otra implementación de `ProveedorLLM`, sin tocar el ciclo.

export interface LlamadaHerramienta {
  id: string
  nombre: string
  argumentos: unknown
}

export interface ResultadoHerramienta {
  id: string
  contenido: string
  esError: boolean
}

export type Mensaje =
  | { rol: "usuario"; texto: string }
  /** `nativo` guarda la respuesta tal como la devolvió el proveedor, para reenviarla sin cambios en la siguiente llamada. */
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; nativo?: unknown }
  | { rol: "herramientas"; resultados: ResultadoHerramienta[] }
  /** Instrucción del sistema a mitad de conversación (por ejemplo, "alcanzaste el tope de iteraciones"). */
  | { rol: "aviso"; texto: string }

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  /** JSON Schema de los argumentos, generado desde zod. */
  esquema: Record<string, unknown>
}

export type MotivoFin = "fin" | "herramientas" | "limite_tokens" | "rechazo"

export interface Uso {
  entrada: number
  salida: number
  cacheLeida: number
  cacheEscrita: number
}

export interface RespuestaModelo {
  texto: string
  llamadas: LlamadaHerramienta[]
  fin: MotivoFin
  uso: Uso
  nativo?: unknown
}

export interface OpcionesEnvio {
  /** El modelo debe responder solo con texto (se usa al alcanzar el tope de iteraciones). */
  sinHerramientas?: boolean
}

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones?: OpcionesEnvio): Promise<RespuestaModelo>
}

/** Error del proveedor ya traducido a un mensaje que se puede mostrar en el chat (sin claves ni trazas). */
export class ErrorProveedor extends Error {
  override name = "ErrorProveedor"
}
