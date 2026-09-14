# `@bookie/pi-extension`

Distributable Pi package for Bookie tools. Canonical behavior belongs in `@bookie/core`; follow [SPEC-003](../../docs/specs/003-pi-extension.md) and the Pi-specific constraints in [AGENTS.md](../../AGENTS.md#pi-implementation-constraints).

BK-013 through BK-015 expose five local tools:

- `bookie_read` reads one explicitly selected local concept by canonical path or UID.
- `bookie_search` performs bounded filesystem lexical and metadata search.
- `bookie_validate` validates an explicit vault, optionally against a local Git base ref.
- `bookie_write` creates or amends one concept from a bounded JSON request file through policy-bearing core APIs and Pi's complete file-mutation queue.
- `bookie_checkpoint` prepares a sensitivity-filtered Activity from structured fragments and either writes after explicit/TUI approval or stages the prepared snapshot for approval before compaction.

Every tool requires an explicit `vault` path, propagates cancellation, throws on operational failure, and bounds output to Pi's 50KB/2,000-line limits. Retrieved text is labelled untrusted. Excluded reads fail with static redaction. Writes require either an explicit originating approval parameter or confirmation through available UI; ambiguous non-interactive approval fails before the request file is read. Checkpoint preparation accepts complete caller-supplied metadata, never raw transcripts, and generates no canonical identity or timestamp. Declined, cancelled, failed, and no-UI pre-compaction capture never blocks compaction. The package starts no background resource and performs no network, commit, or push operation.

From a built repository checkout, load the package temporarily with:

```bash
pi -e ./packages/pi-extension
```

Or install the local package path:

```bash
pi install ./packages/pi-extension
```

A Git installation uses the repository root Pi manifest; its `prepare` script builds the workspace artifacts before Pi loads `packages/pi-extension/dist/index.js`.
