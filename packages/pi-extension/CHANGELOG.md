# pi-bookie release notes

## [1.0.4] - 2026-11-25

- Strictly validate nested `ecosystem.json` fields (`models`, `modelFallbacks`, `bookie`) and fail closed on invalid configs.
- Honor `modelFallbacks.fast`, comma-separated `PI_ECO_MODEL_FAST`, and skip catalogued models whose provider lacks configured auth.

## [1.0.3] - 2026-11-25

- Removed orphaned `retained-handoff.ts` and stale `bookie_work` reference in `bookie-continuity/SKILL.md`.

## [1.0.2] - 2026-11-25

- Retain user decisions from string and text-block messages.
- Reject cancelled or failed distillations and honor the configured fast model.
- Save distinct checkpoints with canonical activity IDs and exclusive file creation.

## [1.0.1] — 2026-11-25

- Updated `README.md` and `packages/pi-extension/README.md` to reflect `1.0.1` SQLite FTS5 passive recall, `/bookie-distill`, `ecosystem.json`, and remove stale JEV / `bookie_work` references.

## [1.0.0] — 2026-11-24

- v1.0.0 major release: removed retired `bookie_work` consumer, added `~/.pi/agent/ecosystem.json` config support, passive `<project_memory>` auto-recall, and canonical OKF `auto-distill`.

## [0.13.1] — 2026-11-24

- Emit canonical OKF Activity frontmatter in `auto-distill` and add contextual deferred Bookie tool activation in `before_agent_start`.

## [0.13.0] — 2026-11-24

- Add automatic cheap-model checkpoint distillation on `session_before_compact` + `/bookie-distill` command (`PI_ECO_MODEL_FAST`, fail-closed secret scanning, `sensitivity: internal`).

## [0.12.0] — 2026-11-24

- Add passive session-start `<project_memory>` auto-recall via `systemPromptOptions.sections` backed by `pi-bookie-core@0.5.0` SQLite FTS5 (fail-closed sensitivity and secret checks).
- Defer all 12 Bookie tools (`exposure: "deferred"`) to eliminate Turn-1 tool-schema bloat while remaining discoverable via Pi's built-in `tool_search` and `codemode`.

## [0.11.1] — 2026-11-21

- A checkpoint can identify a single active delivery and retain its observed sources even when the delivery omitted a named checkpoint. Older notes that name one delivery can supply a read-only lookup.

## [0.11.0] — 2026-11-21

- Named Principal checkpoints now record the delivery and observed source references. An exact read returns the arguments for looking up that delivery after a new session or a fresh launch.
- The save verifies the stored checkpoint and records source availability under current access.

## [0.10.0] — 2026-11-21

- Save one project checkpoint with its outcome, open choice and selected evidence. Evidence-backed summaries support up to 4,000 characters. Ordinary saves keep their 2,000-character limit.
- Follow retained Architect decisions, Principal verification receipts and paged Scout briefs after starting a new Pi session. Recall checks current access and identifies missing sources or ambiguous matches.
- Uses the existing pi-bookie-core 0.4.0. Earlier project notes remain readable.

## [0.9.0] — 2026-11-20

- Read and resume a selected local task, retain observations, track selected working files in separate Git history, and move historical evidence between workspaces. Requires pi-bookie-core 0.4.0.

- Correct a mistaken Open choices item through a compatible dashboard's **Not a separate decision** action. The original note stays intact, no answer is invented, and other choices remain open after a new session.
- Keep corrections separate from saved answers in recall. Updated writers arbitrate answers and corrections under the existing vault lock; a conflicting answer from an older writer remains readable with an explicit conflict. The extension pins its compatible core version.
- Save each genuine decision once. Progress summaries can refer to existing choices without creating another combined question.

## [0.8.2] - 2026-11-19

- Keep rejected save inputs actionable in Pi history, including the 2,000-character summary limit, while hiding private argument dumps. Preserve existing save permissions, bounds, exact receipts and uncertain-write recovery.

## [0.8.1] - 2026-11-18

