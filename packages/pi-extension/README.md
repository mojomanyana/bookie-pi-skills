# `pi-bookie`

Distributable Pi package for Bookie tools. Canonical behavior belongs in `pi-bookie-core`; follow [SPEC-003](../../docs/specs/003-pi-extension.md) and the Pi-specific constraints in [AGENTS.md](../../AGENTS.md#pi-implementation-constraints).

BK-013 through BK-015 expose five local tools:

- `bookie_read` reads one explicitly selected local concept by canonical path or UID.
- `bookie_search` performs bounded filesystem lexical and metadata search.
- `bookie_validate` validates an explicit vault, optionally against a local Git base ref.
- `bookie_write` creates or amends one concept from a bounded JSON request file through policy-bearing core APIs and Pi's complete file-mutation queue.
- `bookie_checkpoint` prepares a sensitivity-filtered Activity from structured fragments and either writes after trusted UI approval or applicable session-scoped capture permission or stages the prepared snapshot for approval before compaction.

Excluded write successes serialize an explicit `redacted: true` variant without source/previous hashes, identities or source sizes; included and policy-neutral contracts retain their required hashes. Consumers must narrow that variant before reading hashes. Rollback disables affected writes, never restores fingerprint leakage ([BK-027](../../docs/planning/evidence/BK-027.md)).

Every tool requires an explicit `vault` path, propagates cancellation, throws on operational failure, and bounds output to Pi's 50KB/2,000-line limits. Retrieved text is labelled untrusted. Excluded reads fail with static redaction. Write and checkpoint arguments cannot assert approval. Ordinary writes require trusted Pi UI confirmation of the canonical vault, target and exact request snapshot. Non-interactive calls fail closed unless a structured checkpoint matches the human-selected session permission below. Checkpoint preparation accepts complete caller-supplied metadata, never raw transcripts, and generates no canonical identity or timestamp. Declined, cancelled, failed, and no-UI pre-compaction capture never blocks compaction. The package starts no background resource and performs no network, commit, or push operation.

In this BK-030 implementation candidate, run `/bookie-capture` in Pi to select an existing canonical vault and Project and approve routine Activity capture for this session. Matching checkpoints may retain vault-declared, non-excluded `public` or `internal` summaries and evidence references without another dialog. Other writes still ask. Run `/bookie-capture off` to revoke; reload, session replacement, fork and shutdown also revoke, and children inherit nothing. Labels are assertions, not semantic detection of personal data; this local storage permission grants no disclosure, sharing or training authority.

Cooperating Bookie writers hold `.bookie-write.lock` over revision checks and publication. Contention waits at most five seconds and supports cancellation. A terminated owner can leave a lock; it is never stolen automatically. Before manual recovery, stop all writers and establish that the recorded owner is no longer running, then remove only the selected vault's retained lock. General filesystem editors remain outside this cooperation guarantee.

Request files open nonblocking/no-follow, then must be stable, singly linked regular files. The 2,000,000-byte endpoint is accepted; one extra byte, malformed UTF-8/JSON, FIFO/substitution, directory, symlink or hardlink fails statically. Request abort reasons are not echoed. Failed immediate/staged checkpoint reads release the session slot before returning ([BK-028](../../docs/planning/evidence/BK-028.md)).

The public 0.1.0 package is `pi-bookie`, licensed under MIT. It declares the exact
runtime dependency `pi-bookie-core: 0.1.0`, installed automatically.
Install it with `pi install npm:pi-bookie@0.1.0`. Historical private
names and earlier qualification records remain historical. Avoid loading an old
private Bookie entry alongside the new one; tool names, vault formats and trusted
permission setup have not changed.

From a built repository checkout, load the package temporarily with:

```bash
pi -e ./packages/pi-extension
```

Or install the local package path:

```bash
pi install ./packages/pi-extension
```

Both the root Git manifest and local subpackage load `src/index.ts` through Pi's TypeScript loader, which maps Pi imports to the actual host (including its mutation queue). Do not load `dist/index.js` directly as a Pi entry: native compiled ESM may bypass host mapping when development dependencies are present. Pi packages are `*` host peers, never production dependencies; the development/typecheck baseline remains Pi 0.85.1, not the globally installed 1.4.0 API.

Git `prepare` builds core JavaScript, declarations and schema assets only; Pi loads the extension TypeScript itself. This works with production installs that suppress host peer installation (`npm install --omit=dev --legacy-peer-deps`). Development builds still compile/typecheck the complete extension and retain `dist` declarations. Clean relocated root/local installation and independent real-host-loader create/amend/checkpoint interlocks are default tests. See [BK-026 evidence](../../docs/planning/evidence/BK-026.md).

BK-030 has local required-check evidence on the Pi 0.85.1 development baseline and seven additional model-free real-loader cases on an existing Pi 1.4.0 host. These qualify package loading and shared create/amend/checkpoint queues, not a full interactive/provider run. See [BK-030 evidence](../../docs/planning/evidence/BK-030.md); implementation remains unmerged.


### Session disclosure and optional producer references

Before model-facing Bookie tools can return data, run `/bookie-context` in the trusted Pi UI. Select a vault, an included Project revision and the allowed declared sensitivity classes, then confirm the currently selected provider/model. The extension binds the effective transport endpoint locally as a digest; it never stores keys, headers, or an authenticated endpoint URL. The confirmation also permits initialization of the local recall-control sidecar if it has never existed. A deleted/corrupt control file is not silently recreated. `/bookie-context off`, a model selection change, or session lifecycle replacement revokes this disclosure. Saving permission is separate.

The guard covers every registered Bookie tool, including progress callbacks, errors and result details. It rechecks scope, controls, and destination after asynchronous work. Reads disclose only selected-project concepts in permitted classes. Searches omit global counts and diagnostics. Validation returns a static completion notice; detailed local diagnostics and a validity judgment are not disclosed by that notice. Write/checkpoint results contain static outcome only; checkpoint previews remain in the local confirmation UI. If disclosure changes after a mutation, the tool says local state may have changed and withholds protected output; inspect locally before retrying. Already sent conversation history and arbitrary other Pi extensions are outside this output boundary.

`/bookie-capture` can select structured summaries, producer reference metadata, or both. Reference capture asks for a vault-declared, non-excluded metadata sensitivity class. It stores technical producer references, including original owner identifiers and local paths that may contain user/project names: no final text, raw transcripts, guessed payload classification, or approval claim. Capture permission alone never authorizes sending those records to a model. `/bookie-capture off` revokes capture while leaving independent disclosure permission intact.

With Pi Daddy present, a trusted optional event delivers new durable-result references. `/bookie-capture sync` reconciles missed notifications without launching work. Each command examines at most 256 current-owner entries; partial scans retain an in-memory continuation. Repeated registrations reuse the same exact record; changed identity/digest or suppressed records refuse. A failed page resets traversal rather than skipping unregistered references. Missing Daddy reports unavailable, while existing Bookie state remains usable. Missing Bookie never changes Daddy completion. Producer absence, corrupt/missing artifacts and unfinished admissions are not successful completion evidence.

The trusted bridge now supports bounded exact historical reads through `bookie_reference_read`. No Bookie or Daddy package dependency is required by the other. Metadata capture alone never permits body disclosure; see the separate body selection below.

Concurrent cooperating writes can conservatively invalidate a disclosure snapshot even when the selected Project did not change. A successful local mutation may therefore have its confirmation withheld; this is not a no-effect proof and never triggers an automatic mutation retry.

### Bounded context consumers (BK-032 local candidate)

After `/bookie-context` selects a project and actual model destination, `bookie_context_prepare` accepts up to 16 exact paths in that project and returns an opaque `bundleId` plus source references. `bookie_context_read` reads or revalidates that handle; optional `inputIds` select required inputs. It refuses changed sources, current suppression, changed controls, or changed destination. Working-tree and explicitly pinned committed source modes preserve their distinct representations. These are untrusted excerpts, not permission, approval or a guarantee that a derived conclusion is correct.

Read requests return at most 24,000 UTF-8 excerpt bytes (default 12,000), with a 40,000-byte serialized tool-result cap including metadata. A truncated excerpt has `complete:false`; a required-input consumer must not treat it as complete. Prepare's core envelope retains its existing 256 KiB bound, and each session keeps at most 16 live bundles. Local validation remains a bounded filesystem scan, not an indexed retrieval service.

Reload/fork/model changes revoke live state. Pi retains only a compact manifest (no source body); context restoration exposes opaque handles, never old bodies or permissions. After a fresh human disclosure choice, `bookie_context_prepare({fromBundleId: ...})` can rebuild an active-branch handle from pinned selectors. Changed source hashes still refuse. Bookie filters its own tool results and strips their details during context assembly; it cannot purge quotations in assistant prose, summaries, compaction text or another extension's messages. Revalidation is optimistic against cooperating storage, not an atomic freeze of external filesystem edits.

`bookie_reference_read` accepts an existing registration ID and `part: manifest|final|partial`; it does not accept arbitrary paths, content hashes or producer ownership. Producer bodies are default-denied even when their reference metadata can be disclosed. In trusted Pi UI, `/bookie-context producer` selects one registered producer instance/owner and declares the body class within already permitted classes for the selected project/destination. This is session-only standing permission; it is not automatic personal-data detection. `/bookie-context off` or any session/model replacement revokes it. Historical output stays labeled historical, exact producer hashes are checked, and nothing is imported as canonical memory. A missing part, missing source, changed source, suppression, absent producer and denied authority are distinct typed in-process results where the cause is actually known; unknown/corrupt transport remains `unavailable`.

Trusted host integrations may request `bookie:resolve:v1` with exact current owner, a context/producer reference, and a reply callback. Successful replies contain bounded excerpts, exact references, completeness and `assertCurrent()` for the final aggregate check. A trusted per-request body callback can authorize only the exact stored reference, part, project and actual destination; no model argument supplies it. A no-UI child without current trusted disclosure and exact body authority is denied. The optional bridge cannot launch children, run a shell, grant semantic approval or silently retry work.

Legacy `bookie_read`/`bookie_search` results already sent during the same live session remain historical observations. Replay rechecks their project, control revision and destination, but does not rescan each source on every context assembly. Use the prepared-context tools when current source identity is required; session/model replacement still reduces legacy history to a static notice. This avoids adding repeated full-vault scans to ordinary conversation replay.

### Correcting an authoring failure

Mutation request.path is a vault-relative Markdown path such as projects/demo/task.md; Bookie read selectors and frontmatter project/relation references retain their separate /projects/... form. Keep the existing validators and use the returned fixed guidance to correct the request explicitly. For a Task, bookie.state is one of proposed, ready, in_progress, blocked, done or cancelled; lifecycle status is a separate field. Checkpoint Activity and fragment sensitivity labels must be declared by the selected vault, and the Activity class cannot be excluded. Do not relabel content merely to make a write pass.

Selected path, state and checkpoint-sensitivity failures now return bounded static hints. Other schema errors remain code-only; protected values, arbitrary validator messages and private source bodies are withheld. A changed disclosure grant still withholds feedback, and a possibly completed mutation still warns against blind retry. This local source repair is not installed-package or publication qualification.
