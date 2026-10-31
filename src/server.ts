// Arranque: lee la configuración del entorno, crea el proveedor de modelo y sirve front + API en un solo puerto.
import { join } from "node:path"
import { crearApp } from "./app"
import { leerConfig } from "./agente/config"
import { ProveedorAnthropic } from "./llm/anthropic"

const config = leerConfig()
const proveedor = config.ANTHROPIC_API_KEY
  ? new ProveedorAnthropic({
      apiKey: config.ANTHROPIC_API_KEY,
      modelo: config.LLM_MODEL,
      maxTokens: config.LLM_MAX_TOKENS,
      timeoutMs: config.LLM_TIMEOUT_MS,
      esfuerzo: config.LLM_EFFORT,
    })
  : null

const app = crearApp({ raiz: join(import.meta.dir, ".."), config, proveedor })
// idleTimeout alto: un turno con varias llamadas al modelo puede pasar los 10 s por defecto de Bun.
const servidor = Bun.serve({ port: config.PORT, idleTimeout: 255, fetch: app.fetch })

console.log(`Registro de Contratos Vigentes en ${servidor.url}`)
console.log(`Modelo: ${config.LLM_PROVIDER}/${config.LLM_MODEL} · clave ${proveedor ? "configurada" : "NO configurada (el chat responderá 503)"}`)
