# «Salir» en el selector de perfil — delegación hospedada (PR62 R1)

## Contexto

El paso de entrada (`entry-step`, chrome del shell suprimido) necesitaba
una salida de sesión. La primera versión hacía POST + redirect locales
asumiendo que «no hay contexto activo aquí» — premisa falsa: `#/onboard/
spaces` admite scope activo («Trabajando en X») y consumidores montados.
Un cierre local deja la valla `sessionClosing` del shell a `false`
mientras el POST está en vuelo: sin teardown, sin checkpoint de borradores,
sin limpieza canónica.

## Decisión (18 October 2026 · A2 F1)

- Hospedado (`this.shellHosted`, inyectado por la carcasa): «Salir»
  invoca la capacidad opcional `requestLogout` — el shell activa su valla
  de cierre síncronamente y posee teardown + POST + limpieza + navegación.
  El módulo no repinta tras delegar ni emite POST/redirect local.
- Hosted SIN la capacidad (documento de carcasa anterior al bridge):
  fallo cerrado — feedback «No se pudo cerrar la sesión. Reintenta o
  recarga la página.», sin bypass local.
- Standalone real (hostless): se conserva el camino local POST
  `/api/auth/logout` + limpieza de claves `biq.activeTeamId.*` +
  redirect `/login`.
- El título «Elige tu perfil» y el layout head+botón quedan como la
  entrega aceptada.

## Propiedad

`requestLogout` vive en `injectCapabilities` de biq-app (ver
biq-app `docs/2026-10-18-request-logout-host-capability.md`). El módulo
jamás detecta la carcasa por `window.shell` ni selectores privados —
solo por la declaración inyectada.
