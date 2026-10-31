// Front del chat: sin build. Habla con /api/chat por SSE y muestra cada llamada a herramienta.
import { marked } from "/vendor/marked.js"
import DOMPurify from "/vendor/purify.js"

const PROMPT_EJEMPLO =
  "Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que esté limpio, muéstrame lo que requiere revisión campo por campo y termina con el reporte de alertas. No registres nada dudoso sin preguntarme."
const CORTE_MAESTRO = "2026-05-30"

const $ = (id) => document.getElementById(id)

function leerLocal(clave) {
  try {
    return localStorage.getItem(clave)
  } catch {
    return null
  }
}

function guardarLocal(clave, valor) {
  try {
    if (valor === null) localStorage.removeItem(clave)
    else localStorage.setItem(clave, valor)
  } catch {
    // Sin almacenamiento (modo privado): la sesión dura lo que dure la pestaña.
  }
}

function nuevoIdSesion() {
  const id = crypto.randomUUID()
  guardarLocal("sesion", id)
  return id
}

const sesionGuardada = leerLocal("sesion")
const estado = {
  sesion: sesionGuardada ?? nuevoIdSesion(),
  clave: leerLocal("clave"),
  ocupado: false,
  pendientes: [],
  archivo: "alertas",
  tarjetas: new Map(),
}

// ---------- API ----------

async function api(ruta, opciones = {}) {
  const headers = { ...(opciones.headers ?? {}), ...(estado.clave ? { "x-access-key": estado.clave } : {}) }
  const respuesta = await fetch(ruta, { ...opciones, headers })
  if (respuesta.status === 401) {
    pedirClave()
    throw new Error("Clave de acceso incorrecta.")
  }
  return respuesta
}

function pedirClave() {
  const clave = window.prompt("Este enlace está protegido. Escribe la clave de acceso (está en el README):")
  estado.clave = clave?.trim() || null
  guardarLocal("clave", estado.clave)
}

// ---------- Render del chat ----------

function markdown(texto) {
  return DOMPurify.sanitize(marked.parse(texto ?? ""))
}

function agregar(nodo) {
  $("bienvenida")?.remove()
  const lista = $("mensajes")
  const indicador = lista.querySelector(".pensando")
  lista.insertBefore(nodo, indicador)
  nodo.scrollIntoView({ block: "end", behavior: "smooth" })
  return nodo
}

function burbujaUsuario(texto) {
  const nodo = document.createElement("div")
  nodo.className = "burbuja usuario"
  nodo.textContent = texto
  return agregar(nodo)
}

function burbujaAsistente(texto, pideConfirmacion) {
  const nodo = document.createElement("div")
  nodo.className = `burbuja asistente${pideConfirmacion ? " pide-confirmacion" : ""}`
  nodo.innerHTML = `${pideConfirmacion ? '<span class="etiqueta">Requiere tu confirmación</span>' : ""}${markdown(texto)}`
  return agregar(nodo)
}

function burbujaError(texto) {
  const nodo = document.createElement("div")
  nodo.className = "burbuja error"
  nodo.textContent = texto
  return agregar(nodo)
}

function nota(texto) {
  const nodo = document.createElement("div")
  nodo.className = "nota"
  nodo.innerHTML = markdown(texto)
  return agregar(nodo)
}

function bonito(valor) {
  if (typeof valor !== "string") return JSON.stringify(valor, null, 2)
  try {
    return JSON.stringify(JSON.parse(valor), null, 2)
  } catch {
    return valor
  }
}

function argumentosCortos(argumentos) {
  const texto = JSON.stringify(argumentos ?? {})
  return texto === "{}" ? "" : texto.length > 80 ? `${texto.slice(0, 80)}…` : texto
}

