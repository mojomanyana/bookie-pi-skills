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

- [Bounded rebuild admission](architecture/decisions/0011-bounded-rebuild-admission.md) — accepted ADR-0011 resolves OQ-013; source metadata/preflight, v2 recipe golden vectors and artifact staging/inventory are merged prerequisites. Historical reproducible immutable local-image qualification and integrated repair review are complete for the recorded profile; PR #30 changed runtime bytes. Docker access is now restored and the S5 private trusted recipe/builder path has fresh local runtime/deployment qualification (1/0/0 and 10/0/0, four reproducible builds). See [S5 evidence](planning/evidence/BK-017.md#s5-changed-candidate-qualification--2026-10-29-utc). Its independent review and delivery govern progression; fenced output attachment, controller integration, production distribution/Compose and scale verification remain pending. [PR #28](https://github.com/mojomanyana/bookie-pi-skills/pull/28) merged at `2026-10-10T00:12:09Z` as `4774ce18f47a5e979ab1d09365a2b2377af26458`, with successful PR and merged-main CI. BK-025 is Done; BK-017 remains Ready/partial and SPEC-004 In progress. Delivery reconciliation merged in [PR #29](https://github.com/mojomanyana/bookie-pi-skills/pull/29) with successful merged-main CI. See the handoff for verified delivery snapshots and the next BK-017 seam.

## Delivery

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
