import { z } from "zod"
import { agregarLineaJson, ErrorProceso, rutas } from "./archivos"

// Los errores de validación llegan al modelo y a la usuaria: en español.
z.config(z.locales.es())

/** Contexto que recibe toda herramienta: `directory` es la raíz del proyecto. */
export interface ContextoHerramienta {
  directory: string
  sessionId: string
}

export interface Herramienta<Args extends z.ZodRawShape> {
  description: string
  args: Args
  /** Recibe los argumentos tal como llegan (del modelo, de demo.ts o de otra plataforma) y los valida antes de usarlos. */
  execute(args: unknown, ctx: ContextoHerramienta): Promise<string>
}

interface Definicion<Args extends z.ZodRawShape, Dato> {
  description: string
  args: Args
  /** Lógica de la herramienta. Puede lanzar: `herramienta()` convierte el error en `{ ok: false, error }`. */
  run(args: z.infer<z.ZodObject<Args>>, ctx: ContextoHerramienta): { data: Dato; resumen: string } | Promise<{ data: Dato; resumen: string }>
}

export function describirErrorZod(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ")
}

function textoDeError(error: unknown): string {
  if (error instanceof ErrorProceso) return error.message
  if (error instanceof z.ZodError) return `datos inválidos: ${describirErrorZod(error)}`
  return `error interno: ${error instanceof Error ? error.message : String(error)}`
}

function mensajeIdDe(args: unknown): string | null {
  if (typeof args !== "object" || args === null || !("mensaje_id" in args)) return null
  return typeof args.mensaje_id === "string" ? args.mensaje_id : null
}

/** RN7: cada ejecución deja una línea en out/log.jsonl. Si el log falla, la herramienta igual responde. */
export function registrarEnLog(ctx: ContextoHerramienta, linea: Record<string, unknown>): void {
  try {
    agregarLineaJson(rutas(ctx.directory).log, { ts: new Date().toISOString(), sesion: ctx.sessionId, ...linea })
  } catch {
    // El log es auditoría, no parte del resultado.
  }
}

/**
 * Construye una herramienta con el contrato del reto: valida los argumentos con zod,
 * devuelve siempre un string JSON `{ ok: true, resumen, data }` o `{ ok: false, error }` y nunca lanza.
 */
export function herramienta<Args extends z.ZodRawShape, Dato>(
  nombre: string,
  definicion: Definicion<Args, Dato>,
): Herramienta<Args> {
  const esquema = z.object(definicion.args)
  return {
    description: definicion.description,
    args: definicion.args,
    async execute(argumentos, ctx) {
      const mensaje_id = mensajeIdDe(argumentos)
      try {
        const validados = esquema.safeParse(argumentos)
        if (!validados.success) throw new ErrorProceso(`argumentos inválidos: ${describirErrorZod(validados.error)}`)
        const { data, resumen } = await definicion.run(validados.data, ctx)
        registrarEnLog(ctx, { herramienta: nombre, mensaje_id, ok: true, resumen })
        return JSON.stringify({ ok: true, resumen, data })
      } catch (error) {
        const texto = textoDeError(error)
        registrarEnLog(ctx, { herramienta: nombre, mensaje_id, ok: false, resumen: texto })
        return JSON.stringify({ ok: false, error: texto })
      }
    },
  }
}