/** Tarjeta de una llamada a herramienta: nombre, argumentos y resultado resumido (desplegable con el detalle). */
function pintarTarjeta(nodo, { nombre, argumentos, llamada }) {
  const enCurso = !llamada
  nodo.className = `herramienta${enCurso ? " en-curso" : llamada.ok ? "" : " fallo"}`
  const insignia = enCurso ? '<span class="insignia curso">ejecutando</span>' : `<span class="insignia ${llamada.ok ? "ok" : "fallo"}">${llamada.ok ? "ok" : "error"}</span>`
  nodo.innerHTML = `
    <summary>
      <span class="nombre"></span>${insignia}
      <span class="resumen"></span>
      ${enCurso ? "" : `<span class="ms">${llamada.ms} ms</span>`}
    </summary>
    <h4>Argumentos</h4><pre class="args"></pre>
    ${enCurso ? "" : '<h4>Resultado</h4><pre class="resultado"></pre>'}`
  nodo.querySelector(".nombre").textContent = nombre
  nodo.querySelector(".resumen").textContent = enCurso ? argumentosCortos(argumentos) : llamada.resumen
  nodo.querySelector(".args").textContent = bonito(argumentos ?? {})
  if (!enCurso) nodo.querySelector(".resultado").textContent = bonito(llamada.resultado)
}

function tarjeta(datos) {
  const nodo = document.createElement("details")
  pintarTarjeta(nodo, datos)
  return agregar(nodo)
}

function mostrarPensando(texto) {
  let nodo = $("mensajes").querySelector(".pensando")
  if (!nodo) {
    nodo = document.createElement("div")
    nodo.className = "pensando"
    $("mensajes").append(nodo)
  }
  nodo.textContent = texto
  nodo.scrollIntoView({ block: "end" })
}

function ocultarPensando() {
  $("mensajes").querySelector(".pensando")?.remove()
}

function mostrarPendientes(pendientes) {
  estado.pendientes = pendientes ?? []
  const caja = $("confirmacion")
  caja.hidden = estado.pendientes.length === 0
  $("pendientes").replaceChildren(
    ...estado.pendientes.map((p) => {
      const li = document.createElement("li")
      li.textContent = `${p.mensaje_id}: ${p.campos.join(", ")}`
      return li
    }),
  )
}

function bloquear(ocupado) {
  estado.ocupado = ocupado
  for (const id of ["enviar", "entrada", "confirmar", "corregir", "nueva", "reiniciar"]) $(id).disabled = ocupado
}

// ---------- Turno por SSE ----------

function manejarEvento(evento, datos) {
  if (evento === "herramienta_inicio") {
    mostrarPensando(`Ejecutando ${datos.nombre}…`)
    estado.tarjetas.set(datos.id, tarjeta({ nombre: datos.nombre, argumentos: datos.argumentos }))
  } else if (evento === "herramienta_fin") {
    const nodo = estado.tarjetas.get(datos.llamada.id) ?? tarjeta({ nombre: datos.llamada.nombre, argumentos: datos.llamada.argumentos })
    pintarTarjeta(nodo, { nombre: datos.llamada.nombre, argumentos: datos.llamada.argumentos, llamada: datos.llamada })
    mostrarPensando("Pensando…")
  } else if (evento === "nota") {
    nota(datos.texto)
  } else if (evento === "fin") {
    ocultarPensando()
    burbujaAsistente(datos.reply, datos.needsConfirmation)
    mostrarPendientes(datos.pendientes)
  }
}

async function leerEventos(cuerpo) {
  const lector = cuerpo.pipeThrough(new TextDecoderStream()).getReader()
  let pendiente = ""
  let terminado = false
  for (;;) {
    const { value, done } = await lector.read()
    if (done) break
    pendiente += value
    let corte
    while ((corte = pendiente.indexOf("\n\n")) >= 0) {
      const bloque = pendiente.slice(0, corte)
      pendiente = pendiente.slice(corte + 2)
      let evento = "message"
      let datos = ""
      for (const linea of bloque.split("\n")) {
        if (linea.startsWith("event: ")) evento = linea.slice(7)
        else if (linea.startsWith("data: ")) datos += linea.slice(6)
      }
      if (!datos) continue
      if (evento === "fin") terminado = true
      manejarEvento(evento, JSON.parse(datos))
    }
  }
  return terminado
}

