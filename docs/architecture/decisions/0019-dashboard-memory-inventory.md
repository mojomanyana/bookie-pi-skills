# ADR-0019: Current scoped notes in the optional dashboard

- Status: Accepted for the operator-authorized dashboard contents batch on 2026-11-16; implemented and locally verified as a candidate; merge and publication remain pending.
- Scope: BK-049, SPEC-003, REQ-014/024/025/027. Extends ADR-0016 and retains current capture/disclosure authority.

## Decision

The optional Bookie managed-memory dashboard may show a bounded inventory of saved Activity notes in the currently authorized project: titles, brief source summaries and exact display references. This terminal metadata does not become model input, proof of acceptance, execution authority or an automatic saved decision. Current owner, trust, Auto permission, project, class, exclusion, suppression and explicit disabled-state checks apply before and after reading. The authorized terminal view uses a separate local ticket; it never resolves provider credentials or model endpoints. Existing model-facing disclosure and choice-control tickets retain their destination checks. No cross-project discovery or producer-body import is added.

Negotiate the additive inventory capability in the existing source-registration reply. Older hosts receive the unchanged sequence/items payload. New hosts receive at most 12 entries within 8192 UTF-8 bytes, separate from the existing eight contribution slots. An exact visible total is shown only after a complete scan. A capped displayed selection can retain an exact count with limited=true. Incomplete scans with usable entries are available/limited with no count; no usable entries are unknown. Empty requires a complete authorized zero-result observation, count=0 and limited=false. Unavailable/unknown observations expose no protected entries or count.

Register a generic refresh callback independently of saved choices. It returns a freshly authorized observation to the host; it never calls publish from inside that callback. The host owns visible-demand scheduling, coalescing, deadlines, backoff and accepted-observation timestamps. Bookie propagates cancellation through bounded local reads, checks its publisher/owner/session generation before returning, and closes the source immediately on lifecycle or explicit revocation. A timeout, stale callback or failed read cannot refresh a healthy timestamp. Ordinary save/lifecycle events may still publish current metadata.

Existing open-choice rows, exact answer controls and their contribution budget are preserved. Readiness remains meaningful when there are no open choices. No models, JEV calls, network requests, background research or new persistence are introduced.

## Compatibility and verification

This is an additive optional adapter capability and needs no core or canonical migration. Verify old-host payloads, empty and non-empty inventories, scope/exclusion before count/selection, clipping/partial scans, cancellation, stale owner and disclosure revocation, zero-choice refresh, saved-choice preservation and fresh-session content restoration. Reuse the existing local/native checks. Fixtures establish mechanics, not general semantic quality or large-vault latency. Rollback removes optional inventory/refresh while preserving saved notes.
