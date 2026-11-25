# SPEC-004: Retrieval Service (Retired)

## Status

Retired in `1.0.0` (superseded by embedded zero-dependency `node:sqlite` FTS5 in `pi-bookie-core/src/sqlite-index.ts`).

## Goal

Retain a concise historical tombstone so sequential specification numbering (`SPEC-001`–`SPEC-005`) remains intact after deleting `apps/service/`, `schemas/service/v1/protocol.schema.json`, and `test/service-design-contract.test.mjs`.

## Non-goals

- Operating a separate Fastify or Redis retrieval service.

## Requirements

None — local OKF vaults are indexed directly on disk by `pi-bookie-core`.

## Acceptance criteria

- Embedded SQLite FTS5 indexing (`queryVaultFts`) passes fail-closed sensitivity and secret controls.

## Test strategy

`node --test packages/core/test/sqlite-index.test.mjs`

## Dependencies

- `pi-bookie-core` (Node 24 built-in `node:sqlite`).
