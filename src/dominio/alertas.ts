import { z } from "zod"
import { escribirArchivo, ErrorProceso, leerLineasJson, rutas } from "../lib/archivos"
import { diasEntre, esFechaValida, fechaDeTimestamp, sumarDias } from "../lib/fechas"
import { reglas } from "../lib/reglas"
import { leerCorreo, leerProcesados, listarMensajes } from "./buzon"
import { leerMaestro } from "./maestro"
import type { FilaMaestro } from "./tipos"

export interface ContratoPorVencer {
  id_contrato: string
  cliente: string
  fecha_fin: string
  dias: number
  requiere_poliza: boolean
  estado_poliza: string
  comercial: string
}

export interface PolizaPendiente {
  id_contrato: string
  cliente: string
  tipo_poliza: string
  estado_poliza: string
  fecha_fin: string
}

export interface RegistroDesdeCorte {
  id_contrato: string
  cliente: string
  accion: "alta" | "actualizacion"
  fecha: string
  detalle: string
}

export interface Alertas {
  hoy: string
  ruta: string
  vencen: ContratoPorVencer[]
  vencidos: ContratoPorVencer[]
  polizas_pendientes: PolizaPendiente[]
  registrados_desde_corte: RegistroDesdeCorte[]
  pendientes_buzon: { mensaje_id: string; asunto: string }[]
}

const LineaHistorial = z.object({
  ts: z.string(),
  id_contrato: z.string().nullable(),
  accion: z.string(),
  cambios: z.record(z.string(), z.object({ antes: z.unknown(), despues: z.unknown() })),
})

function porVencer(fila: FilaMaestro, hoy: string): ContratoPorVencer {
  return {
    id_contrato: fila.id_contrato, cliente: fila.cliente, fecha_fin: fila.fecha_fin, dias: diasEntre(hoy, fila.fecha_fin),
    requiere_poliza: fila.requiere_poliza, estado_poliza: fila.estado_poliza, comercial: fila.comercial,
  }
}

function registradosDesdeCorte(directory: string, maestro: FilaMaestro[]): RegistroDesdeCorte[] {
  const corte = reglas.fecha_corte_maestro
  const cliente = new Map(maestro.map((f) => [f.id_contrato, f.cliente]))
  const altas: RegistroDesdeCorte[] = maestro
    .filter((f) => f.fecha_registro >= corte)
    .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, accion: "alta", fecha: f.fecha_registro, detalle: f.objeto }))
  const actualizaciones: RegistroDesdeCorte[] = leerLineasJson(rutas(directory).historial)
    .flatMap((l) => {
      const linea = LineaHistorial.safeParse(l)
      return linea.success && linea.data.accion === "actualizacion" && fechaDeTimestamp(linea.data.ts) >= corte ? [linea.data] : []
    })
    .map((l) => ({
      id_contrato: l.id_contrato ?? "",
      cliente: cliente.get(l.id_contrato ?? "") ?? "",
      accion: "actualizacion",
      fecha: fechaDeTimestamp(l.ts),
      detalle: Object.entries(l.cambios).map(([campo, c]) => `${campo}: ${String(c.antes)} → ${String(c.despues)}`).join("; "),
    }))
  return [...altas, ...actualizaciones]
}

function fila(celdas: (string | number)[]): string {
  return `| ${celdas.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`
}

function tabla(encabezados: string[], filas: (string | number)[][], vacio: string): string {
  if (filas.length === 0) return `_${vacio}_`
  return [fila(encabezados), fila(encabezados.map(() => "---")), ...filas.map(fila)].join("\n")
}

function markdown(a: Alertas, totalContratos: number): string {
  const limite = sumarDias(a.hoy, reglas.dias_alerta_vencimiento)
  const poliza = (c: ContratoPorVencer) => (c.requiere_poliza ? c.estado_poliza : "no aplica")
  return [
    `# Alertas de contratos — ${a.hoy}`,
    "",
    `Fuente: \`out/sharepoint/maestro-contratos.csv\` (${totalContratos} contratos). Generado por el agente de Registro de Contratos Vigentes.`,
    "",
    `## 1. Vencen en ${reglas.dias_alerta_vencimiento} días o menos (hasta ${limite})`,
    "",
    tabla(["Contrato", "Cliente", "Fin", "Días", "Póliza", "Comercial"], a.vencen.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, c.dias, poliza(c), c.comercial]), "Ningún contrato vence en el periodo."),
    "",
    "### Ya vencidos sin renovación registrada",
    "",
    tabla(["Contrato", "Cliente", "Venció", "Hace (días)", "Comercial"], a.vencidos.map((c) => [c.id_contrato, c.cliente, c.fecha_fin, -c.dias, c.comercial]), "No hay contratos vencidos."),
    "",
    "## 2. Pólizas pendientes (requiere póliza y su estado no es vigente)",
    "",
    tabla(["Contrato", "Cliente", "Tipo de póliza", "Estado", "Fin del contrato"], a.polizas_pendientes.map((p) => [p.id_contrato, p.cliente, p.tipo_poliza.replace(/;/g, ", "), p.estado_poliza, p.fecha_fin]), "No hay pólizas pendientes."),
    "",
    `## 3. Registrados o actualizados desde el corte (${reglas.fecha_corte_maestro})`,
    "",
    tabla(["Contrato", "Cliente", "Acción", "Fecha", "Detalle"], a.registrados_desde_corte.map((r) => [r.id_contrato, r.cliente, r.accion, r.fecha, r.detalle]), "Aún no se ha registrado nada desde el corte."),
    "",
    a.pendientes_buzon.length
      ? `**Mensajes del buzón sin procesar:** ${a.pendientes_buzon.map((m) => `${m.mensaje_id} (${m.asunto})`).join("; ")}.`
      : "**Buzón al día:** no quedan mensajes sin procesar.",
    "",
  ].join("\n")
}

/** Un correo ilegible no debe impedir el reporte (HU-6): se lista igual, con su asunto marcado. */
function asuntoSeguro(directory: string, mensajeId: string): string {
  try {
    return leerCorreo(directory, mensajeId).asunto
  } catch {
    return "correo ilegible"
  }
}

/** HU-5: reporte de riesgos con una fecha de referencia explícita, para que el resultado sea reproducible. */
export function generarAlertas(directory: string, hoy: string): Alertas {
  if (!esFechaValida(hoy)) throw new ErrorProceso(`fecha "hoy" inválida: ${hoy} (usa YYYY-MM-DD)`)
  const maestro = leerMaestro(directory)
  const conDias = maestro.map((f) => porVencer(f, hoy)).sort((a, b) => a.dias - b.dias)
  const procesados = leerProcesados(directory)
  const alertas: Alertas = {
    hoy,
    ruta: "out/alertas.md",
    vencen: conDias.filter((c) => c.dias >= 0 && c.dias <= reglas.dias_alerta_vencimiento),
    vencidos: conDias.filter((c) => c.dias < 0),
    polizas_pendientes: maestro
      .filter((f) => f.requiere_poliza && f.estado_poliza !== "vigente")
      .map((f) => ({ id_contrato: f.id_contrato, cliente: f.cliente, tipo_poliza: f.tipo_poliza, estado_poliza: f.estado_poliza, fecha_fin: f.fecha_fin })),
    registrados_desde_corte: registradosDesdeCorte(directory, maestro),
    pendientes_buzon: listarMensajes(directory)
      .filter((id) => !procesados[id])
      .map((id) => ({ mensaje_id: id, asunto: asuntoSeguro(directory, id) })),
  }
  escribirArchivo(rutas(directory).alertas, markdown(alertas, maestro.length))
  return alertas
}
