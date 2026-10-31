// Genera modulo/agent.md y modulo/skill/registro-contratos/SKILL.md desde las fuentes que usa la aplicación:
// agent/prompt.md (comportamiento) y src/knowledge/registro-contratos.md (conocimiento).
// Uso: bun run modulo. La prueba tests/modulo.test.ts falla si el módulo quedó desactualizado.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const ENCABEZADO_AGENTE = `---
description: Registra contratos vigentes desde el buzón único (extrae, valida, archiva y alerta) y pide confirmación humana para los campos dudosos.
mode: primary
permission:
  edit: deny
  bash: deny
---`

const ENCABEZADO_SKILL = `---
name: registro-contratos
description: Proceso de registro de contratos vigentes de Periferia (reglas RN1-RN7, cálculo de confianza, campos del maestro, alertas y regla de gobierno). Úsala al procesar el buzón de contratos o al responder sobre vigencias y pólizas.
---`

export function archivosDelModulo(raiz: string): Record<string, string> {
  const prompt = readFileSync(join(raiz, "agent", "prompt.md"), "utf8").trim()
  const conocimiento = readFileSync(join(raiz, "src", "knowledge", "registro-contratos.md"), "utf8").trim()
  return {
    [join("modulo", "agent.md")]: `${ENCABEZADO_AGENTE}\n\n${prompt}\n`,
    [join("modulo", "skill", "registro-contratos", "SKILL.md")]: `${ENCABEZADO_SKILL}\n\n${conocimiento}\n`,
  }
}

if (import.meta.main) {
  const raiz = join(import.meta.dir, "..")
  for (const [ruta, contenido] of Object.entries(archivosDelModulo(raiz))) {
    mkdirSync(dirname(join(raiz, ruta)), { recursive: true })
    writeFileSync(join(raiz, ruta), contenido, "utf8")
    console.log(`escrito ${ruta}`)
  }
}
