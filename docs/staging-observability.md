# Staging observability

The vendored `biq-observability` wheel and its provenance are in `vendor/observability.json`. Canonical source and contract: BasketIQ/biq-core `docs/observability/contract.md`. Domain biq-core pins remain unchanged. Install the wheel before the server for local instrumented tests; Docker and CI install it explicitly.

Runtime enables only for `K_SERVICE` ending in `-staging`, or explicit `BIQ_OBSERVABILITY_ENABLED=1`. `0` is the rollback/disable switch. No collector or new IAM is required. JSON events and sanitized OpenTelemetry spans go to Cloud Logging, not to the Cloud Trace backend. Query `jsonPayload.trace_id` or `jsonPayload.operation_id` (SDK spans use `jsonPayload.attributes."biq.operation_id"`). Responses expose `x-biq-operation-id` and `x-biq-trace-id`. No secrets, bodies, query strings, SQL text or exception messages are captured by this exporter.

Includes HTTP ingress, HTTPX/requests egress, supported gRPC/psycopg calls, and lifecycle events. Events from the platform remain necessary for abrupt terminations. Existing clients created before bootstrap need explicit verification. Live acceptance requires exact-SHA CI/deploy and a served trace; this document alone is not evidence of coverage.

Theme Cloud Tasks carry only current traceparent and operation ID as per-execution job overrides. Authentication and payload semantics are unchanged; the independently deployed club-theme worker links its execution to enqueue and propagates context on its internal callback.
