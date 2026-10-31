import { z } from "zod"

/** Forma del string que devuelve toda herramienta, para leerlo sin confiar en `JSON.parse`. */
export const RespuestaHerramientaSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), resumen: z.string(), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type RespuestaHerramienta = z.infer<typeof RespuestaHerramientaSchema>

export function leerRespuesta(texto: string): RespuestaHerramienta {
  const crudo: unknown = JSON.parse(texto)
  return RespuestaHerramientaSchema.parse(crudo)
}
