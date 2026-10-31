import { reglas } from "../lib/reglas"
import { similitud } from "../lib/texto"
import { type Adjunto, documentoPrincipal, leerMensaje, motivoSinContrato, type Remitente, resolverRemitente } from "./buzon"
import { extraerContrato } from "./extraccion"
import { leerMaestro } from "./maestro"
import type { CampoExtraido, CamposContrato, Contrato, FilaMaestro, PropuestaContrato } from "./tipos"

export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado"

export interface CampoEnRevision {
  campo: string
  motivo: string
  valor_propuesto: unknown
  confianza: number | null
  evidencia: string | null
}

export interface Diferencia {
  campo: string
  actual: unknown
  nuevo: unknown
}

export interface Validacion {
  mensaje_id: string
  clasificacion: Clasificacion
  motivo: string
  id_contrato_existente: string | null
  /** Nombres de los campos que una persona debe confirmar antes de registrar (RN5). */
  requiere_revision: string[]
  detalle_revision: CampoEnRevision[]
  diferencias: Diferencia[]
  remitente: Remitente
  advertencias: string[]
  contrato: Contrato | null
  documento: Adjunto | null
}

const CAMPOS_OTROSI: CampoExtraido[] = ["valor", "moneda", "fecha_fin"]

/** Aplica sobre la extracción lo que propone el agente y anota qué campos cambió: esos exigen confirmación humana. */
function aplicarPropuesta(extraido: Contrato, propuesta: PropuestaContrato | undefined) {
  const contrato: Contrato = { ...extraido }
  const corregidos: (keyof CamposContrato)[] = []
  for (const [campo, valor] of Object.entries(propuesta ?? {}) as [keyof CamposContrato, unknown][]) {
    if (valor === undefined || valor === extraido[campo]) continue
    Object.assign(contrato, { [campo]: valor })
    corregidos.push(campo)
  }
  return { contrato, corregidos }
}

function valorDeFila(fila: FilaMaestro, campo: string): unknown {
  const valor = fila[campo as keyof FilaMaestro]
  return campo === "tipo_poliza" && valor === "" ? null : valor
}

function diferenciasCon(fila: FilaMaestro, contrato: Contrato, campos: string[]): Diferencia[] {
  return campos.flatMap((campo) => {
    const nuevo = contrato[campo as keyof CamposContrato]
    const actual = valorDeFila(fila, campo)
    if (nuevo === null || nuevo === undefined || nuevo === actual) return []
    return [{ campo, actual, nuevo }]
  })
}

function conflictoDeIdentidad(fila: FilaMaestro, contrato: Contrato): CampoEnRevision[] {
  if (!contrato.nit_cliente || contrato.nit_cliente === fila.nit_cliente) return []
  return [{
    campo: "nit_cliente",
    motivo: `el maestro registra ${fila.id_contrato} con el NIT ${fila.nit_cliente} (${fila.cliente})`,
    valor_propuesto: contrato.nit_cliente,
    confianza: contrato.confianza.nit_cliente,
    evidencia: contrato.evidencia.nit_cliente ?? null,
  }]
}

interface Resultado {
  clasificacion: Clasificacion
  motivo: string
  fila: FilaMaestro | null
  diferencias: Diferencia[]
  conflictos: CampoEnRevision[]
}

function clasificarOtrosi(contrato: Contrato, maestro: FilaMaestro[]): Resultado {
  const fila = maestro.find((f) => f.id_contrato === contrato.id_contrato) ?? null
  if (!fila) {
    return {
      clasificacion: "rechazado",
      motivo: `otrosí del contrato ${contrato.id_contrato ?? "(sin número)"}, que no está en el maestro: hay que registrar primero el contrato base`,
      fila: null, diferencias: [], conflictos: [],
    }
  }
  const diferencias = diferenciasCon(fila, contrato, CAMPOS_OTROSI)
  if (diferencias.length === 0) {
    return { clasificacion: "duplicado", motivo: `el otrosí ya está aplicado en ${fila.id_contrato}`, fila, diferencias, conflictos: [] }
  }
  const amplia = contrato.fecha_fin !== null && contrato.fecha_fin > fila.fecha_fin
  if (amplia && fila.requiere_poliza && fila.estado_poliza !== "pendiente" && reglas.otrosi_que_extiende_plazo_deja_poliza_pendiente) {
    diferencias.push({ campo: "estado_poliza", actual: fila.estado_poliza, nuevo: "pendiente" })
  }
  const campos = diferencias.map((d) => d.campo).join(", ")
  return { clasificacion: "actualizacion", motivo: `otrosí ${contrato.numero_otrosi ?? ""} de ${fila.id_contrato}: cambia ${campos}`, fila, diferencias, conflictos: conflictoDeIdentidad(fila, contrato) }
}

