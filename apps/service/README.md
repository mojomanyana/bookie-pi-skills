# `@bookie/service`

Authenticated indexing and retrieval service backed by a disposable Redis projection. Follow [SPEC-004](../../docs/specs/004-retrieval-service.md), the [retrieval architecture](../../docs/architecture/retrieval.md), and the [security architecture](../../docs/architecture/security.md).

The service mounts canonical vaults read-only and never becomes a write path.

## Current implementation

BK-017 has begun with a Dockerless Fastify contract slice:

- static liveness/readiness envelopes;
- strict protocol-v1 search request and response validation;
- digest-only opaque bearer-token verification with expiry windows;
- explicit per-vault `index:read` and `search` authorization before store access;
- static redacted authentication, request, and dependency errors;
- generated request IDs, `Cache-Control: no-store`, disabled automatic logging, and request-abort propagation to the store boundary.

Redis projection, rebuild fencing, activation/rollback, lexical query execution, context, admin routes, rate/deadline controls, and hardened Compose remain part of BK-017 and are not implemented yet.
