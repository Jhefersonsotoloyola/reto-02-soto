import { normalizar } from "./texto"

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}
const PATRON_MES = Object.keys(MESES).join("|")

function dosDigitos(n: number): string {
  return String(n).padStart(2, "0")
}

export function ultimoDiaDelMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate()
}

/** Arma "YYYY-MM-DD" solo si la fecha existe en el calendario; "31 de febrero" → null. */
export function fechaIso(anio: number, mes: number, dia: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > ultimoDiaDelMes(anio, mes)) return null
  return `${anio}-${dosDigitos(mes)}-${dosDigitos(dia)}`
}

export function esFechaValida(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m !== null && fechaIso(Number(m[1]), Number(m[2]), Number(m[3])) === iso
}

function partes(iso: string): [number, number, number] {
  const [a, m, d] = iso.split("-").map(Number)
  return [a ?? 0, m ?? 0, d ?? 0]
}

/**
 * Suma meses con la regla de calendario: el plazo termina el mismo día del mes
 * correspondiente; si ese día no existe, el último día del mes (31-ene + 1 mes = 28/29-feb).
 */
export function sumarMeses(iso: string, meses: number): string {
  const [a, m, d] = partes(iso)
  const indice = a * 12 + (m - 1) + meses
  const anio = Math.floor(indice / 12)
  const mes = (indice % 12) + 1
  return fechaIso(anio, mes, Math.min(d, ultimoDiaDelMes(anio, mes))) ?? iso
}

export function sumarDias(iso: string, dias: number): string {
  const [a, m, d] = partes(iso)
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10)
}

/** Días calendario de `desde` a `hasta` (negativo si `hasta` es anterior). */
export function diasEntre(desde: string, hasta: string): number {
  const [a1, m1, d1] = partes(desde)
  const [a2, m2, d2] = partes(hasta)
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86_400_000)
}

/** Fecha local "YYYY-MM-DD" de un instante (por defecto, ahora). Los timestamps se guardan en UTC; las fechas de negocio, en hora local. */
export function hoyIso(instante: Date = new Date()): string {
  return `${instante.getFullYear()}-${dosDigitos(instante.getMonth() + 1)}-${dosDigitos(instante.getDate())}`
}

export function fechaDeTimestamp(ts: string): string {
  return hoyIso(new Date(ts))
}

export interface FechaEnTexto {
  /** null cuando el texto nombra una fecha que no existe (por ejemplo "30 de febrero"). */
  iso: string | null
  original: string
  indice: number
}

/** Encuentra fechas en letras con día numérico: "el quince (15) de agosto de 2026", "a los treinta (30) días del mes de julio de 2026". */
export function fechasEnTexto(texto: string): FechaEnTexto[] {
  const patron = new RegExp(
    `(?:\\((\\d{1,2})\\)|\\b(\\d{1,2}))\\s+(?:d[ií]as\\s+del\\s+mes\\s+)?de\\s+(${PATRON_MES})\\s+(?:de|del)\\s+(\\d{4})`,
    "gi",
  )
  const encontradas: FechaEnTexto[] = []
  for (const m of normalizar(texto).matchAll(patron)) {
    const dia = Number(m[1] ?? m[2])
    const mes = MESES[(m[3] ?? "").toLowerCase()] ?? 0
    encontradas.push({ iso: fechaIso(Number(m[4]), mes, dia), original: m[0], indice: m.index })
  }
  return encontradas
}

/** "en el mes de agosto de 2026" → { anio: 2026, mes: 8 }. Solo para textos que no dan el día. */
export function mesEnTexto(texto: string): { anio: number; mes: number; original: string } | null {
  const m = new RegExp(`mes de\\s+(${PATRON_MES})\\s+(?:de|del)\\s+(\\d{4})`, "i").exec(normalizar(texto))
  if (!m) return null
  return { anio: Number(m[2]), mes: MESES[(m[1] ?? "").toLowerCase()] ?? 0, original: m[0] }
}
