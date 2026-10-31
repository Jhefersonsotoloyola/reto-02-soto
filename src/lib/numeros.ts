import { normalizar } from "./texto"

const VALORES: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, primero: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28,
  veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70,
  ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200, doscientas: 200,
  trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600,
  setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900,
}

/**
 * Convierte un número escrito en letras a número: "DOSCIENTOS SESENTA Y CINCO MILLONES" → 265000000.
 * Devuelve null si encuentra una palabra que no es parte de un número.
 */
export function letrasANumero(texto: string): number | null {
  const palabras = normalizar(texto).split(/[\s-]+/).filter((p) => p && p !== "y")
  if (palabras.length === 0) return null
  let total = 0
  let grupo = 0
  for (const palabra of palabras) {
    const valor = VALORES[palabra]
    if (valor !== undefined) grupo += valor
    else if (palabra === "mil") {
      total += (grupo || 1) * 1000
      grupo = 0
    } else if (palabra === "millon" || palabra === "millones") {
      total = (total + (grupo || 1)) * 1_000_000
      grupo = 0
    } else return null
  }
  return total + grupo
}

/**
 * Lee un monto con separadores de cualquier convención:
 * "265.000.000" → 265000000, "120,000.00" → 120000, "1500,50" → 1500.5.
 */
export function parsearMonto(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, "")
  if (!/\d/.test(limpio)) return null
  const ultimoPunto = limpio.lastIndexOf(".")
  const ultimaComa = limpio.lastIndexOf(",")
  const posicion = Math.max(ultimoPunto, ultimaComa)
  let entero = limpio
  let decimales = ""
  if (posicion >= 0) {
    const separador = limpio.charAt(posicion)
    const cola = limpio.slice(posicion + 1)
    const usaAmbos = ultimoPunto >= 0 && ultimaComa >= 0
    const repetido = limpio.split(separador).length > 2
    if (usaAmbos || (!repetido && cola.length !== 3)) {
      entero = limpio.slice(0, posicion)
      decimales = cola
    }
  }
  const numero = Number(`${entero.replace(/[.,]/g, "")}${decimales ? `.${decimales}` : ""}`)
  return Number.isFinite(numero) ? numero : null
}
