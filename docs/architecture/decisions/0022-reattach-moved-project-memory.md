# ADR-0022: Human re-attach of moved project memory

- Status: Accepted for implementation by the owner's decision of 2026-11-17: "Explicit command, you confirm. A Bookie command shows the earlier project it believes this is (matching Git history), with old and new paths, and re-attaches only after you confirm in the terminal. Never automatic and never offered to the model." Tracked as BK-052; not released.
- Scope: SPEC-003, REQ-011/013/024/025/035. Extends ADR-0016 and supersedes its statement that the extension never scans for an existing vault, for this human command only; automatic paths still never scan or reuse a different binding. Capture (ADR-0012), disclosure (ADR-0013), dashboard (ADR-0019) and canonical profile rules are unchanged.

## Context

ADR-0016 binds automatic project memory to the exact workspace: the private mapping `bookie-project-memory/<key>.json` is named by `sha256([1, realpath, "dev:ino:birthtimeNs"])` and is a hard link to the ledger's sealed `binding` file. A moved or renamed folder computes a different key, so its memory is no longer found, and the next Auto session creates a new empty memory for the new path. Before this decision Bookie kept no readable folder path and no Git evidence; the earlier location could not be recovered from its own storage.

## Decision

Each managed open writes a small location record, `workspace.json`, beside the sealed binding in the ledger directory (outside the canonical vault). It holds the mapping key, the folder's real path and directory identity, the Git `HEAD` commit with the folder's prefix inside its repository (or `null`), the last-opened time and a bounded move history. It is written through a private temporary file and an atomic rename, under the same current-authority check as the open. Only a successful Git probe replaces a recorded commit; when Git is missing, times out or refuses the repository (for example for dubious ownership), the open keeps the commit already recorded for this folder. Lookup never reads the record. The command uses a record only when the binding's key is the hash of the record's own path and directory identity, so a stale or edited record makes a memory unmatchable rather than describing another folder. Git is run read-only with inherited `GIT_*` routing, user/system configuration, replace objects, hooks and fsmonitor disabled, the folder passed with `-C` as core's reader does, a 5-second limit and bounded output.

The human-only `/bookie-reattach` command is registered as a Pi command, never as a tool, and is mentioned in no model-facing description or injected guidance. It requires the interactive terminal (`mode: "tui"` with UI), a trusted folder and an idle Pi session (no response streaming, so this session cannot save a note during the move); trust and idleness are checked again just before the commit. It refuses when this folder's memory holds anything beyond the untouched automatic seed, or cannot be verified. An untouched seed is byte-for-byte the seeded manifest, index and Project text (apart from its generated identifiers and time) with no other entry, recall control or registration; it is the empty memory Auto creates on the first session in the moved folder, and it is set aside unbound, never deleted or merged.

Candidates are other live bindings whose record names a folder that is gone from its recorded path: nothing is there (deleted, moved, or on a disconnected drive or unmounted volume), a different folder is there now (re-created, re-cloned or restored at that path, possibly this folder), or the path now leads to this folder under another name (a case-only rename, or a link left where the folder or a parent used to be), so this folder's real path and key differ from the recorded ones. A candidate is offered only with evidence, and the independent review of 2026-11-17 removed the earlier "unverified" offer:

- Git: a commit was recorded, this folder is in a Git repository at the same prefix, and `git merge-base --is-ancestor <recorded> HEAD` succeeds. Ancestry of the recorded `HEAD` already implies the same root commit, so no separate root comparison is stored.
- Same folder: the recorded directory identity (device, inode and creation time) is this folder's, which is a rename on one volume.

A recorded commit that Git does not confirm excludes the candidate even when the folder identity matches. A memory with neither kind of evidence is never offered. The command lists the memories it did not offer, with the reason, when their folder is gone, or when their folder still exists but matches this folder's history or identity (a copy or fork); memories of unrelated folders that still exist are not listed. The terminal shows the old and new paths, why the earlier folder counts as gone, the evidence (stating that a clone or fork with the same history also matches), note and open-choice counts and times; the confirmation names both paths. Anything other than an explicit yes changes nothing.

Under an exclusive store lock, the command re-checks everything it showed, writes a pending binding for this folder's key in the chosen ledger, links it exclusively as this folder's mapping (or atomically replaces the untouched seed's mapping through a temporary link), and commits by renaming the pending binding over the ledger's seal. Before that rename the earlier mapping still resolves and this folder's cannot; after it this folder resolves and the earlier mapping fails the seal check and is removed. The move is appended to the record's history.

Every run of the command first takes the store lock and removes what an interrupted re-attach can leave, and the commit step does the same under its lock: temporary links (`reattach-*.tmp`, which only the lock holder creates), a pending binding together with any mapping that is the same file (that mapping fails closed), and an earlier mapping that has one link while its ledger's seal resolves for another folder. Before the commit this restores the earlier binding; after it this completes the move. Anything that does not match these shapes exactly is left in place and refused with the file named. A crash at any step after taking the lock is therefore recovered by the next run once the lock is removed.

Re-attaching grants nothing new. Capture and disclosure authority were never persisted or bound to a path: both are session-local and tied to the current Auto owner, trust and model destination. After re-attach the session forgets its cached managed selection only; manual `/bookie-capture off` or `/bookie-context off` choices stay in effect, and the next access re-runs the normal owner, trust and destination checks. With Pi Daddy Auto on, those checks pass as for any project with Bookie memory, so the model in this folder can recall the attached notes immediately; the confirmation says so.

## Alternatives

- Automatic reuse at session start: rejected by the owner and by ADR-0016's fail-closed reuse rule.
- A model tool: rejected; a model must not change which memory a folder discloses.
- Merging into or replacing memory with saved content: rejected; no merge semantics exist for canonical records.
- Matching memories created before this record existed: their path is only inside a one-way hash, so nothing can be shown or checked against copies without new input. See OQ-016.

## Compatibility, rollback and limits

No canonical record, schema, core API or dependency changes. Older extensions ignore `workspace.json` and still resolve re-attached memory, because the binding format is unchanged. Rollback removes the command and the record writer; re-attached bindings keep working.

- Git ancestry shows shared history, not identity: a clone or fork of the same repository also matches once the original folder is gone from its path, which is why the human decides and the dialog says so.
- A disconnected drive or unmounted volume looks like a deleted folder; the dialog says that this folder is then a copy.
- A folder whose device number changes (for example a remounted drive) counts as replaced at its path; its memory was already unreachable there because its key changed.
- A folder without Git that was copied to another volume has no evidence and cannot be re-attached; nor can memories last opened before location records existed (OQ-016).
- The re-attach lock is never stolen; a crash leaves it in place and the next run names the file to remove.
- A crash after the commit loses that move's history entry; the next open rewrites the record without it.
- A save by another Pi process that starts before the final seed check can land in the set-aside memory after it. The command reports a change it sees at its final check only; the saving tool's own post-save check reports the save as uncertain. Nothing is lost.

## Verification

Deterministic tests with temporary real Git repositories cover the record and its retention when Git fails, matching evidence, an existing old path, unrelated projects not listed, contradicting history, memories without evidence, edited or stale records, a folder re-created at its path, an unreadable path, cancellation, refusal without the terminal, trust or idleness (also between confirmation and commit), refusal with saved memory or an edited seed, setting aside the automatic seed, a failed commit restoring it, a crash after every file operation of the re-attach being recovered by the next run, the held lock, lookup after re-attach, no automatic re-attach at session start and absence from tools and injected guidance. No model or provider was run.
