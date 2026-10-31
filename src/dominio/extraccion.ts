import { fechaIso, fechasEnTexto, mesEnTexto, sumarDias, sumarMeses, ultimoDiaDelMes } from "../lib/fechas"
import { letrasANumero, parsearMonto } from "../lib/numeros"
import { reglas } from "../lib/reglas"
import { normalizar, recortar, tituloRazonSocial } from "../lib/texto"
import { CAMPOS_EXTRAIDOS, type CampoExtraido, type Contrato, MONEDAS, type Moneda, type Pais } from "./tipos"

/** Un campo extraído: valor, confianza en [0, 1] y el fragmento de texto que lo sustenta. */
interface Hallazgo<T> {
  valor: T | null
  confianza: number
  evidencia?: string
  nota?: string
}

const NADA: Hallazgo<never> = { valor: null, confianza: 0 }

interface Clausula {
  titulo: string | null
  cuerpo: string
}

const ORDINALES = "PRIMERA|SEGUNDA|TERCERA|CUARTA|QUINTA|SEXTA|S[ÉE]PTIMA|OCTAVA|NOVENA|D[ÉE]CIMA(?: [A-ZÁÉÍÓÚ]+)?"

/** Separa el texto en párrafos; también corta antes de cada "PRIMERA.", "SEGUNDA."… por si el PDF perdió los saltos de línea. */
function parrafos(texto: string): string[] {
  return texto
    .replace(new RegExp(`\\s(?=(?:${ORDINALES})\\.\\s)`, "g"), "\n\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p !== "")
}

function clausulas(texto: string): Clausula[] {
  const encabezado = new RegExp(`^(?:${ORDINALES})\\.\\s*(?:([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ,]+)\\.\\s*)?(.*)$`)
  return parrafos(texto).flatMap((p) => {
    const m = encabezado.exec(p)
    return m ? [{ titulo: m[1] ? normalizar(m[1]) : null, cuerpo: m[2] ?? "" }] : []
  })
}

/** Cláusula por título ("VALOR", "PLAZO"…) o, en un otrosí, la que modifica esa cláusula ("cláusula SEGUNDA (VALOR)"). */
function buscarClausula(lista: Clausula[], titulo: RegExp): Clausula | undefined {
  return (
    lista.find((c) => c.titulo !== null && titulo.test(c.titulo)) ??
    lista.find((c) => c.titulo === null && new RegExp(`\\(${titulo.source.replace(/^\^/, "")}[a-z]*\\)`).test(normalizar(c.cuerpo)))
  )
}

function fragmento(texto: string): string {
  return recortar(texto.replace(/\s+/g, " ").trim(), 180)
}

// ---------- Número de contrato ----------

function extraerId(encabezado: string): Hallazgo<string> {
  const conPatron = /\b([A-Z]{1,5}-\d{4}-\d{1,4})\b/.exec(encabezado)
  if (conPatron?.[1]) return { valor: conPatron[1], confianza: 0.98, evidencia: fragmento(encabezado) }
  const numeros = [...encabezado.matchAll(/No\.?\s*([A-Z0-9][A-Z0-9\-/]{2,})/g)].map((m) => m[1] ?? "")
  const ultimo = numeros.at(-1)
  return ultimo ? { valor: ultimo, confianza: 0.85, evidencia: fragmento(encabezado) } : NADA
}

// ---------- Partes ----------

interface Parte {
  nombre: string
  etiqueta: string
  id: string
  /** Texto entre esta parte y la siguiente: domicilio, representante, rol. */
  tramo: string
}

function idSinFormato(crudo: string, etiqueta: string): string {
  const limpio = crudo.replace(/[.\s]/g, "")
  return etiqueta === "NIT" ? limpio.replace(/-\d$/, "") : limpio
}

function partes(preambulo: string): Parte[] {
  const patron = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9&.\- ]{2,}?),\s*(?:identificad[ao]\s+con\s+)?(NIT|RUC|RTN)\s*(?:No\.?\s*)?(\d[\d.\- ]*\d)/g
  const encontradas = [...preambulo.matchAll(patron)]
  return encontradas.map((m, i) => {
    const fin = m.index + m[0].length
    const siguiente = encontradas[i + 1]?.index ?? preambulo.length
    const etiqueta = m[2] ?? ""
    return { nombre: (m[1] ?? "").trim(), etiqueta, id: idSinFormato(m[3] ?? "", etiqueta), tramo: preambulo.slice(fin, siguiente) }
  })
}

function esPropia(parte: Parte): boolean {
  const propia = reglas.empresa_propia
  return parte.id === propia.identificador || normalizar(parte.nombre) === normalizar(propia.razon_social)
}

