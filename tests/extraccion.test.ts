import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { extraerContrato } from "../src/dominio/extraccion"
import { parsearCsv, serializarCsv } from "../src/lib/csv"
import { diasEntre, fechasEnTexto, sumarDias, sumarMeses } from "../src/lib/fechas"
import { letrasANumero, parsearMonto } from "../src/lib/numeros"
import { similitud, slug } from "../src/lib/texto"
import { RAIZ } from "./ayudas"

const buzon = join(RAIZ, "fixtures", "reto-02", "buzon")
function contrato(id: string, archivo = "contrato.txt") {
  const correo = JSON.parse(readFileSync(join(buzon, id, "correo.json"), "utf8")) as { cuerpo: string }
  const tipo = archivo.startsWith("otrosi") ? "otrosi" : "contrato"
  return extraerContrato(readFileSync(join(buzon, id, archivo), "utf8"), tipo, correo.cuerpo)
}

describe("números y montos", () => {
  test("letras a número", () => {
    expect(letrasANumero("DOSCIENTOS SESENTA Y CINCO MILLONES")).toBe(265_000_000)
    expect(letrasANumero("CIENTO VEINTE MIL")).toBe(120_000)
    expect(letrasANumero("UN MILLÓN QUINIENTOS MIL")).toBe(1_500_000)
    expect(letrasANumero("DOS MIL QUINIENTOS MILLONES")).toBe(2_500_000_000)
    expect(letrasANumero("veintiún mil")).toBe(21_000)
    expect(letrasANumero("CIENTO VEINTE MANZANAS")).toBeNull()
  })

  test("montos con distintos separadores", () => {
    expect(parsearMonto("COP $265.000.000")).toBe(265_000_000)
    expect(parsearMonto("USD 120,000.00")).toBe(120_000)
    expect(parsearMonto("1.234.567,89")).toBe(1_234_567.89)
    expect(parsearMonto("1500,50")).toBe(1500.5)
    expect(parsearMonto("sin cifras")).toBeNull()
  })
})

describe("fechas", () => {
  test("suma de meses con regla de calendario", () => {
    expect(sumarMeses("2026-08-31", 12)).toBe("2027-08-31")
    expect(sumarMeses("2026-01-31", 1)).toBe("2026-02-28")
    expect(sumarDias(sumarMeses("2026-08-15", 12), -1)).toBe("2027-08-14")
    expect(diasEntre("2026-09-03", "2026-09-30")).toBe(27)
  })

  test("fechas en letras, y las que no existen quedan en null", () => {
    const [primera, segunda] = fechasEnTexto("desde el primero (1) de agosto de 2026 hasta el treinta (30) de febrero de 2027")
    expect(primera?.iso).toBe("2026-08-01")
    expect(segunda?.iso).toBeNull()
  })
})

describe("texto y CSV", () => {
  test("slug igual al de las carpetas del maestro", () => {
    const sufijos = ["s.a.s.", "s.a.", "s. de r.l."]
    expect(slug("Logística del Istmo S.A.", sufijos)).toBe("logistica-del-istmo")
    expect(slug("Agroexport Sula S. de R.L.", sufijos)).toBe("agroexport-sula")
  })

  test("similitud de objeto", () => {
    expect(similitud("Mesa de servicio TI nivel 1 y 2", "Mesa de servicio TI nivel 1 y 2")).toBe(1)
    expect(similitud("Soporte y mantenimiento plataforma SAP", "Implementación de la plataforma CRM")).toBeLessThan(0.6)
  })

  test("CSV con comas y comillas ida y vuelta", () => {
    const filas = [["a", "b, con coma", 'c "citado"'], ["1", "", "x\ny"]]
    expect(parsearCsv(serializarCsv(filas))).toEqual(filas)
  })
})

describe("extracción por fixture", () => {
  test("msg-001: contrato nuevo con póliza de cumplimiento", () => {
    const c = contrato("msg-001")
    expect(c).toMatchObject({
      id_contrato: "CT-2026-015", cliente: "Industrias Delta S.A.S.", nit_cliente: "890900111", pais: "CO",
      valor: 265_000_000, moneda: "COP", fecha_inicio: "2026-08-01", fecha_fin: "2027-07-31",
      requiere_poliza: true, tipo_poliza: "cumplimiento",
    })
    expect(Math.min(...Object.values(c.confianza))).toBeGreaterThanOrEqual(0.8)
  })

  test("msg-002: contrato sin póliza; el correo lo confirma", () => {
    const c = contrato("msg-002")
    expect(c).toMatchObject({ id_contrato: "CT-2026-016", nit_cliente: "1790012345001", pais: "EC", valor: 120_000, moneda: "USD", requiere_poliza: false, tipo_poliza: null })
    expect(c.fecha_fin).toBe("2027-08-14")
    expect(c.confianza.requiere_poliza).toBeGreaterThanOrEqual(0.85)
  })

  test("msg-003: otrosí con nuevo valor y nueva fecha fin", () => {
    const c = contrato("msg-003", "otrosi.txt")
    expect(c).toMatchObject({ tipo_documento: "otrosi", numero_otrosi: 1, id_contrato: "CT-2026-011", nit_cliente: "20512345678", pais: "PE", valor: 520_000, moneda: "PEN", fecha_fin: "2027-11-01" })
    expect(c.fecha_inicio).toBeNull()
  })

  test("msg-006: valor por demanda y plazo en meses quedan con baja confianza", () => {
    const c = contrato("msg-006")
    expect(c).toMatchObject({ id_contrato: "CM-2026-03", cliente: "Distribuidora Caribe S.A.S.", valor: 0, valor_indeterminado: true, moneda: "COP", fecha_fin: "2027-08-31", requiere_poliza: true })
    expect(c.confianza.valor).toBeLessThan(0.8)
    expect(c.confianza.fecha_fin).toBeLessThan(0.8)
    expect(c.notas.some((n) => n.startsWith("fecha_fin:"))).toBe(true)
  })

  test("campos ausentes son null con confianza 0", () => {
    const c = extraerContrato("CONTRATO DE PRESTACIÓN DE SERVICIOS\n\nPRIMERA. OBJETO. Soporte técnico.", "contrato", "")
    expect(c.id_contrato).toBeNull()
    expect(c.valor).toBeNull()
    expect(c.confianza.valor).toBe(0)
    expect(c.objeto).toBe("Soporte técnico")
  })

  test("valor en letras distinto al número baja la confianza", () => {
    const texto = "CONTRATO No. CT-2026-099\n\nSEGUNDA. VALOR. El valor total es de CIEN MILLONES DE PESOS M/CTE (COP $150.000.000)."
    const c = extraerContrato(texto, "contrato", "")
    expect(c.valor).toBe(150_000_000)
    expect(c.confianza.valor).toBe(0.5)
  })
})
