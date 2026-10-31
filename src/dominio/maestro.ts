import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { z } from "zod"
import { ErrorProceso, escribirArchivo, rutas } from "../lib/archivos"
import { parsearCsv, serializarCsv } from "../lib/csv"
import { COLUMNAS_MAESTRO, ESTADOS_POLIZA, type FilaMaestro, FUENTES, MONEDAS, PAISES } from "./tipos"

const FilaSchema = z.object({
  id_contrato: z.string().min(1),
  cliente: z.string(),
  nit_cliente: z.string(),
  pais: z.enum(PAISES),
  objeto: z.string(),
  valor: z.coerce.number().nonnegative(),
  moneda: z.enum(MONEDAS),
  fecha_inicio: z.string(),
  fecha_fin: z.string(),
  requiere_poliza: z.enum(["true", "false"]).transform((v) => v === "true"),
  tipo_poliza: z.string(),
  estado_poliza: z.enum(ESTADOS_POLIZA),
  comercial: z.string(),
  ruta_sharepoint: z.string(),
  fecha_registro: z.string(),
  fuente: z.enum(FUENTES),
})

/** RN6: el fixture es de solo lectura; la primera vez se copia a out/sharepoint/ y desde ahí se trabaja. */
export function asegurarMaestro(directory: string): string {
  const r = rutas(directory)
  if (!existsSync(r.maestro)) {
    if (!existsSync(r.maestroFixture)) throw new ErrorProceso("no existe fixtures/reto-02/maestro-contratos.csv")
    mkdirSync(r.sharepoint, { recursive: true })
    copyFileSync(r.maestroFixture, r.maestro)
  }
  return r.maestro
}

export function leerMaestro(directory: string): FilaMaestro[] {
  const [encabezado, ...filas] = parsearCsv(readFileSync(asegurarMaestro(directory), "utf8"))
  if (!encabezado || COLUMNAS_MAESTRO.some((c, i) => encabezado[i] !== c)) {
    throw new ErrorProceso("el maestro no tiene las columnas esperadas")
  }
  return filas.map((celdas, n) => {
    const fila = FilaSchema.safeParse(Object.fromEntries(COLUMNAS_MAESTRO.map((c, i) => [c, celdas[i] ?? ""])))
    if (!fila.success) throw new ErrorProceso(`fila ${n + 2} del maestro inválida: ${fila.error.issues[0]?.message}`)
    return fila.data
  })
}

export function escribirMaestro(directory: string, filas: FilaMaestro[]): void {
  const cuerpo = filas.map((fila) => COLUMNAS_MAESTRO.map((c) => String(fila[c])))
  escribirArchivo(rutas(directory).maestro, serializarCsv([[...COLUMNAS_MAESTRO], ...cuerpo]))
}

/** Siguiente `AUTO-<año>-<NNN>` libre para contratos que no traen número. */
export function siguienteIdAutomatico(filas: FilaMaestro[], anio: string): string {
  const prefijo = `AUTO-${anio}-`
  const usados = filas.filter((f) => f.id_contrato.startsWith(prefijo)).map((f) => Number(f.id_contrato.slice(prefijo.length)) || 0)
  return `${prefijo}${String(Math.max(0, ...usados) + 1).padStart(3, "0")}`
}
