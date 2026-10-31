import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as modulo from "../modulo/tools/contratos"
import { archivosDelModulo } from "../scripts/generar-modulo"
import * as app from "../src/tools/contratos"
import { RAIZ } from "./ayudas"

test("agent.md y SKILL.md del módulo están al día con agent/prompt.md y src/knowledge/ (si falla: bun run modulo)", () => {
  for (const [ruta, esperado] of Object.entries(archivosDelModulo(RAIZ))) {
    expect(readFileSync(join(RAIZ, ruta), "utf8")).toBe(esperado)
  }
})

test("las herramientas del módulo son exactamente las de la aplicación", () => {
  expect(Object.keys(modulo).sort()).toEqual(Object.keys(app).sort())
  for (const nombre of Object.keys(app) as (keyof typeof app)[]) expect(modulo[nombre]).toBe(app[nombre])
})
