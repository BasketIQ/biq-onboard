# F1 Identity Admission

Website-assisted generation requires a confirmed, fresh App admission before
creating a job lease, changing generation state or dispatching Cloud Tasks.
The receipt is orchestration-only with explicit zero bounds. It records source
fingerprints, not the URL/document. UUID leases and stable operation IDs bind
the actor membership, original timestamp and parent receipt to worker delivery.

The worker in App claims a separate execution receipt before source access or
callbacks. Redelivery cannot take ownership from an already-admitted worker.
Provider execution and measured cost are separate receipts. Queue failures
finish the non-model parent with known zero usage, not fabricated model usage.
Manual identity operations do not use this admission path.

Onboard reuses its deployed `BIQ_APP_URL` and numeric-mounted
`BIQ_INTERNAL_TOKEN` bindings. Explicit `BIQ_APP_BASE_URL` /
`BIQ_APP_INTERNAL_TOKEN` aliases remain supported, without copying credentials.

CI defaults to a fake consumption transport and forbids constructing the
default live Cloud Tasks client. Tests may inject a fake client explicitly.
HTTP redirects cannot forward the internal credential to another origin.

Five isolated adapter tests pass. Complete backend qualification requires
`biq-core[org]==0.31.0`; installed local environments have older SDKs and do
not qualify it. The initial local qualification was rejected before execution.
The Director explicitly authorized its retry. On 16-Nov the registered Helper
staging robot obtained a token, but GAR returned HTTP403:
`artifactregistry.repositories.downloadArtifacts` denied on
`projects/basketiq-platform-prod/locations/europe-west1/repositories/basketiq-python`.
Pip consequently reported no matching Core0.31.0 distribution. The temporary
venv was cleaned; backend tests did not execute. This does not prove the wheel
is missing. No production IAM change or alternate identity was attempted.
Local qualification requires repository-scoped reader access for the authorized
robot; ordinary PR CI is a separate qualification/evidence lane.
No complete backend, staging composition or runtime deployment is claimed.

ES: La generacion asistida se admite antes de cambiar el estado o encolar.
Un reenvio no concede un segundo permiso. La edicion manual no depende de
Smart. La calificacion completa con el SDK fijado sigue pendiente.
