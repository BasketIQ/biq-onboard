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
