import { beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { leerMaestro } from "../src/dominio/maestro"
import type { Validacion } from "../src/dominio/validacion"
import { leerLineasJson, rutas } from "../src/lib/archivos"
import * as contratos from "../src/tools/contratos"
import { agregarMensaje, datos, ejecutar, proyectoTemporal } from "./ayudas"

let dir: string
beforeEach(() => {
  dir = proyectoTemporal()
})

const validar = async (id: string, contrato?: object) => datos<Omit<Validacion, "contrato" | "documento">>(await ejecutar(contratos.validar, { mensaje_id: id, contrato }, dir))

describe("clasificación de los 6 mensajes del buzón", () => {
  test("cada mensaje cae en la clasificación esperada del PRD", async () => {
    const esperado: Record<string, [string, string[]]> = {
      "msg-001": ["nuevo", []],
      "msg-002": ["nuevo", []],
      "msg-003": ["actualizacion", []],
      "msg-004": ["duplicado", []],
      "msg-005": ["rechazado", []],
      "msg-006": ["nuevo", ["valor", "fecha_fin"]],
    }
    for (const [id, [clasificacion, revision]] of Object.entries(esperado)) {
      const v = await validar(id)
      expect([id, v.clasificacion, v.requiere_revision]).toEqual([id, clasificacion, revision])
    }
  })

  test("un mismo NIT con objeto distinto no es actualización (Industrias Delta ya tiene CT-2025-018)", async () => {
    const v = await validar("msg-001")
    expect(v.clasificacion).toBe("nuevo")
    expect(v.motivo).toContain("CT-2025-018")
  })

  test("el remitente desconocido se reporta pero no bloquea", async () => {
    const v = await validar("msg-006")
    expect(v.remitente.conocido).toBe(false)
    expect(v.advertencias.join(" ")).toContain("jperez@periferia-ficticia.com")
  })

  test("leer_buzon marca la cotización como rechazada con motivo", async () => {
    const { mensajes } = datos<{ mensajes: { id: string; tiene_contrato: boolean; clasificacion?: string; motivo?: string }[] }>(await ejecutar(contratos.leer_buzon, {}, dir))
    const cotizacion = mensajes.find((m) => m.id === "msg-005")
    expect(cotizacion).toMatchObject({ tiene_contrato: false, clasificacion: "rechazado" })
    expect(cotizacion?.motivo).toContain("cotización")
  })
})

describe("registro", () => {
  test("RN5: sin confirmar no registra; con confirmado = true sí", async () => {
    const sinConfirmar = await ejecutar(contratos.registrar, { mensaje_id: "msg-006" }, dir)
    expect(sinConfirmar.ok).toBe(false)
    if (!sinConfirmar.ok) expect(sinConfirmar.error).toStartWith("requiere revisión: valor, fecha_fin")
    expect(leerMaestro(dir).some((f) => f.id_contrato === "CM-2026-03")).toBe(false)

    const confirmado = await ejecutar(contratos.registrar, { mensaje_id: "msg-006", confirmado: true }, dir)
    expect(confirmado.ok).toBe(true)
    const fila = leerMaestro(dir).find((f) => f.id_contrato === "CM-2026-03")
    expect(fila).toMatchObject({ valor: 0, fecha_fin: "2027-08-31", estado_poliza: "pendiente", comercial: "No registrado: jperez@periferia-ficticia.com" })
  })

  test("un valor propuesto distinto a la extracción exige confirmación aunque la extracción fuera segura", async () => {
    const v = await validar("msg-001", { valor: 999 })
    expect(v.requiere_revision).toEqual(["valor"])
    const r = await ejecutar(contratos.registrar, { mensaje_id: "msg-001", contrato: { valor: 999 } }, dir)
    expect(r.ok).toBe(false)
  })

  test("alta: fila, archivo en la carpeta del cliente, historial y procesados", async () => {
    await ejecutar(contratos.registrar, { mensaje_id: "msg-001" }, dir)
    const r = rutas(dir)
    const fila = leerMaestro(dir).find((f) => f.id_contrato === "CT-2026-015")
    expect(fila).toMatchObject({ estado_poliza: "pendiente", fuente: "buzon", comercial: "Laura Gómez Restrepo", ruta_sharepoint: "Contratos/2026/industrias-delta/CT-2026-015.txt" })
    expect(readFileSync(join(r.sharepoint, "Contratos", "2026", "industrias-delta", "CT-2026-015.txt"), "utf8")).toContain("CT-2026-015")
    expect(leerLineasJson(r.historial)).toHaveLength(1)
    expect(JSON.parse(readFileSync(r.procesados, "utf8"))["msg-001"].accion).toBe("alta")
  })

  test("otrosí: actualiza la fila, deja la póliza pendiente de ampliación y conserva antes/después", async () => {
    await ejecutar(contratos.registrar, { mensaje_id: "msg-003" }, dir)
    const fila = leerMaestro(dir).find((f) => f.id_contrato === "CT-2026-011")
    expect(fila).toMatchObject({ valor: 520_000, fecha_fin: "2027-11-01", estado_poliza: "pendiente", fecha_inicio: "2026-05-02" })
    const [linea] = leerLineasJson(rutas(dir).historial) as { cambios: Record<string, { antes: unknown; despues: unknown }> }[]
    expect(linea?.cambios.fecha_fin).toEqual({ antes: "2027-05-01", despues: "2027-11-01" })
  })

  test("duplicado y rechazado se cierran sin tocar el maestro", async () => {
    const antes = readFileSync(join(dir, "fixtures", "reto-02", "maestro-contratos.csv"), "utf8")
    for (const id of ["msg-004", "msg-005"]) expect((await ejecutar(contratos.registrar, { mensaje_id: id }, dir)).ok).toBe(true)
    expect(leerMaestro(dir)).toHaveLength(8)
    expect(leerLineasJson(rutas(dir).historial)).toHaveLength(0)
    expect(readFileSync(join(dir, "fixtures", "reto-02", "maestro-contratos.csv"), "utf8")).toBe(antes)
  })

  test("procesar dos veces el mismo mensaje no duplica filas", async () => {
    await ejecutar(contratos.registrar, { mensaje_id: "msg-002" }, dir)
    const segunda = await ejecutar(contratos.registrar, { mensaje_id: "msg-002" }, dir)
    expect(segunda.ok).toBe(false)
    expect(leerMaestro(dir).filter((f) => f.id_contrato === "CT-2026-016")).toHaveLength(1)
  })

  test("el otrosí reenviado después de aplicarse es duplicado", async () => {
    await ejecutar(contratos.registrar, { mensaje_id: "msg-003" }, dir)
    agregarMensaje(dir, "msg-103", { "otrosi.txt": readFileSync(join(dir, "fixtures", "reto-02", "buzon", "msg-003", "otrosi.txt"), "utf8") })
    expect((await validar("msg-103")).clasificacion).toBe("duplicado")
  })

  test("contrato sin número recibe AUTO-<año>-<secuencia>", async () => {
    const texto = readFileSync(join(dir, "fixtures", "reto-02", "buzon", "msg-002", "contrato.txt"), "utf8").replace(" No. CT-2026-016", "")
    agregarMensaje(dir, "msg-200", { "contrato.txt": texto })
    const r = datos<{ id_contrato: string }>(await ejecutar(contratos.registrar, { mensaje_id: "msg-200" }, dir))
    expect(r.id_contrato).toBe("AUTO-2026-001")
  })
})

describe("errores controlados (HU-6)", () => {
  test("adjunto vacío, mensaje inexistente, fecha inválida y moneda desconocida devuelven { ok: false }", async () => {
    agregarMensaje(dir, "msg-vacio", { "contrato.txt": "   " })
    const casos = [
      await ejecutar(contratos.extraer, { mensaje_id: "msg-vacio" }, dir),
      await ejecutar(contratos.extraer, { mensaje_id: "msg-999" }, dir),
      await ejecutar(contratos.validar, { mensaje_id: "msg-001", contrato: { fecha_inicio: "2026-13-01" } }, dir),
      await ejecutar(contratos.validar, { mensaje_id: "msg-001", contrato: { moneda: "EUR" } }, dir),
      await ejecutar(contratos.alertas, { hoy: "mañana" }, dir),
      await ejecutar(contratos.extraer, { mensaje_id: "../../" }, dir),
    ]
    for (const c of casos) expect(c.ok).toBe(false)
  })

  test("un contrato en EUR queda con moneda null y en revisión, no inventado", async () => {
    agregarMensaje(dir, "msg-eur", { "contrato.txt": "CONTRATO No. CT-2026-090\n\nEntre ACME S.A.S., identificada con NIT 900.555.111-2, con domicilio en Bogotá (EL CONTRATANTE), y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7.\n\nPRIMERA. OBJETO. Soporte.\n\nSEGUNDA. VALOR. El valor es de MIL EUROS (EUR 1.000)." })
    const v = await validar("msg-eur")
    expect(v.requiere_revision).toContain("moneda")
  })

  test("un otrosí de un contrato que no está en el maestro se rechaza con motivo", async () => {
    agregarMensaje(dir, "msg-otro", { "otrosi.txt": "OTROSÍ No. 2 AL CONTRATO No. CT-2019-001\n\nEntre ACME S.A.S., NIT 900.555.111-2 (EL CONTRATANTE), y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7.\n\nPRIMERA. Modificar la cláusula TERCERA (PLAZO): se extiende hasta el treinta (30) de junio de 2027." })
    const v = await validar("msg-otro")
    expect(v.clasificacion).toBe("rechazado")
    expect(v.motivo).toContain("CT-2019-001")
  })
})

describe("auditoría contra el PRD", () => {
  test("HU-6: un correo.json dañado o un PDF dañado no tumban leer_buzon ni alertas", async () => {
    const carpeta = join(dir, "fixtures", "reto-02", "buzon", "msg-roto")
    mkdirSync(carpeta, { recursive: true })
    writeFileSync(join(carpeta, "correo.json"), "{")
    agregarMensaje(dir, "msg-pdf", { "contrato.pdf": new Uint8Array([1, 2, 3, 4]) })
    const { mensajes } = datos<{ mensajes: { id: string; clasificacion?: string; motivo?: string }[] }>(await ejecutar(contratos.leer_buzon, {}, dir))
    expect(mensajes).toHaveLength(8)
    expect(mensajes.find((m) => m.id === "msg-roto")?.clasificacion).toBe("rechazado")
    expect(mensajes.find((m) => m.id === "msg-pdf")?.motivo).toContain("dañado")
    expect((await ejecutar(contratos.alertas, { hoy: "2026-09-03" }, dir)).ok).toBe(true)
  })

  test("RN2: un contrato sin número reenviado sin cambios es duplicado, no actualización", async () => {
    const texto = readFileSync(join(dir, "fixtures", "reto-02", "buzon", "msg-002", "contrato.txt"), "utf8").replace(" No. CT-2026-016", "")
    agregarMensaje(dir, "msg-200", { "contrato.txt": texto })
    await ejecutar(contratos.registrar, { mensaje_id: "msg-200" }, dir)
    agregarMensaje(dir, "msg-201", { "contrato.txt": texto })
    const v = await validar("msg-201")
    expect(v.clasificacion).toBe("duplicado")
    expect(v.id_contrato_existente).toBe("AUTO-2026-001")
  })
})

describe("alertas", () => {
  test("con hoy = 2026-09-03 y el buzón procesado", async () => {
    for (const id of ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005"]) await ejecutar(contratos.registrar, { mensaje_id: id }, dir)
    const a = datos<{ vencen: { id_contrato: string }[]; polizas_pendientes: { id_contrato: string }[]; registrados_desde_corte: { id_contrato: string }[]; pendientes_buzon: { mensaje_id: string }[] }>(
      await ejecutar(contratos.alertas, { hoy: "2026-09-03" }, dir),
    )
    expect(a.vencen.map((c) => c.id_contrato)).toEqual(["CT-2026-009", "CT-2026-004"])
    expect(a.polizas_pendientes.map((p) => p.id_contrato).sort()).toEqual(["CT-2026-004", "CT-2026-011", "CT-2026-015"])
    expect(a.registrados_desde_corte.map((r) => r.id_contrato)).toEqual(["CT-2026-015", "CT-2026-016", "CT-2026-011"])
    expect(a.pendientes_buzon.map((m) => m.mensaje_id)).toEqual(["msg-006"])
    expect(readFileSync(rutas(dir).alertas, "utf8")).toContain("## 3. Registrados o actualizados desde el corte")
  })
})
