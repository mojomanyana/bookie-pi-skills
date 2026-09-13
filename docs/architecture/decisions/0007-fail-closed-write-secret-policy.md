# ADR-0007: Fail closed on detected secrets at write surfaces

## Status

Accepted; release 0.1 CLI-surface portions superseded by [ADR-0008](0008-read-query-only-release-cli.md)

## Context

REQ-026 requires user-facing operations to prevent detected secrets from entering canonical records or Evidence resources and forbids secrets from indexes, checkpoints, or logs. The low-level BK-008 and BK-009 mutation primitives intentionally remained policy-neutral while OQ-009 decided the user-facing boundary. BK-012 cannot expose CLI create, amend, or Evidence capture until that boundary has deterministic detection, redacted failure behavior, and an explicit override rule.

Canonical export already has a reviewed deterministic local detector for private-key markers, known credential shapes, credential-bearing URI userinfo, and credential-named fields or assignments. Reusing one detector generation avoids contradictory policy between writes and exports. A user-facing unchecked override would require approval identity, audit persistence, and safe non-interactive semantics that release 0.1 does not otherwise need.

## Decision

Any supported Pi or future CLI init, create, amend, and Evidence write surface fails closed when the shared deterministic local detector finds possible credential material. They expose no flag, environment variable, configuration value, prompt, or fallback that bypasses the check. A later override requires a superseding decision with an accepted approval and audit design.

Core exposes policy-bearing `createConceptWithPolicy()`, `amendConceptWithPolicy()`, and `captureEvidenceWithPolicy()` operations above the low-level filesystem and BK-008/BK-009 primitives. A future accepted initialization operation must scan its destination plus exact supplied manifest and index sources. An entry preflight scans every untrusted request graph and supplied path string before returning value-bearing input or path diagnostics. After candidate construction, create scans `{ path, frontmatter, bodyText }` plus the complete rendered UTF-8 source. Amend scans the same shape for the complete resulting concept, not only edited fields, so retained YAML comments and previously unchecked material cannot be republished through a partial edit. Evidence capture scans the descriptor candidate and the complete bounded staged resource before either target is published. All post-resolution scanning and publication remain inside the primitive's coordinated read-modify-write window.

Concept scanning uses the same structured/string detector and shared fixture outcomes as canonical export. The Evidence resource scanner is byte-oriented and incremental, carries bounded state across chunk boundaries, and applies the shared detector's ASCII private-key markers, known token shapes, credential URI, and credential-assignment outcomes without requiring arbitrary Evidence to be valid text. The [versioned shared fixture corpus](../../../packages/core/test/fixtures/secret-detection-v1.mjs), including placeholders and signatures split at every supported boundary, is the normative detector contract. Detection remains local and performs no network calls.

A detection failure takes precedence over otherwise returnable candidate diagnostics, publishes no path, and returns one static `WRITE-SECRET` error diagnostic with file `<redacted>`. Results, stderr, logs, exceptions, and telemetry do not include the candidate path, source path, field name, matched value, surrounding bytes, or detector-specific match. The remediation says to remove or redact possible credential material and retry; it does not advertise an unavailable bypass. Cancellation, bounds, conflict checks, sensitivity exclusions, and existing mutation safety remain independent and fail closed. Policy-bearing operations also redact every diagnostic file for a candidate assigned an excluded sensitivity class; they never emit that candidate's path, UID, title, body, resource path, source path, field values, content hashes, or byte lengths. An excluded successful Evidence capture therefore returns an explicit redacted-success shape without descriptor/resource hashes or resource size.

The BK-008/BK-009 primitives remain available as explicitly low-level policy-neutral APIs for trusted composition and tests. Any CLI or Pi write surface may call only the named policy-bearing core operations; ADR-0008 exposes no release 0.1 CLI write surface. The existing canonical-export-only low-level `secretPolicy: "allow-unchecked"` contract from ADR-0006 is unchanged and is not exposed by release 0.1 CLI or Pi.

## Consequences

### Positive

- Release 0.1 has one deterministic detector generation across canonical writes and export.
- Non-interactive commands have unambiguous safe behavior and cannot be weakened by ambient configuration.
- Detection occurs before publication, including for binary Evidence and signatures split across stream chunks.
- Static diagnostics avoid turning the detector into a credential disclosure channel.

### Negative

- False positives block a write until the user redacts or removes the triggering content.
- Amend scans can reject an otherwise unrelated edit to a record that already contains detected material.
- Evidence capture performs additional streaming work before publication.
- Low-level policy-neutral APIs remain capable of unsafe use, so package documentation and static tests must prevent CLI/Pi from calling them directly.

## Alternatives considered

- **Empty policy hook in release 0.1:** least implementation work, but violates REQ-026 and creates false assurance; rejected.
- **User-facing `allow-unchecked`:** handles false positives, but safe authorization, approval attribution, and audit storage are unresolved; rejected for release 0.1.
- **Read-only CLI:** preserves safety while deferring write workflows; selected for release 0.1 by ADR-0008 after portable publication review activated this rollback.
- **Network secret-scanning provider:** may broaden detection but introduces availability, confidentiality, credential, and nondeterminism risks at a local write boundary; rejected.

## Validation

Automated adversarial tests must show that every supported core write surface rejects each shared detector fixture, detects a signature split at every relevant resource chunk boundary, publishes no vault, concept, descriptor, or resource on rejection, and emits only the static redacted diagnostic. Success and boundary tests must show placeholders and ordinary binary resources still publish, limits and cancellation remain effective, and CLI/Pi contain no unchecked switch or direct calls to policy-neutral mutation primitives.

## Rollback and revisit triggers

Before release, disable the mutating CLI/Pi commands rather than replacing detection with an allow-all hook if the policy-bearing path cannot be verified. After release, a compatible rollback removes write commands while retaining read-only behavior; it never silently weakens the detector.

Revisit when measured false positives materially block normal use, or when the product has an accepted authenticated approval identity and append-only audit design. Any user-facing override must remain explicit, attributable, non-ambient, sensitivity-preserving, and covered by redaction tests.
