import { z } from "zod"

const entero = (porDefecto: number) => z.coerce.number().int().positive().default(porDefecto)

const ConfigSchema = z.object({
  PORT: entero(3000),
  LLM_PROVIDER: z.enum(["anthropic"]).default("anthropic"),
  LLM_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  LLM_MAX_TOKENS: entero(16000),
  LLM_TIMEOUT_MS: entero(90_000),
  /** CA1: tope de iteraciones modelo → herramientas por turno. */
  MAX_ITERACIONES: entero(25),
  /** Tope de tokens (entrada + salida) por sesión, para que nadie gaste la clave sin límite. */
  MAX_TOKENS_SESION: entero(600_000),
  /** Tope de tokens de todo el proceso del servidor desde que arrancó. */
  MAX_TOKENS_SERVIDOR: entero(6_000_000),
  MAX_SESIONES: entero(200),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Si se define, el front la pide y la API la exige en el encabezado x-access-key. */
  ACCESS_KEY: z.string().optional(),
})

export type Config = z.infer<typeof ConfigSchema>

export function leerConfig(entorno: Record<string, string | undefined> = process.env): Config {
  const sinVacios = Object.fromEntries(Object.entries(entorno).filter(([, v]) => v !== undefined && v.trim() !== ""))
  return ConfigSchema.parse(sinVacios)
}
