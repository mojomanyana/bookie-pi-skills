# SPEC-003: Pi extension

## Status

In progress — BK-013 implements packaged read, filesystem-search, and validation; BK-014 adds approved queued create/amend; BK-015 adds structured checkpoint preparation and pre-compaction approval; service retrieval and export tools remain later backlog work

Owner: unassigned  
Target release: 0.1  
Depends on: SPEC-002, [ADR-0009](../architecture/decisions/0009-structured-checkpoint-preparation.md), Pi extension/package APIs

## Goal

Provide a distributable Pi package that exposes safe Bookie read, search, write, checkpoint, validate, and export workflows while keeping canonical rules in core and requiring approval for durable capture.

## Non-goals

- Automatic memory promotion after every turn.
- Automatic commits or pushes.
- Owning Redis indexing logic.
- Full transcript archival.
- Complex TUI dashboards in the first release.

## Requirements

1. Register these stable tools: `bookie_read`, `bookie_search`, `bookie_write`, `bookie_checkpoint`, `bookie_validate`, and `bookie_export`.
2. Register human commands for capture, checkpoint, search, validation, status, and export.
3. Resolve configuration only after project trust and support a vault outside the current code repository.
4. Use Pi's `StringEnum` for string enum schemas and strict TypeBox inputs.
5. Queue the complete mutation window with Pi's file mutation queue using the resolved absolute path.
6. Throw actionable errors so failed tools are marked failed; never return error-looking successful content.
7. Enforce Pi output limits, save bounded details only, and disclose truncation.
8. Offer a checkpoint before compaction only when UI is available; compaction must continue if the user declines or no UI exists.
9. Never write a checkpoint from `agent_end` or `agent_settled` without explicit approval.
10. Label local and service fallback modes and include source/trust/freshness metadata.
11. Start clients/watchers on session start or demand and close them idempotently at session shutdown.
12. Package runtime dependencies correctly and expose skills only when they add workflow knowledge beyond tool descriptions.

## Tool behavior

- `bookie_read`: resolve UID/path and return bounded canonical content plus metadata.
- `bookie_search`: search local overlay and optional service; expose mode and score sources.
- `bookie_write`: create/amend/supersede/archive using typed actions; no generic arbitrary-file write. Activity create/amend is rejected here and routes exclusively through `bookie_checkpoint`'s structured preparation boundary.
- `bookie_checkpoint`: prepare a deterministic preview from complete caller-supplied Activity metadata and structured sensitivity-labelled fragments through core. It either writes immediately after explicit/TUI approval or stages the already-prepared request for cancellable confirmation at the next compaction event.
- `bookie_validate`: validate selected files or vault, optionally against a base ref.
- `bookie_export`: produce a dry-run or local artifact; external destination execution belongs to SPEC-005.

Non-interactive calls that require approval must fail with a clear instruction unless the user explicitly supplied an approval flag in the originating tool parameters.

Per ADR-0009, checkpoint preparation accepts no raw transcript and generates no path, UID, project, actor, timestamp, or sensitivity. The required fragment sections are outcome, changed artifacts, decisions, evidence, validation, unresolved work, and next action; source session is optional. Core validates sensitivity labels against the manifest, rejects missing/undeclared classes and detected secrets, omits complete excluded fragments before preview, and renders a bounded body behind an opaque prepared-publication value detached from publicly returned data. Confirmation identifies only the canonical target and a digest of filtered input; it does not retain or display raw vault or external request-file paths. `createCheckpointWithPolicy()` rechecks the prepared vault/target/parent identities and complete manifest hash inside the queued mutation and reloads that manifest again after temporary staging before creating the Activity. A staged checkpoint is session-local and is discarded at shutdown. Only one draft slot may be preparing, pending, confirming, or publishing; reservation occurs before request-file I/O, and further sequential or concurrent staging attempts fail statically until the slot is released. A confirmation that would exceed Pi's byte or line limit is rejected rather than truncated.

## Acceptance criteria

- The package installs from a local path and Git source using Pi package conventions.
- All six tools load, advertise accurate descriptions, and call core rather than duplicate policy.
- Mutation tests prove serialization through the file mutation queue.
- Checkpoint preview/confirm/write succeeds in TUI and refuses ambiguous approval in print/JSON mode.
- Declining or cancelling a checkpoint writes nothing and does not cancel compaction; no-UI compaction also continues without reading or writing a draft.
- A mixed-sensitivity checkpoint retains included context but omits excluded UIDs, paths, and marker content from its preview, written Activity, diagnostics, and logs.
- No lifecycle hook creates canonical files during ordinary agent completion.
- Service outage returns labelled local fallback results; total retrieval failure throws or returns an explicit failed/degraded contract rather than an empty success.
- Tool outputs truncate at documented byte/line limits and point to a retrievable full artifact where appropriate.
- Session shutdown releases all resources and remains safe when called twice.
- Source inspection confirms no commit or push invocation exists.

## Test strategy

- Extension registration tests with a fake Pi API.
- Tool contract tests against temporary example vaults.
- Parallel mutation test that would lose an update without queueing.
- TUI, RPC/print, cancellation, decline, service-failure, and output-boundary tests.
- Mixed-sensitivity checkpoint tests capture preview output, Activity bytes, diagnostics, and notifications, proving included content remains and excluded identifiers/content do not.
- Preparation tests cover required sections, missing/undeclared classes, excluded Activity classification, detected secrets, input/output bounds, cancellation, and manifest snapshot changes. Hook tests cover a staged write, decline, cancellation, no UI, no staged draft, shutdown cleanup, and absence of `agent_end`/`agent_settled` writers.
- Package smoke test through `pi -e` or local package installation in CI where Pi is available.
- Static test denying `git commit`, `git push`, credential logging, and writes outside core mutation APIs.

## Dependencies

- [SPEC-002](002-core-and-cli.md)
- [Pi package architecture](../architecture/overview.md#pi-extension)
- Installed Pi documentation: `docs/extensions.md`, `docs/packages.md`, and `docs/skills.md`

## Delivery notes

Begin with read, local search, validate, and explicit create. Add checkpoint only after the Activity schema and session-context redaction policy are verified. Keep initial rendering compact and use default Pi rendering unless a proven usability problem requires customization.
