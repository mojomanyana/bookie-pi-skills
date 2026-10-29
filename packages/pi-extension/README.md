# `@bookie/pi-extension`

Distributable Pi package for Bookie tools. Canonical behavior belongs in `@bookie/core`; follow [SPEC-003](../../docs/specs/003-pi-extension.md) and the Pi-specific constraints in [AGENTS.md](../../AGENTS.md#pi-implementation-constraints).

BK-013 through BK-015 expose five local tools:

- `bookie_read` reads one explicitly selected local concept by canonical path or UID.
- `bookie_search` performs bounded filesystem lexical and metadata search.
- `bookie_validate` validates an explicit vault, optionally against a local Git base ref.
- `bookie_write` creates or amends one concept from a bounded JSON request file through policy-bearing core APIs and Pi's complete file-mutation queue.
- `bookie_checkpoint` prepares a sensitivity-filtered Activity from structured fragments and either writes after explicit/TUI approval or stages the prepared snapshot for approval before compaction.

Excluded write successes serialize an explicit `redacted: true` variant without source/previous hashes, identities or source sizes; included and policy-neutral contracts retain their required hashes. Consumers must narrow that variant before reading hashes. Rollback disables affected writes, never restores fingerprint leakage ([BK-027](../../docs/planning/evidence/BK-027.md)).

Every tool requires an explicit `vault` path, propagates cancellation, throws on operational failure, and bounds output to Pi's 50KB/2,000-line limits. Retrieved text is labelled untrusted. Excluded reads fail with static redaction. Writes require either an explicit originating approval parameter or confirmation through available UI; ambiguous non-interactive approval fails before the request file is read. Checkpoint preparation accepts complete caller-supplied metadata, never raw transcripts, and generates no canonical identity or timestamp. Declined, cancelled, failed, and no-UI pre-compaction capture never blocks compaction. The package starts no background resource and performs no network, commit, or push operation.

Request files open nonblocking/no-follow, then must be stable, singly linked regular files. The 2,000,000-byte endpoint is accepted; one extra byte, malformed UTF-8/JSON, FIFO/substitution, directory, symlink or hardlink fails statically. Request abort reasons are not echoed. Failed immediate/staged checkpoint reads release the session slot before returning ([BK-028](../../docs/planning/evidence/BK-028.md)).

From a built repository checkout, load the package temporarily with:

```bash
pi -e ./packages/pi-extension
```

Or install the local package path:

```bash
pi install ./packages/pi-extension
```

Both the root Git manifest and local subpackage load `src/index.ts` through Pi's TypeScript loader, which maps Pi imports to the actual host (including its mutation queue). Do not load `dist/index.js` directly as a Pi entry: native compiled ESM may bypass host mapping when development dependencies are present. Pi packages are `*` host peers, never production dependencies; the development/typecheck baseline remains Pi 0.85.1, not the globally installed 1.4.0 API.

Git `prepare` builds core JavaScript, declarations and schema assets only; Pi loads the extension TypeScript itself. This works with production installs that suppress host peer installation (`npm install --omit=dev --legacy-peer-deps`). Development builds still compile/typecheck the complete extension and retain `dist` declarations. Clean relocated root/local installation and independent real-host-loader create/amend/checkpoint interlocks are default tests. See [BK-026 evidence](../../docs/planning/evidence/BK-026.md).
