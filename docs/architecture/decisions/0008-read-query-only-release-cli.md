# ADR-0008: Read/query-only release 0.1 CLI

- **Status:** Accepted
- **Date:** 2026-09-04
- **Supersedes:** ADR-0007 only where it required release 0.1 CLI mutation commands or treated a read-only CLI as incomplete

## Context

Implementation review of vault initialization and staged file export found the same portability boundary: portable Node exposes neither directory-relative no-follow mutation primitives nor an atomic descriptor-bound no-replace publication operation. Path-based publication can be redirected by a same-principal rename/symlink race after validation. Final identity checks detect some races only after bytes or a symlink have already been published.

The core create, amend, Evidence capture, validation, query, inspect, and exact-commit JSONL stream APIs remain useful and tested. The decision is specifically about which of those capabilities release 0.1 may expose through the CLI without weakening accepted path-race and no-replace guarantees.

## Decision

Release 0.1 CLI exposes only `validate`, `search`, and `inspect`. These commands do not write the canonical vault or another filesystem output. `init`, `create`, `amend`, `evidence add`, and file-targeted `export jsonl` are unavailable and return a static unknown-command invocation error.

Canonical JSONL generation remains available as the low-level bounded core stream API accepted by ADR-0006. A future CLI file export may be added only with an audited publication primitive and explicit platform/filesystem support matrix, or with a separately accepted output contract that does not claim atomic no-replace file publication.

ADR-0007's fail-closed write-secret policy and policy-bearing create, amend, and Evidence APIs remain accepted. Their omission from the release CLI is a surface rollback, not a bypass or weakening of policy.

## Consequences

- BK-012 can complete as a read/query-only CLI slice.
- Deterministic authoring inputs from OQ-010 remain specified but are not CLI-reachable.
- Users invoke the core JSONL stream API through trusted composition until safe CLI publication is accepted.
- Pi write work remains separate and must use policy-bearing APIs plus its accepted queued mutation boundary.
- The CLI has no reason to import any canonical mutation or export API in release 0.1.

## Rejected alternatives

- Path-based temporary file plus `link()`: a raced temporary pathname can publish attacker-controlled bytes or a symlink.
- Final metadata verification: detects substitution only after publication.
- Cooperating lock files: do not constrain non-cooperating same-principal filesystem actors.
- Silently narrowing the race threat model: contradicts the accepted security posture.

## Verification

Process and static tests must show that only validate, search, and inspect are accepted; deferred command names return static invocation errors without echoing arguments; CLI source imports no mutation/export API; exact inspect bytes and bounded search/validation results preserve core diagnostics and sensitivity handling; package installation from a clean build exposes a working `bookie` binary.

## Revisit trigger

Revisit file-writing CLI commands when Node exposes suitable primitives or an audited native helper has an accepted support matrix and adversarial path-swap, no-replace, cleanup, and durability tests.
