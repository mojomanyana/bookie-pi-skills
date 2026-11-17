# ADR-0022: Human re-attach of moved project memory

- Status: Accepted for implementation by the owner's decision of 2026-11-17: "Explicit command, you confirm. A Bookie command shows the earlier project it believes this is (matching Git history), with old and new paths, and re-attaches only after you confirm in the terminal. Never automatic and never offered to the model." Tracked as BK-052; not released.
- Scope: SPEC-003, REQ-011/013/024/025/035. Extends ADR-0016 and supersedes its statement that the extension never scans for an existing vault, for this human command only; automatic paths still never scan or reuse a different binding. Capture (ADR-0012), disclosure (ADR-0013), dashboard (ADR-0019) and canonical profile rules are unchanged.

## Context

ADR-0016 binds automatic project memory to the exact workspace: the private mapping `bookie-project-memory/<key>.json` is named by `sha256([1, realpath, "dev:ino:birthtimeNs"])` and is a hard link to the ledger's sealed `binding` file. A moved or renamed folder computes a different key, so its memory is no longer found, and the next Auto session creates a new empty memory for the new path. Before this decision Bookie kept no readable folder path and no Git evidence; the earlier location could not be recovered from its own storage.

## Decision

Each managed open writes a small location record, `workspace.json`, beside the sealed binding in the ledger directory (outside the canonical vault). It holds the mapping key, the folder's real path and directory identity, the Git `HEAD` commit with the folder's prefix inside its repository (or `null`), the last-opened time and a bounded move history. It is written through a private temporary file and an atomic rename, under the same current-authority check as the open. Lookup never reads it; a missing or invalid record only makes a memory unmatchable. Git is run read-only with inherited `GIT_*` routing, user/system configuration, replace objects, hooks and fsmonitor disabled, a 5-second limit and bounded output.

The human-only `/bookie-reattach` command is registered as a Pi command, never as a tool, and is mentioned in no model-facing description or injected guidance. It requires the interactive terminal (`mode: "tui"` with UI) and a trusted folder. It refuses when this folder's memory holds anything beyond the untouched automatic seed, or cannot be verified. An untouched seed (no notes, decisions, evidence, controls, registrations or project edits) is the empty memory Auto creates on the first session in the moved folder; it is set aside unbound, never deleted or merged.

Candidates are other live bindings with a record whose folder no longer exists. A recorded folder that still exists is a copy or fork and is never offered. When a commit was recorded, this folder must be in a Git repository at the same prefix and `git merge-base --is-ancestor <recorded> HEAD` must succeed; otherwise the candidate is excluded. Ancestry of the recorded `HEAD` already implies the same root commit, so no separate root comparison is stored. A matching directory identity (same device, inode and creation time) is reported as same-folder evidence. A candidate with neither is shown as unverified. The terminal shows the old and new paths, evidence, note and open-choice counts and times; the confirmation names both paths. Anything other than an explicit yes changes nothing.

Under an exclusive store lock, the command re-checks everything it showed, writes a pending binding for this folder's key in the chosen ledger, links it exclusively as this folder's mapping (or atomically replaces the untouched seed's mapping), and commits by renaming the pending binding over the ledger's seal. Before that rename the earlier mapping still resolves and this folder's cannot; after it this folder resolves and the earlier mapping fails the seal check and is removed. A crash before the commit leaves a recognizable pending link that fails closed and is rolled back by the next run. The move is appended to the record's history.

Re-attaching grants nothing. Capture and disclosure authority were never persisted or bound to a path: both are session-local and tied to the current Auto owner, trust and model destination. After re-attach the session forgets its cached managed selection only; manual `/bookie-capture off` or `/bookie-context off` choices stay in effect, and the next access re-runs the normal owner, trust and destination checks.

## Alternatives

- Automatic reuse at session start: rejected by the owner and by ADR-0016's fail-closed reuse rule.
- A model tool: rejected; a model must not change which memory a folder discloses.
- Merging into or replacing memory with saved content: rejected; no merge semantics exist for canonical records.
- Matching memories created before this record existed: their path is only inside a one-way hash, so nothing can be shown or checked against copies without new input. See OQ-016.

## Compatibility, rollback and limits

No canonical record, schema, core API or dependency changes. Older extensions ignore `workspace.json` and still resolve re-attached memory, because the binding format is unchanged. Rollback removes the command and the record writer; re-attached bindings keep working. Git ancestry shows shared history, not identity: a clone of the same repository whose original folder was deleted also matches, which is why the human decides. The re-attach lock is never stolen; a crash leaves it in place and the next run explains manual removal. A crash between the commit and removing the earlier mapping leaves that mapping failing closed until removed manually.

## Verification

Deterministic tests with temporary real Git repositories cover the record, matching evidence, an existing old path, contradicting history, unverified candidates, cancellation, refusal without the terminal or trust, refusal with saved memory, setting aside the automatic seed, interruption rollback, the held lock, lookup after re-attach, no automatic re-attach at session start and absence from tools and injected guidance. No model or provider was run.
