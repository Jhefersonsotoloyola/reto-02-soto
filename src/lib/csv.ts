/** Lector y escritor CSV (RFC 4180): comillas dobles, comas y saltos de línea dentro de campos. */

export function parsearCsv(texto: string): string[][] {
  const filas: string[][] = []
  let fila: string[] = []
  let campo = ""
  let entreComillas = false
  const contenido = texto.replace(/^﻿/, "")
  for (let i = 0; i < contenido.length; i++) {
    const c = contenido.charAt(i)
    if (entreComillas) {
      if (c === '"' && contenido.charAt(i + 1) === '"') {
        campo += '"'
        i++
      } else if (c === '"') entreComillas = false
      else campo += c
    } else if (c === '"') entreComillas = true
    else if (c === ",") {
      fila.push(campo)
      campo = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && contenido.charAt(i + 1) === "\n") i++
      fila.push(campo)
      filas.push(fila)
      fila = []
      campo = ""
    } else campo += c
  }
  if (campo !== "" || fila.length > 0) {
    fila.push(campo)
    filas.push(fila)
  }
  return filas.filter((f) => f.some((valor) => valor !== ""))
}

function escaparCampo(valor: string): string {
  return /[",\r\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor
}

export function serializarCsv(filas: string[][]): string {
  return `${filas.map((fila) => fila.map(escaparCampo).join(",")).join("\n")}\n`
}
