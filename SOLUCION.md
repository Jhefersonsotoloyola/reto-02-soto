# SOLUCIÓN — Reto 02: Registro de Contratos Vigentes

## 1. Problema en una frase

Desde el 2026-05-30 nadie alimenta el maestro de contratos y solo llegan a administración
los que tienen póliza, así que **la dirección no sabe qué contratos están vigentes, cuáles
vencen ni qué pólizas faltan**; le duele a la analista administrativa (dueña del maestro),
a gerencia (sin visibilidad de riesgo) y a la empresa (pólizas exigidas que no se
constituyen).

## 2. Arquitectura

```
┌────────────┐ POST /api/chat (SSE) ┌───────────────────────────────────────────┐
│ web/       │ ───────────────────▶ │ src/app.ts  API HTTP, sesiones en memoria │
│ chat +     │ ◀─────────────────── │ src/agente/ciclo.ts  bucle del agente     │
│ tarjetas de│  eventos por llamada │   ├─ src/llm/adapter.ts  interfaz propia   │
│ herramienta│                      │   │   └─ src/llm/anthropic.ts (SDK)        │
│ + visor out│                      │   ├─ src/agente/confirmaciones.ts (CA3)    │
└────────────┘                      │   └─ src/tools/contratos.ts (zod)          │
                                    │        └─ src/dominio/* (reglas)          │
                                    └──────────┬──────────────────┬─────────────┘
                                               │                  │
                                  fixtures/ (solo lectura)   out/ (maestro, archivo,
                                                             historial, log, alertas)
```

| Capa | Archivo | Qué cambia ahí |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Cómo conversa el agente, cuándo pregunta, formato de respuesta. |
| Conocimiento | `src/knowledge/registro-contratos.md` y `reglas.json` | Reglas RN1–RN7, tabla de confianza, umbral 0.8, 60 días, corte, similitud 0.9, tipos de póliza. |
| Ejecución | `src/tools/contratos.ts` → `src/dominio/` | Extracción, validación, registro, alertas. Importable sin el servidor (`demo.ts`, `modulo/`). |

Un cambio de reglas de negocio se hace en `reglas.json` o en el conocimiento; el servidor
no se toca. El prompt y el conocimiento se leen al abrir cada sesión.

## 3. Ciclo del agente

`src/agente/ciclo.ts`, por turno:

1. Agrega el mensaje de la usuaria al historial de la sesión.
2. Llama al modelo con el prompt de sistema (fijado al crear la sesión), el historial y las
   definiciones de herramientas (JSON Schema generado desde zod).
3. Si el modelo pide herramientas, el backend valida los argumentos con zod; si no cumplen,
   devuelve el error al modelo sin ejecutar. Las ejecuta **en serie** (dos registros en
   paralelo escribirían el mismo CSV), emite cada llamada al front por SSE y la deja en el
   historial visible y en `out/log.jsonl`.
4. Repite hasta que el modelo responde sin herramientas.

Topes y errores:

- **CA1:** `MAX_ITERACIONES` (25). Al alcanzarlo agrego un aviso de sistema y hago una última
  llamada con `tool_choice: none` para que diga qué hizo y qué falta.
- **Costo:** tope de tokens por sesión y por servidor; timeout por llamada al modelo.
- **CA5:** un error del proveedor (timeout, clave, límite) se traduce a un mensaje claro en el
  chat; la sesión sigue viva. Una herramienta nunca lanza: devuelve `{ ok: false, error }`.

**Confirmación humana (CA3) en código, no solo en el prompt.** `confirmaciones.ts` anota las
revisiones pendientes cuando `contratos_validar` o `contratos_registrar` reportan campos en
revisión, con el turno en que se detectaron. Una llamada a `contratos_registrar` con
`confirmado: true` se bloquea si no hay revisión pendiente para ese mensaje o si se detectó
en el mismo turno: el modelo no puede "autoconfirmarse"; necesita un mensaje nuevo de la
usuaria. El front resalta ese estado (respuesta en ámbar y barra con botones **Confirmo** /
**Corregir**).

