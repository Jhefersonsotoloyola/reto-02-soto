// Herramientas del agente de Registro de Contratos Vigentes.
// Cada export es una herramienta; el modelo la ve como `contratos_<export>`.
// No dependen del servidor HTTP: demo.ts y modulo/ las importan tal cual.
import { existsSync, readFileSync } from "node:fs"
import { extname } from "node:path"
import { z } from "zod"
import { documentoPrincipal, leerMensaje, leerProcesados, listarMensajes, motivoSinContrato, resolverRemitente } from "../dominio/buzon"
import { generarAlertas } from "../dominio/alertas"
import { camposAplicables, extraerContrato } from "../dominio/extraccion"
import { registrarMensaje } from "../dominio/registro"
import { PropuestaContratoSchema } from "../dominio/tipos"
import { validarMensaje } from "../dominio/validacion"
import { ErrorProceso, rutaDentroDe } from "../lib/archivos"
import { herramienta } from "../lib/herramienta"
import { textoDePdf } from "../lib/pdf"
import { reglas } from "../lib/reglas"

const mensajeId = z.string().min(1).describe("Id del mensaje del buzón, por ejemplo msg-001")
const propuesta = PropuestaContratoSchema.optional().describe(
  "Solo los campos que corriges o que la usuaria dictó; lo que omitas se toma de la extracción. Omítelo para usar la extracción tal cual.",
)

/** HU-6: un mensaje ilegible (correo.json dañado) se lista como rechazado con su motivo; no impide leer los demás. */
async function resumenDeMensaje(directory: string, id: string) {
  try {
    const mensaje = await leerMensaje(directory, id)
    const remitente = resolverRemitente(directory, mensaje.correo.de)
    const motivo = motivoSinContrato(mensaje)
    return {
      id,
      de: mensaje.correo.de,
      asunto: mensaje.correo.asunto,
      fecha: mensaje.correo.fecha,
      adjuntos: mensaje.correo.adjuntos,
      tiene_contrato: motivo === null,
      documento: documentoPrincipal(mensaje)?.etiqueta ?? null,
      comercial: remitente.nombre,
      remitente_registrado: remitente.conocido,
      ...(motivo ? { clasificacion: "rechazado", motivo } : {}),
    }
  } catch (error) {
    const motivo = `mensaje ilegible: ${error instanceof Error ? error.message : String(error)}`
    return { id, de: null, asunto: null, fecha: null, adjuntos: [], tiene_contrato: false, documento: null, comercial: null, remitente_registrado: false, clasificacion: "rechazado", motivo }
  }
}

export const leer_buzon = herramienta("contratos_leer_buzon", {
  description: "Lista los mensajes del buzón de contratos aún no procesados, con remitente, asunto, adjuntos y si traen contrato.",
  args: {},
  async run(_args, ctx) {
    const procesados = leerProcesados(ctx.directory)
    const pendientes = listarMensajes(ctx.directory).filter((id) => !procesados[id])
    const mensajes = await Promise.all(pendientes.map((id) => resumenDeMensaje(ctx.directory, id)))
    const conContrato = mensajes.filter((m) => m.tiene_contrato).length
    return {
      data: { mensajes, ya_procesados: Object.keys(procesados).length },
      resumen: `${mensajes.length} pendientes (${conContrato} con contrato u otrosí), ${Object.keys(procesados).length} ya procesados`,
    }
  },
})

export const extraer = herramienta("contratos_extraer", {
  description: "Extrae los datos del contrato u otrosí adjunto a un mensaje, con confianza de 0 a 1 y evidencia textual por campo.",
  args: { mensaje_id: mensajeId },
  async run({ mensaje_id }, ctx) {
    const mensaje = await leerMensaje(ctx.directory, mensaje_id)
    const documento = documentoPrincipal(mensaje)
    if (!documento?.texto) {
      throw new ErrorProceso(`${mensaje_id} no trae contrato (${motivoSinContrato(mensaje)}); clasificación: rechazado. Ciérralo con contratos_registrar.`)
    }
    const contrato = extraerContrato(documento.texto, documento.tipo === "otrosi" ? "otrosi" : "contrato", mensaje.correo.cuerpo)
    const bajas = camposAplicables(contrato).filter((campo) => contrato.confianza[campo] < reglas.umbral_confianza)
    return {
      data: { mensaje_id, adjunto: documento.nombre, ...contrato, campos_baja_confianza: bajas },
      resumen: `${mensaje_id}: ${documento.etiqueta} ${contrato.id_contrato ?? "sin número"} · ${contrato.cliente ?? "cliente no identificado"} · confianza < ${reglas.umbral_confianza} en: ${bajas.join(", ") || "ninguno"}`,
    }
  },
})

