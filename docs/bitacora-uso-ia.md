# Bitácora de uso de IA — reto 02

Registro de cómo usé asistentes de IA para construir y entregar este reto, en el orden en
que ocurrió (30 de octubre de 2026). Complementa la sección 10 de `SOLUCION.md`.

## Herramientas

| Herramienta | Modelo | Uso |
|---|---|---|
| Claude Code, en la app de escritorio de Claude (Windows) | Claude Opus 5.5 | Análisis del PRD, diseño, código, pruebas, verificación en navegador, documentación, publicación del repositorio y despliegue. |
| Navegador integrado de la app de Claude | — | Revisión visual del front, autorización de GitHub CLI con código de dispositivo, configuración de Render. |
| Claude Sonnet 5.5 (API de Anthropic) | `claude-sonnet-5-5` | Es el modelo **que usa el agente** en ejecución, no una herramienta de desarrollo. |

Cada commit generado con la asistencia lleva la línea `Co-Authored-By: Claude Opus 5.5`.

## Pasos

| # | Qué pedí | Qué hizo la IA | Cómo lo verifiqué / qué decidí yo |
|---|---|---|---|
| 1 | Resolver el reto 2 del zip de retos. | Extrajo el zip en una carpeta temporal, leyó el PRD y los fixtures del reto 02 y detectó que la PC no tenía Node ni Bun. | Elegí instalar Bun (winget, paquete oficial) y usar Anthropic como proveedor. |
| 2 | — | Propuso la arquitectura: herramientas tipadas con zod separadas del servidor, extracción determinista, CSV como maestro, ciclo propio del agente. Consultó la referencia actual de la API de Claude antes de escribir el adaptador. | Acepté la extracción determinista (ver "Propuestas descartadas"). |
| 3 | — | Escribió las reglas de negocio (`reglas.json`), el conocimiento del proceso, la extracción, la validación RN1–RN5, el registro y las alertas, y `demo.ts`. | `bun run demo.ts`: los 6 mensajes salieron con la clasificación esperada y 9/9 chequeos al primer intento. |
| 4 | — | Corrigió lo que vio en la salida de la demo: fechas UTC frente a locales en el historial, campos "no aplica" de un otrosí marcados como baja confianza, la etiqueta "cotizacion" sin tilde y mensajes de zod en inglés. | Volví a correr la demo y el typecheck. |
| 5 | — | Escribió el adaptador de Claude (SDK oficial, caché de prompt, timeout, fallback del servidor), el ciclo del agente con tope de iteraciones y tokens, la política de confirmación humana por turnos, la API HTTP con SSE y el front de chat. | 41 pruebas automáticas, incluidas las del ciclo con un proveedor falso (CA1, CA3, CA5). |
| 6 | — | Levantó la app con un proveedor de guion **solo en una carpeta temporal** para revisar el front en el navegador integrado: tarjetas de herramientas, confirmación, panel de archivos, vista móvil. | Encontró y corrigió dos defectos visuales: el aviso de confirmación no se ocultaba y la vista móvil se desbordaba. El guion no quedó en el repositorio. |
| 7 | — | Generó `modulo/` (bonus) desde las mismas fuentes que usa la app y una prueba que falla si divergen. | 43 pruebas en verde. |
| 8 | Priorizar lo obligatorio del PRD, no rehacer lo que funciona, no sumar extras y documentar. | Siguió desde el estado actual: escribió README y SOLUCION, corrió la demo dos veces para comprobar determinismo, levantó el servidor real sin clave y generó el zip de entrega. | Confirmé que el fixture no cambió (`git status fixtures` vacío) y que el zip no trae `node_modules`, `out` ni `.env`. |
| 9 | Subir el repositorio como privado y desplegar en Render con mis cuentas. | Detectó que la línea de comandos estaba conectada a otra cuenta de GitHub y pidió permiso antes de autorizar nada. Con mi autorización: conectó GitHub CLI a mi cuenta personal por código de dispositivo, creó el repo privado `Jhefersonsotoloyola/reto-02-soto` con el historial, agregó ese repo (solo ese) a la app de Render en GitHub y creó el servicio web en Render con el plan gratuito y `/api/health` como chequeo. | La clave de Anthropic no la escribió la IA: la pegué yo en Render (Environment → `ANTHROPIC_API_KEY`). |
| 10 | Comprobar la app publicada con la clave. | La primera llamada llegó a Anthropic, pero la cuenta no tenía saldo; la app mostró el error en el chat y la sesión siguió viva. La IA cambió el mensaje para que saliera en español y sin JSON, con una prueba nueva (44 en total), y lo desplegó. | Reclamé yo los USD 200 en créditos de API que incluye mi plan (Claude Console → "Vincular y reclamar"); la IA no aceptó términos por mí. |
| 11 | "Revísalo tú." | Reinició los datos de la demo y, en el enlace público, envió el prompt de ejemplo del PRD: 18 llamadas a herramientas, los 6 mensajes con la clasificación esperada y msg-006 detenido con la pregunta de confirmación. Después envió "confirmo el valor 0 y la fecha fin 2027-08-31": msg-006 quedó registrado como CM-2026-03. Por último pidió regenerar las alertas. | Revisó en el servidor el maestro (11 filas, sin duplicados), el historial (3 altas, una confirmada por la usuaria, y 1 actualización con antes/después), `procesados.json` (6 mensajes), el log (20 llamadas, 0 errores) y `alertas.md` (3 secciones). |

## Propuestas descartadas y por qué

- **Extraer los campos del contrato con el modelo.** Lo descarté: el PRD exige que el modelo no
  afirme valores que no salgan de una herramienta (CA2), la demo debe correr sin clave y el
  resultado debe ser reproducible.
- **Deduplicar contratos solo por NIT.** Habría marcado CT-2026-015 como actualización de
  CT-2025-018 (mismo cliente, otro objeto).
- **Llamar a la API con `fetch` directo.** Se usó el SDK oficial: errores tipados, reintentos y timeout.
- **Confiar la confirmación humana solo al prompt.** Se pasó a una regla del servidor que
  bloquea `confirmado: true` hasta que la usuaria responde.
- **Dejar un "modo demo" con respuestas simuladas del modelo en la app.** Solo se usó para
  revisar el front en local; la app desplegada conversa únicamente con un modelo real.
- **Copiar el PRD de Periferia dentro del repositorio.** Se dejó fuera para no publicarlo.
- **Usar la cuenta de GitHub de la empresa para el repositorio.** Elegí mi cuenta personal.

## Cómo comprobar lo entregado

```bash
bun install
bun run demo.ts     # 6 mensajes, segunda pasada con confirmado: true, alertas, 9 chequeos
bun test            # 44 pruebas
bun run typecheck   # TypeScript estricto
git log --format="%h %s%n%b" | grep -c "Co-Authored-By: Claude"   # commits asistidos
```
