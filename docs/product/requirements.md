# Product requirements

These requirements are authoritative. Specifications may refine them but may not weaken them without an explicit requirements and architecture review.

## Canonical records

| ID | Requirement |
|---|---|
| REQ-001 | The canonical ledger shall be a Git-trackable OKF v0.2-compatible directory of UTF-8 Markdown and referenced files. |
| REQ-002 | Every Bookie concept shall carry a stable, globally unique `bookie.uid` independent of its filesystem path. |
| REQ-003 | The initial profile shall support Project, Task, Document, Research, Decision, Activity, Evidence, and Person concepts without requiring a centralized OKF type registry. |
| REQ-004 | Writers shall preserve unknown frontmatter fields and standard Markdown body content during round trips. |
| REQ-005 | OKF lifecycle status and Bookie workflow state shall remain separate fields. |

## Audit and evidence

| ID | Requirement |
|---|---|
| REQ-006 | Canonical changes shall be attributable through Git and OKF generation/provenance fields. |
| REQ-007 | Merged Activity and Evidence concepts shall be append-only; corrections shall create linked replacement records. |
| REQ-008 | Every captured evidence resource shall record SHA-256, media type, capture time, origin when known, and supported concepts. |
| REQ-009 | Superseded decisions shall remain addressable and link to the replacing decision. |
| REQ-010 | Validation shall detect malformed frontmatter, missing required profile fields, broken typed relations, missing evidence resources, and digest mismatch. |

## Capture and Pi behavior

| ID | Requirement |
|---|---|
| REQ-011 | Durable writes shall occur only after an explicit user request or approval. |
| REQ-012 | Checkpoints shall summarize outcomes, changed artifacts, decisions, evidence, unresolved work, and source session identity without requiring full transcript storage. |
| REQ-013 | Bookie tools and hooks shall never commit or push automatically. |
| REQ-014 | Pi shall expose stable read, search, write, checkpoint, validate, and export capabilities through a custom extension. |
| REQ-015 | File mutations shall be atomic with respect to concurrent Pi tool mutations of the same target. |

## Retrieval

| ID | Requirement |
|---|---|
| REQ-016 | Redis, vectors, lexical indexes, caches, and exports shall be rebuildable from a named canonical Git commit. |
| REQ-017 | Retrieval shall combine lexical, semantic, metadata, lifecycle, trust, and freshness signals while returning source citations. |
| REQ-018 | Filesystem lexical and metadata search shall remain available when the shared retrieval service is unavailable. |
| REQ-019 | Each indexed chunk shall record its source hash, source commit, chunker version, and embedding generation. |
| REQ-020 | Vectors produced by different embedding generations shall never be ranked in the same vector space. |
| REQ-021 | Embedding providers shall be selected at deployment through a provider-neutral contract with cloud and local implementations. |

## Team and security

| ID | Requirement |
|---|---|
| REQ-022 | Git repository permissions shall control canonical writes and the retrieval service shall authenticate clients. |
| REQ-023 | Redis shall remain on a private network and shall not serve as an authorization boundary. |
| REQ-024 | Separate vaults shall provide confidentiality boundaries; cross-vault search requires an explicitly authorized aggregation design. |
| REQ-025 | Retrieved content shall be labelled and handled as untrusted data before model context injection. |
| REQ-026 | Secrets and excluded sensitivity classes shall not be indexed, checkpointed, or logged. Export secret detection shall default on; only an explicit low-level unchecked policy may bypass detection, never sensitivity exclusions. |
| REQ-027 | Retrieval failure or fallback shall be observable to callers and operators. |

## Portability and export

| ID | Requirement |
|---|---|
| REQ-028 | The system shall provide a deterministic, versioned JSONL export before destination-specific adapters. |
| REQ-029 | Destination exports shall support dry-run, stable identity mapping, idempotent upsert planning, and explicit loss warnings. |
| REQ-030 | Core format and policy behavior shall be reusable outside Pi by the CLI and service. |

## Initial quality targets

| ID | Requirement |
|---|---|
| REQ-031 | The initial design shall support up to 50,000 concepts, 250,000 chunks, and 15 team members on one Docker host. |
| REQ-032 | Warm retrieval excluding external embedding latency shall target p95 below 500 milliseconds at the initial scale. |
| REQ-033 | The canonical repository shall remain readable and valid after removal of all Bookie software. |
| REQ-034 | Every implementation slice shall include automated success, error, and boundary-path tests. |