- Show the verified selected answer in saved-answer Memory previews and return the same question/answer when recall finds either the original question or its answer receipt. Historical notes remain unchanged.
- Reuse unchanged derived answer previews only after a fresh complete scan confirms both record identities and revisions under current access; cold previews still require exact paired inspection.
- Keep inaccessible or altered answer previews explicitly unavailable; preserve paired-record permissions, cancellation and existing bounds. Add fresh-session recall through answer-only terms alongside the existing dashboard choice checks. Core remains exactly 0.3.0; no JEV or model call is added.

## [0.8.0] - 2026-11-18

- Reconnect saved project memory after a folder moves with the terminal-only `/bookie-reattach` command. It shows matching evidence, old/new paths and saved contents, and reconnects only after confirmation. Existing notes, decisions and disclosure permissions are preserved.
- Recover interrupted reattachment safely, protect nonempty destination memories, and retain previously recorded Git evidence when a later Git probe cannot answer. Memories without recorded matching evidence are not silently adopted.
- Verify dashboard memory inventory and refresh even with no open choices, including fresh-session recall and selected, custom and deferred answers. The relocation fixture now runs without administrator privileges.
- Keep the extension compatible with the exact released `pi-bookie-core` 0.3.0 dependency; no core update or JEV call is required.

## [0.7.0] - 2026-11-17

- Save a known next work step with `nextAction`, separately from the user's unresolved choices. Already-authorized review or build work can remain in the handoff without creating a dashboard question.
- Clarify input limits and direct correction of rejected save arguments, while retaining read-before-retry for uncertain writes. Preserve next actions through resource delivery and fresh-session recall; existing notes and the exact core 0.3.0 dependency remain compatible.

## [0.6.0] - 2026-11-16

- Show saved project-note titles, brief summaries and honest counts in a compatible Pi Daddy dashboard, including after a new chat. Keep unavailable access distinct from an empty notebook.
- Refresh the visible dashboard even when no choices are open. This local display uses current project permissions without requesting provider credentials; model-facing recall and choice controls retain their existing disclosure checks.
- Preserve saved choices, older dashboard hosts and exact core 0.3.0 compatibility. No model call, JEV use or automatic saved decision is added.

- Reconcile historical blockers with the current authorized task without bypassing real prerequisites, permissions or explicit stop conditions.
- Return exact read parameters after an immediate saved or already-saved project note, so requested read-back selects the right note even when titles repeat. A successful save does not itself claim read-back or semantic verification; pending final-reply deliveries remain pending.

## [0.5.0] - 2026-11-16

- Offer possible project-memory matches when approximate wording misses the strict search, with shared words and exact source references instead of confidence percentages.
- Explain the next step after a complete search finds no strict match. Let users select a possible match, clarify, or continue without prior context; a suggestion never becomes a saved decision automatically.
- Preserve strict, recent and exact search, project boundaries and disclosure permissions. Includes the exact automatic dependency pi-bookie-core 0.3.0; no model or JEV call is added.

## [0.4.0] - 2026-11-13

- Find managed project notes using all query words regardless of case or order, and explicitly browse the most recent recorded notes.
- Show result limits and incomplete/clipped recall clearly. Exact search, project boundaries and disclosure permissions remain available and unchanged.
- Add a scripted Pi 1.5.2 fresh-session/choice CI check. Includes the exact automatic dependency pi-bookie-core 0.2.0.

## [0.3.1] - 2026-11-10

- Include these release notes in the npm package so Pi 1.5 and newer can explain subsequent updates on a fresh launch.
- Project memory, choice controls, permissions and stored records are unchanged.

## [0.3.0] - 2026-11-10

- Answer a saved project choice from the Pi Daddy dashboard by selecting an option or writing your own answer. Choose Later to leave it open.
- Recall the answer after starting a fresh Pi session in the same project; other unanswered choices stay open.

## [0.2.3] - 2026-11-10

- Keep an explicitly outstanding choice under Unresolved work so it remains visible after a fresh session without demanding immediate attention.

## [0.2.2] - 2026-11-10

- Use the current trusted workspace for automatic project recall. Keep a refused lookup distinct from a successful search with no matches.

## [0.2.1] - 2026-11-09

- Remember the public resource actually delivered in a completed reply, including its exact link, for later project recall.

## [0.2.0] - 2026-11-09

- With Pi Daddy Auto enabled in a trusted parent workspace, create private project memory on first use and save and recall routine notes in that folder.
- Standalone Bookie retains explicit project and disclosure selection.
