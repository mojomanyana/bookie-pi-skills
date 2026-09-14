# ADR-0010: Version the service protocol and isolate scoped Redis builds

- **Status:** Accepted
- **Date:** 2026-09-15
- **Decision owners:** Repository owner, service architect, and deployment owner
- **Scope:** Release 0.2 Bookie retrieval service

## Context

BK-016 must settle the service protocol, authentication, Redis projection, and one-host deployment before runtime code begins. The initial deployment serves 3–15 users, at most 50,000 concepts and 250,000 chunks, on one Docker host without dedicated on-call staff. Warm retrieval excluding external embedding latency targets p95 below 500 ms. Git-tracked OKF remains canonical, Redis is disposable, vaults are confidentiality boundaries, and service or provider failures must never look like an empty successful search.

An exact Git object ID is not by itself approval to index historical content. Caller-selected vault names, Redis filters, and obscurity of identifiers are not authorization. Opaque bearer tokens are replayable if stolen, Fastify does not supply end-to-end cancellation automatically, and Redis generation names alone do not prevent partial-state activation.

## Decision

### Runtime and protocol

Use the maintained Fastify major compatible with the Node 24 baseline. Fastify owns HTTP parsing, strict route-schema validation, lifecycle hooks, and the static error handler; core continues to own canonical parsing and validation. Every JSON body and response is validated against the versioned JSON Schema at [`schemas/service/v1/protocol.schema.json`](../../../schemas/service/v1/protocol.schema.json). Unknown properties fail, JSON is the only accepted request media type, and compressed request bodies are disabled initially.

