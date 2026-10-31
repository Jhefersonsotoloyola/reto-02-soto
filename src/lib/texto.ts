/** Quita tildes y diéresis: "Río" → "Rio". */
export function sinTildes(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

/** Forma canónica para comparar: sin tildes, minúsculas y espacios simples. */
export function normalizar(texto: string): string {
  return sinTildes(texto).toLowerCase().replace(/\s+/g, " ").trim()
}

/** Corta en el último espacio antes de `max` caracteres y agrega "…" si hizo falta. */
export function recortar(texto: string, max: number): string {
  if (texto.length <= max) return texto
  const corte = texto.lastIndexOf(" ", max - 1)
  return `${texto.slice(0, corte > 0 ? corte : max - 1).replace(/[,;:.\s]+$/, "")}…`
}

/** Quita el sufijo societario del final: "Industrias Delta S.A.S." → "Industrias Delta". */
export function sinSufijoSocietario(razonSocial: string, sufijos: string[]): string {
  let nombre = razonSocial.trim()
  for (const sufijo of [...sufijos].sort((a, b) => b.length - a.length)) {
    if (normalizar(nombre).endsWith(` ${sufijo}`)) {
      nombre = nombre.slice(0, nombre.length - sufijo.length).trim()
      break
    }
  }
  return nombre.replace(/[,\s]+$/, "")
}

/** "Logística del Istmo S.A." → "logistica-del-istmo", igual que las carpetas del maestro. */
export function slug(razonSocial: string, sufijos: string[]): string {
  return normalizar(sinSufijoSocietario(razonSocial, sufijos))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

const CONECTORES = new Set(["de", "del", "la", "las", "los", "el", "y", "e"])

/** Convierte "MINERA LOS ANDES S.A.C." en "Minera los Andes S.A.C." cuando el texto no trae otra grafía. */
export function tituloRazonSocial(texto: string): string {
  return texto
    .toLowerCase()
    .split(" ")
    .map((palabra, i) => {
      if (palabra.includes(".")) return palabra.toUpperCase()
      if (i > 0 && CONECTORES.has(palabra)) return palabra
      return palabra.charAt(0).toUpperCase() + palabra.slice(1)
    })
    .join(" ")
}

function bigramas(texto: string): Map<string, number> {
  const limpio = normalizar(texto).replace(/[^a-z0-9 ]/g, "")
  const conteo = new Map<string, number>()
  for (let i = 0; i < limpio.length - 1; i++) {
    const par = limpio.slice(i, i + 2)
    conteo.set(par, (conteo.get(par) ?? 0) + 1)
  }
  return conteo
}

/** Coeficiente de Sørensen-Dice sobre bigramas de caracteres, en [0, 1]. */
export function similitud(a: string, b: string): number {
  const ba = bigramas(a)
  const bb = bigramas(b)
  const total = [...ba.values(), ...bb.values()].reduce((s, n) => s + n, 0)
  if (total === 0) return a === b ? 1 : 0
  let comunes = 0
  for (const [par, n] of ba) comunes += Math.min(n, bb.get(par) ?? 0)
  return (2 * comunes) / total
}
