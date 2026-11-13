# Documentation map

This page is the stable entry point for product and engineering context.

## Product

- [Vision](product/vision.md) — problem, users, principles, success measures, and non-goals.
- [Requirements](product/requirements.md) — authoritative behavioral and quality requirements.

## Architecture

- [System overview](architecture/overview.md) — components, boundaries, flows, failure modes, and scale assumptions.
- [Data model](architecture/data-model.md) — OKF envelope, Bookie profile, entity rules, evidence, and audit semantics.
- [Retrieval](architecture/retrieval.md) — derived indexing, ranking, embeddings, migration, and observability.
- [Security](architecture/security.md) — assets, trust boundaries, threats, and controls.
- [Architecture decisions](architecture/decisions/) — accepted load-bearing decisions, including the [service protocol, auth, and projection design](architecture/decisions/0010-service-protocol-auth-and-projection.md).

- [Bounded rebuild admission](architecture/decisions/0011-bounded-rebuild-admission.md) — accepted ADR-0011 resolves OQ-013; source metadata/preflight, v2 recipe golden vectors and artifact staging/inventory are merged prerequisites. Historical reproducible immutable local-image qualification and integrated repair review are complete for the recorded profile; PR #30 changed runtime bytes. Docker access is now restored and the S5 private trusted recipe/builder path has fresh local runtime/deployment qualification (1/0/0 and 10/0/0, four reproducible builds). See [S5 evidence](planning/evidence/BK-017.md#s5-changed-candidate-qualification--2026-10-29-utc). S5 is delivered in PR #32/#33. Corrected S6 private fenced input claims/output attachment now pass real Redis (25/0/0) and fresh runtime/deployment qualification (1/0/0 and 10/0/0); see [S6 evidence](planning/evidence/BK-017.md#s6-fenced-output-attachment--2026-10-30-utc). S6 integrated approval and delivery are recorded in PR #34/#35. S7 now supplies an owned admission/controller component and optional existing-v1 rebuild/status/cancel routes, with corrected real Redis 29/0/0, root 1000/0/0 and fresh runtime/deployment 1/0/0 and 10/0/0; see [S7 evidence](planning/evidence/BK-017.md#s7-owned-controller--2026-10-30-utc). S7 is delivered in PR #36 with final integrated approval and matching merged-main CI; see [delivery evidence](planning/evidence/BK-017.md#s7-delivery-completed--2026-10-30-utc). The first S8 private actual stored-output verifier is delivered in PR #38 with final integrated approval and exact merged-main CI **1031/0/0**, as an initially unconnected primitive; see [S8 delivery evidence](planning/evidence/BK-017.md#s8-integrity-delivery-completed--2026-11-03-utc). The S8 controller-owned bounded writer/real-verifier continuation is delivered in [PR #40](https://github.com/mojomanyana/bookie-pi-skills/pull/40), with latest root **1160/0/0** and matching retained Redis **71/0/0**. Separate operator authorization now supplies fresh current-harness runtime **1/0/0** and deployment **10/0/0**, four independently clean `6d033e…` artifact images, complete bounded traces and confirmed owned cleanup without retries or raised limits; see [current qualification](planning/evidence/BK-017.md#s8-current-harness-qualification--2026-11-04-utc). The original timeout remains unexplained. Independent integrated APPROVE and matching corrected-head/[merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/41821298026) **1160/0/0** establish delivery of the complete 27-path increment; see [delivery evidence](planning/evidence/BK-017.md#s8-writer-delivery-completed--2026-11-04-utc). This is not full BK-017 or production acceptance. Success remains `building` with capacity/renewal held. Search/evaluation/completion/serving, production supervision/distribution/Compose and scale verification remain pending. [PR #28](https://github.com/mojomanyana/bookie-pi-skills/pull/28) merged at `2026-10-10T00:12:09Z` as `4774ce18f47a5e979ab1d09365a2b2377af26458`, with successful PR and merged-main CI. BK-025 is Done; BK-017 remains Ready/partial and SPEC-004 In progress. Delivery reconciliation merged in [PR #29](https://github.com/mojomanyana/bookie-pi-skills/pull/29) with successful merged-main CI. See the handoff for verified delivery snapshots and the next BK-017 seam.

- [Public package names](architecture/decisions/0015-public-package-names.md) — owner-selected `pi-bookie` and automatic `pi-bookie-core` dependency; first release MIT0.1.0, current Pi maintenance 0.1.3 with core 0.1.0. Private root/CLI/service remain separate.

- [MIT project license](architecture/decisions/0014-mit-project-license.md) — owner-selected license for Bookie code and documentation; third-party licensing and public delivery remain separate.

## Delivery