async function enviar(texto) {
  if (estado.ocupado || !texto.trim()) return
  bloquear(true)
  burbujaUsuario(texto)
  mostrarPensando("Pensando…")
  try {
    const respuesta = await api("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ sessionId: estado.sesion, message: texto }),
    })
    if (!respuesta.ok || !respuesta.body) {
      const cuerpo = await respuesta.json().catch(() => ({}))
      throw new Error(cuerpo.error ?? `El servidor respondió ${respuesta.status}.`)
    }
    const completo = await leerEventos(respuesta.body)
    if (!completo) throw new Error("Se cortó la conexión antes de terminar. Recarga la página para ver lo que alcanzó a procesar.")
  } catch (error) {
    ocultarPensando()
    burbujaError(error instanceof Error ? error.message : String(error))
  } finally {
    bloquear(false)
    cargarArchivo(estado.archivo)
    $("entrada").focus()
  }
}

// ---------- Panel de archivos de out/ ----------

function parsearCsv(texto) {
  const filas = []
  let fila = []
  let campo = ""
  let comillas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++ }
      else if (c === '"') comillas = false
      else campo += c
    } else if (c === '"') comillas = true
    else if (c === ",") { fila.push(campo); campo = "" }
    else if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = "" }
    else if (c !== "\r") campo += c
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila) }
  return filas
}

function celda(fila, texto) {
  const td = document.createElement(fila ? "td" : "th")
  td.textContent = texto
  return td
}

function tablaMaestro(texto) {
  const [encabezado, ...filas] = parsearCsv(texto.trim())
  const i = (c) => encabezado.indexOf(c)
  const formato = new Intl.NumberFormat("es-CO")
  const columnas = ["Contrato", "Cliente", "Valor", "Inicio", "Fin", "Póliza", "Registro"]
  const tabla = document.createElement("table")
  const cabeza = document.createElement("tr")
  cabeza.append(...columnas.map((c) => celda(false, c)))
  tabla.append(cabeza)
  for (const f of filas) {
    const tr = document.createElement("tr")
    if (f[i("fecha_registro")] >= CORTE_MAESTRO) tr.className = "nuevo"
    const poliza = f[i("requiere_poliza")] === "true" ? `${f[i("tipo_poliza")].replaceAll(";", ", ")} · ${f[i("estado_poliza")]}` : "no aplica"
    tr.append(
      celda(true, f[i("id_contrato")]),
      celda(true, f[i("cliente")]),
      celda(true, `${f[i("moneda")]} ${formato.format(Number(f[i("valor")]))}`),
      celda(true, f[i("fecha_inicio")]),
      celda(true, f[i("fecha_fin")]),
      celda(true, poliza),
      celda(true, `${f[i("fecha_registro")]} · ${f[i("fuente")]}`),
    )
    tabla.append(tr)
  }
  const leyenda = document.createElement("p")
  leyenda.className = "vacio"
  leyenda.textContent = `${filas.length} contratos. En verde, los registrados desde el corte del ${CORTE_MAESTRO}.`
  return [leyenda, tabla]
}

function lineasJson(texto, ultimas) {
  const lineas = texto.trim().split("\n").filter(Boolean).slice(-ultimas).reverse()
  const pre = document.createElement("pre")
  pre.textContent = lineas.map((l) => bonito(l)).join("\n\n")
  return [pre]
}

