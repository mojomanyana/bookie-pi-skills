# pi-bookie-core release notes

## [0.3.0] - 2026-11-16

- Add `suggestVault` for bounded, unconfirmed lexical candidates with exact source references and explicit matched-word explanations.
- Apply host visibility before candidate counts and ranking. Preserve `searchVault`, `recallVault`, canonical records and their existing result contracts.
- Candidate ranking is deterministic word overlap, not semantic confidence. No provider, index or JEV dependency is introduced.

## [0.2.0] - 2026-11-13

- Add separate normalized all-word `recallVault` and explicit recent-note listing with recorded-time ordering and visible result limits.
- Preserve exact `searchVault` behavior and the existing canonical format.