## 4. Elección del modelo

**Claude Sonnet 5.5** (`claude-sonnet-5-5`, Anthropic), esfuerzo `medium`, configurable por
`LLM_MODEL`/`LLM_EFFORT`.

- El trabajo del modelo es orquestar herramientas y redactar en español; la extracción no
  depende de él. Sonnet es fiable en tool use de varios pasos a la mitad de precio que Opus 5.5.
- Uso el SDK oficial con caché de prompt (el prefijo herramientas + sistema + historial se
  relee a 0.1x en cada iteración) y el respaldo del servidor (`fallbacks: "default"`) por si
  un clasificador de seguridad declina.

**Costo estimado por caso** (precios de Sonnet 5.5: US$2 / 10 por millón de tokens de entrada /
salida; lectura de caché US$0.20): procesar el buzón completo son unas 6–7 llamadas al modelo
con un contexto que crece de ~5 000 a ~25 000 tokens. Con caché: ~90 000 tokens leídos de caché
(US$0.02) + ~25 000 escritos (US$0.06) + ~6 000 de salida (US$0.06) ≈ **US$0.15 por lote, unos
US$0.025 por contrato**. El consumo real de cada sesión queda en `tokensSesion` de la
respuesta de `/api/chat`.

**Medido en el enlace público (2026-10-30):** el prompt de ejemplo del PRD procesó los 6
mensajes en un turno de unos 20 segundos, con 18 llamadas a herramientas y 58 755 tokens
procesados en total, incluidos los leídos de caché. La sesión completa (procesar, confirmar
msg-006 y regenerar alertas) sumó 159 052 tokens en 3 turnos.

## 5. Estrategia de extracción

Determinista, sobre el texto del adjunto (`src/dominio/extraccion.ts`). El modelo no extrae ni
corrige valores: puede proponer un valor y la herramienta lo trata como propuesta.

| Campo | Cómo se encuentra |
|---|---|
| Tipo de documento | Primera línea: "CONTRATO…", "OTROSÍ…"; cualquier otra cosa (cotización) → rechazado. |
| Número | Patrón `XX-AAAA-NNN` en el encabezado; en un otrosí, el del contrato modificado. |
| Partes | Preámbulo: `RAZÓN SOCIAL, identificada con NIT/RUC/RTN …`. Se descarta a Periferia por su NIT; la otra es el cliente. La grafía se toma del bloque de firmas. |
| País | Formato del identificador (`reglas.json`) contrastado con la ciudad del domicilio. |
| Objeto | Cláusula OBJETO, sin el "EL CONTRATISTA se obliga a…", máximo 200 caracteres. |
| Valor y moneda | Cláusula VALOR: el monto en letras se convierte a número y se compara con la cifra; el código (COP, USD…) se compara con la palabra (pesos, dólares…). "Sin valor determinado" → 0. |
| Plazo | "desde … hasta …" se contrasta con el plazo en meses. "N meses a partir de la firma" → fin derivado por calendario (el mismo día del mes correspondiente). |
| Póliza | Cláusula de garantías; tipos por palabras clave; se contrasta con lo que dice el correo del comercial. |

**Confianza:** cada regla asigna un valor según cuánta evidencia coincide (tabla completa en
`src/knowledge/registro-contratos.md`). Ejemplos: letras = número → 0.98; solo número → 0.85;
letras ≠ número → 0.5; valor por demanda → 0.6; fecha fin derivada de meses → 0.6; firma sin
día → 0.8. Un campo ausente es `null` con confianza 0. Cada campo trae su **evidencia**
(el fragmento del texto), que el agente muestra al pedir confirmación.

**Doble control contra valores inventados:** `contratos_registrar` vuelve a extraer y validar
desde el documento; si el agente envía un valor distinto al extraído, ese campo pasa a revisión
y exige `confirmado: true`.

## 6. Regla de gobierno (propuesta)