export const validar = herramienta("contratos_validar", {
  description: "Clasifica un mensaje como nuevo, actualizacion, duplicado o rechazado contra el maestro y lista los campos que requieren revisión humana.",
  args: { mensaje_id: mensajeId, contrato: propuesta },
  async run({ mensaje_id, contrato }, ctx) {
    const v = await validarMensaje(ctx.directory, mensaje_id, contrato)
    const { contrato: valores, documento, ...resto } = v
    const resumen = [
      `${mensaje_id}: ${v.clasificacion}`,
      v.id_contrato_existente ? `(${v.id_contrato_existente})` : "",
      v.requiere_revision.length ? `· revisión: ${v.requiere_revision.join(", ")}` : "· sin campos en revisión",
    ].filter(Boolean).join(" ")
    return {
      data: { ...resto, documento: documento?.nombre ?? null, valores: valores ? { ...valores, evidencia: undefined } : null },
      resumen,
    }
  },
})

export const registrar = herramienta("contratos_registrar", {
  description: "Registra o actualiza el contrato de un mensaje en el maestro, archiva el documento y cierra el mensaje; también cierra duplicados y rechazados sin escribir en el maestro.",
  args: {
    mensaje_id: mensajeId,
    contrato: propuesta,
    confirmado: z.boolean().optional().describe("true solo después de que la usuaria confirmó explícitamente los campos en revisión"),
  },
  async run({ mensaje_id, contrato, confirmado }, ctx) {
    const r = await registrarMensaje(ctx.directory, mensaje_id, contrato, confirmado === true)
    const destino = r.ruta_archivo ? ` → ${r.ruta_archivo}` : ""
    return { data: r, resumen: `${mensaje_id}: ${r.accion}${r.id_contrato ? ` ${r.id_contrato}` : ""}${destino}` }
  },
})

export const alertas = herramienta("contratos_alertas", {
  description: "Genera out/alertas.md con contratos que vencen en 60 días o menos, pólizas pendientes y registros desde el corte del maestro.",
  args: { hoy: z.string().describe("Fecha de referencia en formato YYYY-MM-DD") },
  run({ hoy }, ctx) {
    const a = generarAlertas(ctx.directory, hoy)
    return {
      data: a,
      resumen: `${a.vencen.length} vencen en ≤ ${reglas.dias_alerta_vencimiento} días, ${a.vencidos.length} vencidos, ${a.polizas_pendientes.length} pólizas pendientes, ${a.registrados_desde_corte.length} registros desde el corte`,
    }
  },
})

export const leer_pdf = herramienta("contratos_leer_pdf", {
  description: "Devuelve el texto de un PDF nativo (con capa de texto) ubicado dentro de fixtures/ u out/.",
  args: { ruta: z.string().min(1).describe("Ruta relativa a la raíz del proyecto, por ejemplo fixtures/reto-02/buzon/msg-001/contrato.pdf") },
  async run({ ruta }, ctx) {
    if (!/^(fixtures|out)[\\/]/.test(ruta)) throw new ErrorProceso("solo se leen archivos dentro de fixtures/ u out/")
    if (extname(ruta).toLowerCase() !== ".pdf") throw new ErrorProceso(`no es un PDF: ${ruta}`)
    const archivo = rutaDentroDe(ctx.directory, ruta)
    if (!existsSync(archivo)) throw new ErrorProceso(`no existe ${ruta}`)
    const texto = await textoDePdf(readFileSync(archivo))
    if (texto.trim() === "") throw new ErrorProceso(`${ruta} no tiene texto extraíble (¿escaneado? necesitaría OCR)`)
    return { data: { ruta, texto }, resumen: `${ruta}: ${texto.length} caracteres` }
  },
})
