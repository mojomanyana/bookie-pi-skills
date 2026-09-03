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
- [Architecture decisions](architecture/decisions/) — accepted load-bearing decisions.

## Delivery

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
- [YAML decision evidence](../test/yaml-roundtrip-decision.test.mjs)
- [Core concept loader](../packages/core/src/concept-loader.ts) and [tests](../packages/core/test/concept-loader.test.mjs)
- [Core vault validator](../packages/core/src/vault-validator.ts) and [tests](../packages/core/test/vault-validator.test.mjs)
- [Core concept mutation](../packages/core/src/concept-mutation.ts) and [tests](../packages/core/test/concept-mutation.test.mjs)
- [Example vault](../examples/vault/)
- [Repository contract tests](../test/repository.test.mjs)

## Document lifecycle

- Requirements are changed deliberately and retain stable identifiers.
- An ADR is immutable after acceptance except for corrections; a new ADR supersedes it.
- Specifications move through `Draft`, `Ready`, `In progress`, `Implemented`, and `Verified`.
- A specification is not `Verified` until its acceptance criteria have recorded test evidence.
- Roadmap and backlog state describe delivery, not architecture authority.
