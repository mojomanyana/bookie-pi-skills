# SPEC-003: Pi extension

## Status

In progress — packaged read, filesystem-search, validation, approved create/amend and structured checkpoint/pre-compaction workflows through BK-015 are merged. Subsequent BK-026/027/028 queue/result/request safety corrections merged in [PR #30](https://github.com/mojomanyana/bookie-pi-skills/pull/30) with successful matching PR and [merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40872106782); all three are Done. Earlier verification did not establish these repaired boundaries. BK-030–037 are delivered in the public 0.1.0 local-ledger packages through PR #42, with matching CI, tag and archive verification recorded in [delivery evidence](../planning/evidence/public-delivery-0.1.0.md). Service retrieval and remaining human/configuration commands remain later work. BK-038 is delivered in the 0.1.1 instruction-only Pi maintenance release through PR #43, with matching CI and exact archive verification recorded in [0.1.1 delivery](../planning/evidence/public-delivery-0.1.1.md).

Owner: unassigned  
Target release: 0.1  
Depends on: SPEC-002, [ADR-0009](../architecture/decisions/0009-structured-checkpoint-preparation.md), Pi extension/package APIs

## Package distribution

[ADR-0015](../architecture/decisions/0015-public-package-names.md) names the public Pi package `pi-bookie` at MIT0.1.0, with the exact automatic runtime dependency `pi-bookie-core: 0.1.0`. Keep `pi.extensions: ["./src/index.ts"]`, host Pi peer dependencies and existing tool/event names. The current Pi release installs with `pi install npm:pi-bookie@0.1.2`; local/Git installation remains supported. ADR-0015's dated maintenance clarification permits Pi 0.1.1 with core 0.1.0 unchanged; exact paired package qualification and publication are recorded in the 0.1.1 delivery evidence. The root, CLI and service remain private. Renaming does not deliver unfinished service work or import earlier archive qualification.

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
- `bookie_checkpoint`: prepare a deterministic preview from complete caller-supplied Activity metadata and structured sensitivity-labelled fragments through core. It either writes immediately after trusted UI approval or applicable session-scoped capture permission or stages the already-prepared request for cancellable confirmation at the next compaction event.
- `bookie_validate`: validate selected files or vault, optionally against a base ref.
- `bookie_export`: produce a dry-run or local artifact; external destination execution belongs to SPEC-005.

`bookie_write` serializes the explicit hash-free `redacted: true` policy-success variant for excluded create/amend/unchanged and sensitivity transitions. It emits neither current/previous source hashes nor identity/size fields. Included successes and low-level core hashes remain unchanged. Rollback disables affected writes rather than returning the old leaky shape; see [SPEC-002's result union](002-core-and-cli.md#pre-write-secret-policy).

BK-030 replaces model-selectable approval with trusted host authority. Write/checkpoint tool arguments cannot assert approval. Ordinary create/amend and immediate checkpoints require Pi UI confirmation of the canonical vault identity and exact request/prepared snapshot. Non-interactive calls fail closed without applicable standing capture permission. Confirmation is invalid after session replacement or cancellation; queued publication rechecks the bound vault identity.

The human-only `/bookie-capture` command can grant or revoke routine capture for this session into one explicitly selected canonical vault and Project revision. It permits structured Activity checkpoints with declared, non-excluded `public`/`internal` metadata/fragments, including the evidence-reference section, and no other mutation. A changed project or vault identity, revocation, reload, fork, switch or shutdown invalidates permission. No policy is inherited by children or restored from model/tool arguments. This is local write permission, not provider disclosure, personal-data consent, sharing or training permission. Class labels are assertions, not semantic personal-data detection. Other classes and concept changes continue to require request-specific confirmation.

Cooperating core/Pi writers serialize per canonical vault under an exclusive filesystem lock covering revision validation and publication; expectedSourceHash remains the revision token. Contention waits are bounded and abortable. Success releases the exact owned lock; interruption can leave a lock and next writers fail closed. There is no automatic lease expiry or lock stealing. Recovery requires the operator to stop all writers, verify the recorded owner is no longer running and remove only that vault's retained lock. This narrower cooperation guarantee does not address hostile filesystem actors or enable deferred CLI writes. See ADR-0012.

Per ADR-0009, checkpoint preparation accepts no raw transcript and generates no path, UID, project, actor, timestamp, or sensitivity. The required fragment sections are outcome, changed artifacts, decisions, evidence, validation, unresolved work, and next action; source session is optional. Core validates sensitivity labels against the manifest, rejects missing/undeclared classes and detected secrets, omits complete excluded fragments before preview, and renders a bounded body behind an opaque prepared-publication value detached from publicly returned data. BK-030 confirmation identifies the canonical vault, selected Project, target and digest of filtered input. It never displays external request-file paths. Credential-shaped vault paths are rejected before confirmation. `createCheckpointWithPolicy()` rechecks the prepared vault/target/parent identities and complete manifest hash inside the queued mutation and reloads that manifest again after temporary staging before creating the Activity. A staged checkpoint is session-local and is discarded at shutdown. Only one draft slot may be preparing, pending, confirming, or publishing; reservation occurs before request-file I/O, and further sequential or concurrent staging attempts fail statically until the slot is released. A confirmation that would exceed Pi's byte or line limit is rejected rather than truncated.

## Request-file boundary

Write and immediate/staged checkpoint requests open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` before descriptor validation; missing platform flags fail closed. Only singly linked regular descriptors of at most 2,000,000 bytes are read. The reader probes one extra byte, checks descriptor mode/link/device/inode/size/mtime/ctime and complete byte count, then fatally decodes UTF-8 and parses JSON. FIFOs (including substitution immediately before open), symlinks, hardlinks, directories, unstable/oversized/malformed input fail statically without publication. Request cancellation is a static `AbortError`, never a caller-supplied reason; checks follow final descriptor stat and successful close and precede approval, so cancellation during asynchronous finalization cannot escape as a usable snapshot or enter confirmation. The same static cancellation boundary wraps write/checkpoint dialogs whether the host resolves or rejects on abort; an arbitrary abort reason never replaces the static cancellation error. A failed checkpoint attempt releases its reservation before settlement so a subsequent valid checkpoint can proceed; no lifecycle writer or transcript capture is added. See [BK-028 evidence](../planning/evidence/BK-028.md).

## Host runtime packaging

Both root-Git and local-subpackage manifests select the TypeScript `src/index.ts` entry so Pi's real loader maps host imports before executing them. Compiled extension ESM is retained for development/types, not selected as a Pi entry: native ESM can bypass mapping through physical development dependencies. Pi packages are `*` peers, never production dependencies; the supported development API stays 0.85.1. Git prepare builds the host-independent core and schemas without installing a private Pi runtime. Real-loader tests use a separate physical host, hold its target queue after synchronized approval, verify no publication, release and verify create/checkpoint completion or stale-amend conflict. BK-026 is Done with PR #30 merge/CI evidence, not a specification completion claim; the development/typecheck baseline remains Pi 0.85.1. BK-030 additionally passes seven model-free real-loader cases against an existing Pi 1.4.0 installation, covering both package entries and create/amend/checkpoint queue behavior; live interactive/provider acceptance is not established by those cases.

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

## BK-031 returning-output integration (released in 0.1.0)

The Pi adapter owns trusted destination/policy selection independently of save permission. Guard read/search, validation metadata, write results and checkpoint previews before model-visible return. The actual current Pi provider/model/endpoint, selected vault/Project and allowed declared classes come from trusted host/UI state, never tool parameters. Core scope/context metadata helps enforce this boundary but is not authority. Static withheld results must not imply that mutation failed after it succeeded. Optional producer-reference synchronization uses trusted producer lookup and exact scoped references; it never reruns original work. No history-confined provider guarantee, new live disclosure choice or child inheritance is inferred.

### BK-032 bounded no-shell consumers

Add `bookie_context_prepare`, `bookie_context_read` (read or revalidate), and `bookie_reference_read`. Scope and destination come from `/bookie-context`; exact source selectors and registered reference IDs are only data selectors. Preserve compact source manifests on the active Pi branch, cap retained live bundles and full serialized results, and emit no automatic source-body restoration. A source edit, suppression, lost producer, absent grant, owner change or destination change prevents stale output. Expose the same guarded resolver via an optional owner-bound `bookie:resolve:v1` event with final `assertCurrent` callback. Independent consumers must resolve every required input before a verdict.

Retained producer body permission is separate from reference registration and ordinary class permission. Trusted UI or exact in-process body authorization is required; no-UI model calls default to denied. Output text is untrusted and bounded, with explicit truncation; missing final data does not become a complete result. Backward metadata-only capture remains unchanged.

BK-032 restoration keeps only opaque SHA-shaped bundle/registration handles and fixed part labels in old Bookie tool results; paths and bodies are withheld. The manifest remains in a bounded custom session entry, and reprepare requires its presence on the active branch plus fresh current disclosure. When composing several retained outputs, a generation change or failed aggregate recheck withholds all Bookie bodies in that context. A context with only one successfully validated result performs its complete currentness check once; every new context request validates again. Multiple successful results retain aggregate replay after asynchronous collection. A later failed validator or lifecycle change still withholds all Bookie bodies, including earlier successful results. Legacy same-session read/search observations are historical and scope/control/destination-checked rather than content-rescanned; exact current-source assurance belongs to prepared-context consumers. External edits are not frozen atomically, and assistant prose/compaction copies remain outside this filter boundary.


## BK-033: scoped work-map consumer (released in 0.1.0)

`/bookie-work` selects one included work-map Document and plan from the current `/bookie-context` scope using trusted UI. The selection is session-local and resets on session/tree/model changes. `/bookie-work off` clears it. Selection grants no write, execution or acceptance authority. `bookie_work` returns a bounded projection for selected Task UIDs and their prerequisite closure, with current exact references and separate alignment, output, judgment and runtime dimensions. Unknown/missing owners remain explicit; no runtime observation comes from model tool arguments. Host adapters connect through a bounded optional event, and successful observations include an in-process currentness callback.

Writes remain ordinary approved Document create/amend operations; a core validator/renderer checks the versioned work-map body before it is persisted. Existing selected exact context references provide the lesson input for Harness improvement proposals. No new background task, automatic skill deployment, canonical type, provider call or global index is introduced.

Acceptance covers shared tasks across plans, acyclic hard prerequisites, selective task revision reuse, current output/judgment matching, absent owner behavior, blocked continuation, source/control/destination revocation and expected-revision write conflicts. BK-032 and this dependent increment were delivered together in PR #42 and public 0.1.0. Original local implementation evidence retains its historical scope; current delivery is recorded separately.

### BK-033 operational use and boundaries

The shortest current path is: call `bookie_work` with `action: schema` for bounded public authoring help (its synthetic example passes the actual validator); select the canonical vault, Project, classes and actual model destination with `/bookie-context`; use `bookie_read` to obtain exact canonical Project/plan/Task/Decision references and source hashes; create or amend an ordinary Document through `bookie_write` containing one `bookie-work-map-v1` JSON block; select it with `/bookie-work`; call `bookie_work` for the selected task revisions and current projection. Source hashes come from Bookie, not model-written hash recipes. Principal's `principal_workflow resource` returns its current owner-computed Git reference. Receipt bindings copy the task revision from `bookie_work`. No acceptance, execution authority or ability to read another repository follows from possessing a reference.

Each task declares its exact concept, consumed inputs, hard prerequisites, required output IDs/descriptions and optional `reviewScope` (`task` by default, or `integrated`), resource references and effect scope (`unknown` by default). Task revisions include the selected Project goal revision and declared task/consumed inputs/contracts/resources/effects plus predecessor revisions. Plan membership alone does not claim that every plan paragraph is consumed: a task that depends on plan text must list that plan Document in its inputs. Unrelated plans do not invalidate that task; an amended consumed input or Project goal does. A cancelled, done, proposed, blocked or in-progress canonical Task cannot receive a new admission; the operator must explicitly amend it to `ready`. The selected Project must also be active for a new admission. An owner's already-running observation remains visible without re-admission. Accepted outputs remain separate from lifecycle labels.

Hard `dependsOn` requires the predecessor to be currently completed with applicable acceptance and current resources. A review task consumes its producer's exact available output as a resource/input instead of requiring that producer already accepted. This permits build → independent review → accepted output without a circular prerequisite. Rejected output permits a ready task's corrective attempt; an unreviewed output does not silently authorize a duplicate attempt. Exact task/integrated review scope must match. Changed goal, stale resources, rejected/missing predecessor acceptance and unresolved or unknown external effects prevent inferred completion. Runtime owner absence is explicit; it cannot prove external effects reconciled.

`/bookie-work` also selects each task's allowed actual working roots. Repository roots must be individually confirmed from declared task resources and owner-observed as current. Tasks without repository resources use a separately confirmed current working root. Daddy checks the actual routed canonical child directory before spawn; a different worktree/root requires new explicit selection. This is additional applicability checking, not a replacement for Daddy capabilities, grants or workspace leases.

Output and judgment attachments (`outputRefs`, `judgments`) may be added to the selected Document through its ordinary approved amendment path. The consumer refreshes only those attachments while preserving the exact map identity, Project/goal, plans, selected tasks, contracts, inputs, resources, effects, repository scope and disclosure. Owner callbacks verify each new attachment; authored receipt strings never become acceptance. Other intent edits invalidate the selection and require explicit reselection.

Without Principal or another review owner, attach an exact canonical Decision reference with `owner: bookie`, `kind: human-decision`, the exact task/output/review-scope binding and an included stable, accepted Decision. `/bookie-work accept` shows the exact Decision and output binding and asks the human to confirm their review. The Decision's authored `accepted` state alone is insufficient. This fallback is session-local; changing session, branch or destination requires new confirmation. It grants no write, execution, publication or sharing rights. Bookie-owned output references use `kind: concept` and exact canonical path, UID and source hash, so non-development roles can use ordinary canonical artifacts without Principal.

`/bookie-work reconcile` selects one original external/unknown attempt, a current included canonical receipt and human confirmation of the actual external result. Daddy still requires native execution settlement. Receipt identity binds original owner, initiative/task revision, operation/execution and exact receipt bytes. Its reference is capped at 2048 characters before confirmation. The record is operator-confirmed, not a fabricated provider verification or task acceptance. If no live handle exists, recovery-only ownership preserves the old generation and forbids dispatch; an original historical task revision can be reconciled after a current goal amendment when the canonical initiative/Project and selected Task UID still match, without rolling back intent or relabeling the old attempt; after reconciliation, clean release and fresh acquisition provide new ownership. A revoked or changed receipt returns the attempt to required reconciliation. No timeout, process exit or mere semantic approval proves an external effect succeeded or was undone.

A bounded `bookie-work-selection-v1` custom entry retains only canonical vault/Project/map/plan/task references on the active Pi branch. After reload it supplies a UI map-path hint; current sources and user selection are checked again. It restores neither coordinator ownership, disclosure grants nor human judgments. The projection omits unrelated map tasks and handled suggestions unless explicitly requested. It does not erase already-copied prose or compacted history. These mechanical controls support a later C01 fresh-subject continuation evaluation; they do not establish C01–C03 or proactive guidance/model quality.

Version 1 bounds are 32 KiB canonical map JSON, 32 tasks, eight plans, 64 prerequisite edges and 16 suggestions; one selected projection includes at most 12 tasks and 16 canonical inputs in addition to the bounded map Document and returns at most 48,000 serialized UTF-8 bytes. Owner reference payloads are at most 4 KiB. Source/currentness checks use bounded local filesystem scans, potentially repeated per selected input; this is not a service index or scalable scheduler.

Bookie optionally publishes the current guarded projection through Daddy's existing terminal-only dashboard source channel. The bounded view shows selected task dependencies, output/review status, declared repository labels and external-effect state; an omitted-task count is explicit. Registry publication remains unknown unless separately established—Git identity is not release proof. Sequence/freshness and owner-generation checks remain Daddy-owned; source/authority/lifecycle invalidation closes Bookie's publisher. An absent or failed dashboard cannot grant access or prevent a guarded model read.


C09/C12 target outcomes use the existing work selection and reconciliation commands: select one owner-issued target per Task, confirm the exact original attempt/canonical receipt/outcome in trusted UI, and expose each current target separately in the projection and dashboard. Operator attestation is labelled distinctly from responsible-owner verification; unknown delivery blocks completion and remains unresolved. A missing owner cannot supply pending or published facts. This follow-up is included in the public 0.1.0 delivery; its focused and composed evidence retains its original qualification scope. See [delivery evidence](../planning/evidence/public-delivery-0.1.0.md).

For package-release targets, `principal_workflow` action `resource` with `packageRelease` returns the exact owner-issued target from the selected manifest and Git candidate; copy that target unchanged into the Task. This is target identity, not registry verification. Historical reconciliation uses the original target retained on the attempt even after the current package/goal changes; the current target is independently revalidated and does not inherit that old outcome. Dashboard details put outcome and provenance before bounded package/registry labels, with exact full target references available in the guarded work projection.

Measured composition performance correction: the optional terminal dashboard publishes the already validated projection as last-observed metadata, with an explicit observation timestamp and a fresh selected canonical-source/disclosure check. It does not initiate another repository, review or runtime owner traversal. Current model output and admission retain their full owner/source validation; no time-based cache or source-currentness grace period is introduced.

Within one read-only work projection, each owner access rechecks the active selection identity, trusted disclosure ticket and fixed human-selected repository roots. Canonical map/input reconstruction remains at the enclosing operation entry/final return and all admission/mutation boundaries, rather than recursively running the whole graph inside each owner authorization callback. This grants no additional root and introduces no cached validity period; a canonical mutation during owner resolution still withholds the final projection.

Nested runtime observations may use the optional trusted `assertObservationAuthority` callback: fresh active selection identity, disclosure destination, Project and recall-control revision, while Daddy retains current owner/lock/generation/native/effect checks. Absent callback keeps the full selection fallback. Only read observations use this path; acquisition, admission, mutation, reconciliation and release retain full selection validation. Pure concept and already-confirmed receipt/judgment observation callbacks likewise revalidate exact referenced source plus fresh authority, with full canonical task/map guards at the enclosing operation and acceptance/reconciliation boundaries. No returned callback grants permission to execute or mutate.

The native same-workspace admission uses `workspaceId: null`; a nonempty routed workspace ID is also valid. In both cases the actual canonical child directory must match that task’s explicitly selected working root. Admission projects only the requested task and its transitive hard-prerequisite closure; full selected canonical intent checks still bracket the operation. Unrelated task owner observations are not repeatedly fetched to admit one task.

A target-only projection may select an implicit prerequisite within the selected plan’s existing transitive closure. It cannot select an unrelated task elsewhere in the map; current UI task selection and full intent guards remain unchanged.

### Applied effect continuation

Work projections must direct an already applied exact effect toward required output evidence and acceptance, not another execution. Missing output evidence remains awaiting-acceptance after ordinary applicability checks; semantic completion is not inferred from the effect receipt alone.

## BK-034: bounded authoring failure feedback (local repair)

Existing mutation validators and checkpoint preparation remain authoritative. When a write fails before publication, the adapter may add only fixed public-contract guidance selected by an existing diagnostic: MUTATION-PATH explains the vault-relative request.path contract; CONCEPT-SCHEMA with exact instancePath /bookie/state and keyword enum explains the concept-specific state contract and names the public Task states. Other schema diagnostics remain code-only. No arbitrary diagnostic pointer, file, message, submitted value or protected source is echoed.

Checkpoint preparation's existing vault reason receives a fixed reminder to check the relative target and safe existing parent; it does not claim every vault failure is a path-format failure. Existing sensitivity-policy receives fixed guidance for Activity and fragment labels, without returning the manifest's class list or suggesting misclassification. The guard admits only exact catalog messages after its unchanged final disclosure/currentness check. Secret rejection, revoked authority and any possibly changed canonical state keep their existing protected outcomes. No input correction, retry, new permission, generated metadata, or weaker validation is introduced. See [BK-034 implementation evidence](../planning/evidence/BK-034.md) and the separate [0.1.0 delivery record](../planning/evidence/public-delivery-0.1.0.md). The release does not expand the original verification scope.

### BK-035 canonical disclosure and recovery refinement

Only explicit internal canonical read/search/validate, context and work-map paths use the validated control-history revision. Producer reference resolution and default/mutation tickets retain whole-registry identity and separate body permission. Grant object/epoch identity is checked again immediately after asynchronous recall reads. A missing derived field in an older core fails closed. Task intent, live resources, current source, scope and destination remain independently checked; metadata registration grants no body or execution authority.

A failed remembered context validator still withholds the current request's complete Bookie body set. Its exact cache entry is then retired so later current reads can recover; a same-ID replacement during an await is not removed. Existing aggregate/lifecycle checks remain. This deterministic local repair does not establish semantic memory quality. See [BK-035 evidence](../planning/evidence/BK-035.md).

## BK-037: bounded selected-record Pi export (authorized local increment)

Expose `bookie_export` as a read-only exact-commit operation under the existing human-selected context scope and destination. Explicit selectors identify 1–16 concept paths and optional expected source hashes. Return the complete canonical JSONL lines for that selection, with selected-record scope, resolved commit, exact source hashes, byte/count/hash metadata and untrusted content. Do not call a selected subset the complete vault export. No output path, working-tree substitute, unchecked-secret policy or model-selected authority is supported. Missing/denied/oversized selection refuses the complete result rather than truncating a JSONL record.

Reuse core's validated canonical exporter and existing current historical-disclosure rules. Current UID/project/sensitivity, suppression, supported corrections, manifest exclusions and destination remain authoritative; a mere working-body edit does not replace pinned historical bytes. Full decoded frontmatter/title/body are checked against private suppression/exclusion identities; ordinary correction provenance links are preserved. Core's default high-confidence secret detector remains enabled, without claiming complete arbitrary-secret detection. Final and later context delivery revalidate current dependencies. No new artifact store, service, CLI file export or durable schema is introduced. Implementation/check evidence is tracked in BK-037; the sealed prior release remains separate.

## BK-038: portable task-continuity guidance

The operator-approved ecosystem improvement batch adds one discoverable
`bookie-continuity` skill and its bounded checkpoint recipe. It guides existing
Activity capture and exact prepared-context reads, retaining outcome, non-goals,
phase, accepted verification routes, scoped user decision source references,
open questions and evidence handles. It introduces no runtime changes or new
canonical format. Applicable trusted conversation authority remains separate
from untrusted remembered prose; no saved record grants permissions.

The skill applies only when continuity helps the current task. It uses an
already selected trusted Project and existing save/disclosure permissions, or a
concise session/already-authorized local note when Bookie is unavailable. No
global search, mandatory setup, background save, provider call, repeated retry
or automatic authority restoration is introduced. Root Git/local and npm
subpackage discovery must expose the same instruction resource, and the
supporting recipe must survive package inclusion. Offline packaging checks
establish availability only; fresh model behavior remains separately evaluated.


### Checkpoint feedback and explicit host metadata (BK-040, [0.1.2 delivery](../planning/evidence/public-delivery-0.1.2.md))

An invalid checkpoint input fails before publication with fixed actionable guidance for complete Activity metadata, valid actor syntax and ACT-ULID identity. No private input value, fragment, path or validator detail is echoed. Exact static Bookie error messages remain failed historical status through context filtering, including reload or disclosure loss; their details and every unrecognized error remain withheld. This neither restores permissions nor current data. Existing uncertain-write warnings remain uncertain and prohibit blind retry. Dynamic diagnostic text is not admitted to history by a broad error regex.

The separately exported `pi-bookie/dist/checkpoint-metadata.js` helper accepts an actual host session ID, default current time and cryptographic entropy; bounded explicit overrides permit deterministic tests. It returns only schema-compatible identity/actor/time fields. It does not choose a Project/path/class, read history, authorize capture or save. The complete persisted request remains the unit of preparation, confirmation and recovery. Core preparation and schemas are unchanged; see ADR-0009's dated host-helper clarification.

Acceptance includes actor-only, UID-only and combined invalid input with unchanged vault/request and absent target; fixed failures survive context and reset without recovering protected bodies; true post-mutation uncertainty remains; valid helper metadata passes actual core validation, saves exactly one Activity through trusted capture, resumes only after fresh disclosure selection, and refuses changed input. Pure helper tests reject malformed session/time/entropy and preserve deterministic identity when supplied explicit test inputs. Installed package payload verification must include the documented helper path. No provider or shared-service test is required for these mechanical contracts.

## BK-041 selected retained handoffs (Pi package 0.1.3)

When the selected coordinator supports retained handoffs, `/bookie-work` offers a session permission to link the final for an explicitly selected task. The coordinator verifies the original execution, exact retained bytes and selected working root. Its bounded reference contains only the operation, execution, manifest digest and final digest. A trusted settlement hint or an explicit work read rechecks the producer and scope, then uses the existing approved Document amendment path to fill the declared handoff (or sole output) once. Multiple other output slots require explicit selection outside this automatic path. Replacing the session, revoking access, changing task inputs or losing owner evidence prevents use of an earlier result.

The dashboard names reviewable outputs and shows `/bookie-work review`. This human-only command reads the selected output into a paginated terminal view after fresh authorization and digest validation. Reading or closing the view leaves the judgment pending. An explicit bound judgment remains necessary for acceptance. Operations and roles without a compatible retained-output owner continue using canonical Bookie output references or another registered owner.

### Automatic project memory (BK-042)
Under [ADR-0016](../architecture/decisions/0016-managed-project-auto.md), verified root-session Pi Daddy Auto supplies the current workspace's dedicated memory scope. A user can start a project, save a routine choice and recall it in the same workspace without a vault path, setup commands, fixture or repository. Repeated saves of the same decision are idempotent. Manual file-based and cross-project operations retain their existing rules.

### Remember delivered resources (BK-043)
Under ADR-0016 the selected workspace's routine memory may retain a public resource shared in a completed Pi reply. Bookie may use a bounded model-selected reference or a cited Scout source, matched to an actual visible link in that reply. Store a separate Activity with the exact URL, preserving the original decision. Do not derive notes from arbitrary conversation text, ingest producer bodies, or treat a planned, withheld or interrupted reply as delivery. Session changes or revoked authority retire pending references. Fresh-session recall should compare the earlier decision with the delivery and leave the user's next choice open.
