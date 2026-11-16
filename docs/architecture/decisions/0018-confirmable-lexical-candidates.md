# ADR-0018: Confirmable local recall candidates

- Status: Accepted for the operator-authorized flexible-recall implementation on 2026-11-16; delivered in pi-bookie 0.5.0/core 0.3.0 with verification recorded in BK-048 and public-delivery evidence.
- Scope: BK-048, SPEC-002/003, REQ-014/017/018/024/025/027. Extends ADR-0017 and retains ADR-0013/0016 authority boundaries.

## Decision

Preserve `searchVault`, `recallVault` and Pi search/recent/exact matching and ordering. Add the separate core `suggestVault` API and explicit managed-only Pi `mode=candidates`. Reuse the bounded validated filesystem scanner and current host-owned visibility predicate before counting or ranking. No canonical records, permissions, provider calls, indexes, JEV state or shared service change.

Candidates require at least one complete NFKC/lowercase Unicode query token in the title/body. Rank by distinct matched query-token count, then matched title-token count, then recorded time descending and canonical path ascending. Duplicate terms have no extra weight. This lexical ordering is not a semantic score or probability. There is no stemming, synonym expansion, typo correction or model-generated query expansion inside the API. Keep the existing default of ten and explicit 1–50 result bound.

Each candidate remains unconfirmed and untrusted. Return exact source identity, bounded exact-source excerpts, actual normalized matched terms, term counts and explicit clipping/completeness flags. The explanation's word bytes share the text-output budget. Hidden records never consume result slots or appear in visible counts. Current choice-resolution and final authority checks still guard Pi output.

Only a complete managed strict term search with zero matches adds a static next-step hint to try candidate mode or shorter terms in the same scope. The hint starts no work and does not establish empty history. Failed or incomplete search is unknown, not an absence result. Candidate mode can be called explicitly; it neither requires nor manufactures an earlier strict result.

Continuity guidance offers relevant candidates without a fixed option count, plus none of these or the user's own clarification. After selection, exact-read the source and check its identity/currentness before relying on it. A similarly named record must not be silently substituted. None of these rejects the presented suggestions, not all history. A user may clarify, try other terms or choose to proceed without past context; an explicit user instruction to stop on lookup failure still applies. Choosing a candidate never automatically saves a decision, changes scope or grants execution/disclosure authority.

## Compatibility and rollback

The new export and Pi caller require a paired core/extension release with an updated exact dependency before publication. Existing package versions are not delivery evidence. Older core/CLI/manual-vault APIs remain unchanged; manual Pi vaults reject candidate mode. Rollback removes candidate discovery while preserving all canonical files and recall controls.

## Verification

Use deterministic synthetic fixtures for unchanged strict/recent/exact behavior, lexical ranking and ties, actual source identity, partial/empty/single/multiple candidate results, visibility before counts/top-K, clipping and scan limits, cancellation, fresh-session isolation/revocation, no canonical writes and manual-vault refusal. Scripted checks establish mechanics only, not autonomous model selection or human recall quality. No provider or JEV invocation is required.
