---
name: registro-contratos
description: Proceso de registro de contratos vigentes de Periferia (reglas RN1-RN7, cálculo de confianza, campos del maestro, alertas y regla de gobierno). Úsala al procesar el buzón de contratos o al responder sobre vigencias y pólizas.
---

# Conocimiento del proceso: Registro de Contratos Vigentes

Este documento describe el proceso que el agente opera. Los parámetros numéricos
(umbral de confianza, días de alerta, fecha de corte, similitud) viven en
`src/knowledge/reglas.json`; las herramientas los leen de ahí. Cambiar una regla
es editar ese archivo, no el servidor.

## Para qué existe

El maestro de contratos vigentes estuvo congelado desde el 2026-05-30 porque lo
alimentaba una sola persona y solo llegaban los contratos con póliza. El buzón
único `contratos@periferia-ficticia.com` reemplaza ese flujo: todo contrato,
otrosí o acta firmada entra por ahí, con o sin póliza.

## Flujo por mensaje

1. `contratos_leer_buzon`: lista los mensajes pendientes (los que no están en
   `out/procesados.json`). Un mensaje sin contrato ni otrosí adjunto ya viene
   marcado como `rechazado` con su motivo.
2. `contratos_extraer`: lee el adjunto y devuelve los campos del contrato con una
   confianza entre 0 y 1 y la evidencia (el fragmento de texto de donde salió
   cada valor). Un campo que no está en el texto es `null` con confianza 0.
3. `contratos_validar`: clasifica el mensaje contra el maestro y lista los campos
   que necesitan revisión humana.
4. `contratos_registrar`: escribe en el maestro, archiva el documento, deja el
   cambio en el historial y cierra el mensaje en el buzón. También cierra los
   duplicados y los rechazados, sin escribir en el maestro.
5. `contratos_alertas`: genera `out/alertas.md` para gerencia.

## Clasificación (reglas RN1–RN4)

| Clasificación | Cuándo | Qué se escribe |
|---|---|---|
| `duplicado` (RN1) | Mismo `id_contrato` con el mismo `valor`, `fecha_inicio` y `fecha_fin`. También un otrosí cuyos cambios ya están aplicados, o un contrato del mismo cliente con objeto similar (≥ 0.9) sin ningún campo clave distinto. | Nada en el maestro. Solo se cierra el mensaje. |
| `actualizacion` (RN2) | Es un otrosí de un contrato del maestro, o mismo `id_contrato` con algún campo clave distinto, o mismo `nit_cliente` con objeto similar (≥ 0.9) y algún campo clave distinto. | Se modifica la fila existente y el cambio queda en `historial.jsonl` con el valor anterior y el nuevo. |
| `nuevo` (RN3) | No hay coincidencia. | Fila nueva en el maestro. |
| `rechazado` (RN4) | El mensaje no trae contrato (cotización, pregunta), el texto no permite identificar partes ni objeto, o es un otrosí de un contrato que no está en el maestro. | Nada en el maestro. Se cierra el mensaje con el motivo. |

El mismo cliente puede tener varios contratos. Coincidir solo por NIT no basta
para hablar de actualización: el objeto también debe coincidir.

## Revisión humana (RN5)

- Todo campo obligatorio con confianza menor al umbral (0.8) entra en
  `requiere_revision`.
- Todo valor que el agente proponga distinto a lo que extrajo la herramienta
  también entra en revisión: el agente puede proponer, la persona confirma.
- `contratos_registrar` rechaza el registro mientras haya campos en revisión,
  salvo que se llame con `confirmado: true`. Ese `true` solo es válido después de
  que la usuaria respondió que confirma; el servidor lo bloquea si se intenta en
  el mismo turno en que se detectó la revisión.

## Cómo se calcula la confianza

| Situación | Confianza |
|---|---|
| Valor en letras y en números que coinciden | 0.98 |
| Valor solo en números | 0.85 |
| Valor en letras y números que no coinciden | 0.5 |
| Contrato por demanda o sin valor determinado (se registra `0`) | 0.6 |
| Fechas explícitas "desde … hasta …" coherentes con el plazo en meses | 0.98 |
| Fechas explícitas sin plazo en meses para contrastar | 0.95 |
| `fecha_fin` derivada de un plazo en meses | 0.6 |
| Fecha de firma sin día (solo mes y año): se toma el último día del mes | 0.8 |
| Póliza con cláusula de garantías explícita | 0.95 |
| Póliza condicionada (por ejemplo, solo para órdenes de cierto valor) | 0.85 |
| Contrato sin ninguna mención de pólizas o garantías | 0.85 |
| El correo del comercial contradice el contrato sobre la póliza | 0.6 |

Una `fecha_fin` derivada de meses sigue la regla de calendario: el plazo termina el
mismo día del mes correspondiente (12 meses desde el 2026-08-31 terminan el
2027-08-31).

## Campos que se completan al registrar

| Campo | Regla |
|---|---|
| `id_contrato` | El número del documento. Si no tiene, `AUTO-<año de inicio>-<secuencia de 3 dígitos>`. |
| `estado_poliza` | Contrato nuevo con póliza → `pendiente`. Sin póliza → `no_aplica`. |
| `comercial` | Nombre del remitente según `comerciales.json`. Si el remitente no está registrado: `No registrado: <correo>`; se reporta pero no bloquea. |
| `ruta_sharepoint` | `Contratos/<año de inicio>/<cliente-slug>/<id_contrato>.<ext>`. Un otrosí se archiva junto al contrato como `<id_contrato>-otrosi-<n>.<ext>`. |
| `fecha_registro` | Fecha del día en que se registra. |
| `fuente` | `buzon` para todo lo que entra por este agente. |

Un otrosí que amplía `fecha_fin` de un contrato con póliza deja `estado_poliza` en
`pendiente`: la póliza vigente no cubre el nuevo plazo hasta que la aseguradora
emita la ampliación.

## Alertas para gerencia

`out/alertas.md` tiene tres secciones, calculadas con la fecha `hoy` que se le
pasa a la herramienta:

1. Contratos que vencen en 60 días o menos (y, aparte, los que ya vencieron sin
   renovación registrada).
2. Pólizas pendientes: `requiere_poliza = true` y `estado_poliza` distinto de
   `vigente`.
3. Contratos registrados o actualizados desde el corte del 2026-05-30: muestra
   cuánto del vacío de junio a agosto ya se cubrió.

## Regla de gobierno, en corto

- Canal único: `contratos@periferia-ficticia.com`, administrado por la analista
  administrativa, dueña del maestro.
- El comercial envía el PDF firmado, sus otrosíes y actas de terminación dentro de
  los 3 días hábiles siguientes a la firma, con asunto
  `[CONTRATO] <Cliente> - <Número>` (o `[OTROSÍ]`, `[ACTA]`).
- Un remitente que no está en `comerciales.json` se procesa igual y se reporta a la
  gerencia comercial para que asigne responsable.
- Contrato sin firma o sin valor: no se registra hasta que la analista confirme
  con el comercial; si en 5 días hábiles no hay respuesta, se escala a gerencia
  comercial.
