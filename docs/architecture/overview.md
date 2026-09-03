# System architecture

## Recommendation

Use OKF v0.2 Markdown in Git as the canonical ledger, a custom Pi extension as the user/agent interface, and a custom Docker service backed by Redis 8 as a disposable shared retrieval plane.

## Assumptions and measurable drivers

- 3–15 users in one trust domain.
- At most 50,000 concepts and 250,000 chunks in the first supported deployment.
- Fewer than 10 canonical writes per minute.
- One Docker host and no dedicated on-call rotation.
- Git availability determines writes; Redis availability determines enhanced search.
- Warm retrieval excluding an external embedding call targets p95 under 500 ms.

Revisit the architecture when two of these limits are exceeded for a sustained month, when separate per-record authorization is required, or when retrieval becomes a staffed production service.

## Context

```text
team member / Pi
       |
       | local canonical reads and branch writes
       v
local vault clone ---------> Git remote/main
       |                           |
       | local fallback            | approved commit
       v                           v
Bookie Pi extension ------> Bookie service ------> Redis 8
                                   |
                                   +------> embedding provider
```

## Components

### Canonical vault

A dedicated Git repository contains OKF concepts, Bookie profile metadata, references, and evidence resources. It is independent of source-code repositories. Git branches and pull requests provide review and attribution.

### Core library

A TypeScript package owns parsing, normalization, profile validation, typed relations, hashing, lifecycle policy, filesystem search, and the canonical export model. Per ADR-0005 it combines a private YAML v2 Document AST with retained source bytes so no-op concept loading is lossless. Per ADR-0006 canonical JSONL reads one exact local Git commit and writes bounded deterministic lines through a caller-owned byte sink. Core contains no Pi, HTTP server, Redis, or provider-specific behavior.

### CLI

The CLI exposes deterministic automation for validation, evidence verification, indexing manifests, filesystem search, import, and export. CI calls the CLI instead of duplicating domain logic.

### Pi extension

The extension registers Bookie tools and commands, translates tool inputs into core operations, queues file mutation windows, offers explicit checkpoints, and discloses fallback or truncated output. It does not own canonical domain rules.

### Bookie service

The service authenticates retrieval clients, indexes only an approved canonical checkout, creates embeddings, fuses retrieval results, and reports index generation and source commit. Its canonical checkout is read-only.

### Redis

Redis stores JSON projections, lexical and vector indexes, and rebuild status. Redis is internal-only, disposable, and never receives canonical writes that do not already exist in Git.

### Embedding provider

A deployment-selected adapter generates document and query vectors. Provider credentials remain server-side. Model identity, dimensions, preprocessing, and chunker version form an immutable embedding generation.

## Write flow

1. A user explicitly asks the extension to create or amend a record.
2. The extension resolves the configured vault and validates project trust.
3. The core library prepares and validates the complete target document.
4. The extension queues the read-modify-write window for that absolute path.
5. The file is atomically replaced; no commit or push occurs.
6. The user reviews and submits the change through Git.
7. CI validates format, immutability, links, and evidence digests.
8. After merge, the service indexes the approved commit.

## Read flow

1. The extension scopes the query by vault, project, type, lifecycle, and sensitivity policy.
2. It queries the service when configured.
3. The service runs lexical and vector retrieval separately, applies filters, and fuses ranked lists.
4. It returns bounded excerpts with path, UID, commit, trust, freshness, score components, and degradation flags.
5. The extension merges direct local results for unmerged changes.
6. If the service fails, the extension returns labelled filesystem-only results rather than silent emptiness.

## Deployment

The first shared deployment has two custom/runtime services on a private Docker network:

- `bookie-service`, with a read-only canonical checkout and provider credentials;
- Redis 8, with a persistent volume and no public port.

A CI job or controlled deployment step updates the checkout to an approved commit and requests an idempotent rebuild. The service API is exposed only through authenticated private networking or an authenticating reverse proxy.

## Failure behavior

| Failure | Required behavior |
|---|---|
| Redis unavailable | Return observable filesystem-only results from the extension. |
| Embedding provider unavailable | Continue lexical retrieval; report semantic degradation. |
| Index behind Git main | Return indexed commit and lag; never imply freshness. |
| Invalid concept | Reject canonical mutation with actionable errors. |
| Digest mismatch | Fail validation and indexing of the affected evidence record. |
| Service unavailable | Preserve local read/write/validate operation. |
| Partial reindex | Keep serving the prior complete generation. |

## Scaling path

- Begin with exact vector search for a small corpus; use HNSW after measured need.
- Scale the stateless service horizontally only after centralizing rebuild coordination.
- Add Redis high availability only if enhanced-search RTO becomes contractual.
- Add a graph store only when a defined multi-hop evaluation set outperforms application-side traversal.
- Evaluate Redis Iris only when managed memory promotion or enterprise operations justify Kubernetes and licensing.

## Non-goals

This architecture does not provide live multi-user editing, per-record ACLs inside one vault, autonomous session-memory promotion, deep graph analytics, or compliance-grade immutable storage.

## Decisions

- [ADR-0001](decisions/0001-okf-git-canonical-store.md)
- [ADR-0002](decisions/0002-redis-derived-retrieval.md)
- [ADR-0003](decisions/0003-provider-neutral-embeddings.md)
- [ADR-0004](decisions/0004-typescript-monorepo.md)
- [ADR-0005](decisions/0005-yaml-document-ast.md)
- [ADR-0006](decisions/0006-exact-commit-streaming-export.md)
