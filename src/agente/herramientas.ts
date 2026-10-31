import { z } from "zod"
import { describirErrorZod, type ContextoHerramienta, type Herramienta, registrarEnLog } from "../lib/herramienta"
import type { DefinicionHerramienta } from "../llm/adapter"

export interface HerramientaRegistrada {
  nombre: string
  definicion: DefinicionHerramienta
  ejecutar(argumentos: unknown, ctx: ContextoHerramienta): Promise<string>
}

/** JSON Schema para el modelo a partir de los argumentos zod (sin `$schema`, que la API no necesita). */
function esquemaJson(args: z.ZodRawShape): Record<string, unknown> {
  const { $schema: _omitido, ...esquema } = z.toJSONSchema(z.object(args))
  return esquema
}

/**
 * Registra las herramientas de uno o más archivos: cada export de `<archivo>.ts` se llama `<archivo>_<export>`.
 * Antes de ejecutar, valida los argumentos con zod y, si no cumplen, devuelve el error al modelo sin ejecutar.
 */
export function registrarHerramientas(modulos: Record<string, Record<string, Herramienta<z.ZodRawShape>>>): Map<string, HerramientaRegistrada> {
  const registro = new Map<string, HerramientaRegistrada>()
  for (const [archivo, exportaciones] of Object.entries(modulos)) {
    for (const [exportacion, herramienta] of Object.entries(exportaciones)) {
      const nombre = `${archivo}_${exportacion}`
      const esquema = z.object(herramienta.args)
      registro.set(nombre, {
        nombre,
        definicion: { nombre, descripcion: herramienta.description, esquema: esquemaJson(herramienta.args) },
        async ejecutar(argumentos, ctx) {
          const validados = esquema.safeParse(argumentos)
          if (validados.success) return herramienta.execute(validados.data, ctx)
          const error = `argumentos inválidos: ${describirErrorZod(validados.error)}`
          registrarEnLog(ctx, { herramienta: nombre, mensaje_id: null, ok: false, resumen: error })
          return JSON.stringify({ ok: false, error })
        },
      })
    }
  }
  return registro
}
