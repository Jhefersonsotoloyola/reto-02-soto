import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { z } from "zod"
import type { Herramienta } from "../src/lib/herramienta"
import { leerRespuesta, type RespuestaHerramienta } from "../src/lib/respuesta"
import type { Mensaje, OpcionesEnvio, ProveedorLLM, RespuestaModelo } from "../src/llm/adapter"

export const RAIZ = join(import.meta.dir, "..")

/** Copia de lo que las herramientas y el prompt leen, en una carpeta temporal: cada prueba tiene su propio out/. */
export function proyectoTemporal(): string {
  const dir = mkdtempSync(join(tmpdir(), "reto02-"))
  for (const parte of ["fixtures", "agent", join("src", "knowledge")]) {
    cpSync(join(RAIZ, parte), join(dir, parte), { recursive: true })
  }
  return dir
}

export function agregarMensaje(dir: string, id: string, adjuntos: Record<string, string | Uint8Array>, cuerpo = "Adjunto documento."): void {
  const carpeta = join(dir, "fixtures", "reto-02", "buzon", id)
  mkdirSync(carpeta, { recursive: true })
  const correo = { id, de: "lgomez@periferia-ficticia.com", para: "contratos@periferia-ficticia.com", asunto: `Prueba ${id}`, fecha: "2026-09-01T10:00:00-05:00", cuerpo, adjuntos: Object.keys(adjuntos) }
  writeFileSync(join(carpeta, "correo.json"), JSON.stringify(correo))
  for (const [nombre, contenido] of Object.entries(adjuntos)) writeFileSync(join(carpeta, nombre), contenido)
}

export async function ejecutar(h: Pick<Herramienta<z.ZodRawShape>, "execute">, args: unknown, dir: string): Promise<RespuestaHerramienta> {
  return leerRespuesta(await h.execute(args, { directory: dir, sessionId: "prueba" }))
}

export function datos<T>(r: RespuestaHerramienta): T {
  if (!r.ok) throw new Error(`se esperaba ok y llegó: ${r.error}`)
  return r.data as T
}

type Guion = (mensajes: Mensaje[], opciones: OpcionesEnvio) => RespuestaModelo

/** Proveedor falso: responde según un guion, sin red ni clave. Guarda lo que recibió para inspeccionarlo. */
export class ProveedorGuion implements ProveedorLLM {
  readonly nombre = "guion"
  readonly modelo = "guion-1"
  readonly recibidos: { mensajes: Mensaje[]; opciones: OpcionesEnvio }[] = []

  constructor(private readonly guion: Guion) {}

  async enviar(_sistema: string, mensajes: Mensaje[], _herramientas: unknown[], opciones: OpcionesEnvio = {}): Promise<RespuestaModelo> {
    this.recibidos.push({ mensajes: [...mensajes], opciones })
    return this.guion(mensajes, opciones)
  }
}

const USO = { entrada: 100, salida: 20, cacheLeida: 0, cacheEscrita: 0 }

export function respuestaTexto(texto: string): RespuestaModelo {
  return { texto, llamadas: [], fin: "fin", uso: USO }
}

let contador = 0
export function respuestaLlamadas(...llamadas: [string, unknown][]): RespuestaModelo {
  return { texto: "", llamadas: llamadas.map(([nombre, argumentos]) => ({ id: `t${++contador}`, nombre, argumentos })), fin: "herramientas", uso: USO }
}

/** Cuántos turnos de usuaria hay en el historial (para saber en qué turno va el guion). */
export function turnosDeUsuaria(mensajes: Mensaje[]): number {
  return mensajes.filter((m) => m.rol === "usuario").length
}
