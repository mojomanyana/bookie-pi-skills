# ADR-0015: Public Pi and core package names

## Status

Accepted by the repository owner on 2026-11-06. Resolves OQ-015. Supersedes only
the pre-release package-name/private-distribution assumptions in ADR-0004,
ADR-0005 and ADR-0006; their architecture, parsing and export contracts remain.
ADR-0014's MIT decision is unchanged.

## Context

The owner selected unscoped public names after declining a personal namespace.
The Pi-facing package is the user installation surface; its core must resolve as
an ordinary automatic runtime dependency. Historical private archives and merged
evidence used `@bookie/pi-extension` and `@bookie/core`; those records retain their
original identities and do not become evidence for renamed archives.

## Decision

- Name `packages/pi-extension` **pi-bookie**, version **0.1.0**, under **MIT**.
- Name `packages/core` **pi-bookie-core**, version **0.1.0**, under **MIT**.
- Make only these two package manifests public (`private: false`, public npm
  access). The monorepo root, `@bookie/cli` and `@bookie/service` remain private.
- `pi-bookie` depends on exactly `pi-bookie-core: 0.1.0`; installation brings core
  automatically. The private CLI and service use that same exact core pin.
- Preserve package directories, core exports, Pi's TypeScript entry, Pi host peers,
  all tool/event identifiers and vault/recall formats. No alias package, protocol
  change, automatic state migration or new behavior is introduced.
- Update active imports, workspace links, runtime staging paths and executable
  fixture expectations consistently. Preserve historical ADR text and evidence;
  this decision supplies their explicit package-name supersession.

## Installation and compatibility

After publication, users install `npm:pi-bookie@0.1.0` through Pi. Direct core
consumers import `pi-bookie-core`. Local/Git development entries remain supported.
When switching an existing private installation, select the new package instead
of loading old and new Bookie entries together. Existing vault data is unchanged;
disclosure/capture/work selections remain subject to their normal trusted setup.

Core and Pi tarballs must be qualified together with exact dependency resolution,
MIT notices and actual host loading before release. Historical immutable service
runtime identities are not requalified by changing source import paths. Service
completion, runtime/deployment qualification and data-owner decisions remain
separate. Public manifests alone do not publish a package, establish registry
ownership, mark unmerged backlog work delivered, or authorize a provider call.

## Validation and rollback

Repository contracts pin the two public names/versions/licenses, exact core
dependencies, unchanged Pi entry/peers and the three private package boundaries.
Run the existing required check and exact paired archive/install/loader checks.
Rollback selects the preserved old private artifacts; do not rewrite historical
receipts or transfer their hashes/acceptance to renamed artifacts.

## Maintenance clarification — 2026-11-07

The 0.1.0 versions above record the first public release, delivered in PR #42 and
tag v0.1.0; they are not a permanent version lock. The authorized continuity
instruction maintenance candidate is `pi-bookie` 0.1.1, retaining the exact
automatic dependency `pi-bookie-core: 0.1.0`. Core runtime and its package remain
unchanged. Private root/CLI/service boundaries, package names, tool identifiers,
permission contracts, MIT notices and paired archive/install/host-loading gates
remain unchanged. This patch does not advance the shared-retrieval milestone.
Preparing a new version is not publication; [delivery evidence](../../planning/evidence/public-delivery-0.1.0.md)
distinguishes the released baseline from this local candidate.
