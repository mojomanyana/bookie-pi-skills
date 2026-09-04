# Toolchain baseline

Last reviewed: 2026-09-04 UTC

This is the supported repository-development baseline, not a promise that every registry's highest major version is compatible.

## Runtime and package manager

| Tool | Baseline | Policy |
|---|---:|---|
| Node.js | 24 | Pinned by `.nvmrc`; root and packable package engines are `>=24`. Use Node 24 in CI until an ADR changes the runtime line. |
| npm | 11.9.0 | Recorded in `packageManager`; refresh the lockfile only with a compatible npm 11 release. |
| Git | 2.29+ for base-aware validation | Required only when `validateVault()` receives `baseRef`; this baseline provides local object-format discovery and bounded plumbing. Filesystem-only core behavior does not invoke Git. |
| Pi | Current release when SPEC-003 starts | No repository dependency exists yet. Add peer dependencies and a smoke-test matrix when the extension imports Pi APIs. |

## Continuous integration

The single GitHub Actions workflow uses `actions/checkout@v5` and `actions/setup-node@v5`, whose action runtimes use Node 24. It runs on GitHub-hosted `ubuntu-latest`, loads the application runtime from `.nvmrc`, restores npm's cache, performs `npm ci`, and executes the root quality command. A future self-hosted runner must be v2.327.1 or newer before it can execute these v5 actions.

Repository tests require each action exactly once and recognize both shorthand and named `uses:` steps so workflow presentation changes cannot hide a stale duplicate.

## Development dependencies

| Package | Selected line | Reason |
|---|---:|---|
| ESLint / `@eslint/js` | 10 | Current compatible major on Node 24. |
| `globals` | 17 | Current compatible major. |
| Prettier | 3 | Current major. |
| TypeScript | 6.0 | Latest line accepted by the current `typescript-eslint` peer range. |
| `typescript-eslint` | 8 | Current major; supports ESLint 10 but requires TypeScript below 6.1. |
| `@types/node` | 24 | Intentionally matches the Node 24 runtime rather than the registry's Node 26 types. |
| Ajv / `ajv-formats` | 8 / 3 | Strict JSON Schema 2020-12 validation and URI formats in both repository conformance tests and the packaged core vault validator. |
| `yaml` | 2 | Generic YAML 1.2 fixture reader and the ADR-0005 core Document parser. Core retains raw source for exact no-op serialization and keeps parser AST types private. |
| `mdast-util-from-markdown` | 2 | Inert CommonMark AST parsing for local link/image/reference validation without rendering, raw-HTML traversal, or network access. |

TypeScript 7 and Node 26 types are intentionally not selected: they are not compatible with the current parser/runtime baseline. They are upgrade candidates, not stale patch dependencies.

## Update procedure

1. Run `npm outdated --long` and distinguish compatible updates from runtime/parser major changes.
2. Confirm peer and engine ranges with registry metadata.
3. Update one toolchain boundary at a time.
4. Refresh `package-lock.json` with the pinned npm major.
5. Run `npm run check` from a clean install.
6. For a major runtime, parser, or Pi API change, add or supersede an ADR.
7. Update this document's date and rationale.

## Drift guards

Repository tests verify:

- `.nvmrc`, root engine, and package engine alignment;
- `@bookie/core` runs its build during `npm pack`, and a clean relocated tarball contains code, declarations, canonical schema assets, and a complete declared runtime dependency set;
- pinned npm package-manager syntax;
- workspace name/version/private-state alignment with the lockfile;
- OKF and example profile version consistency;
- backlog dependency order, valid states, and completion evidence;
- contiguous requirement, specification, ADR, backlog, and open-question numbering;
- Node 24-native checkout/setup action lines and the surrounding clean-install CI contract.
