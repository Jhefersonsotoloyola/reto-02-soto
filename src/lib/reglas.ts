import { z } from "zod"
import reglasJson from "../knowledge/reglas.json"

const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const

const ReglasSchema = z.object({
  umbral_confianza: z.number().min(0).max(1),
  dias_alerta_vencimiento: z.number().int().positive(),
  fecha_corte_maestro: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  similitud_objeto_actualizacion: z.number().min(0).max(1),
  empresa_propia: z.object({ razon_social: z.string(), identificador: z.string() }),
  campos_obligatorios: z.array(z.string()),
  campos_clave_actualizacion: z.array(z.string()),
  identificadores: z.array(
    z.object({ etiqueta: z.string(), patron: z.string(), pais: z.enum(PAISES) }),
  ),
  lugares_por_pais: z.record(z.enum(PAISES), z.array(z.string())),
  moneda_por_pais: z.record(z.enum(PAISES), z.enum(MONEDAS)),
  palabras_moneda: z.record(z.enum(MONEDAS), z.array(z.string())),
  tipos_poliza: z.record(z.string(), z.array(z.string())),
  patrones_valor_indeterminado: z.array(z.string()),
  sufijos_societarios: z.array(z.string()),
  otrosi_que_extiende_plazo_deja_poliza_pendiente: z.boolean(),
})

export type Reglas = z.infer<typeof ReglasSchema>

/** Reglas de negocio del proceso. Se validan al cargar: un JSON mal editado falla al arrancar, no en mitad de un registro. */
export const reglas: Reglas = ReglasSchema.parse(reglasJson)