1. **Canal único.** `contratos@periferia-ficticia.com`. Lo administra la analista
   administrativa, dueña del maestro, con un suplente nombrado en Administración para
   vacaciones y rotación. Sin área legal interna, **el dueño del maestro es Administración**;
   Gerencia Administrativa aprueba excepciones. (Responde la pregunta abierta de la sección 10
   del PRD.)
2. **Obligación del comercial.** Enviar al buzón todo contrato firmado por ambas partes, con o
   sin póliza, y sus otrosíes, prórrogas y actas de inicio o terminación, **en los 3 días
   hábiles siguientes a la firma**, un documento por correo, con asunto
   `[CONTRATO] Cliente - Número`, `[OTROSÍ] Cliente - Número` o `[ACTA] Cliente - Número`.
3. **Acuse automático.** En cada procesamiento (programado cada hora en producción) el agente
   responde al remitente: "registrado como CT-xxx", "en revisión: falta X" o "rechazado:
   motivo". Meta: acuse el mismo día hábil.
4. **Excepciones y escalamiento.** Sin firma o sin partes identificables: se rechaza y se pide
   la versión firmada. Sin valor o con campos dudosos: no se registra hasta que la analista
   confirme con el comercial; si en 5 días hábiles no hay respuesta, se escala al gerente
   comercial. Remitente no registrado: se procesa y se avisa a gerencia comercial para darlo de
   alta. Contrato con póliza: la analista inicia el trámite con el corredor ese mismo día.
5. **Cierre del gap junio–agosto 2026 (una campaña de dos semanas).** Finanzas entrega la lista
   de clientes facturados de junio a octubre; se cruza con el maestro y se envía a cada
   comercial la lista de sus contratos faltantes; cada comercial los reenvía al buzón con el
   asunto normal en una semana; el agente los procesa como cualquier otro mensaje y la sección
   "registrados desde el corte" de `alertas.md` mide el avance. Lo que falte al cierre se escala
   a gerencia comercial.
6. **Indicador mensual.** **Cobertura del maestro** = contratos con facturación en el mes que
   existen en el maestro / contratos facturados en el mes. Meta ≥ 95 %. Complementario: días
   entre la firma y el registro (mediana ≤ 3 días hábiles).

## 7. Decisiones y trade-offs

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Extracción determinista (regex y reglas) con confianza por campo. | Que el modelo extraiga los campos del texto. | Cumple CA2 por diseño: el valor registrado sale de código auditable y reproducible, `demo.ts` corre sin modelo y no hay costo por extracción. Costo: formatos muy distintos bajan la confianza y caen en revisión humana. |
| `contratos_registrar` revalida desde el documento y trata como propuesta lo que envía el agente. | Registrar el objeto `contrato` tal como lo manda el modelo. | Evita el riesgo del PRD de que el modelo "redondee" o invente un valor. Costo: se repite la extracción (milisegundos). |
| Confirmación humana aplicada por el servidor (política por turnos). | Confiar en que el prompt le pida al modelo esperar. | Un prompt se puede ignorar; el bloqueo en código no. |
| Herramientas en serie y escritura síncrona del CSV. | Ejecutar en paralelo o usar una base de datos. | El PRD pide CSV y sin base de datos; en serie no hay carreras sobre el maestro. En producción iría una lista de SharePoint con control de versión. |
| Similitud de Dice sobre bigramas para "mismo objeto" (umbral 0.9). | Deduplicar solo por NIT. | Industrias Delta y Corporación Andina ya tienen otros contratos: por NIT se marcarían como actualización por error. |
| SSE para transmitir las llamadas. | WebSocket o respuesta única. | Un turno es unidireccional; SSE basta y el usuario ve cada herramienta mientras ocurre. |

**Dependencias** (sección 8 del PRD: "las que necesites, justificadas"):