/** La razón social suele repetirse en el bloque de firmas con mayúsculas y minúsculas; se prefiere esa grafía. */
function grafiaLegible(texto: string, nombreMayusculas: string): string {
  const buscado = normalizar(nombreMayusculas)
  for (const linea of texto.split("\n")) {
    for (const celda of linea.split(/\s{2,}/)) {
      const candidata = celda.trim()
      if (normalizar(candidata) === buscado && candidata !== candidata.toUpperCase()) return candidata
    }
  }
  return tituloRazonSocial(nombreMayusculas)
}

function elegirContraparte(lista: Parte[]): { parte: Parte; confianza: number } | null {
  const otras = lista.filter((p) => !esPropia(p))
  const contratantes = otras.filter((p) => /CONTRATANTE/.test(p.tramo))
  if (otras.length === 1 && otras[0]) return { parte: otras[0], confianza: contratantes.length === 1 ? 0.95 : 0.85 }
  if (contratantes.length === 1 && contratantes[0]) return { parte: contratantes[0], confianza: 0.7 }
  return otras[0] ? { parte: otras[0], confianza: 0.5 } : null
}

function inferirPais(parte: Parte): Hallazgo<Pais> {
  const porId = reglas.identificadores.find((r) => r.etiqueta === parte.etiqueta && new RegExp(r.patron).test(parte.id))?.pais
  const tramo = normalizar(parte.tramo)
  const porLugar = (Object.entries(reglas.lugares_por_pais) as [Pais, string[]][]).find(([, lugares]) =>
    lugares.some((lugar) => new RegExp(`\\b${lugar}\\b`).test(tramo)),
  )?.[0]
  const evidencia = `${parte.etiqueta} ${parte.id}${porLugar ? `, domicilio en ${porLugar}` : ""}`
  if (porId && porLugar) {
    return porId === porLugar
      ? { valor: porId, confianza: 0.98, evidencia }
      : { valor: porId, confianza: 0.6, evidencia, nota: `el identificador sugiere ${porId} pero el domicilio sugiere ${porLugar}` }
  }
  const unico = porId ?? porLugar
  return unico ? { valor: unico, confianza: 0.85, evidencia } : NADA
}

// ---------- Objeto ----------

function extraerObjeto(lista: Clausula[]): Hallazgo<string> {
  const clausula = buscarClausula(lista, /^objeto/)
  if (!clausula) return NADA
  const limpio = clausula.cuerpo
    .replace(/^EL CONTRATISTA\s+/i, "")
    .replace(/^se (obliga|compromete) a\s+/i, "")
    .replace(/^(ejecutar|prestar[áa]?|realizar|desarrollar)\s+/i, "")
    .replace(/^(el|la|los|las)\s+/i, "")
    .replace(/\.$/, "")
  if (limpio === "") return NADA
  const objeto = limpio.charAt(0).toUpperCase() + limpio.slice(1)
  return { valor: recortar(objeto, 200), confianza: 0.9, evidencia: fragmento(clausula.cuerpo) }
}

// ---------- Valor y moneda ----------

function monedaPorPalabra(palabra: string): Moneda | null {
  const buscada = normalizar(palabra)
  const entrada = (Object.entries(reglas.palabras_moneda) as [Moneda, string[]][]).find(([, palabras]) => palabras.includes(buscada))
  return entrada?.[0] ?? null
}

interface ValorExtraido {
  valor: Hallazgo<number>
  indeterminado: boolean
  moneda: Hallazgo<Moneda>
}

function monedaDelTexto(texto: string, pais: Pais | null): Hallazgo<Moneda> {
  const porPais = pais ? reglas.moneda_por_pais[pais] : null
  const codigo = new RegExp(`\\b(${MONEDAS.join("|")})\\b`).exec(texto)?.[1] as Moneda | undefined
  const evidencia = codigo ? `el texto menciona ${codigo}` : undefined
  if (codigo && porPais) return codigo === porPais ? { valor: codigo, confianza: 0.85, evidencia } : { valor: codigo, confianza: 0.6, evidencia }
  if (codigo) return { valor: codigo, confianza: 0.7, evidencia }
  if (porPais) return { valor: porPais, confianza: 0.7, evidencia: `moneda habitual de ${pais}`, nota: "moneda inferida del país" }
  return NADA
}

