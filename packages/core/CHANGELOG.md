# pi-bookie-core release notes

## [1.0.2] - 2026-11-25

- Coordinate the core release with the checkpoint reliability fixes in pi-bookie.

## [1.0.1] — 2026-11-25

- Updated `README.md` and `packages/core/README.md` to document local `node:sqlite` FTS5, passive recall/distill, and `ecosystem.json`, removing stale references to `bookie_work` and `apps/service`.

## [1.0.0] — 2026-11-24

- v1.0.0 major release: local-first OKF canonical core + zero-dependency Node 24 SQLite FTS5 hybrid index (`queryVaultFts`) with fail-closed sensitivity and secret controls.

## [0.5.2] — 2026-11-24

- Parse both YAML and single-line JSON frontmatter in `queryVaultFts` and wrap FTS5 sync in a SQLite transaction.

## [0.5.1] — 2026-11-24

- Maintenance release aligned with `pi-bookie@0.13.0` OIDC publishing.

## [0.5.0] — 2026-11-24

- Add zero-dependency rebuildable SQLite FTS5 index (`queryVaultFts`) using Node 24's built-in `node:sqlite`, enforcing fail-closed sensitivity filtering and secret detection.
- Remove unfinished `apps/service/` Redis microservice.

## [0.4.0] — 2026-11-20

- Reuse a validated project scope when the complete file and directory identities still match. Changes to the vault trigger a fresh inspection.
- Add durable local task observations, explicit file capture, background Git publication and portable historical bundles. Canonical OKF note formats remain readable.

## [0.3.0] - 2026-11-16

- Add `suggestVault` for bounded, unconfirmed lexical candidates with exact source references and explicit matched-word explanations.
- Apply host visibility before candidate counts and ranking. Preserve `searchVault`, `recallVault`, canonical records and their existing result contracts.
- Candidate ranking is deterministic word overlap, not semantic confidence. No provider, index or JEV dependency is introduced.

## [0.2.0] - 2026-11-13

- Add separate normalized all-word `recallVault` and explicit recent-note listing with recorded-time ordering and visible result limits.
- Preserve exact `searchVault` behavior and the existing canonical format.
