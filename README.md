# Bookie

Bookie is a local-first, Git-native project ledger for people and agents. It keeps tasks, documents, research, decisions, activity checkpoints, files, and evidence in an [Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)-compatible bundle and exposes disciplined workflows through a Pi extension.

The local ledger foundation, BK-030–037, is released in `pi-bookie` and `pi-bookie-core` 0.1.0 under MIT. [PR #42](https://github.com/mojomanyana/bookie-pi-skills/pull/42), matching CI, immutable tag and exact npm archives are recorded in [delivery evidence](docs/planning/evidence/public-delivery-0.1.0.md). The 0.1.1 Pi maintenance candidate adds optional task-continuity guidance (BK-038); it is prepared locally, not yet published. Core remains 0.1.0.

[BK-032](docs/planning/evidence/BK-032.md) adds the local model-facing consumers: prepare/read/revalidate exact context handles, resolve registered producer references without a shell, and restore only opaque references after session changes. Trusted project/destination permission remains mandatory; producer text requires a separate explicit body choice. Missing components return unavailable rather than launching replacement work. These consumers are included in the 0.1.0 release; package delivery does not establish general live-provider or memory-quality guarantees.

## Current status

| Area | Available now | Remaining work |
| --- | --- | --- |
| Canonical core | Lossless Markdown/YAML, validation, conflict-safe mutation, Evidence capture, local search/inspect and exact-commit JSONL export. | Verified through BK-011. |
| CLI and Pi | Read/query CLI; Pi read, search, validate, approved writes, curated checkpoints and bounded selected canonical JSONL export. | CLI filesystem-writing commands are deferred by ADR-0008. |
| Shared retrieval | Merged authenticated HTTP contract, projection, ingestion, source preflight, Fenced candidate storage, owned rebuild admission/lifecycle and qualified immutable local runtime images. | BK-017 S8 stored-stream completion, lexical search/context, evaluation/activation, production startup/Compose and scale qualification. |

The canonical profile is verified. Shared retrieval is still incomplete: S5 private trusted recipe/builder verification and S6 fenced input claims/output attachment are delivered. S7's private owned controller and optional existing-v1 rebuild/status/cancel routes are delivered in [PR #36](https://github.com/mojomanyana/bookie-pi-skills/pull/36), with final integrated approval and matching merged-main CI. Completion/serving and production deployment/scale qualification remain pending. [PR #28](https://github.com/mojomanyana/bookie-pi-skills/pull/28) merged at `2026-10-10T00:12:09Z` as `4774ce18f47a5e979ab1d09365a2b2377af26458`; matching PR and merged-main CI succeeded. BK-025 is Done; BK-017 remains Ready/partial and SPEC-004 In progress. Delivery reconciliation merged in [PR #29](https://github.com/mojomanyana/bookie-pi-skills/pull/29); its merged-main CI passed. This service status does not negate the separate public local-ledger packages; no production shared-retrieval qualification is claimed. See the [backlog](docs/planning/backlog.md) for acceptance and the [handoff](docs/planning/next-session.md) for development status. Shared-code and build improvements are recorded in [BK-025](docs/planning/evidence/BK-025.md).

The bounded BK-017 integrity/policy repair and **BK-026–029 local safety increment** merged in [PR #30](https://github.com/mojomanyana/bookie-pi-skills/pull/30) as `eb2a34f31977165b866927ce0ac0d04bc5f34376`; matching PR and [merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40872106782) passed, including all **938 tests**. BK-026–029 are Done: host-loader queue sharing, hash-free excluded write results, nonblocking request reads and supervised CLI parsing. See their [delivery evidence](docs/planning/evidence/BK-026.md#post-merge-delivery-reconciliation--2026-10-29-utc), the dated [principal assessment](docs/planning/principal-assessment.md) and the [handoff](docs/planning/next-session.md). BK-017 remains partial; no further retrieval feature was enabled. Docker access is restored. Fresh S5 runtime/deployment qualification passed **1/0/0** and **10/0/0**; four clean builds reproduce the local artifact recorded in [BK-017 evidence](docs/planning/evidence/BK-017.md#s5-changed-candidate-qualification--2026-10-29-utc). S5 supplies only authenticated private recipe provenance and independently verified complete output, not a controller or serving capability. S5 merged in [PR #32](https://github.com/mojomanyana/bookie-pi-skills/pull/32), with delivery recorded in [PR #33](https://github.com/mojomanyana/bookie-pi-skills/pull/33). The corrected S6 increment passes real Redis **25/0/0**, fresh runtime **1/0/0** and deployment **10/0/0**; see [S6 evidence](docs/planning/evidence/BK-017.md#s6-fenced-output-attachment--2026-10-30-utc). S6 is delivered in PR #34/#35. Corrected S7 passes real Redis **29/0/0**, root checks **1000/0/0**, runtime **1/0/0** and deployment **10/0/0**; see [S7 evidence](docs/planning/evidence/BK-017.md#s7-owned-controller--2026-10-30-utc). Attachment remains `building` with its reservation held, not complete or servable. S7 is delivered with final integrated APPROVE and [matching merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/41130311607); see [delivery evidence](docs/planning/evidence/BK-017.md#s7-delivery-completed--2026-10-30-utc). The first S8 increment now implements a private, unconnected actual stored-output verifier, with fresh local root **1031/0/0**, Redis **49/0/0**, runtime **1/0/0** and deployment **10/0/0**; see [S8 delivery evidence](docs/planning/evidence/BK-017.md#s8-integrity-delivery-completed--2026-11-03-utc). This private increment is delivered in [PR #38](https://github.com/mojomanyana/bookie-pi-skills/pull/38), with final integrated approval and exact merged-main CI **1031/0/0**. The S8 controller-owned bounded writer/verifier is delivered in [PR #40](https://github.com/mojomanyana/bookie-pi-skills/pull/40). Latest root **1160/0/0** passes and matching Redis **71/0/0** evidence is retained. After separate operator authorization, the repaired current harness passes fresh runtime **1/0/0** and deployment **10/0/0**, with four independently clean `6d033e…` artifact images, complete bounded traces and confirmed owned cleanup; see [current qualification](docs/planning/evidence/BK-017.md#s8-current-harness-qualification--2026-11-04-utc). No retries or budget changes occurred. The earlier timeout remains unexplained, not retroactively passed. The complete 27-path increment has independent integrated APPROVE, matching corrected-head CI and [exact merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/41821298026) **1160/0/0**; see [delivery evidence](docs/planning/evidence/BK-017.md#s8-writer-delivery-completed--2026-11-04-utc). See [writer evidence](docs/planning/evidence/BK-017.md#s8-owned-payload-writer--2026-11-03-utc). This is increment delivery, not full BK-017 completion or production acceptance. Integrity success still holds `building` with its reservation/renewable lease; Search/evaluation/completion/serving and production/scale gates remain.

## Local ecosystem foundation (released in 0.1.0)

BK-030 and [BK-031](docs/planning/evidence/BK-031.md) add trusted session/project capture, cooperating writer locks, exact extractive context bundles, local suppression/correction controls and metadata-only producer receipts. A current or pinned-commit bundle records its sources and is revalidated before reuse. Current exclusions and sensitivity rules still apply to historical inputs. Bookie does not infer engineering approval from memory, a producer result or a successful hash check.

These optional local features do not enable the unfinished retrieval service. Existing profile 1.0 records remain canonical; the explicitly initialized recall sidecar must be preserved during rollback. Saving and model disclosure are separate human-controlled permissions. See [ADR-0013](docs/architecture/decisions/0013-local-recall-and-producer-references.md) for exact representation, resource limits, recovery and trusted-host boundaries.

## Design commitments

- OKF Markdown in Git is canonical.
- Redis and embeddings are rebuildable retrieval indexes.
- Capture is explicit; checkpoints require request-specific user approval or a human-selected session/project routine-capture permission. No model argument grants authority.
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

## Package installation

The released public package names are **pi-bookie** and its automatic dependency
**pi-bookie-core**, both version 0.1.0 under MIT ([ADR-0015](docs/architecture/decisions/0015-public-package-names.md)). Install the Pi package with:

```bash
pi install npm:pi-bookie@0.1.0
```

The local 0.1.1 Pi candidate adds the `bookie-continuity` skill and recipe while
retaining core 0.1.0; use its new npm pin only after publication.

Core installs automatically; users do not need a second Pi package. Direct Node
consumers import `pi-bookie-core`. Root, CLI and service remain private. Local/Git
development installation remains supported. When replacing an old private
`@bookie/pi-extension` entry, select only one Bookie extension source; vault data,
tool names and trusted permission setup are unchanged. Historical evidence keeps
the old package names and hashes.

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

Bookie code and documentation are licensed under [MIT](LICENSE); see [ADR-0014](docs/architecture/decisions/0014-mit-project-license.md). Third-party dependencies retain their own licenses. The local-ledger packages are published; this license does not complete the separate service release.


### Scoped work maps (released BK-033)

Bookie can retain a bounded, versioned work map inside an ordinary canonical Document. `bookie_work` with `action: schema` explains the actual authoring contract without shell access or private vault reads. `/bookie-work` selects the current Project/plan/task scope; `bookie_work` returns only that scope's exact inputs, output contracts, prerequisites and current owner observations. It does not dispatch work or infer acceptance from a Task label. Optional Daddy ownership and Principal review references remain independently checked.

For a non-engineering role, exact canonical outputs and an operator-confirmed canonical Decision provide a review path without Principal. `/bookie-work accept` confirms that exact output for the current session; `/bookie-work reconcile` records an exact operator-confirmed receipt for a settled external attempt, using recovery-only ownership when necessary. Reload preserves a compact active-branch selection hint, not permissions, judgments or ownership. See [SPEC-003's operational flow](docs/specs/003-pi-extension.md#bk-033-operational-use-and-boundaries) for setup, receipt-only amendments, resource bounds and limitations. This work-map implementation is released in 0.1.0; bounded continuation evidence does not establish general guidance quality.

BK-035 is a released recall repair: canonical observations distinguish ordered control history from producer metadata, and stale remembered outputs can no longer indefinitely withhold later fresh reads. Whole-store validation, producer-body permission and selected task intent remain separate checks. See [implementation evidence](docs/planning/evidence/BK-035.md) and [0.1.0 delivery](docs/planning/evidence/public-delivery-0.1.0.md); release does not establish a measured general memory-quality gain.
