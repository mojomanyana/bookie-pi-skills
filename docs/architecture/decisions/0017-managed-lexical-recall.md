# ADR-0017: Useful bounded recall for managed project memory

- Status: Accepted for implementation by the operator's grouped daily-use batch on 2026-11-13. Regression groups approved separately before execution.
- Scope: BK-047, SPEC-002/003, REQ-014/017/018/024/027.
- Extends ADR-0016 without changing project identity, disclosure or capture authority.

## Decision

Keep `searchVault` and the CLI's exact, case-sensitive substring search unchanged. Add `recallVault` as a separate local core API using the same bounded, validated filesystem scanner. Managed Pi project memory uses this API by default. Manually selected vaults keep exact search by default; the tool description and returned matching/order fields make the distinction explicit. `mode=exact` is also available in managed memory.

Term recall applies Unicode NFKC normalization, locale-independent lowercase, then extracts maximal sequences of Unicode letters/numbers. Every distinct query token must occur as a complete token somewhere in the title or Markdown body, in any order. Punctuation separates tokens. This is lexical matching, with no stemming, synonym expansion, embeddings or guarantee that differently worded notes will be found. An empty or punctuation-only query is invalid. `mode=recent` is an explicit query-free listing, available only for managed project memory in Pi.

Order by the recorded `bookie.occurred_at` timestamp, falling back to `generated.at`, newest first. Missing/unusable timestamps sort last. Equal instants sort by canonical path using ordinal comparison. This is recorded note time, not filesystem modification time, proof of freshness, or a model relevance score. Excerpts remain exact bounded source prefixes; normalized text is never substituted into evidence.

Managed recall defaults to ten results and accepts a limit of 1–50. A host-owned visibility predicate applies current project/class/suppression policy before counting and bounded top-K selection; it is not a tool argument. Snapshot rechecks and choice-resolution checks still run before output. The adapter exposes the effective limit, visible match count, scan completeness, result truncation and text truncation. A capped or incompletely resolved response is not a complete search; clipped excerpts require exact reads before judging their contents. Hidden records must neither consume visible result slots nor appear in match counts.

## Boundaries and delivery

There is no shared retrieval service, indexing, broad vault discovery, folder migration, automatic scope change, new permission source, provider call or model-generated search expansion. Existing canonical records require no migration. Core's new additive export requires a future paired core release and updated exact `pi-bookie` dependency; development version pins do not make that API available in published 0.1.0.

## Verification

Use deterministic cases for reordered/case/punctuation/Unicode terms, missing terms, unchanged exact behavior, timestamp precedence/ties, more than fifty records, limits and incomplete scans, output clipping, visibility before top-K, cancellation, and same-folder fresh-session recall with unrelated/revoked sessions denied. Keep the existing default host lane and add a pinned Pi 1.5.2 scripted `/new`/choice journey. Passing scripted fixtures verifies mechanics, not autonomous model selection or universal research recall.
