# `@bookie/pi-extension`

Distributable Pi package for Bookie tools. Canonical behavior belongs in `@bookie/core`; follow [SPEC-003](../../docs/specs/003-pi-extension.md) and the Pi-specific constraints in [AGENTS.md](../../AGENTS.md#pi-implementation-constraints).

BK-013 exposes three read/query-only tools:

- `bookie_read` reads one explicitly selected local concept by canonical path or UID.
- `bookie_search` performs bounded filesystem lexical and metadata search.
- `bookie_validate` validates an explicit vault, optionally against a local Git base ref.

Every tool requires an explicit `vault` path, labels retrieved text as untrusted, propagates cancellation, throws on operational failure, and bounds output to Pi's 50KB/2,000-line limits. The package starts no background resource and performs no network, canonical write, commit, or push operation.

From a built repository checkout, load the package temporarily with:

```bash
pi -e ./packages/pi-extension
```

Or install the local package path:

```bash
pi install ./packages/pi-extension
```

A Git installation uses the repository root Pi manifest; its `prepare` script builds the workspace artifacts before Pi loads `packages/pi-extension/dist/index.js`.
