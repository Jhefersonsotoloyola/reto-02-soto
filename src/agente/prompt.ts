import { readFileSync } from "node:fs"
import { join } from "node:path"
import { hoyIso } from "../lib/fechas"

/**
 * Prompt de sistema = comportamiento (agent/prompt.md) + conocimiento del proceso (src/knowledge/).
 * Se lee al abrir cada sesión: editar esos archivos cambia el agente sin reiniciar el servidor.
 */
export function cargarPromptSistema(directory: string, fecha: string = hoyIso()): string {
  const comportamiento = readFileSync(join(directory, "agent", "prompt.md"), "utf8").trim()
  const conocimiento = readFileSync(join(directory, "src", "knowledge", "registro-contratos.md"), "utf8").trim()
  return [
    comportamiento,
    `<conocimiento_del_proceso>\n${conocimiento}\n</conocimiento_del_proceso>`,
    `Fecha del servidor al abrir esta sesión: ${fecha}.`,
  ].join("\n\n")
}
