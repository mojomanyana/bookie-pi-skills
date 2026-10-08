# Bookie

Bookie is a local-first, Git-native project ledger for people and agents. It keeps tasks, documents, research, decisions, activity checkpoints, files, and evidence in an [Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)-compatible bundle and exposes disciplined workflows through a Pi extension.

> **Status:** the canonical profile in [SPEC-001](docs/specs/001-canonical-ledger.md) is verified. Lossless loading, vault validation, conflict-safe mutation, Evidence capture, bounded filesystem search/inspect, deterministic exact-commit JSONL export, the read/query-only CLI through BK-012, and Pi read/search/validate/write/checkpoint workflows through BK-015 are merged and verified alongside dependency/CI maintenance through BK-024. ADR-0008 defers all filesystem-writing CLI commands without weakening publication guarantees. The authenticated retrieval-service protocol and threat-reviewed Redis projection design in BK-016 are merged and verified; BK-017 remains the next Ready item: its authenticated HTTP contract is merged in PR #27; projection, fenced Redis candidate storage, approved-history ingestion, a Linux read-only source-deployment guard, metadata-only approved source-manifest reads, isolated deployment-checked source preflight, a disconnected v2 input-recipe codec with measured offline input assembly, a build-time runtime staging helper/inventory, included-only output-stream evidence with isolated-process rechecks and a disconnected output-descriptor codec are local/unmerged; controller integration, Redis search, activation, and full deployment are not yet delivered. [ADR-0011](docs/architecture/decisions/0011-bounded-rebuild-admission.md) is accepted for the next admission/identity refinement; clean-install artifact provenance/image qualification and builder-side verification, full implementation of that contract, and controller wiring remain pending. See the ordered [backlog](docs/planning/backlog.md).

## Design commitments

- OKF Markdown in Git is canonical.
- Redis and embeddings are rebuildable retrieval indexes.
- Capture is explicit; checkpoints require user approval.
- Evidence is hashed; activity records become append-only after merge.
- Storage and embedding providers remain replaceable.
- The corpus stays useful without Pi, Redis, or any external vendor.

## Start here

| Reader                   | First documents                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Any contributor or agent | [Agent guide](AGENTS.md), [documentation map](docs/INDEX.md)                                                                      |
| Product/brainstorming    | [Vision](docs/product/vision.md), [requirements](docs/product/requirements.md), [open questions](docs/planning/open-questions.md) |
| Architecture             | [System overview](docs/architecture/overview.md), [ADRs](docs/architecture/decisions/)                                            |
| Planning                 | [Roadmap](docs/planning/roadmap.md), [backlog](docs/planning/backlog.md), active specification                                    |
| Implementation           | [Specifications](docs/specs/), [definition of done](docs/planning/definition-of-done.md)                                          |

## Repository commands

```bash
npm test
npm run check
```

These checks validate the planning contract, schemas, policy fixtures, internal links, specification completeness, and complete valid/invalid OKF vault fixtures. Runtime product tests are added with each implementation increment.

## Intended repository shape

```text
apps/service/          shared retrieval/indexing service (planned)
packages/core/         lossless parsing, validation, safe mutation, and local query
packages/cli/          automation and CI interface (planned)
packages/pi-extension/ Pi package, tools, commands, and hooks (planned)
docs/                  product, architecture, planning, and executable specs
examples/vault/        minimal OKF + Bookie fixture
test/                  repository-level contract tests
```

## Scope

Bookie is operational recordkeeping, not financial accounting, real-time collaborative editing, or compliance-grade WORM storage. See [vision and non-goals](docs/product/vision.md#non-goals).

No license has been selected yet; see [OQ-001](docs/planning/open-questions.md#oq-001-project-license).