| Paquete | Para qué | Por qué este |
|---|---|---|
| `zod` | Argumentos de las herramientas (obligatorio por el PRD), configuración (`config.ts`), reglas (`reglas.json`) y cuerpo HTTP. Genera también el JSON Schema que ve el modelo. | Un solo esquema valida y documenta; sin duplicar tipos. |
| `@anthropic-ai/sdk` | Adaptador del modelo (`src/llm/anthropic.ts`). | Errores tipados, reintentos, timeout y caché de prompt; descarté `fetch` directo. |
| `marked` + `dompurify` | Mostrar en el chat el Markdown y las tablas del agente (`web/app.js`). | Sin paso de build; `dompurify` sanea el HTML para que un correo con contenido malicioso no inyecte código en el front. |
| `unpdf` | `contratos_leer_pdf` (P1): texto de PDF nativo. | Escrito en JS, sin binarios del sistema ni comandos de shell (requisito de seguridad). |
| `typescript`, `@types/bun` (desarrollo) | `tsc --noEmit` estricto. | No entran en la imagen de producción (`bun install --production`). |

## 8. Supuestos

Los dos supuestos de la sección 10 del PRD, y cómo los tomé:

- **Los contratos llegan con texto, no escaneados.** Los fixtures traen `contrato.txt`; un PDF
  nativo se lee con `contratos_leer_pdf`. Un escaneado se reporta como "sin texto extraíble
  (necesitaría OCR)", que queda para producción.
- **El comercial cumple la regla de gobierno** (sección 6). Sin ella el agente solo registra lo
  que llega al buzón, igual que hoy; el indicador de cobertura mensual es lo que lo detecta.

Supuestos propios al interpretar el PRD:

- El NIT 900.123.456-7 identifica a Periferia (EL CONTRATISTA); la otra parte es el cliente.
- "N meses a partir de la firma": el inicio es la fecha de firma. Si la firma solo dice mes y
  año (msg-006), se toma el último día del mes (confianza 0.8) y el fin se deriva por
  calendario: 2026-08-31 + 12 meses = 2027-08-31, en revisión.
- La póliza condicionada de msg-006 (solo órdenes > COP 100 M) cuenta como `requiere_poliza =
  true`, tipo cumplimiento, estado pendiente.
- Un otrosí que amplía el plazo de un contrato con póliza deja `estado_poliza = pendiente`: la
  póliza vigente no cubre el nuevo plazo hasta que se amplíe (el otrosí de msg-003 lo exige).
- Duplicados y rechazados también se cierran con `contratos_registrar` (quedan en
  `procesados.json`) sin escribir en el maestro ni en el historial.
- Un otrosí de un contrato que no está en el maestro se rechaza con motivo.
- `fecha_registro` es la fecha real del registro; `hoy` solo es la referencia de las alertas.
- Remitente no registrado: `comercial = "No registrado: <correo>"`.
- En una actualización no se sobrescriben `cliente` ni `objeto` del maestro: solo valor,
  moneda, fechas y póliza.
- Los documentos se archivan con su extensión original (`.txt` en los fixtures).

## 9. Cobertura

| Historia / requisito | Estado | Evidencia |
|---|---|---|
| HU-1 Leer el buzón | Hecho | `contratos_leer_buzon`; msg-005 marcado `rechazado` con motivo. |
| HU-2 Extraer | Hecho | Esquema 7.2 con confianza y evidencia por campo; ausentes en `null`/0. |
| HU-3 Validar y clasificar | Hecho | RN1–RN4; `requiere_revision`; remitente desconocido reportado sin bloquear. |
| HU-4 Registrar y archivar | Hecho | Copia del maestro en `out/sharepoint/`, archivo por año/cliente, `historial.jsonl`, `procesados.json`. |
| HU-5 Alertas | Hecho | `out/alertas.md` con las tres secciones y `hoy` como argumento. |
| HU-6 Errores | Hecho | `{ ok: false, error }` legible; el lote sigue (sección 5 de `demo.ts`). |
| CA1–CA5 | Hecho | Pruebas en `tests/ciclo.test.ts`. |
| `demo.ts` sin modelo | Hecho | 9 chequeos de O1–O4 y RN7. |
| Bonus `modulo/` | Hecho | Prompt y skill generados de las mismas fuentes; herramientas re-exportadas; prueba de sincronía. |
| P1 `contratos_leer_pdf` | Hecho, sin prueba con PDF real | Solo PDF con texto; un escaneado se reporta como "necesita OCR". |
| Link público | Hecho | https://reto-02-soto.onrender.com (Render, plan gratuito). Probado de punta a punta con Claude Sonnet 5.5: prompt del PRD, confirmación de msg-006 y alertas. |