function clasificarContrato(contrato: Contrato, maestro: FilaMaestro[]): Resultado {
  const porId = maestro.find((f) => f.id_contrato === contrato.id_contrato)
  if (porId) {
    const diferencias = diferenciasCon(porId, contrato, reglas.campos_clave_actualizacion)
    const mismaVigencia = ["valor", "fecha_inicio", "fecha_fin"].every((c) => !diferencias.some((d) => d.campo === c))
    const conflictos = conflictoDeIdentidad(porId, contrato)
    if (mismaVigencia) {
      return { clasificacion: "duplicado", motivo: `${porId.id_contrato} ya está en el maestro con el mismo valor y vigencia`, fila: porId, diferencias, conflictos }
    }
    return { clasificacion: "actualizacion", motivo: `${porId.id_contrato} ya está en el maestro; cambian ${diferencias.map((d) => d.campo).join(", ")}`, fila: porId, diferencias, conflictos }
  }
  const mismoCliente = maestro.filter((f) => contrato.nit_cliente !== null && f.nit_cliente === contrato.nit_cliente)
  const parecidos = mismoCliente
    .map((f) => ({ fila: f, sim: contrato.objeto ? similitud(f.objeto, contrato.objeto) : 0 }))
    .sort((a, b) => b.sim - a.sim)
  const mejor = parecidos[0]
  if (mejor && mejor.sim >= reglas.similitud_objeto_actualizacion) {
    const diferencias = diferenciasCon(mejor.fila, contrato, ["id_contrato", ...reglas.campos_clave_actualizacion])
    // RN2 exige "algún campo distinto": si solo cambia (o falta) el número, es el mismo contrato reenviado.
    if (diferencias.every((d) => d.campo === "id_contrato")) {
      return {
        clasificacion: "duplicado",
        motivo: `mismo cliente y objeto que ${mejor.fila.id_contrato} (similitud ${mejor.sim.toFixed(2)}), sin cambios en valor, vigencia ni póliza`,
        fila: mejor.fila, diferencias, conflictos: [],
      }
    }
    return {
      clasificacion: "actualizacion",
      motivo: `mismo cliente y objeto similar (${mejor.sim.toFixed(2)}) a ${mejor.fila.id_contrato}`,
      fila: mejor.fila, diferencias, conflictos: [],
    }
  }
  const otros = parecidos.map((p) => `${p.fila.id_contrato} (similitud de objeto ${p.sim.toFixed(2)})`).join(", ")
  return {
    clasificacion: "nuevo",
    motivo: otros ? `no existe ese número; el cliente tiene otros contratos con objeto distinto: ${otros}` : "no existe ese número ni otro contrato del mismo cliente",
    fila: null, diferencias: [], conflictos: [],
  }
}

/** RN5: campos con confianza bajo el umbral, valores corregidos por el agente y conflictos con el maestro. */
function camposEnRevision(contrato: Contrato, corregidos: string[], conflictos: CampoEnRevision[]): CampoEnRevision[] {
  const relevantes: string[] =
    contrato.tipo_documento === "otrosi"
      ? CAMPOS_OTROSI.filter((c) => contrato[c] !== null)
      : [...reglas.campos_obligatorios, ...(contrato.requiere_poliza ? ["tipo_poliza"] : []), ...(contrato.id_contrato ? ["id_contrato"] : [])]
  const lista: CampoEnRevision[] = []
  for (const campo of new Set([...relevantes, ...corregidos])) {
    const clave = campo as CampoExtraido
    const confianza = contrato.confianza[clave] ?? null
    const nota = contrato.notas.find((n) => n.startsWith(`${campo}:`))?.slice(campo.length + 1).trim()
    let motivo: string | null = null
    if (corregidos.includes(campo)) motivo = "el agente propone un valor distinto al extraído del documento"
    else if (confianza !== null && confianza < reglas.umbral_confianza) {
      motivo = contrato[clave] === null ? "no aparece en el documento" : (nota ?? `confianza ${confianza.toFixed(2)}`)
    }
    if (motivo) lista.push({ campo, motivo, valor_propuesto: contrato[clave], confianza, evidencia: contrato.evidencia[clave] ?? null })
  }
  return [...lista, ...conflictos.filter((c) => !lista.some((l) => l.campo === c.campo))]
}

/** Clasifica un mensaje contra el maestro (RN1–RN4) y lista lo que necesita revisión humana (RN5). No escribe nada. */
export async function validarMensaje(directory: string, mensajeId: string, propuesta?: PropuestaContrato): Promise<Validacion> {
  const mensaje = await leerMensaje(directory, mensajeId)
  const remitente = resolverRemitente(directory, mensaje.correo.de)
  const advertencias = remitente.conocido ? [] : [`remitente no registrado en comerciales.json: ${remitente.email}`]
  const documento = documentoPrincipal(mensaje)
  const base = { mensaje_id: mensajeId, remitente, advertencias, documento, requiere_revision: [], detalle_revision: [], diferencias: [], id_contrato_existente: null }

  const sinContrato = motivoSinContrato(mensaje)
  if (sinContrato || !documento?.texto) return { ...base, clasificacion: "rechazado", motivo: sinContrato ?? "sin texto", contrato: null }

  const extraido = extraerContrato(documento.texto, documento.tipo === "otrosi" ? "otrosi" : "contrato", mensaje.correo.cuerpo)
  const { contrato, corregidos } = aplicarPropuesta(extraido, propuesta)
  if (contrato.tipo_documento === "contrato" && !contrato.cliente && !contrato.objeto) {
    return { ...base, clasificacion: "rechazado", motivo: "el texto no permite identificar las partes ni el objeto", contrato }
  }

  const resultado = contrato.tipo_documento === "otrosi" ? clasificarOtrosi(contrato, leerMaestro(directory)) : clasificarContrato(contrato, leerMaestro(directory))
  const registrable = resultado.clasificacion === "nuevo" || resultado.clasificacion === "actualizacion"
  const detalle = registrable ? camposEnRevision(contrato, corregidos, resultado.conflictos) : []
  if (contrato.notas.length) advertencias.push(...contrato.notas.filter((n) => !detalle.some((d) => n.startsWith(`${d.campo}:`))))
  return {
    ...base,
    clasificacion: resultado.clasificacion,
    motivo: resultado.motivo,
    id_contrato_existente: resultado.fila?.id_contrato ?? null,
    requiere_revision: detalle.map((d) => d.campo),
    detalle_revision: detalle,
    diferencias: resultado.diferencias,
    contrato,
  }
}
