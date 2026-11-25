# SPEC-004: Retrieval Service (Retired)

**Status:** Retired in `1.0.0` (superseded by embedded zero-dependency `node:sqlite` FTS5 in `pi-bookie-core/src/sqlite-index.ts`).

The external Fastify + Redis retrieval service (`apps/service/`) and `schemas/service/v1/protocol.schema.json` were permanently removed. Local OKF vaults are indexed directly on disk via `queryVaultFts`.

## Scope

Historical placeholder retained solely to keep sequential specification numbering (`SPEC-001`–`SPEC-005`) intact.

## Acceptance Criteria

None — superseded by `pi-bookie-core` SQLite FTS5 tests (`packages/core/test/sqlite-index.test.mjs`).

## Failure Modes

None — no external service exists.

## Verification

`node --test packages/core/test/sqlite-index.test.mjs`