function extraerValor(lista: Clausula[], texto: string, pais: Pais | null): ValorExtraido {
  const clausula = buscarClausula(lista, /^valor/)
  if (!clausula) return { valor: NADA, indeterminado: false, moneda: NADA }
  const cuerpo = clausula.cuerpo
  const evidencia = fragmento(cuerpo)
  if (reglas.patrones_valor_indeterminado.some((p) => normalizar(cuerpo).includes(p))) {
    return {
      valor: { valor: 0, confianza: 0.6, evidencia, nota: "contrato sin valor determinado: se registra 0 (por demanda)" },
      indeterminado: true,
      moneda: monedaDelTexto(texto, pais),
    }
  }
  const letras = /(?:es|ser[áa]) de\s+([A-ZÁÉÍÓÚÑ ]+?)\s+(?:DE\s+)?(PESOS|D[ÓO]LARES|SOLES|LEMPIRAS|BALBOAS)\b/.exec(cuerpo)
  const cifra = /\(([^)]*\d[^)]*)\)/.exec(cuerpo.slice(letras?.index ?? 0))?.[1] ?? null
  const numero = cifra ? parsearMonto(cifra) : null
  const enLetras = letras?.[1] ? letrasANumero(letras[1]) : null

  const codigo = cifra ? /\b([A-Z]{3})\b/.exec(cifra)?.[1] ?? null : null
  const porPalabra = letras?.[2] ? monedaPorPalabra(letras[2]) : null
  return { valor: hallazgoValor(numero, enLetras, evidencia), indeterminado: false, moneda: hallazgoMoneda(codigo, porPalabra, evidencia) }
}

function hallazgoValor(numero: number | null, enLetras: number | null, evidencia: string): Hallazgo<number> {
  if (numero !== null && enLetras !== null) {
    return numero === enLetras
      ? { valor: numero, confianza: 0.98, evidencia }
      : { valor: numero, confianza: 0.5, evidencia, nota: `el valor en números (${numero}) no coincide con el valor en letras (${enLetras})` }
  }
  if (numero !== null) return { valor: numero, confianza: 0.85, evidencia }
  if (enLetras !== null) return { valor: enLetras, confianza: 0.7, evidencia, nota: "valor solo en letras" }
  return NADA
}

function hallazgoMoneda(codigo: string | null, porPalabra: Moneda | null, evidencia: string): Hallazgo<Moneda> {
  if (codigo && !(MONEDAS as readonly string[]).includes(codigo)) {
    return { valor: null, confianza: 0, evidencia, nota: `moneda no soportada: ${codigo}` }
  }
  const porCodigo = codigo as Moneda | null
  if (porCodigo && porPalabra) {
    return porCodigo === porPalabra
      ? { valor: porCodigo, confianza: 0.98, evidencia }
      : { valor: porCodigo, confianza: 0.5, evidencia, nota: `la moneda en código (${porCodigo}) no coincide con la escrita (${porPalabra})` }
  }
  const unica = porCodigo ?? porPalabra
  return unica ? { valor: unica, confianza: 0.9, evidencia } : NADA
}

// ---------- Firma y plazo ----------

function extraerFirma(texto: string): Hallazgo<string> {
  const parrafo = parrafos(texto).findLast((p) => /\bse firma\b|\bfirmado en\b/.test(normalizar(p)))
  if (!parrafo) return NADA
  const fecha = fechasEnTexto(parrafo)[0]
  if (fecha?.iso) return { valor: fecha.iso, confianza: 0.95, evidencia: fragmento(parrafo) }
  const mes = mesEnTexto(parrafo)
  if (mes) {
    const iso = fechaIso(mes.anio, mes.mes, ultimoDiaDelMes(mes.anio, mes.mes))
    return { valor: iso, confianza: 0.8, evidencia: fragmento(parrafo), nota: "la firma no indica el día: se toma el último día del mes" }
  }
  return NADA
}

interface Plazo {
  inicio: Hallazgo<string>
  fin: Hallazgo<string>
  meses: number | null
}

function primeraFechaDespues(texto: string, palabra: string, antesDe = Number.POSITIVE_INFINITY) {
  const posicion = normalizar(texto).indexOf(palabra)
  if (posicion < 0) return undefined
  return fechasEnTexto(texto).find((f) => f.indice > posicion && f.indice < antesDe)
}

