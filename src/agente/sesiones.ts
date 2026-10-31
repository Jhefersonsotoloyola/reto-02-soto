import type { Mensaje } from "../llm/adapter"
import type { RevisionPendiente } from "./confirmaciones"

/** Una llamada a herramienta tal como se muestra en el chat. */
export interface RegistroLlamada {
  id: string
  nombre: string
  argumentos: unknown
  ok: boolean
  resumen: string
  /** Resultado completo recortado para no inflar la respuesta HTTP. */
  resultado: string
  ms: number
}

export type EventoVisible =
  | { tipo: "usuario"; texto: string; ts: string }
  | { tipo: "asistente"; texto: string; ts: string; pideConfirmacion: boolean }
  | { tipo: "herramienta"; llamada: RegistroLlamada; ts: string }
  | { tipo: "error"; texto: string; ts: string }

export interface Sesion {
  id: string
  creada: string
  /** Se fija al crear la sesión: mantenerlo idéntico conserva la caché del prompt y el razonamiento previo del modelo. */
  sistema: string
  mensajes: Mensaje[]
  eventos: EventoVisible[]
  pendientes: Map<string, RevisionPendiente>
  turno: number
  tokens: number
  ocupada: boolean
}

/** Sesiones en memoria. Al pasar el máximo se descarta la más antigua. */
export class AlmacenSesiones {
  private readonly sesiones = new Map<string, Sesion>()

  constructor(
    private readonly maximo: number,
    private readonly crearSistema: () => string,
  ) {}

  obtener(id: string): Sesion | undefined {
    return this.sesiones.get(id)
  }

  obtenerOCrear(id: string): Sesion {
    const existente = this.sesiones.get(id)
    if (existente) return existente
    const sesion: Sesion = {
      id, creada: new Date().toISOString(), sistema: this.crearSistema(), mensajes: [], eventos: [],
      pendientes: new Map(), turno: 0, tokens: 0, ocupada: false,
    }
    this.sesiones.set(id, sesion)
    for (const [clave, s] of this.sesiones) {
      if (this.sesiones.size <= this.maximo) break
      if (!s.ocupada) this.sesiones.delete(clave)
    }
    return sesion
  }

  hayTurnoEnCurso(): boolean {
    return [...this.sesiones.values()].some((s) => s.ocupada)
  }

  vaciar(): void {
    this.sesiones.clear()
  }
}
