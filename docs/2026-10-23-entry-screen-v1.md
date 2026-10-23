# Pantalla de entrada v1 — una sola pantalla con intención cercada (misión scouting, tramo E-B2)

## Contexto

El selector de entrada (`entry-step`, chrome del shell suprimido) era un
flujo de dos pestañas («Mi equipo» / «Mi club») con título visible «Elige
tu perfil»: solo se veía un bloque a la vez y la activación
(`activateContext` / `enterPersonalTeam`) liberaba `_entryBusy` en cada
`finally`, incluidos caminos anidados (crear→entrar, canjear→activar) —
una respuesta tardía podía soltar el busy de una operación nueva, repintar
sobre un scope distinto o emitir el evento dos veces.

La misión `2026-10-23-scouting-team-player` (tramo «Entrada y login»,
diseño `handoff/outbox/2026-10-23-entry-login-architecture/README.md`
§3/§4.2/§7/§8 y prototipo `handoff/outbox/2026-10-23-entry-prototype-v1/`)
fija una pantalla única con entrada directa por tarjeta.

## Decisión (23 October 2026)

- **Una pantalla, sin pestañas ni título visible.** `h1` oculto
  («Entrar en BasketIQ») para accesibilidad; bloques «Mi equipo»
  (etiqueta `ENTRY_TEAM_ROLE_LABEL` = «Entrenador») y «Mi club»
  renderizados juntos, con los copies del prototipo. «Salir», crear y
  canjear quedan como acciones secundarias.
- **PD-ENTRY (Director 2026-10-23).** «Mi equipo» muestra los equipos
  que entrenas; «Mi club» NO se muestra a un entrenador. Como el
  bootstrap no proyecta rol ni catálogo de equipos de club, el universo
  «entrenado» atestiguable en entrada es el feed de equipos personales:
  un entrenador confirmado (feed cargado con ≥1 equipo activo) ve solo
  «Mi equipo». Mientras el feed carga o tras su error acotado, el bloque
  de club permanece — ocultarlo dejaría membresías sin acceso por un
  fallo de feed. Los equipos archivados no hacen entrenador. El bloque
  «Mi club» no lleva etiqueta de rol: el feed no atestigua «Director
  deportivo» para toda membresía (PD-CLUBS: sin rol en los accesos).
  La invitación por correo queda fuera del bloque y sigue al alcance de
  un entrenador.
- **Tarjeta completa = botón.** Equipo: nombre + categoría/composición
  (`teamMeta`), sin contador de jugadores. Club: solo nombre — no hay
  fuente autoritativa de localidad ni de nº de equipos, así que no se
  pinta nada más. Sin línea de rol dentro de la tarjeta de club.
- **Ayuda Chispa compacta.** `app/src/assets/chispa-head-compact-v2.svg`
  (sha256 `1b1c51a6…e9c9`, fijado por test) empaquetado como data-URI.
  Diálogo con `role=dialog`/`aria-modal`, título+párrafo+listas, Escape,
  retorno de foco al disparador y fondo `inert`. Sustituye al modal
  genérico y al `chispa-speaking.svg` hospedado que solo usaba esta ayuda.
- **Intención de entrada cercada.** `_beginEntryIntent(kind, {club_id?,
  team_id?})` congela `{gen, account_id, contextEpoch}`; un solo intent en
  vuelo (`_entryIntent !== null` ⇒ se ignoran clicks, crear y canjear).
  Tras cada `await` las continuaciones solo siguen si el intent sigue
  vigente (mismo objeto, mismo `gen`, misma cuenta, elemento conectado) —
  una respuesta tardía no pinta, no emite ni libera.
  - Solo el intent dueño libera `_entryBusy`. Las cadenas crear→entrar y
    canjear→activar corren dentro de UN intent.
  - Éxito: `biq-context:activated` exactamente una vez (detail aditivo
    `{kind, club_id, team_id}` — el shell no debe depender de él) y busy
    «Entrando…» se mantiene hasta desmontar o bootstrap fresco; a los
    15 s montado → «No se pudo confirmar la entrada» + «Reintentar»
    (GET bootstrap solamente, nunca re-POST automático).
  - POST ok + PUT narrowing falla → sin evento, sin «rollback»: recuperación
    con «Reintentar equipo» (solo PUT explícito) y «Entrar con todos los
    equipos» (emite), luego resync de bootstrap.
  - Transporte incierto tras mutación enviada → «No sabemos si la entrada
    se completó» + «Comprobar» (GET bootstrap solamente).
  - Cualquier bootstrap nuevo (cambio de `account_id`, re-entrada por
    `#/onboard/spaces` o nav «Espacios», desconexión) incrementa `gen` e
    invalida el intent en vuelo.

- **PD-CLUBS (Director 2026-10-23).** ≤2 clubes → una tarjeta por club.
  ≥3 → UN acceso principal + picker «Elegir club» con buscador y entrada
  directa por fila. El acceso principal es el «Club reciente» solo cuando
  existe un dato válido ligado al usuario — el contexto activo que
  devuelve el bootstrap o el marcador `biq.entry.lastClub.<account_id>`
  (sessionStorage) escrito al entrar con éxito en un club — validado
  siempre contra el feed; sin dato válido el acceso es el picker neutro,
  nunca un club arbitrario. El marcador se limpia al salir y es solo una
  pista de presentación: nunca decide autorización. El picker comparte el
  contrato modal del diálogo de ayuda (`role=dialog`, `aria-modal`,
  Escape/backdrop/cierre, foco al buscador al abrir y de vuelta al
  disparador al cerrar, fondo `inert`); el filtro por nombre es insensible
  a diacríticos y alterna `hidden` en las filas sin repintar, para no
  perder el foco.

## Compatibilidad con la carcasa actual

El shell oculta header/footer durante la entrada; el módulo no dibuja
chrome propio ni de reserva. El contrato del evento se conserva
(`bubbles`+`composed`); el detail nuevo es estrictamente aditivo, así que
shell viejo + módulo nuevo y shell nuevo + módulo viejo siguen funcionando.

## Debt

- `npm run stylelint` no tiene configuración en `origin/main` (defecto
  preexistente: el script y `stylelint-config-standard` están en
  `package.json`, pero no hay config — falla en `ConfigurationError` en
  el archivo intacto igual). No se añadió config en este tramo: la del
  estándar revelaría decenas de avisos ajenos de legado. El bloque nuevo
  de esta pantalla fue escrito siguiendo el estándar (0 avisos netos
  frente a baseline bajo el config estándar, comparación ad-hoc).
- El job `test` de CI corre las suites Playwright dentro de la puerta de
  merge, contra la regla 05 §5 (los tests de navegador pertenecen a
  `browser-tests.yml`). `entry-intent.test.mjs` sigue el patrón
  existente del repo; la migración pertenece al rollout del Helper / un
  tramo posterior.
- Las capturas (`app/scripts/screenshot-entry.mjs`, manual — no va en
  `npm test`) inyectan el CSS real del shell leyendo `origin/main` del
  checkout `biq-app` vía git (nunca su working tree); los tokens
  `data-theme` los fija el propio `<html>` del harness igual que el shell.

## Referencias

- `app/src/onboard-app.ts` — `renderEntryStep`, `_beginEntryIntent`,
  `_runEntryIntent`, `_intentCurrent`, `_resyncBootstrap`.
- Tests: `app/tests/entry-selector.test.mjs`, `app/tests/entry-intent.test.mjs`.
- Diseño: `handoff/outbox/2026-10-23-entry-login-architecture/README.md`;
  prototipo: `handoff/outbox/2026-10-23-entry-prototype-v1/`.
