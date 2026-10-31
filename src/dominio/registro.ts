import { copyFileSync, mkdirSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { agregarLineaJson, ErrorProceso, rutas } from "../lib/archivos"
import { fechaDeTimestamp, hoyIso } from "../lib/fechas"
import { reglas } from "../lib/reglas"
import { slug } from "../lib/texto"
import { leerProcesados, marcarProcesado } from "./buzon"
import { escribirMaestro, leerMaestro, siguienteIdAutomatico } from "./maestro"
import type { Contrato, FilaMaestro, PropuestaContrato } from "./tipos"
import { type Clasificacion, type Validacion, validarMensaje } from "./validacion"

export type Accion = "alta" | "actualizacion" | "sin_cambios" | "rechazado"

export interface ResultadoRegistro {
  mensaje_id: string
  clasificacion: Clasificacion
  accion: Accion
  id_contrato: string | null
  ruta_archivo: string | null
  cambios: Record<string, { antes: unknown; despues: unknown }>
  confirmado_por_usuario: boolean
  motivo: string
}

/** Copia el documento a out/sharepoint/<rutaRelativa>. La ruta guardada en el maestro usa "/" como SharePoint. */
function archivar(directory: string, origen: string, rutaRelativa: string): void {
  const destino = join(rutas(directory).sharepoint, ...rutaRelativa.split("/"))
  mkdirSync(dirname(destino), { recursive: true })
  copyFileSync(origen, destino)
}

function exigirCampos(contrato: Contrato): void {
  const faltan = reglas.campos_obligatorios.filter((c) => contrato[c as keyof Contrato] === null)
  if (faltan.length) {
    throw new ErrorProceso(`no se puede registrar sin ${faltan.join(", ")}: pide esos valores a la usuaria y envíalos en "contrato"`)
  }
}

function alta(directory: string, v: Validacion, contrato: Contrato, origen: string): Pick<ResultadoRegistro, "id_contrato" | "ruta_archivo" | "cambios"> {
  exigirCampos(contrato)
  const maestro = leerMaestro(directory)
  const anio = (contrato.fecha_inicio ?? "").slice(0, 4)
  const id = contrato.id_contrato ?? siguienteIdAutomatico(maestro, anio)
  const ruta = `Contratos/${anio}/${slug(contrato.cliente ?? "", reglas.sufijos_societarios)}/${id}${extname(origen)}`
  const fila: FilaMaestro = {
    id_contrato: id,
    cliente: contrato.cliente ?? "",
    nit_cliente: contrato.nit_cliente ?? "",
    pais: contrato.pais ?? "CO",
    objeto: contrato.objeto ?? "",
    valor: contrato.valor ?? 0,
    moneda: contrato.moneda ?? "COP",
    fecha_inicio: contrato.fecha_inicio ?? "",
    fecha_fin: contrato.fecha_fin ?? "",
    requiere_poliza: contrato.requiere_poliza === true,
    tipo_poliza: contrato.requiere_poliza ? (contrato.tipo_poliza ?? "") : "",
    estado_poliza: contrato.requiere_poliza ? "pendiente" : "no_aplica",
    comercial: v.remitente.nombre,
    ruta_sharepoint: ruta,
    fecha_registro: hoyIso(),
    fuente: "buzon",
  }
  archivar(directory, origen, ruta)
  escribirMaestro(directory, [...maestro, fila])
  const cambios = Object.fromEntries(Object.entries(fila).map(([campo, valor]) => [campo, { antes: null, despues: valor }]))
  return { id_contrato: id, ruta_archivo: ruta, cambios }
}

function actualizacion(directory: string, v: Validacion, contrato: Contrato, origen: string): Pick<ResultadoRegistro, "id_contrato" | "ruta_archivo" | "cambios"> {
  const maestro = leerMaestro(directory)
  const indice = maestro.findIndex((f) => f.id_contrato === v.id_contrato_existente)
  const fila = maestro[indice]
  if (!fila) throw new ErrorProceso(`el contrato ${v.id_contrato_existente} ya no está en el maestro`)
  const carpeta = fila.ruta_sharepoint ? dirname(fila.ruta_sharepoint) : `Contratos/${fila.fecha_inicio.slice(0, 4)}/${slug(fila.cliente, reglas.sufijos_societarios)}`
  const sufijo = contrato.tipo_documento === "otrosi" ? `otrosi-${contrato.numero_otrosi ?? 1}` : `actualizacion-${v.mensaje_id}`
  const ruta = `${carpeta}/${fila.id_contrato}-${sufijo}${extname(origen)}`

  const actualizada: FilaMaestro = { ...fila }
  const cambios: ResultadoRegistro["cambios"] = {}
  for (const d of v.diferencias.filter((d) => d.campo !== "id_contrato")) {
    Object.assign(actualizada, { [d.campo]: d.nuevo })
    cambios[d.campo] = { antes: d.actual, despues: d.nuevo }
  }
  archivar(directory, origen, ruta)
  maestro[indice] = actualizada
  escribirMaestro(directory, maestro)
  return { id_contrato: fila.id_contrato, ruta_archivo: ruta, cambios }
}

/**
 * HU-4: registra (o cierra) un mensaje. Vuelve a validar desde el documento, así que el valor que se escribe
 * siempre sale de la herramienta; lo que el agente proponga distinto exige `confirmado = true`.
 */
export async function registrarMensaje(
  directory: string,
  mensajeId: string,
  propuesta: PropuestaContrato | undefined,
  confirmado: boolean,
): Promise<ResultadoRegistro> {
  const previo = leerProcesados(directory)[mensajeId]
  if (previo) {
    throw new ErrorProceso(`el mensaje ${mensajeId} ya se procesó el ${fechaDeTimestamp(previo.ts)} (${previo.accion}${previo.id_contrato ? `, ${previo.id_contrato}` : ""})`)
  }
  const v = await validarMensaje(directory, mensajeId, propuesta)
  if (v.requiere_revision.length > 0 && !confirmado) {
    const detalle = v.detalle_revision.map((d) => `${d.campo} = ${JSON.stringify(d.valor_propuesto)} (${d.motivo})`).join("; ")
    throw new ErrorProceso(`requiere revisión: ${detalle}. Pregunta a la usuaria y, solo si confirma, vuelve a llamar con confirmado=true.`)
  }

  let accion: Accion = v.clasificacion === "rechazado" ? "rechazado" : "sin_cambios"
  let datos: Pick<ResultadoRegistro, "id_contrato" | "ruta_archivo" | "cambios"> = { id_contrato: v.id_contrato_existente, ruta_archivo: null, cambios: {} }
  if (v.contrato && v.documento && (v.clasificacion === "nuevo" || v.clasificacion === "actualizacion")) {
    accion = v.clasificacion === "nuevo" ? "alta" : "actualizacion"
    datos = accion === "alta" ? alta(directory, v, v.contrato, v.documento.ruta) : actualizacion(directory, v, v.contrato, v.documento.ruta)
    agregarLineaJson(rutas(directory).historial, {
      ts: new Date().toISOString(),
      id_contrato: datos.id_contrato,
      accion,
      cambios: datos.cambios,
      mensaje_id: mensajeId,
      ruta_archivo: datos.ruta_archivo,
      confirmado_por_usuario: confirmado && v.requiere_revision.length > 0,
      campos_confirmados: confirmado ? v.requiere_revision : [],
    })
  }
  marcarProcesado(directory, mensajeId, {
    ts: new Date().toISOString(),
    clasificacion: v.clasificacion,
    accion,
    id_contrato: datos.id_contrato,
    motivo: v.motivo,
  })
  return {
    mensaje_id: mensajeId,
    clasificacion: v.clasificacion,
    accion,
    ...datos,
    confirmado_por_usuario: confirmado && v.requiere_revision.length > 0,
    motivo: v.motivo,
  }
}
