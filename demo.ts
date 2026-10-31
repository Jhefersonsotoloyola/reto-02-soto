// Verificación sin modelo de lenguaje: procesa el buzón llamando directamente a las herramientas.
// Uso: bun run demo.ts
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { leerMaestro } from "./src/dominio/maestro"
import { leerLineasJson, rutas } from "./src/lib/archivos"
import type { ContextoHerramienta } from "./src/lib/herramienta"
import { leerRespuesta, type RespuestaHerramienta } from "./src/lib/respuesta"
import * as contratos from "./src/tools/contratos"

const HOY = "2026-09-03"
const ctx: ContextoHerramienta = { directory: import.meta.dir, sessionId: "demo" }
const r = rutas(ctx.directory)

const gris = (t: string) => `\x1b[90m${t}\x1b[0m`
const verde = (t: string) => `\x1b[32m${t}\x1b[0m`
const rojo = (t: string) => `\x1b[31m${t}\x1b[0m`
const amarillo = (t: string) => `\x1b[33m${t}\x1b[0m`
const negrita = (t: string) => `\x1b[1m${t}\x1b[0m`

async function llamar(nombre: keyof typeof contratos, args: unknown): Promise<RespuestaHerramienta> {
  const respuesta = leerRespuesta(await contratos[nombre].execute(args, ctx))
  const etiqueta = gris(`   ${nombre.padEnd(10)}`)
  console.log(respuesta.ok ? `${etiqueta} ${respuesta.resumen}` : `${etiqueta} ${amarillo(`✗ ${respuesta.error}`)}`)
  return respuesta
}

function titulo(texto: string): void {
  console.log(`\n${negrita(texto)}`)
}

// Determinismo: out/ se limpia al inicio; el fixture nunca se toca (RN6).
rmSync(r.out, { recursive: true, force: true })

titulo(`1. Buzón (fecha de referencia ${HOY})`)
const buzon = await llamar("leer_buzon", {})
const ListaBuzon = z.object({ mensajes: z.array(z.object({ id: z.string(), asunto: z.string() })) })
const ids = buzon.ok ? ListaBuzon.parse(buzon.data).mensajes : []

titulo("2. Primera pasada: extraer → validar → registrar, sin confirmar nada")
const sinRegistrar: string[] = []
for (const { id, asunto } of ids) {
  console.log(`\n ${negrita(id)} ${gris(asunto)}`)
  await llamar("extraer", { mensaje_id: id })
  await llamar("validar", { mensaje_id: id })
  const registro = await llamar("registrar", { mensaje_id: id })
  if (!registro.ok) sinRegistrar.push(id)
}

titulo("3. Segunda pasada: la analista confirma \"valor 0 y fecha fin 2027-08-31\" para msg-006")
await llamar("registrar", { mensaje_id: "msg-006", contrato: { valor: 0, fecha_fin: "2027-08-31" }, confirmado: true })

titulo(`4. Alertas con hoy = ${HOY}`)
await llamar("alertas", { hoy: HOY })
console.log(gris(readFileSync(r.alertas, "utf8").replace(/^/gm, "   │ ")))

titulo("5. Errores controlados (HU-6): cada uno devuelve { ok: false } y la demo sigue")
await llamar("extraer", { mensaje_id: "msg-999" })
await llamar("extraer", { mensaje_id: "../../etc" })
await llamar("validar", { mensaje_id: "msg-001", contrato: { fecha_fin: "2027-02-30" } })
await llamar("validar", { mensaje_id: "msg-001", contrato: { moneda: "EUR" } })
await llamar("alertas", { hoy: "03/09/2026" })
await llamar("registrar", { mensaje_id: "msg-001" })
await llamar("leer_pdf", { ruta: "../secreto.pdf" })

titulo("6. Verificación de objetivos")
const maestro = leerMaestro(ctx.directory)
const idsMaestro = maestro.map((f) => f.id_contrato)
const historial = leerLineasJson(r.historial)
const procesados = existsSync(r.procesados) ? Object.keys(JSON.parse(readFileSync(r.procesados, "utf8")) as object) : []
const minera = maestro.find((f) => f.id_contrato === "CT-2026-011")
const caribe = maestro.find((f) => f.id_contrato === "CM-2026-03")
const chequeos: [string, boolean][] = [
  ["O1 · los 6 mensajes quedaron clasificados y cerrados en out/procesados.json", procesados.length === 6],
  ["O1 · CT-2026-015 (con póliza) y CT-2026-016 (sin póliza) están en el maestro", idsMaestro.includes("CT-2026-015") && idsMaestro.includes("CT-2026-016")],
  ["O2 · cero filas duplicadas en el maestro", new Set(idsMaestro).size === idsMaestro.length],
  ["O2 · el otrosí actualizó CT-2026-011 (fin 2027-11-01, PEN 520000) y dejó historial", minera?.fecha_fin === "2027-11-01" && minera.valor === 520000 && historial.length === 4],
  ["O2 · el fixture maestro-contratos.csv sigue intacto (8 contratos)", readFileSync(r.maestroFixture, "utf8").trim().split("\n").length === 9],
  ["O3 · msg-006 quedó sin registrar en la primera pasada", sinRegistrar.length === 1 && sinRegistrar[0] === "msg-006"],
  ["O3 · tras confirmar, CM-2026-03 quedó con valor 0 y fin 2027-08-31", caribe?.valor === 0 && caribe.fecha_fin === "2027-08-31"],
  ["O4 · out/alertas.md tiene las tres secciones", (readFileSync(r.alertas, "utf8").match(/^## \d\./gm) ?? []).length === 3],
  ["RN7 · out/log.jsonl registra cada llamada", leerLineasJson(r.log).length >= 20],
]
for (const [texto, ok] of chequeos) console.log(`   ${ok ? verde("✔") : rojo("✘")} ${texto}`)
console.log(gris(`\n   Archivos generados en ${join("out")}/: procesados.json, log.jsonl, alertas.md, sharepoint/`))
if (chequeos.some(([, ok]) => !ok)) process.exit(1)
