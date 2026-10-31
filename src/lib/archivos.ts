import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

/** Error esperado del proceso (mensaje inexistente, revisión pendiente…). Su texto llega tal cual al modelo y a la usuaria. */
export class ErrorProceso extends Error {
  override name = "ErrorProceso"
}

/** Todas las rutas salen de `directory` (raíz del proyecto): nunca rutas absolutas fijas. */
export function rutas(directory: string) {
  const fixtures = join(directory, "fixtures", "reto-02")
  const out = join(directory, "out")
  const sharepoint = join(out, "sharepoint")
  return {
    fixtures,
    buzon: join(fixtures, "buzon"),
    maestroFixture: join(fixtures, "maestro-contratos.csv"),
    comerciales: join(fixtures, "comerciales.json"),
    out,
    sharepoint,
    maestro: join(sharepoint, "maestro-contratos.csv"),
    historial: join(sharepoint, "historial.jsonl"),
    procesados: join(out, "procesados.json"),
    log: join(out, "log.jsonl"),
    alertas: join(out, "alertas.md"),
  }
}

export type Rutas = ReturnType<typeof rutas>

export function leerJson(ruta: string): unknown {
  return JSON.parse(readFileSync(ruta, "utf8"))
}

export function escribirArchivo(ruta: string, contenido: string): void {
  mkdirSync(dirname(ruta), { recursive: true })
  writeFileSync(ruta, contenido, "utf8")
}

export function agregarLineaJson(ruta: string, registro: object): void {
  mkdirSync(dirname(ruta), { recursive: true })
  appendFileSync(ruta, `${JSON.stringify(registro)}\n`, "utf8")
}

export function leerLineasJson(ruta: string): unknown[] {
  if (!existsSync(ruta)) return []
  return readFileSync(ruta, "utf8")
    .split("\n")
    .filter((linea) => linea.trim() !== "")
    .map((linea) => JSON.parse(linea))
}

/** Resuelve `ruta` dentro de `base` y rechaza cualquier intento de salir de ella ("../", rutas absolutas). */
export function rutaDentroDe(base: string, ruta: string): string {
  const destino = resolve(base, ruta)
  const rel = relative(resolve(base), destino)
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ErrorProceso(`ruta fuera de ${relative(process.cwd(), base) || base}: ${ruta}`)
  }
  return destino
}

/** Los identificadores de mensaje son nombres de carpeta; se validan para que no sirvan para recorrer el disco. */
export function validarMensajeId(mensajeId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(mensajeId)) {
    throw new ErrorProceso(`mensaje_id inválido: "${mensajeId}"`)
  }
}
