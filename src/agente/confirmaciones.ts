import { z } from "zod"
import type { RespuestaHerramienta } from "../lib/respuesta"
import type { LlamadaHerramienta } from "../llm/adapter"

export interface RevisionPendiente {
  mensaje_id: string
  campos: string[]
  /** Turno en que la usuaria vio (o verá) la pregunta. La confirmación solo vale en un turno posterior. */
  turno: number
}

/** CA3 en código: cuándo una llamada exige que la usuaria haya respondido antes, y cómo cambian las revisiones pendientes. */
export interface PoliticaConfirmacion {
  /** Devuelve el motivo para no ejecutar la llamada, o null si puede ejecutarse. */
  bloquear(llamada: LlamadaHerramienta, pendientes: Map<string, RevisionPendiente>, turno: number): string | null
  actualizar(llamada: LlamadaHerramienta, respuesta: RespuestaHerramienta, pendientes: Map<string, RevisionPendiente>, turno: number): void
}

const ArgsRegistro = z.object({ mensaje_id: z.string(), confirmado: z.boolean().optional() })
const DatosValidacion = z.object({ requiere_revision: z.array(z.string()) })

function marcarPendiente(pendientes: Map<string, RevisionPendiente>, mensajeId: string, campos: string[], turno: number): void {
  const previa = pendientes.get(mensajeId)
  pendientes.set(mensajeId, { mensaje_id: mensajeId, campos, turno: previa?.turno ?? turno })
}

/** Política del registro de contratos: `contratos_registrar` con `confirmado: true` exige una revisión mostrada en un turno anterior. */
export const confirmacionContratos: PoliticaConfirmacion = {
  bloquear(llamada, pendientes, turno) {
    if (llamada.nombre !== "contratos_registrar") return null
    const args = ArgsRegistro.safeParse(llamada.argumentos)
    if (!args.success || args.data.confirmado !== true) return null
    const pendiente = pendientes.get(args.data.mensaje_id)
    if (!pendiente) {
      return `confirmado=true rechazado: no hay una revisión de ${args.data.mensaje_id} que la usuaria haya visto. Llama a contratos_validar, muéstrale los campos y pregúntale.`
    }
    if (pendiente.turno === turno) {
      return `confirmado=true rechazado: la revisión de ${args.data.mensaje_id} (${pendiente.campos.join(", ")}) se detectó en este turno y la usuaria aún no respondió. Termina el turno con la pregunta de confirmación.`
    }
    return null
  },

  actualizar(llamada, respuesta, pendientes, turno) {
    const mensajeId = ArgsRegistro.pick({ mensaje_id: true }).safeParse(llamada.argumentos).data?.mensaje_id
    if (!mensajeId) return
    if (llamada.nombre === "contratos_validar" && respuesta.ok) {
      const campos = DatosValidacion.safeParse(respuesta.data).data?.requiere_revision ?? []
      if (campos.length) marcarPendiente(pendientes, mensajeId, campos, turno)
    }
    if (llamada.nombre === "contratos_registrar") {
      if (respuesta.ok) pendientes.delete(mensajeId)
      else {
        const campos = /^requiere revisión: ([a-z_, ]+) —/.exec(respuesta.error)?.[1]?.split(", ")
        if (campos) marcarPendiente(pendientes, mensajeId, campos, turno)
      }
    }
  },
}
