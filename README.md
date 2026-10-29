# Bookie

Bookie is a local-first, Git-native project ledger for people and agents. It keeps tasks, documents, research, decisions, activity checkpoints, files, and evidence in an [Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)-compatible bundle and exposes disciplined workflows through a Pi extension.

## Current status

| Area | Available now | Remaining work |
| --- | --- | --- |
| Canonical core | Lossless Markdown/YAML, validation, conflict-safe mutation, Evidence capture, local search/inspect and exact-commit JSONL export. | Verified through BK-011. |
| CLI and Pi | Read/query CLI; Pi read, search, validate, approved writes and curated checkpoints. | CLI filesystem-writing commands are deferred by ADR-0008. |
| Shared retrieval | Merged authenticated HTTP contract, projection, ingestion, source preflight, Redis candidate primitives and qualified immutable local runtime images. | BK-017 S6 fenced lifecycle, controller integration, Redis search, activation, production Compose and scale qualification; record S5 review/delivery before dependent work. |

The canonical profile is verified. Shared retrieval is still incomplete: S5 private trusted recipe/builder verification is implemented and locally qualified; controller/Redis integration and production deployment/scale qualification remain pending. [PR #28](https://github.com/mojomanyana/bookie-pi-skills/pull/28) merged at `2026-10-10T00:12:09Z` as `4774ce18f47a5e979ab1d09365a2b2377af26458`; matching PR and merged-main CI succeeded. BK-025 is Done; BK-017 remains Ready/partial and SPEC-004 In progress. Delivery reconciliation merged in [PR #29](https://github.com/mojomanyana/bookie-pi-skills/pull/29); its merged-main CI passed. No package publication or production qualification is claimed. See the [backlog](docs/planning/backlog.md) for acceptance and the [handoff](docs/planning/next-session.md) for development status. Shared-code and build improvements are recorded in [BK-025](docs/planning/evidence/BK-025.md).

The bounded BK-017 integrity/policy repair and **BK-026–029 local safety increment** merged in [PR #30](https://github.com/mojomanyana/bookie-pi-skills/pull/30) as `eb2a34f31977165b866927ce0ac0d04bc5f34376`; matching PR and [merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40872106782) passed, including all **938 tests**. BK-026–029 are Done: host-loader queue sharing, hash-free excluded write results, nonblocking request reads and supervised CLI parsing. See their [delivery evidence](docs/planning/evidence/BK-026.md#post-merge-delivery-reconciliation--2026-10-29-utc), the dated [principal assessment](docs/planning/principal-assessment.md) and the [handoff](docs/planning/next-session.md). BK-017 remains partial; no further retrieval feature was enabled. Docker access is restored. Fresh S5 runtime/deployment qualification passed **1/0/0** and **10/0/0**; four clean builds reproduce the local artifact recorded in [BK-017 evidence](docs/planning/evidence/BK-017.md#s5-changed-candidate-qualification--2026-10-29-utc). S5 supplies only authenticated private recipe provenance and independently verified complete output, not a controller or serving capability. Integrated review and actual delivery evidence govern progression to S6; no production distribution or scale qualification is inferred.

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
nvm use
npm ci
npm run check
```

Use the [Node 24 toolchain](docs/planning/toolchain.md). `npm run check` runs formatting, lint, typechecking and all repository/workspace tests, including packaging. `npm test` runs just the test workflow. Redis and hardened deployment checks require their documented environments; see the [service commands](apps/service/README.md).

## Repository shape

```text
apps/service/          authenticated service and unfinished retrieval implementation
packages/core/         lossless parsing, validation, safe mutation, and local query
packages/cli/          read/query automation and CI interface
packages/pi-extension/ Pi tools, approved writes, and checkpoint hooks
docs/                  product, architecture, planning, and executable specs
examples/vault/        minimal OKF + Bookie fixture
test/                  repository-level contract tests
```

## Scope

Bookie is operational recordkeeping, not financial accounting, real-time collaborative editing, or compliance-grade WORM storage. See [vision and non-goals](docs/product/vision.md#non-goals).

No license has been selected yet; see [OQ-001](docs/planning/open-questions.md#oq-001-project-license).
