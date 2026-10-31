# Registro de Contratos Vigentes — agente conversacional (reto 02)

Agente que actúa como punto único de recepción de contratos: lee el buzón, extrae los datos
de cada contrato con su confianza, detecta duplicados y otrosíes, registra en el maestro,
archiva el documento y pide confirmación humana antes de registrar algo dudoso. Al final
genera el reporte de alertas de vencimientos y pólizas.

**Enlace de prueba:** https://reto-02-soto.onrender.com (plan gratuito de Render: si estuvo
inactivo, la primera carga tarda unos 50 segundos en despertar).

## Requisitos

- [Bun](https://bun.sh) 1.1 o superior (probado con 1.4.4).
- Una clave de API de Anthropic para el chat. `demo.ts` y las pruebas no la necesitan.

## Instalación y arranque (un comando)

```bash
bun install
cp .env.example .env   # y completa ANTHROPIC_API_KEY
bun run dev            # front + API en http://localhost:3000
```

Alternativa con Docker: `docker compose up --build`.

## Variables de entorno

| Variable | Obligatoria | Por defecto | Para qué |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Sí, para el chat | — | Clave del modelo. Solo la lee el backend; nunca llega al front, a los logs ni a las respuestas. |
| `LLM_MODEL` | No | `claude-sonnet-5-5` | Modelo de Claude. |
| `LLM_EFFORT` | No | `medium` | Esfuerzo de razonamiento (`low`, `medium`, `high`). |
| `LLM_TIMEOUT_MS` | No | `90000` | Tiempo máximo por llamada al modelo. |
| `MAX_ITERACIONES` | No | `25` | Tope de iteraciones modelo → herramientas por turno. |
| `MAX_TOKENS_SESION` | No | `600000` | Tope de tokens por sesión. |
| `MAX_TOKENS_SERVIDOR` | No | `6000000` | Tope de tokens de todo el servidor. |
| `ACCESS_KEY` | No | — | Si se define, el link pide esta clave (encabezado `x-access-key`). |
| `PORT` | No | `3000` | Puerto HTTP. |

## Demo sin modelo

```bash
bun run demo.ts
```

Limpia `out/`, procesa los 6 mensajes llamando directamente a las herramientas, deja
`msg-006` sin registrar en la primera pasada, lo registra en una segunda llamada con
`confirmado: true`, genera `out/alertas.md` con fecha 2026-09-03, muestra los errores
controlados y verifica los objetivos O1–O4. Termina con código 1 si algún chequeo falla.

## Pruebas

```bash
bun test          # 44 pruebas: extracción, reglas RN1–RN7, ciclo del agente, API HTTP, módulo
bun run typecheck # TypeScript estricto, sin any
```

## Arquitectura

```
web/ (chat, HTML + JS)  ──HTTP/SSE──▶  src/app.ts (API)  ──▶  src/agente/ciclo.ts (bucle del agente)
                                                                 │            │
                                              src/llm/adapter.ts │            │ src/tools/contratos.ts (zod)
                                              src/llm/anthropic.ts            │        │
                                                                              ▼        ▼
                                                         fixtures/ (solo lectura)   out/ (escritura)
```

| Qué | Dónde |
|---|---|
| Comportamiento (system prompt) | `agent/prompt.md` |
| Conocimiento del proceso y parámetros de negocio | `src/knowledge/registro-contratos.md`, `src/knowledge/reglas.json` |
| Ejecución (herramientas, importables sin servidor) | `src/tools/contratos.ts` → lógica en `src/dominio/` |
| Ciclo del agente, sesiones, confirmación humana | `src/agente/` |
| Adaptador del modelo | `src/llm/adapter.ts` (interfaz) y `src/llm/anthropic.ts` |
| Módulo reutilizable (bonus) | `modulo/` (se regenera con `bun run modulo`) |

Archivos que genera en `out/`: `sharepoint/maestro-contratos.csv` (copia de trabajo del
maestro), `sharepoint/Contratos/<año>/<cliente>/…` (documentos archivados),
`sharepoint/historial.jsonl`, `procesados.json`, `log.jsonl` y `alertas.md`.

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, pendientes[], tokensSesion }`. Con `Accept: text/event-stream` transmite eventos `herramienta_inicio`, `herramienta_fin`, `nota` y `fin`. |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión y revisiones pendientes. |
| `GET` | `/api/health` | `{ ok, provider, model, configurado, accesoProtegido, herramientas }`, sin la clave. |
| `GET` | `/api/archivos/:nombre` | `alertas`, `maestro`, `historial`, `procesados` o `log` (texto). |
| `POST` | `/api/reset` | Borra `out/` y las sesiones: deja la demo como al inicio. |

## Prompt de ejemplo

```
Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que
esté limpio, muéstrame lo que requiere revisión campo por campo y termina
con el reporte de alertas. No registres nada dudoso sin preguntarme.
```

Luego: `confirmo el valor 0 y la fecha fin 2027-08-31` (o el botón **Confirmo los valores propuestos**).

## Despliegue

Desplegado en Render como Web Service con Docker (plan gratuito), desde este repositorio,
con redespliegue automático en cada push a `main` y `/api/health` como chequeo de salud.
La clave del modelo se define en Render → servicio → **Environment** → `ANTHROPIC_API_KEY`
(y opcionalmente `ACCESS_KEY`). También se puede crear con **New → Blueprint** usando
`render.yaml`. El disco es efímero: `out/` se reinicia en cada despliegue y el botón
**Reiniciar demo** lo deja como al inicio.

## Uso de IA

Resumen en la sección 10 de `SOLUCION.md`; pasos detallados en `docs/bitacora-uso-ia.md`.
