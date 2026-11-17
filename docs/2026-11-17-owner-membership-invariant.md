# Titularidad y membresía / Ownership and membership

Adopt Core 0.33.0. All club role replacement, member deactivation and deletion
already flow through `replace_member_role`. That transaction now checks a
provisioned club owner's account binding as well as the last-director invariant.
An owner must transfer ownership before losing their last active director
membership. The HTTP adapter returns 409 `owner_transfer_required` without
changing the membership, compatibility grants or audit history.

No new owner role is introduced. Club writers retain exactly coach and
sports_director. Existing clubs without an ownership record keep the current
behavior until audited provisioning; no owner is inferred from an administrator
or first director. Provisioning belongs to the subsequent migration rollout.

Se conserva un solo perfil por membresía. La titularidad es una relación con
la cuenta y el recurso. La dependencia compartida impide desactivar, borrar o
degradar al owner sin transferencia previa, dentro de la misma transacción.
El código estable `owner_transfer_required` debe traducirse en el cliente:
ES «Transfiere la titularidad antes de retirar este acceso»; EN «Transfer
ownership before removing this access».

Validation: Core emulator tests cover demotion, deactivation and deletion and
existing membership projection regressions. Onboard CI verifies its consumers.

## Service delegation boundary

The environment emergency username grants access only in local/test without
S2S configured. Staging/production and delegated service calls require a live
platform grant or active club membership. Global administration routes require
platform.admin; a generic authenticated user is insufficient. Session-only
club role administration also checks current membership status. This closes a
username-based bypass without changing the authenticated BFF delegation header
contract. Transport role assertions never replace live authorization.

En staging, un token S2S y el nombre del usuario de emergencia no bastan para
administrar. Las pruebas cubren esta denegación en ES/EN, la revocación del
administrador y la imposibilidad de acceder a rutas globales como Director.
