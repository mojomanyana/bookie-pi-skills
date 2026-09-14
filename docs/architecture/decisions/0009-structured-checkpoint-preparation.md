# ADR-0009: Structured checkpoint preparation

- **Status:** Accepted
- **Date:** 2026-09-14
- **Decision owners:** Product owner and security reviewer
- **Scope:** Release 0.1 Pi checkpoint preparation and pre-compaction capture

## Context

REQ-012 requires curated Activity checkpoints without transcript archival, while REQ-026 forbids excluded sensitivity classes and detected secrets from checkpoint previews, canonical Activities, diagnostics, and logs. Pi compaction events do not supply the canonical vault, Activity path, UID, project, actor, or timestamp needed for a valid record. Inferring those values or classifying arbitrary transcript prose inside the extension would duplicate canonical policy and could expose excluded content before the policy-bearing write boundary.

BK-015 therefore needs a deterministic preparation boundary before the extension may preview or retain a pending checkpoint.

## Decision

Core owns checkpoint preparation. A caller supplies complete Activity path/frontmatter metadata and bounded structured fragments. Each fragment has one fixed checkpoint section, one sensitivity class, and text. Core validates the fragment classes against the vault manifest, rejects missing or undeclared classes, omits complete fragments assigned to manifest-excluded classes, rejects detected secrets before returning preview text, and renders included fragments into one deterministic Activity body. It retains a detached `CreateConceptRequest` behind an opaque publication value and returns only the filtered structured input plus a bounded preview contract.

The extension never infers sensitivity from prose and never reads a raw transcript to build a checkpoint. `bookie_checkpoint` may either write the prepared request immediately after explicit or interactive approval, or retain the already-prepared in-memory request for the next compaction event. Interactive approval identifies the exact stable filtered snapshot using only its canonical target path and a digest of the filtered input; raw vault and external request-file paths are neither retained in pending state nor displayed. The pre-compaction hook may use only that prepared state; with UI and a pending checkpoint it previews and requests cancellable confirmation, while decline or failure does not cancel compaction. With UI and no pending checkpoint it emits only a static reminder. Without UI it does nothing and compaction continues.

All Activity publication through policy-bearing APIs uses an opaque value returned by `prepareCheckpoint()` and `createCheckpointWithPolicy()`; ordinary policy-bearing create/amend rejects Activities while the policy-neutral low-level APIs remain available for trusted composition. Checkpoint publication enforces the prepared vault/target/parent identities and complete manifest hash inside the mutation window wrapped by `withFileMutationQueue()`. Ordinary `agent_end` and `agent_settled` events never create or stage checkpoints. Only one checkpoint slot may be reserved, pending, confirming, or publishing per extension session. Reservation occurs before request-file I/O, so a second sequential or concurrent staging attempt fails statically until the first attempt fails preparation or the draft is consumed, declined, cancelled, or discarded idempotently at session shutdown.

The required structured sections are outcome, changed artifacts, decisions, evidence, validation, unresolved work, and next action. A source-session section is optional because Pi may not have an attributable session identifier. Callers use explicit `None.` text when a required section has no event; an excluded-only section is rendered as a static omission notice without counts or identifiers.

## Alternatives considered

### Let the extension summarize and classify the transcript

Rejected. It would send or scan raw conversation content, duplicate sensitivity policy, introduce nondeterministic generation, and risk displaying excluded text before classification.

### Generate Activity identity and timestamps in the extension

Rejected for release 0.1. OQ-010 requires complete caller-supplied authoring metadata unless a shared deterministic generator is separately accepted. Implicit generation also complicates retries and collision handling.

### Require only a complete pre-rendered Activity request

Rejected. The policy-bearing create operation prevents excluded candidate publication but cannot safely preview a mixed-sensitivity body because excluded fragments have already been flattened into prose.

## Consequences

- Preview and write consume the same deterministic, policy-filtered body.
- Excluded fragments and detected secrets cannot enter pending extension state or UI preview.
- Callers must curate and label fragments rather than handing Bookie a transcript.
- Sensitivity labels are explicit caller assertions; core validates class membership but does not infer whether a caller mislabeled prose.
- Checkpoint preparation adds a core API and a session-local extension draft, but no new canonical storage format or background service.
- Pending drafts do not survive session shutdown or process restart; callers can restage from their request file.

## Security and failure behavior

Preparation fails closed on unsafe vault/manifest state, malformed or over-bound input, missing/undeclared fragment classes, an excluded Activity classification, detected secrets, cancellation, a preview exceeding Pi's byte or line limits, or a changed manifest snapshot. Publication also fails if the prepared root, target parent, or complete manifest no longer matches, including a policy change after temporary-file staging but before final publication. Failures are static and do not return fragment text, excluded identifiers, or secret detector details. A failed or declined pre-compaction write emits at most a static notification and never blocks compaction.

## Validation

Tests must capture the prepared preview, canonical Activity bytes, thrown errors, UI notifications, and registered lifecycle handlers. Mixed-sensitivity fixtures must retain included markers while excluded UIDs, paths, and markers appear nowhere in those captured surfaces. Tests must also cover secret rejection, missing/undeclared sensitivity, TUI approval/decline/cancellation, no-UI compaction, queue participation, and ordinary completion events.

## Rollback and revisit trigger

Rollback removes the checkpoint tool/hook and core preparation API; no migration is needed because created Activities already conform to the canonical profile. Revisit when users need deterministic metadata generation, durable drafts across sessions, or measured workflows cannot provide structured sensitivity labels. Any transcript-derived summarization requires a new decision covering provider trust, classification, prompt injection, and preview redaction.
