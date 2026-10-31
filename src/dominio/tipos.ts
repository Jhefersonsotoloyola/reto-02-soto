import { z } from "zod"
import { esFechaValida } from "../lib/fechas"

export const PAISES = ["CO", "EC", "PE", "PA", "HN"] as const
export const MONEDAS = ["COP", "USD", "PEN", "PAB", "HNL"] as const
export const ESTADOS_POLIZA = ["vigente", "pendiente", "vencida", "no_aplica"] as const
export const FUENTES = ["buzon", "manual", "migracion"] as const

/** Campos que la extracción lee del documento; cada uno lleva su confianza. */
export const CAMPOS_EXTRAIDOS = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza",
] as const
export type CampoExtraido = (typeof CAMPOS_EXTRAIDOS)[number]

export type Pais = (typeof PAISES)[number]
export type Moneda = (typeof MONEDAS)[number]

const FechaIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "debe tener formato YYYY-MM-DD")
  .refine(esFechaValida, "la fecha no existe en el calendario")

/** Valores de negocio de un contrato u otrosí: lo que se puede proponer, corregir y registrar. */
export const CamposContratoSchema = z.object({
  id_contrato: z.string().trim().min(1).max(40).nullable().describe("Número del contrato tal como aparece en el documento"),
  cliente: z.string().trim().min(1).max(200).nullable().describe("Razón social de la contraparte"),
  nit_cliente: z.string().regex(/^[0-9A-Za-z-]{5,20}$/, "sin puntos ni espacios").nullable().describe("Identificador tributario sin dígito de verificación ni puntos"),
  pais: z.enum(PAISES).nullable().describe("País de la contraparte"),
  objeto: z.string().trim().min(1).max(200).nullable().describe("Objeto del contrato, máximo 200 caracteres"),
  valor: z.number().nonnegative().nullable().describe("Valor total sin separadores; 0 si es por demanda"),
  valor_indeterminado: z.boolean().describe("true si el contrato es por demanda o sin valor determinado"),
  moneda: z.enum(MONEDAS).nullable().describe("Moneda del valor"),
  fecha_inicio: FechaIso.nullable().describe("Inicio de vigencia YYYY-MM-DD"),
  fecha_fin: FechaIso.nullable().describe("Fin de vigencia YYYY-MM-DD"),
  requiere_poliza: z.boolean().nullable().describe("true si el contrato exige póliza o garantía"),
  tipo_poliza: z.string().regex(/^[a-z_]+(;[a-z_]+)*$/, "lista en minúsculas separada por ;").nullable().describe("Tipos de póliza separados por ;"),
})
export type CamposContrato = z.infer<typeof CamposContratoSchema>

/** Lo que el agente puede enviar a validar/registrar: cualquier subconjunto de campos. Lo que no envía se toma de la extracción. */
export const PropuestaContratoSchema = CamposContratoSchema.partial()
export type PropuestaContrato = z.infer<typeof PropuestaContratoSchema>

export type TipoDocumento = "contrato" | "otrosi" | "otro"

export interface Contrato extends CamposContrato {
  tipo_documento: "contrato" | "otrosi"
  numero_otrosi: number | null
  plazo_meses: number | null
  fecha_firma: string | null
  confianza: Record<CampoExtraido, number>
  evidencia: Partial<Record<CampoExtraido, string>>
  notas: string[]
}

export const COLUMNAS_MAESTRO = [
  "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza",
  "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
] as const

export interface FilaMaestro {
  id_contrato: string
  cliente: string
  nit_cliente: string
  pais: Pais
  objeto: string
  valor: number
  moneda: Moneda
  fecha_inicio: string
  fecha_fin: string
  requiere_poliza: boolean
  tipo_poliza: string
  estado_poliza: (typeof ESTADOS_POLIZA)[number]
  comercial: string
  ruta_sharepoint: string
  fecha_registro: string
  fuente: (typeof FUENTES)[number]
}

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type Correo = z.infer<typeof CorreoSchema>

export const ComercialSchema = z.object({ email: z.string(), nombre: z.string(), region: z.string() })
export type Comercial = z.infer<typeof ComercialSchema>