function extraerPlazo(lista: Clausula[], firma: Hallazgo<string>): Plazo {
  const clausula = buscarClausula(lista, /^(plazo|duracion|vigencia)/)
  if (!clausula) return { inicio: NADA, fin: NADA, meses: null }
  const cuerpo = clausula.cuerpo
  const evidencia = fragmento(cuerpo)
  const normal = normalizar(cuerpo)
  const meses = Number(/\((\d{1,3})\)\s+mes(?:es)?\b/.exec(normal)?.[1] ?? /\b(\d{1,3})\s+mes(?:es)?\b/.exec(normal)?.[1] ?? NaN)
  const plazoMeses = Number.isFinite(meses) ? meses : null
  const posicionHasta = normal.indexOf("hasta")
  const desde = primeraFechaDespues(cuerpo, "desde", posicionHasta >= 0 ? posicionHasta : undefined)
  const hasta = primeraFechaDespues(cuerpo, "hasta")
  const invalida = fechasEnTexto(cuerpo).find((f) => f.iso === null)
  const notaInvalida = invalida ? `el texto trae una fecha que no existe: "${invalida.original}"` : undefined

  if (desde?.iso && hasta?.iso) {
    if (plazoMeses === null) return { inicio: { valor: desde.iso, confianza: 0.95, evidencia }, fin: { valor: hasta.iso, confianza: 0.95, evidencia }, meses: null }
    const coherente = [sumarMeses(desde.iso, plazoMeses), sumarDias(sumarMeses(desde.iso, plazoMeses), -1)].includes(hasta.iso)
    const confianza = coherente ? 0.98 : 0.7
    const nota = coherente ? undefined : `las fechas no coinciden con el plazo de ${plazoMeses} meses`
    return { inicio: { valor: desde.iso, confianza, evidencia, nota }, fin: { valor: hasta.iso, confianza, evidencia, nota }, meses: plazoMeses }
  }
  const inicio: Hallazgo<string> = desde?.iso
    ? { valor: desde.iso, confianza: 0.95, evidencia }
    : /a partir de la (fecha de (su )?)?(firma|suscripcion)/.test(normal)
      ? { ...firma, nota: [firma.nota, "el plazo corre desde la firma"].filter(Boolean).join("; ") }
      : { ...NADA, nota: notaInvalida }
  if (hasta?.iso) return { inicio, fin: { valor: hasta.iso, confianza: 0.9, evidencia }, meses: plazoMeses }
  if (inicio.valor && plazoMeses !== null) {
    const prorroga = /prorroga/.test(normal) ? "; tiene prórroga automática" : ""
    return {
      inicio,
      fin: { valor: sumarMeses(inicio.valor, plazoMeses), confianza: 0.6, evidencia, nota: `fecha_fin derivada: ${plazoMeses} meses desde ${inicio.valor}${prorroga}` },
      meses: plazoMeses,
    }
  }
  return { inicio, fin: { ...NADA, nota: notaInvalida }, meses: plazoMeses }
}

// ---------- Póliza ----------

interface PolizaExtraida {
  requiere: Hallazgo<boolean>
  tipo: Hallazgo<string>
}

/** Qué dice el correo del comercial sobre la póliza: true, false o null si no lo menciona. */
function polizaSegunCorreo(cuerpoCorreo: string): boolean | null {
  const texto = normalizar(cuerpoCorreo)
  if (/\b(no (pide|requiere|exige|lleva|necesita)|sin) poliza/.test(texto)) return false
  if (/\b(requiere|pide|exige|lleva|necesita) poliza/.test(texto)) return true
  return null
}

function extraerPoliza(lista: Clausula[], texto: string, cuerpoCorreo: string): PolizaExtraida {
  const clausula = buscarClausula(lista, /^(garantias?|polizas?|seguros)/)
  const fuente = clausula?.cuerpo ?? parrafos(texto).find((p) => /poliza/.test(normalizar(p))) ?? ""
  const normal = normalizar(fuente)
  const exige = /poliza|garantia/.test(normal) && /constitu|tomar|expedir|otorgar|presentar/.test(normal)
  let requiere: Hallazgo<boolean>
  if (exige) {
    const condicional = /para cada|cuyo valor supere|cuando el valor|siempre que/.test(normal)
    requiere = condicional
      ? { valor: true, confianza: 0.85, evidencia: fragmento(fuente), nota: "póliza condicionada: solo para ciertas órdenes de servicio" }
      : { valor: true, confianza: 0.95, evidencia: fragmento(fuente) }
  } else {
    requiere = { valor: false, confianza: 0.85, evidencia: "el contrato no tiene cláusula de garantías ni menciona pólizas" }
  }
  const segunCorreo = polizaSegunCorreo(cuerpoCorreo)
  if (segunCorreo !== null && segunCorreo !== requiere.valor) {
    requiere = { ...requiere, confianza: 0.6, nota: `el correo del comercial dice que ${segunCorreo ? "sí" : "no"} requiere póliza` }
  } else if (segunCorreo !== null) {
    requiere = { ...requiere, confianza: Math.min(0.99, requiere.confianza + 0.05) }
  }

  if (!requiere.valor) return { requiere, tipo: { valor: null, confianza: requiere.confianza } }
  const tipos = Object.entries(reglas.tipos_poliza)
    .filter(([, claves]) => claves.some((clave) => normal.includes(clave)))
    .map(([tipo]) => tipo)
  const tipo: Hallazgo<string> = tipos.length
    ? { valor: tipos.join(";"), confianza: requiere.confianza, evidencia: requiere.evidencia }
    : { valor: null, confianza: 0.5, nota: "exige póliza pero no dice de qué tipo" }
  return { requiere, tipo }
}