Para producción faltaría: conector real de Exchange/Graph y de SharePoint, OCR para
escaneados, acuse automático por correo, ejecución programada, persistencia de sesiones y
autenticación de la analista.

## 10. Uso de IA

| Herramienta | Para qué |
|---|---|
| Claude Code (modelo Claude Opus 5.5), en la app de escritorio de Claude | Leer el PRD y los fixtures, proponer la arquitectura, escribir el código de herramientas, ciclo, adaptador, front y pruebas, ejecutar `demo.ts` y las pruebas, revisar el front en un navegador, redactar borradores de README y de este documento, publicar el repositorio privado y desplegar en Render. |

El paso a paso (qué pedí, qué hizo la IA y cómo lo verifiqué) está en `docs/bitacora-uso-ia.md`.

Lo que descarté de lo propuesto o considerado durante el desarrollo:

- **Extraer los campos con el modelo:** lo descarté por CA2, costo y determinismo (sección 7).
- **Deduplicar por NIT:** habría marcado CT-2026-015 como actualización de CT-2025-018.
- **Llamar a la API con `fetch` directo:** usé el SDK oficial por sus errores tipados, reintentos y timeout.
- **Confirmación solo por prompt:** la pasé a una política del servidor.
- **Un "modo demo" con respuestas simuladas del modelo en la app:** lo usé solo para revisar el
  front en local y no lo incluí en el repositorio; la app solo conversa con un modelo real.

Revisé y probé cada módulo (47 pruebas, `demo.ts`, typecheck estricto) y puedo explicar
cada línea entregada.

## 11. Riesgos de llevarlo a producción

| Riesgo | Mitigación |
|---|---|
| Contratos escaneados o con formatos distintos: la extracción falla. | OCR antes de extraer; una confianza baja ya cae en revisión humana; ampliar patrones con los casos reales. |
| Falsos duplicados por variaciones en el nombre del cliente ("INDUSTRIAS DELTA" frente a "Industrias Delta S.A.S."). | La deduplicación nunca compara nombres: usa `id_contrato` y, si no coincide, `nit_cliente` + objeto con similitud ≥ 0.9 (`reglas.json`). Probado: CT-2026-015 entra como nuevo aunque Industrias Delta ya tenga CT-2025-018. |
| El modelo "redondea" el valor o infiere una fecha. | El valor registrado sale de la herramienta; cualquier diferencia exige confirmación humana (sección 5). |
| Instrucciones maliciosas dentro de un correo o adjunto (prompt injection). | El prompt trata el contenido como datos; las herramientas solo escriben en el maestro por reglas fijas, no ejecutan comandos y no aceptan rutas fuera del proyecto. |
| Dos procesos escribiendo el maestro a la vez. | Un solo proceso programado; en SharePoint, control de concurrencia por versión (ETag). |
| Gasto descontrolado de la clave. | Topes configurables de iteraciones y de tokens por sesión y por servidor. El tope del servidor vive en memoria y se reinicia con el proceso, así que la clave lleva además un límite de gasto mensual en la consola del proveedor. Clave de acceso opcional al link. |
| Caída o cambio del proveedor de modelo. | Adaptador desacoplado: otro proveedor es otra implementación de `ProveedorLLM`; `demo.ts` sigue operando sin modelo. |
| Datos personales (representantes legales) en logs. | El log guarda solo resúmenes; en producción, retención limitada y acceso restringido. |
| El proceso vuelve a depender de una persona. | Regla de gobierno con suplente, indicador mensual de cobertura y conocimiento documentado en el repositorio. |
