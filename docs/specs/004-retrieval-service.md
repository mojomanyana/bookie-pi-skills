# SPEC-004: Shared retrieval service

## Status

In progress — BK-016 service design is merged and verified; BK-017 authenticated lexical indexing/search is Ready

Owner: service implementer

Target release: 0.2

Depends on: SPEC-002, ADR-0002, ADR-0003, ADR-0010

## Goal

Run an authenticated, Docker-hosted service that indexes an approved read-only vault checkout into Redis 8 and returns cited lexical/semantic retrieval while preserving filesystem fallback and atomic index generation cutover.

## Non-goals

- Canonical writes through HTTP.
- Redis as backup or authority.
- Automatic long-term memory extraction.
- Kubernetes or high availability.
- Deep graph traversal or arbitrary attachment execution.

## Requirements

1. Mount one or more explicitly configured vault checkouts read-only and resolve authorization to vaults from server-side identity.
2. Reject indexing unless the checkout commit is valid and the complete vault passes canonical validation.
3. Project concepts and heading-aware chunks with all provenance fields defined in retrieval architecture.
4. Implement provider-neutral document/query embeddings with Voyage AI, OpenAI-compatible, and Ollama adapters selectable at deployment.
5. Isolate every embedding generation and reject dimension/model mismatch.
6. Build a namespaced generation, verify it, evaluate it, and atomically activate it without serving partial state.
7. Run lexical and vector retrieval independently and fuse rankings deterministically.
8. Apply project, type, lifecycle, workflow, sensitivity, trust, and freshness filtering.
9. Return bounded citations, score components, active generation, source commit, and degradation state.
10. Keep Redis private; expose static unauthenticated health/readiness plus authenticated index, search, context, rebuild-status, cancellation, and compare-and-set activation APIs.
11. Authenticate random opaque bearer tokens against constant-time checked digests and authorize every operation through a server-side per-vault scope before Git or Redis lookup.
12. Avoid query/result text, canonical UIDs/paths, credentials, raw dependency errors, and excluded counts/content in logs and metrics.
13. Provide Docker Compose deployment for one host with digest-pinned images, loopback-only service publication by default, health checks, hardened containers, a private Redis network, no Redis host port, and a persistent sensitive-but-disposable Redis volume.
14. Enforce the protocol, approved-commit rule, Redis projection/cutover plan, limits, cancellation, logging, and threat controls in ADR-0010.

## Version 1 HTTP contract

[`schemas/service/v1/protocol.schema.json`](../../schemas/service/v1/protocol.schema.json) is the normative strict request/response schema. Every JSON object carries `schema_version: "1"`; unknown properties, unsupported media types, compressed bodies, and over-limit values fail before handler work. Context serialization additionally enforces the request budget and a 64 KiB aggregate UTF-8 content ceiling across all items. Responses include `Cache-Control: no-store`. Errors are bounded static objects and never echo rejected values or dependency diagnostics.

```text
GET    /health/live                     public; static process liveness
GET    /health/ready                    public; static dependency readiness
GET    /v1/index                        index:read; all and only granted vaults
POST   /v1/search                       search; one granted vault
POST   /v1/context                      context; one granted active build
POST   /v1/admin/rebuild                rebuild:create; idempotent exact-commit build
GET    /v1/admin/rebuild/:id            rebuild:read; vault-scoped job status
DELETE /v1/admin/rebuild/:id            rebuild:cancel; asynchronous cancellation
POST   /v1/admin/activate               build:activate; compare-and-set cutover/rollback
```

`Authorization: Bearer <opaque-token>` is the only credential transport. Admin credentials are separate from reader credentials. `GET /v1/index` requires no caller-supplied vault and lists only granted handles. Every body-selected vault, path parameter, job, build, context reference, and Redis key is resolved inside a server-side vault grant before lookup. Unauthorized and nonexistent objects are indistinguishable.