async function cargarArchivo(nombre) {
  estado.archivo = nombre
  for (const boton of document.querySelectorAll(".pestanas button")) boton.setAttribute("aria-selected", String(boton.dataset.archivo === nombre))
  const visor = $("visor")
  try {
    const respuesta = await api(`/api/archivos/${nombre}`)
    const texto = respuesta.status === 204 ? "" : await respuesta.text()
    if (!texto.trim()) {
      visor.innerHTML = '<p class="vacio">Todavía no existe: se genera al procesar el buzón. El maestro parte del fixture congelado al 2026-05-30.</p>'
      return
    }
    if (nombre === "alertas") visor.innerHTML = markdown(texto)
    else if (nombre === "maestro") visor.replaceChildren(...tablaMaestro(texto))
    else visor.replaceChildren(...lineasJson(texto, nombre === "log" ? 60 : 30))
  } catch (error) {
    visor.textContent = error instanceof Error ? error.message : String(error)
  }
}

// ---------- Sesión ----------

function limpiarChat() {
  estado.tarjetas.clear()
  $("mensajes").replaceChildren()
  mostrarPendientes([])
}

async function restaurarSesion() {
  const respuesta = await api(`/api/sessions/${estado.sesion}`)
  if (!respuesta.ok) return
  const sesion = await respuesta.json()
  if (!sesion.eventos?.length) return
  limpiarChat()
  for (const e of sesion.eventos) {
    if (e.tipo === "usuario") burbujaUsuario(e.texto)
    else if (e.tipo === "herramienta") tarjeta({ nombre: e.llamada.nombre, argumentos: e.llamada.argumentos, llamada: e.llamada })
    else if (e.tipo === "asistente") burbujaAsistente(e.texto, e.pideConfirmacion)
  }
  mostrarPendientes(sesion.pendientes)
}

async function revisarSalud() {
  const pastilla = $("estado")
  try {
    const salud = await (await fetch("/api/health")).json()
    if (salud.accesoProtegido && !estado.clave) pedirClave()
    pastilla.textContent = salud.configurado ? `${salud.provider} · ${salud.model}` : "sin clave del modelo"
    pastilla.className = `pastilla ${salud.configurado ? "ok" : "error"}`
    pastilla.title = `Herramientas: ${salud.herramientas.join(", ")}`
  } catch {
    pastilla.textContent = "servidor no disponible"
    pastilla.className = "pastilla error"
  }
}

// ---------- Eventos de la página ----------

$("formulario").addEventListener("submit", (e) => {
  e.preventDefault()
  const texto = $("entrada").value
  $("entrada").value = ""
  enviar(texto)
})

$("entrada").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    $("formulario").requestSubmit()
  }
})

$("ejemplo").addEventListener("click", () => enviar(PROMPT_EJEMPLO))

$("confirmar").addEventListener("click", () => {
  const ids = estado.pendientes.map((p) => p.mensaje_id).join(", ")
  enviar(`Confirmo los valores propuestos para ${ids}.`)
})

$("corregir").addEventListener("click", () => {
  const primero = estado.pendientes[0]
  $("entrada").value = primero ? `Para ${primero.mensaje_id}, el campo ${primero.campos[0]} debe ser ` : ""
  $("entrada").focus()
})

$("nueva").addEventListener("click", () => {
  estado.sesion = nuevoIdSesion()
  limpiarChat()
})

$("reiniciar").addEventListener("click", async () => {
  if (!window.confirm("Esto borra out/ (maestro, historial, log) y todas las sesiones, y deja la demo como al inicio. ¿Continuar?")) return
  const respuesta = await api("/api/reset", { method: "POST" })
  if (!respuesta.ok) {
    burbujaError((await respuesta.json().catch(() => ({}))).error ?? "No se pudo reiniciar.")
    return
  }
  estado.sesion = nuevoIdSesion()
  limpiarChat()
  cargarArchivo(estado.archivo)
})

for (const boton of document.querySelectorAll(".pestanas button")) {
  boton.addEventListener("click", () => cargarArchivo(boton.dataset.archivo))
}

await revisarSalud()
if (sesionGuardada) await restaurarSesion().catch(() => {})
cargarArchivo(estado.archivo)