// ---------- Ensamble ----------

/** Un otrosí solo cambia algunos campos; el resto queda como está en el maestro y no cuenta como "baja confianza". */
const NO_APLICAN_EN_OTROSI: CampoExtraido[] = ["objeto", "fecha_inicio", "requiere_poliza", "tipo_poliza"]

export function camposAplicables(contrato: Contrato): CampoExtraido[] {
  return CAMPOS_EXTRAIDOS.filter((c) => contrato.tipo_documento === "contrato" || !NO_APLICAN_EN_OTROSI.includes(c))
}

/**
 * Extracción determinista de un contrato u otrosí a partir de su texto.
 * Un campo que el texto no trae queda en null con confianza 0: nunca se inventa.
 */
export function extraerContrato(texto: string, tipo: "contrato" | "otrosi", cuerpoCorreo: string): Contrato {
  const lista = clausulas(texto)
  const encabezado = texto.split("\n").find((l) => l.trim() !== "") ?? ""
  const preambulo = parrafos(texto).find((p) => /^entre\b/i.test(p)) ?? ""
  const contraparte = elegirContraparte(partes(preambulo))
  const esOtrosi = tipo === "otrosi"

  const id = extraerId(encabezado)
  const cliente: Hallazgo<string> = contraparte
    ? { valor: grafiaLegible(texto, contraparte.parte.nombre), confianza: contraparte.confianza, evidencia: fragmento(contraparte.parte.nombre) }
    : NADA
  const nit: Hallazgo<string> = contraparte
    ? { valor: contraparte.parte.id, confianza: contraparte.confianza, evidencia: `${contraparte.parte.etiqueta} ${contraparte.parte.id}` }
    : NADA
  const pais = contraparte ? inferirPais(contraparte.parte) : NADA
  const objeto = esOtrosi ? NADA : extraerObjeto(lista)
  const valor = extraerValor(lista, texto, pais.valor)
  const firma = extraerFirma(texto)
  const plazo = extraerPlazo(lista, firma)
  const poliza: PolizaExtraida = esOtrosi ? { requiere: NADA, tipo: NADA } : extraerPoliza(lista, texto, cuerpoCorreo)

  const hallazgos: Record<CampoExtraido, Hallazgo<unknown>> = {
    id_contrato: id, cliente, nit_cliente: nit, pais, objeto, valor: valor.valor, moneda: valor.moneda,
    fecha_inicio: esOtrosi ? NADA : plazo.inicio, fecha_fin: plazo.fin, requiere_poliza: poliza.requiere, tipo_poliza: poliza.tipo,
  }
  const confianza = Object.fromEntries(CAMPOS_EXTRAIDOS.map((c) => [c, hallazgos[c].confianza])) as Record<CampoExtraido, number>
  const evidencia: Partial<Record<CampoExtraido, string>> = {}
  for (const campo of CAMPOS_EXTRAIDOS) {
    const fuente = hallazgos[campo].evidencia
    if (fuente) evidencia[campo] = fuente
  }
  const notas = CAMPOS_EXTRAIDOS.flatMap((c) => (hallazgos[c].nota ? [`${c}: ${hallazgos[c].nota}`] : []))

  return {
    tipo_documento: tipo,
    numero_otrosi: esOtrosi ? Number(/OTROS[IÍ]\s+No\.?\s*(\d+)/i.exec(encabezado)?.[1] ?? 1) : null,
    id_contrato: id.valor,
    cliente: cliente.valor,
    nit_cliente: nit.valor,
    pais: pais.valor,
    objeto: objeto.valor,
    valor: valor.valor.valor,
    valor_indeterminado: valor.indeterminado,
    moneda: valor.moneda.valor,
    fecha_inicio: esOtrosi ? null : plazo.inicio.valor,
    fecha_fin: plazo.fin.valor,
    plazo_meses: plazo.meses,
    fecha_firma: firma.valor,
    requiere_poliza: poliza.requiere.valor,
    tipo_poliza: poliza.tipo.valor,
    confianza,
    evidencia,
    notas,
  }
}
