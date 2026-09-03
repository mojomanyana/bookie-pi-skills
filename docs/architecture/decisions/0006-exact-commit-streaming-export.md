# ADR-0006: Export exact Git commits through a bounded byte sink

## Status

Accepted

## Context

REQ-016 requires exports to be rebuildable from a named canonical Git commit, REQ-026 forbids exporting excluded data, and REQ-028 requires one deterministic versioned JSONL format before destination adapters. BK-011 must support up to 50,000 concepts without treating an export as canonical state.

A working-tree export cannot truthfully attach a commit identifier because mutable records may differ from the named base. Accepting a caller-asserted commit has the same provenance defect. Returning one complete byte buffer makes peak memory scale with the full encoded artifact and gives the later CLI no safe way to distinguish validated bytes from an incomplete export.

## Decision

`@bookie/core` exports only an exact local Git commit. It resolves one sanitized local ref once, reads only blobs reachable from that immutable commit, validates that same snapshot, and records the resolved lowercase object ID in every JSONL line. The implementation does not mix staged or working-tree bytes into the artifact and never fetches.

The public core operation writes complete UTF-8 JSONL lines sequentially to a caller-supplied asynchronous byte sink only after source resolution, validation, sensitivity checks, canonical serialization, and total output sizing have completed successfully. Invalid, incomplete, sensitivity-ambiguous, or oversized snapshots invoke the sink zero times. A sink failure or cancellation after emission starts may leave a prefix in caller-owned storage; callers must discard it. The CLI must therefore stage to an absent temporary file and publish only after core reports success.

Canonical record schema 1.0 carries the resolved commit, exact concept source hash, stable identity/path/type/title, the complete decoded frontmatter mapping, and exact decoded Markdown body. Recursive object keys use deterministic ECMAScript UTF-16 ordering; array order and all schema-valid scalar values are preserved. Destination-specific projection and loss reporting remain later work.

## Consequences

### Positive

- `source_commit` identifies the bytes actually exported rather than a comparison base or assertion.
- Repeating an export of one commit and configuration is byte-identical even if the worktree changes.
- Complete decoded extension metadata remains available to later adapters.
- A bounded sink avoids retaining the complete encoded artifact solely for publication.
- Core remains independent of Pi, destination APIs, and Node stream classes.

### Negative

- Export requires a containing non-bare Git worktree and local Git 2.29+ even though filesystem search does not.
- Core must validate a Git snapshot independently from the mutable filesystem validator.
- The operation retains normalized records until validation and output sizing finish, so memory still scales with bounded decoded corpus size.
- Sink callers must implement discard-on-failure and atomic publication; core cannot retract bytes already accepted by an arbitrary callback.
- YAML presentation details are not represented in JSONL, although complete decoded values and exact source hashes are retained.

## Alternatives considered

- **Working-tree export with `source_commit: null`:** simpler and useful for drafts, but it does not satisfy the named-commit rebuild requirement for canonical JSONL.
- **Caller-asserted commit over working-tree bytes:** rejected because it can invent provenance when mutable files differ.
- **Return one `Uint8Array`:** easy to consume but unnecessarily couples peak memory to artifact size.
- **Write a destination path directly in core:** could provide atomic files but exposes a filesystem publication API that non-filesystem callers do not need and couples core to CLI policy.

## Validation

Golden tests export all initial types twice from one commit and compare exact bytes and hashes. Adversarial tests cover moving refs, worktree divergence, malformed or unsafe commit trees, excluded records and references, unclassified records, output bounds, cancellation, sink failures, and 50,000-record ordering.

## Rollback and revisit triggers

Before a public release, remove or revise the unreleased API and schema together. After schema 1.0 is consumed externally, incompatible record changes require a new schema version rather than silent reinterpretation.

Revisit the sink boundary if a measured 50,000-record export cannot meet the accepted memory/time envelope, or if an accepted offline-draft use case requires a separately labelled working-tree format with `source_commit: null`.
