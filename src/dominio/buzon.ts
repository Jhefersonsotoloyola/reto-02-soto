import { existsSync, readdirSync, readFileSync } from "node:fs"
import { extname, join } from "node:path"
import { z } from "zod"
import { ErrorProceso, escribirArchivo, leerJson, rutas, validarMensajeId } from "../lib/archivos"
import { textoDePdf } from "../lib/pdf"
import { normalizar } from "../lib/texto"
import { type Comercial, ComercialSchema, type Correo, CorreoSchema, type TipoDocumento } from "./tipos"

export interface Adjunto {
  nombre: string
  ruta: string
  texto: string | null
  tipo: TipoDocumento
  /** Cómo se presenta el documento: "contrato", "otrosí", "cotización"… */
  etiqueta: string
  error: string | null
}

export interface Mensaje {
  correo: Correo
  adjuntos: Adjunto[]
}

const ProcesadoSchema = z.object({
  ts: z.string(),
  clasificacion: z.string(),
  accion: z.string(),
  id_contrato: z.string().nullable(),
  motivo: z.string().nullable(),
})
export type Procesado = z.infer<typeof ProcesadoSchema>
const ProcesadosSchema = z.record(z.string(), ProcesadoSchema)

/** Lee la primera línea con texto y decide qué documento es. */
export function tipoDeDocumento(texto: string): { tipo: TipoDocumento; etiqueta: string } {
  const primera = (texto.split("\n").find((linea) => linea.trim() !== "") ?? "").trim()
  const inicio = normalizar(primera)
  if (/^(otrosi|adenda|modificacion)\b/.test(inicio)) return { tipo: "otrosi", etiqueta: "otrosí" }
  if (/^contrato\b/.test(inicio)) return { tipo: "contrato", etiqueta: "contrato" }
  const etiqueta = primera.toLowerCase().split(/\s+no\.?\s|[:,]/)[0]?.trim() || "documento sin título"
  return { tipo: "otro", etiqueta }
}

async function leerAdjunto(carpeta: string, nombre: string): Promise<Adjunto> {
  const ruta = join(carpeta, nombre)
  const base = { nombre, ruta, texto: null, tipo: "otro" as const, etiqueta: "adjunto ilegible" }
  if (!existsSync(ruta)) return { ...base, error: `el adjunto ${nombre} no está en la carpeta del mensaje` }
  const extension = extname(nombre).toLowerCase()
  let texto: string
  if (extension === ".txt") texto = readFileSync(ruta, "utf8")
  else if (extension === ".pdf") texto = await textoDePdf(readFileSync(ruta))
  else return { ...base, error: `formato no soportado: ${extension || "sin extensión"}` }
  if (texto.trim() === "") return { ...base, texto, error: `el adjunto ${nombre} está vacío o no tiene texto extraíble` }
  return { nombre, ruta, texto, ...tipoDeDocumento(texto), error: null }
}

export function listarMensajes(directory: string): string[] {
  const { buzon } = rutas(directory)
  if (!existsSync(buzon)) throw new ErrorProceso("no existe la carpeta del buzón fixtures/reto-02/buzon")
  return readdirSync(buzon, { withFileTypes: true })
    .filter((entrada) => entrada.isDirectory() && existsSync(join(buzon, entrada.name, "correo.json")))
    .map((entrada) => entrada.name)
    .sort()
}

export function leerCorreo(directory: string, mensajeId: string): Correo {
  validarMensajeId(mensajeId)
  const archivoCorreo = join(rutas(directory).buzon, mensajeId, "correo.json")
  if (!existsSync(archivoCorreo)) throw new ErrorProceso(`no existe el mensaje ${mensajeId} en el buzón`)
  const correo = CorreoSchema.safeParse(leerJson(archivoCorreo))
  if (!correo.success) throw new ErrorProceso(`correo.json de ${mensajeId} no tiene el formato esperado`)
  return correo.data
}

export async function leerMensaje(directory: string, mensajeId: string): Promise<Mensaje> {
  const correo = leerCorreo(directory, mensajeId)
  const carpeta = join(rutas(directory).buzon, mensajeId)
  const adjuntos = await Promise.all(correo.adjuntos.map((nombre) => leerAdjunto(carpeta, nombre)))
  return { correo, adjuntos }
}

/** El adjunto que se procesa: el primer contrato u otrosí legible. */
export function documentoPrincipal(mensaje: Mensaje): Adjunto | null {
  return mensaje.adjuntos.find((a) => a.error === null && a.tipo !== "otro") ?? null
}

/** RN4: motivo de rechazo cuando el mensaje no trae un contrato procesable; null si sí lo trae. */
export function motivoSinContrato(mensaje: Mensaje): string | null {
  if (documentoPrincipal(mensaje)) return null
  if (mensaje.adjuntos.length === 0) return "el correo no trae adjuntos"
  const detalle = mensaje.adjuntos.map((a) => (a.error ? a.error : `${a.nombre} (${a.etiqueta}) no es un contrato ni un otrosí`))
  return `sin adjunto de contrato: ${detalle.join("; ")}`
}

export function leerProcesados(directory: string): Record<string, Procesado> {
  const { procesados } = rutas(directory)
  if (!existsSync(procesados)) return {}
  return ProcesadosSchema.parse(leerJson(procesados))
}

export function marcarProcesado(directory: string, mensajeId: string, registro: Procesado): void {
  const todos = leerProcesados(directory)
  todos[mensajeId] = registro
  escribirArchivo(rutas(directory).procesados, `${JSON.stringify(todos, null, 2)}\n`)
}

export interface Remitente {
  email: string
  conocido: boolean
  nombre: string
  region: string | null
}

export function resolverRemitente(directory: string, email: string): Remitente {
  const comerciales: Comercial[] = z.array(ComercialSchema).parse(leerJson(rutas(directory).comerciales))
  const encontrado = comerciales.find((c) => c.email.toLowerCase() === email.trim().toLowerCase())
  if (encontrado) return { email, conocido: true, nombre: encontrado.nombre, region: encontrado.region }
  return { email, conocido: false, nombre: `No registrado: ${email}`, region: null }
}