A rebuild request names a full Git object ID. The service accepts it only under the configured approved-ref and rollback-window rule in ADR-0010, binds it to the expected canonical vault UID, performs complete validation and policy checks, and derives an idempotent build ID from all canonical and projection inputs. Rebuild does not activate implicitly. Only a complete evaluated build may be activated, and activation names the expected current build so races fail observably.

## Service configuration contract

Deployment configuration is non-canonical and fail-closed. Each configured vault supplies a public handle, expected canonical vault UID, read-only checkout, local approved ref, rollback window, opaque Redis namespace seed, and provider-approved sensitivity classes. Secret files supply token verifiers, Redis ACL credentials, telemetry HMAC material, and provider credentials. Startup rejects more than 64 vault grants per token, duplicate handles or UIDs, writable/mismatched checkouts, missing approved refs, plaintext token entries, undeclared provider classes, absent limits, or Redis namespaces shared by different vaults.

The authorization matrix, token lifecycle, exact-commit approval, Redis key/index plan, build state machine, activation transaction, Compose threat model, deadlines, concurrency/rate limits, and safe logging fields are normative in [ADR-0010](../architecture/decisions/0010-service-protocol-auth-and-projection.md).

## Acceptance criteria

- Redis can be deleted and rebuilt from an exact Git commit with equivalent indexed projections.
- Search returns source UID/path, exact commit, heading, bounded excerpt, trust, freshness, and score explanation.
- Cross-vault attempts fail for an ungranted request-body vault, foreign job/build IDs, and mixed-vault context references; authorization never depends on Redis filters.
- Embedding failure returns lexical results with explicit degradation; Redis failure produces an unavailable response that causes the extension's local fallback.
- Partial or failed builds never replace the active complete generation; missing/corrupt active pointers return unavailable rather than empty success.
- Duplicate rebuilds converge on one controller job/build identity, a vault has at most one non-terminal rebuild, and terminal retries fence stale workers; cancellation cannot activate or remove the serving build; compare-and-set activation, self-activation, and rollback reject races.
- Expired, revoked, malformed, foreign-vault, and wrong-scope tokens/jobs/builds fail with static non-enumerating errors.
- A model migration can shadow-query, cut over, and roll back without mixed vector ranking.
- Warm service-side retrieval meets p95 under 500 ms on the initial benchmark excluding external embedding latency.
- A record assigned an excluded class produces no Redis projection or chunk, no embedding input, and no search/context result; its UID, path, and marker content are absent from logs and metrics while an included control record remains retrievable.
- Docker exposes no Redis host port in the default configuration.
- Restart, cancellation, duplicate rebuild, malformed concept, oversized input, and provider-rate-limit paths are tested.

## Test strategy

- Unit tests for chunking, projection, fusion, filters, generation identity, and redaction.
- Strict JSON Schema contract tests for every API request, response, error shape, unknown field, size boundary, and media-type rejection.
- Testcontainers or Compose integration with pinned Redis 8.
- Fake embedding adapters for deterministic tests plus opt-in provider smoke tests.
- Destructive rebuild/cutover/rollback tests and cross-vault adversarial tests.
- Load test using the documented initial scale or a representative synthetic corpus.
- Failure injection for Redis, provider, cancellation, partial write, and stale checkout.
- Mixed-sensitivity builds inspect Redis projections, fake embedding calls, search/context responses, and captured logs/metrics for positive inclusion and excluded-data omission.

## Dependencies

- [SPEC-002](002-core-and-cli.md)
- [Retrieval architecture](../architecture/retrieval.md)
- [Security architecture](../architecture/security.md)
- [ADR-0002](../architecture/decisions/0002-redis-derived-retrieval.md)
- [ADR-0003](../architecture/decisions/0003-provider-neutral-embeddings.md)
- [ADR-0010](../architecture/decisions/0010-service-protocol-auth-and-projection.md)

## Delivery notes

Deliver lexical indexing and authenticated citations before vectors. Then add one fake/deterministic embedding adapter, cloud/local adapters, generation cutover, and evaluation. Do not integrate Iris or Agent Memory V0 into the production path.