- [Public local-ledger delivery 0.1.0](planning/evidence/public-delivery-0.1.0.md) — PR #42, matching CI, immutable release and exact npm archive qualification for BK-030–037.
- [Selected handoff review 0.1.3](planning/evidence/BK-041.md) — engineering and customer-update handoffs, review after resume, and changed-input handling.
- [Checkpoint recovery delivery 0.1.2](planning/evidence/public-delivery-0.1.2.md) — BK-040 public release, live save and resume, and clean installation.
- [Public continuity delivery 0.1.1](planning/evidence/public-delivery-0.1.1.md) — BK-038 delivered through PR #43, matching CI, immutable tag and exact npm archive; core 0.1.0 and the unfinished shared service are unchanged.

- [Principal assessment — 2026-10-28](planning/principal-assessment.md) — implementation inventory, safety findings, bounded repair approval, priorities and measured-optimization/refactor guidance. [BK-026](planning/evidence/BK-026.md), [BK-027](planning/evidence/BK-027.md), [BK-028](planning/evidence/BK-028.md) and [BK-029](planning/evidence/BK-029.md) record the subsequent local safety increment, now Done after [PR #30](https://github.com/mojomanyana/bookie-pi-skills/pull/30) and [successful merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40872106782). Earlier assessment/implementation snapshots remain historical.

- [Next-session handoff](planning/next-session.md) — current product picture, checkout state, verification and remaining BK-017 work.
- [Roadmap](planning/roadmap.md) — release sequence and exit gates.
- [Backlog](planning/backlog.md) — ordered issue-ready work.
- [Definition of done](planning/definition-of-done.md) — completion criteria.
- [Open questions](planning/open-questions.md) — unresolved decisions with owners and deadlines.
- [Toolchain baseline](planning/toolchain.md) — supported versions, compatibility holds, and update procedure.

## Reference

- [Bookie profile 1.0](reference/profile-v1.md) — complete manifest, concept, relation, validation, and migration contract.

## Executable specifications

1. [Canonical ledger](specs/001-canonical-ledger.md)
2. [Core library and CLI](specs/002-core-and-cli.md)
3. [Pi extension](specs/003-pi-extension.md)
4. [Retrieval service](specs/004-retrieval-service.md)
5. [Export adapters](specs/005-export-adapters.md)

## Examples and checks

- [Profile 1.0 manifest schema](../schemas/profile/1.0/bookie-config.schema.json)
- [Profile 1.0 manifest fixtures](../fixtures/profile/1.0/bookie-config/)
- [Profile manifest schema tests](../test/bookie-config-schema.test.mjs)
- [Common concept schema](../schemas/bookie-common.schema.json)
- [Initial type schemas](../schemas/types/)
- [Concept schema fixtures](../fixtures/concepts/1.0/)
- [Concept schema tests](../test/concept-schema.test.mjs)
- [Cross-file policy fixtures](../fixtures/policy/1.0/)
- [Cross-file policy contract tests](../test/policy-contract.test.mjs)
- [Complete valid vault fixture](../fixtures/valid-vault/)
- [Invalid vault fixtures](../fixtures/invalid-vaults/)
- [Vault fixture tests](../test/vault-fixtures.test.mjs)
- [Production YAML preservation tests](../packages/core/test/concept-loader.test.mjs) and [mutation goldens](../packages/core/test/concept-mutation.test.mjs)
- [Core concept loader](../packages/core/src/concept-loader.ts) and [tests](../packages/core/test/concept-loader.test.mjs)
- [Core vault validator](../packages/core/src/vault-validator.ts), [Git-base policy](../packages/core/src/vault-git-base.ts), and [tests](../packages/core/test/git-base-validation.test.mjs)
- [Core evidence capture](../packages/core/src/evidence-capture.ts) and [tests](../packages/core/test/evidence-capture.test.mjs)
- [Core filesystem search and inspect](../packages/core/src/filesystem-query.ts) and [tests](../packages/core/test/filesystem-query.test.mjs)
- [Core canonical JSONL export](../packages/core/src/canonical-export.ts), [record schema](../schemas/export/1.0/canonical-record.schema.json), and [tests](../packages/core/test/canonical-export.test.mjs)
- [Core concept mutation](../packages/core/src/concept-mutation.ts) and [tests](../packages/core/test/concept-mutation.test.mjs)
- [Service protocol v1 schema](../schemas/service/v1/protocol.schema.json) and [contract tests](../test/service-design-contract.test.mjs)
- [Example vault](../examples/vault/)
- [Repository contract tests](../test/repository.test.mjs)

## Document lifecycle

- Requirements are changed deliberately and retain stable identifiers.
- An ADR is immutable after acceptance except for corrections; a new ADR supersedes it.
- Specifications move through `Draft`, `Ready`, `In progress`, `Implemented`, and `Verified`.
- A specification is not `Verified` until its acceptance criteria have recorded test evidence.
- Roadmap and backlog state describe delivery, not architecture authority.

- [ADR-0017: managed lexical recall](architecture/decisions/0017-managed-lexical-recall.md) — additive local recall; exact search and scope authority retained.
- [BK-047 evidence](planning/evidence/BK-047.md) — current daily-use candidate and validation status.