The service exposes the routes in [SPEC-004](../../specs/004-retrieval-service.md#version-1-http-contract). It adds explicit rebuild cancellation and compare-and-set activation routes so disconnect, cutover, and rollback behavior are unambiguous. Breaking field or semantic changes use `/v2` and a new schema; additive optional responses require a separately accepted compatibility rule because version 1 responses are strict.

Fastify automatic request/response logging is disabled. Search, context, and other synchronous routes use one composed `AbortSignal` combining client disconnect, route deadline, and shutdown; it is passed to Redis calls, embedding adapters, Git subprocesses, the exact-commit reader, and cancellable parser workers. Rebuild submission ends after durable job creation. The asynchronous builder instead uses a separate signal composed only from explicit job cancellation, the six-hour build deadline, and service shutdown, so closing the submission connection cannot cancel accepted work. Synchronous parsing is bounded in a worker or subprocess; cancellation is never claimed in place.

### Authentication and authorization

Use standalone random opaque bearer tokens for the first deployment. A token is generated from at least 256 random bits and is shown only once. Its verifier file contains a non-secret token ID, SHA-256 digest of the random secret, principal audit handle, UTC `not_before` and `expires_at`, and per-vault grants. It contains no plaintext token. The read-only verifier file is supplied as a mounted secret, not baked into an image or placed in ordinary environment variables. Verification uses fixed parsing, digest computation, and a constant-time comparison. Missing, malformed, expired, revoked, and unknown credentials all return the same static `AUTH_INVALID` response.

Scopes are `index:read`, `search`, `context`, `rebuild:read`, `rebuild:create`, `rebuild:cancel`, and `build:activate`. Admin tokens are separate credentials and carry only required admin scopes. Every grant binds a scope to a server-configured vault handle, and one token may contain at most 64 vault grants so the non-paginated index response stays bounded. A request may select only one handle from its grants; the server resolves that handle to the checkout, expected vault UID, Redis namespace, approved ref, and provider policy before any Git or Redis lookup. An unauthorized vault and a nonexistent vault are indistinguishable. Job and build lookups first bind the object to the authorized vault namespace.

Tokens are replayable bearer credentials. Therefore remote traffic requires TLS at a deployment-owned ingress, tokens are forbidden in query strings and cookies, successful responses use `Cache-Control: no-store`, and plaintext remote exposure is unsupported. Default Compose binds the service only to loopback and publishes no Redis port. Rotation overlaps old and new tokens for a bounded operator-selected interval; removal from the verifier file revokes a token after an atomic configuration reload. Audit logs use an HMAC-derived principal handle, never token IDs or digests. Failed authentication is rate-limited by direct peer address; `trustProxy` is off by default and may name only an exact trusted proxy hop that overwrites forwarded headers.

### Approved commits and indexing policy

Each vault configuration names a read-only checkout, its expected `VLT-` UID, and one local approved ref. A rebuild request names a full object ID. The service resolves the approved ref once and accepts the requested commit only when it equals that tip or is reachable from it under the configured first-parent rollback window. It never fetches, changes the checkout, trusts caller approval, or indexes arbitrary reachable history. At activation, the service re-evaluates the candidate commit against the current approved-ref tip and rollback window and rechecks current manifest and deployment sensitivity/provider policy hashes. It then passes a short-lived activation-authorization epoch to Redis; the Lua transition compares it with the current server-written configuration epoch. The approved-ref tip is not part of immutable build identity, so a prior complete build remains eligible only while its commit is still inside the current rollback window and its security policy hashes still match. Rollback-window changes are deployment configuration changes.

The indexer reuses the hardened exact-commit Git/object boundary and complete core validation. It rejects missing or undeclared sensitivity, all manifest-excluded records, detected secrets, and included records whose projection would expose an excluded UID or path before writing any projection. There is no unchecked indexing policy. Provider-specific approved sensitivity classes are deployment configuration; unapproved classes fail before provider input. The manifest hash, provider-policy hash, projection schema, parser/chunker versions, and optional embedding identity are part of the build identity.

### Build and Redis model

An embedding generation identifies one immutable vector space as decided in ADR-0003. A build is separate and is the SHA-256 identity of vault UID, exact source commit, profile and manifest hash, sensitivity/provider-policy hash, projection schema version, parser version, chunker/preprocessing versions, and optional embedding generation. One controller job owns each build attempt, and each vault permits exactly one non-terminal controller job. Concurrent or repeated submissions for that job's build return the same controller job and build; a different build request returns static `BUILD_CONFLICT` until the controller becomes terminal. A retry after terminal failure/cancellation creates a new controller job only after it atomically removes the old candidate; it never overwrites active, previous, leased, or complete data.

All Redis keys begin with `bk:v1:v:<opaque-vault-namespace>:`. The vault namespace is an HMAC-derived deployment handle, not a canonical UID or path. Build and job IDs are always subordinate to that namespace. The initial key plan is:

```text
bk:v1:v:<v>:active                         -> active build ID
bk:v1:v:<v>:previous                       -> retained rollback build ID
bk:v1:v:<v>:build:<b>:manifest             -> bounded build manifest/state
bk:v1:v:<v>:build:<b>:concept:<ordinal>    -> included concept projection
bk:v1:v:<v>:build:<b>:chunk:<ordinal>      -> included chunk projection/vector
bk:v1:v:<v>:job:<j>                        -> bounded rebuild status
bk:v1:v:<v>:lock:rebuild                   -> fenced worker lease with expiry
bk:v1:v:<v>:lease:<b>                      -> request leases with expiry
```

Redis Search index names contain only the opaque vault namespace, build ID, protocol version, and `lex` or `vec`. Queries use fixed templates with parameter binding/escaping; request text is never interpolated into index expressions. Projections contain source UID/path/hash/commit, concept metadata, heading, bounded text, trust/freshness fields, chunker/projection versions, and the matching embedding generation when a vector exists. Excluded values and their counts never enter Redis, jobs, logs, or metrics.

A builder writes only a fresh candidate namespace and moves through `queued`, `building`, `verifying`, `evaluating`, then immutable `complete`. Verification checks complete-vault validation, counts, hashes, required filters, dimensions, index readiness, sensitivity/secret policy, and the versioned evaluation gate. Failed, interrupted, or cancelled candidates are non-servable. Activation is pointer state and never changes build completeness or the controller job's terminal `complete` state, so an eligible retained previous build can be reactivated. One rebuild runs per vault and one activation runs per vault; multiple vaults may build within configured service resource limits.

Cancellation and activation share one Redis Lua-backed state machine over the unique controller job, build manifest, current configuration epoch, activation-authorization epoch, and active pointer. Cancellation atomically rejects an active build, moves its non-terminal controller job to `cancelling`, and marks its candidate non-activatable before signalling the worker; completion then records `cancelled`. Activation atomically rejects `cancelling`, `cancelled`, failed, or non-complete controller jobs/builds, rejects an expired or mismatched activation authorization, and compares the expected active build. If the candidate already equals `active`, it returns static `BUILD_CONFLICT` and preserves `previous`; otherwise it stores the old active build as `previous` and updates `active` without mutating the complete build/job. Thus cancellation cannot race a candidate into service, relabel the serving build, or erase the rollback pointer through self-activation.

The rebuild lock is a renewable Redis lease containing a process-owner epoch and monotonically increasing fencing token. Every candidate mutation—including each projection/index batch write, checkpoint, manifest update, and terminal transition—uses Lua to verify the owner epoch, controller job, and fencing token in the same atomic operation; an expired or superseded worker cannot contaminate a replacement attempt. On startup, the service atomically increments the process-owner epoch, which immediately invalidates every prior process lease regardless of its remaining TTL, marks all prior-epoch non-terminal jobs failed with static `INTERRUPTED`, makes their candidates non-servable, and schedules bounded cleanup. It does not automatically resume parsing or provider work. A later submission can then create a fresh controller attempt under the normal terminal-retry rule. Recovery never modifies active or previous complete builds.

Readers use a Lua transaction to load `active`, verify its complete/activated state, and add a unique request lease to the build's sorted lease set with an expiry fifteen seconds in the future, longer than the ten-second request deadline. The request releases its lease on completion; expiry handles crashes. Each request queries only its leased build. Garbage collection atomically removes expired leases and cannot remove active, previous, any build with a live lease, or non-terminal job data. A missing pointer, incomplete target, lease failure, or Redis failure returns `INDEX_UNAVAILABLE`, never empty results. The same compare-and-set activation can reactivate `previous` for rollback. Candidate cleanup is bounded and retryable.

### Deployment and operating limits

The default Compose design has an externally reachable loopback-bound service network and a separate internal Redis network. Redis has no Redis host port, disables the default user, and uses separate least-privilege query and indexing ACL credentials. Service, Redis, and any ingress images are pinned by patch version and digest at implementation acceptance. Vaults and `.git` data are mounted read-only. Token verifiers, Redis credentials, telemetry HMAC key, and provider credentials are mounted secret files.

Containers run as non-root with read-only root filesystems, bounded tmpfs, dropped Linux capabilities, `no-new-privileges`, health checks, graceful-stop bounds, and CPU/memory/PID limits. They receive no Docker socket, SSH agent, Git credentials, or host home mount. The Redis volume is sensitive disposable data with owner-only host permissions and an explicit retention/deletion procedure; it is not a backup.

Initial hard limits are 50,000 concepts, 250,000 chunks, 512 MiB aggregate concept input, 4,096 query characters, 50 search results, 20 context references, and 64 KiB aggregate UTF-8 context content. The context serializer tracks encoded content bytes across all items, stops at both the request's `max_bytes` and 64 KiB service ceiling, and sets `truncated`; per-item JSON Schema limits do not substitute for this aggregate runtime check. Headers, JSON bodies, nesting depth, sockets, Redis calls, provider calls, and route duration all have finite limits. Search/context has a ten-second outer deadline and Redis operations a two-second deadline. Rebuild is asynchronous with a six-hour ceiling, cancellable between bounded batches, and survives request disconnect. Shutdown stops new work, drains short requests for ten seconds, cancels builders at a safe checkpoint, and exits within thirty seconds while leaving the prior active build intact.

Rate limits are defense in depth, not authorization: 60 search/context requests per minute per principal-vault with burst 20, 2 rebuild submissions per minute per admin-vault, 4 concurrent searches per token, 32 service-wide, and one rebuild per vault. A single-process in-memory limiter is accepted for the initial deployment; horizontally scaling the service requires shared rate and rebuild coordination first.

Explicit logs contain generated request ID, route template, status, duration, authorization outcome/scope, HMAC audit handles, non-content build/generation IDs, stage latency, included result counts, degradation, and truncation. They never contain authorization/cookie headers, request or result bodies, queries, titles, excerpts, canonical UIDs/paths, raw filters, provider/Git/Redis errors, excluded counts, or Redis payloads. Metrics labels are limited to route, status, degradation code, adapter, and coarse generation version.

## Authorization matrix

| Route                                   | Required scope   | Vault binding                                                       | Failure behavior                                       |
| --------------------------------------- | ---------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| `GET /health/live`, `GET /health/ready` | None             | None; static process/dependency state only                          | No configuration details                               |
| `GET /v1/index`                         | `index:read`     | Returns only indexes granted to the token                           | Invalid token is indistinguishable                     |
| `POST /v1/search`                       | `search`         | Body handle must be in the token grant                              | Unauthorized/nonexistent vault is indistinguishable    |
| `POST /v1/context`                      | `context`        | Body handle and every reference bind to one active vault build      | Cross-build or cross-vault reference fails the request |
| `POST /v1/admin/rebuild`                | `rebuild:create` | Commit is checked against that vault's approved ref                 | Duplicate active attempt returns its job/build         |
| `GET /v1/admin/rebuild/:id`             | `rebuild:read`   | Job is resolved inside an authorized vault grant                    | Foreign/nonexistent job is indistinguishable           |
| `DELETE /v1/admin/rebuild/:id`          | `rebuild:cancel` | Job is resolved inside an authorized vault grant                    | Activated jobs cannot be cancelled                     |
| `POST /v1/admin/activate`               | `build:activate` | Candidate and expected active build must share the authorized vault | Compare-and-set conflict is explicit and static        |

## Consequences

### Positive

- The runtime can reuse one strict schema for Fastify validation and contract tests.
- Token and Redis objects are scoped before lookup, making vault isolation independent of caller filters.
- Exact-commit rebuilds are reproducible while activation rechecks current commit approval and policy.
- Separate build and embedding identities prevent partial activation and mixed vector ranking.
- Loopback-first Compose preserves a small one-host deployment and makes remote TLS responsibility explicit.

### Negative

- Operators must provision, rotate, expire, and revoke token verifier entries.
- Bearer-token theft permits replay until expiry or revocation; the initial design has no phishing-resistant proof of possession.
- Fastify, schema plugins, Redis scripts, and explicit cancellation require compatibility maintenance.
- Candidate builds temporarily duplicate Redis storage, and retained rollback consumes additional memory.
- Remote deployment needs a separately operated TLS ingress even though identity remains in Bookie.

## Alternatives considered

- **Node native HTTP plus hand-written validation:** fewer dependencies, but duplicates strict schema/error/cancellation plumbing and increases protocol drift for no measured benefit at the initial scale.
- **Identity-aware reverse-proxy headers:** appropriate when a deployment already has a managed identity ingress, but unsafe as the standalone default because header trust and identity lifecycle move outside Bookie. A future adapter may map a verified proxy identity to the same grants without changing authorization semantics.
- **OIDC directly in the service:** stronger centralized identity lifecycle, but disproportionate issuer, discovery, key rotation, clock, and claim-validation complexity for the first 3–15-user deployment.
- **Argon2 token verifiers:** useful for human passwords, but unnecessary for uniformly random 256-bit secrets; SHA-256 plus constant-time comparison is simpler without making brute force practical.
- **One mutable Redis index per vault:** lower peak memory, but exposes partial builds and makes rollback non-atomic.
- **Caller-named commits or Redis-side vault filters:** rejected because neither is an authorization or approval boundary.

## Validation, rollback, and revisit triggers

Contract tests compile every schema, reject unknown/oversized inputs, exercise canonical path/UID/date boundaries, and prove static bounded errors. Integration tests must cover cross-vault tokens/jobs/builds, expired/revoked tokens, timing-safe verification, replay-safe duplicate rebuilds and terminal retries, malformed/oversized input, submission disconnect, explicit cancellation/activation/self-activation races, stale-worker projection writes, reader lease/garbage-collection races, aggregate UTF-8 context limits, Redis/provider failure, approval-ref changes before activation, excluded and secret markers across Redis/provider/log/metric surfaces, active-pointer corruption, failed activation, ungraceful restart with expired worker fencing, cutover, reactivation of a previous complete build, and no Redis host port.

Rollback keeps the old complete build and reactivates it with the compare-and-set route. Runtime rollback pins the prior service image and schema-compatible configuration; Redis is rebuildable from the retained approved commit. Abort deployment if schemas leak rejected values, a candidate can be queried before completion, an excluded marker reaches any derived surface, or p95 misses the target on the representative corpus.

Revisit the auth choice when an identity-aware ingress already exists, more than 15 users require centralized offboarding, or audit policy requires MFA/proof of possession. Revisit Fastify if maintained Node 24 compatibility or required cancellation/schema hooks regress. Revisit single-process coordination before horizontal scaling. Revisit Redis topology at the triggers in ADR-0002.
