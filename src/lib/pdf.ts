import { extractText, getDocumentProxy } from "unpdf"

/** Texto de un PDF nativo (con capa de texto). Un PDF escaneado devuelve "" y se reporta como sin texto: necesitaría OCR. */
export async function textoDePdf(contenido: Uint8Array): Promise<string> {
  const documento = await getDocumentProxy(new Uint8Array(contenido))
  const { text } = await extractText(documento, { mergePages: true })
  return text
}
