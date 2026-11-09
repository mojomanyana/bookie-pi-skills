# Next-session handoff — 2026-11-09 UTC

BK-041 shipped in `pi-bookie@0.1.3`. A selected project can link a retained output after settlement. Use `/bookie-work review` in the parent Pi session to read it and record the review decision separately. See the [two-task validation and release evidence](evidence/BK-041.md).

BK-040 shipped in `pi-bookie@0.1.2`. The live save-and-resume trial, dashboard observation and fresh public installation passed. See the [delivery record](evidence/public-delivery-0.1.2.md).

## Previous delivery — 2026-11-07 UTC

## Current local-ledger and continuity delivery

BK-030–037 shipped in `pi-bookie`/`pi-bookie-core` 0.1.0 through
[PR #42](https://github.com/mojomanyana/bookie-pi-skills/pull/42), merged at
`9e51c892310506927570a8589479bb72d5cc7a17`, with successful exact-main CI and
verified public archives. See [delivery evidence](evidence/public-delivery-0.1.0.md).
Earlier unmerged/blocked snapshots below are historical, not the current package state.

BK-038's optional task-continuity guidance and checkpoint recipe are delivered
in `pi-bookie` 0.1.1 through [PR #43](https://github.com/mojomanyana/bookie-pi-skills/pull/43)
at `8271c037164cbc2d5666bc2a1183b83247616eca`, with successful exact-head and
merged-main CI, tag `v0.1.1`, and verified public archive bytes. The required
1,248-test check, independent release review and paired actual-Pi installation
qualification passed. Exact dependency `pi-bookie-core: 0.1.0` was neither changed
nor republished. See [delivery evidence](evidence/public-delivery-0.1.1.md).
The next product seam remains the partial shared service below; optional
instruction availability is not evidence of general memory or model quality.

The shared retrieval service BK-017 remains partial. Its completion/serving,
evaluation/cutover, production deployment and scale gates are not closed by the
local-ledger release. OQ-014 still requires a representative accepted retrieval
corpus/threshold before dependent evaluation. No new provider calls, real-vault
operation, Docker service qualification or production claim is part of BK-038.

## Previous dated handoffs (historical)

# Next-session handoff — 2026-11-04 UTC

## Latest delivery — owned payload writer/verifier delivered in PR #40

[PR #40](https://github.com/mojomanyana/bookie-pi-skills/pull/40) merged at **`2026-11-04T11:29:31Z`** as **`95ec3e7075fc91371e744c5c7a14e0ed9ac12325`**. Repair head **`65a3dde1c2006f4921fee7cc8f18757849bd285e`** passed [corrected-head CI 41820616025](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/41820616025), then [exact merged-main CI 41821298026](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/41821298026) passed clean install and `npm run check` **1160/0/0**, no cancelled tests, at **`11:31:45Z`**. All **27** approved file contents match actual merged main; the whole Git tree is identical to the approved repair head. Published history was extended, not rewritten. [Delivery evidence](evidence/BK-017.md#s8-writer-delivery-completed--2026-11-04-utc) records exact source, native approval and CI provenance.

Final independent integrated APPROVE covers candidate `dirty:30a255e2390b482403a261b45e432580e064946b4c06fd9dac08c10c851e84c3`, including the factual post-review delta, against original main/base `3ba887ad1385c0aac36144bf0393271e66e45f25`. Exact native final `.principal/reports/bookie-bk017-writer-git-delivery-tK9agi/5e9d12f73a9c093d/review.md`, with reviewer settlement retained before Git. REV-001–005 and bootstrap/path repairs are addressed; Test Review SOUND was one reviewer using two skills. Post-review full local checks passed **1160/0/0**; matching actual Redis **71/0/0**, cleanup **73/0/0** and affected **11-file** closest **234/0/0** retain their stated scopes.

Fresh runtime **1/0/0** and deployment **10/0/0** remain qualified for unchanged code/harness inputs; four clean images reproduce **`sha256:6d033e680c2bca2ee3076dcf2b0b53ad5d90e33b06da8efb33a5674f2b6621b7`** under the pinned profile. Current owned cleanup is confirmed. No new image/Redis/provider test, retry, dependency refresh, prune/restart, source guard exception or other-owner cleanup was needed for delivery. The earlier HOST900 cause and historical ACK uncertainty remain unresolved/history, not retroactively passed. Foreign resources, both old qualification directories and sibling five-file WIP are preserved.

**BK-017 remains Ready/partial; SPEC-004 remains In progress.** This delivers private bounded writing and actual stored integrity, retaining `building`, reservation and renewal—not completion or serving. Next accepted work stays inside BK-017: remaining lexical Search/index/context and later fenced evaluation/completion/activation/readers. Stop at **OQ-014** before evaluation/cutover without an agreed versioned corpus/labels/filters/metric/threshold. Production startup/supervision/persistence/connections/secrets/Compose/distribution/full serving/rebuild equivalence, REQ-031/032 scale/latency, OQ-001/005/006/007, trust/portability/legacy/advisory and blocked/deferred gates remain unchanged. No dependent feature implementation is included in this delivery action.

Verified feature-delivery snapshot: `main` at `95ec3e…`, synchronized **0/0**, clean before this factual reconciliation. The docs-only `bk-017-writer-delivery` branch is based on that merge and changes only eight Markdown files; inspect live Git state for later closeout. Sibling `/home/neman/Code/bookie-bk017-trusted-builder` remains on `bk-017-trusted-builder` at `e016f21…` with its original five dirty paths. All earlier uncommitted/pending snapshots below are historical, not the current delivery state.

## Prior result — repaired harness freshly qualified; delivery then pending (historical)

After separate operator authorization, exactly one fresh `npm run test:runtime --workspace @bookie/service` passed **1/0/0** (`2026-11-04T10:00:37.170749Z`–`10:12:54.293290Z`), then exactly one `npm run test:deployment --workspace @bookie/service` passed **10/0/0** (`10:14:44.153812Z`–`10:27:14.385984Z`). Both exited **0/signal null**, no cancelled/skipped tests or retries. All four independently clean local images reproduce artifact **`sha256:6d033e680c2bca2ee3076dcf2b0b53ad5d90e33b06da8efb33a5674f2b6621b7`**, build input `sha256:037aeaffbca0ecc0df537c9ac2de0154ecadb4ab3b3e5f0c77a71942e1da6aea`, and the unchanged pinned profile. [Current qualification evidence](evidence/BK-017.md#s8-current-harness-qualification--2026-11-04-utc) contains original records, exact image/source identities and native settlement.

Qualified candidate `dirty:57ed7d7eb41c9076b6b327092d04059e3d8ab6a2556aa93b0e41497008c04aa2`; all code/harness/test/label bytes stayed unchanged. Coordinator edits afterward only reconcile factual documents. Matching root **1160/0/0**, cleanup **73/0/0**, affected **11-file** closest **234/0/0** and actual Redis **71/0/0** are retained with their exact scopes. Both primary traces are complete: **1,716 records / 405 closed commands / 123 ACK-plus-exact-absence owners each**, no outstanding spans; real client-before-directory cleanup passed. No caps/security guards changed, foreign resources and old directories/images remain, and all owned/native work settled. The original HOST900 cause and historical ACK uncertainty remain unresolved, not retroactively passed.

The current-harness qualification gap is closed under the recorded local profile. A fresh independent **integrated APPROVE** now covers all **27 paths** against main/base `3ba887ad1385c0aac36144bf0393271e66e45f25`, reviewed candidate `dirty:752cd74b6cace8faba6147e75d45c8087d916e0c2eeba52585da1d5a68584b1d`; all **57/57** supplied references matched. Exact native final `.principal/reports/bookie-bk017-current-harness-qualification-X2Acxt/8f7532101b276a31/review.md` is retained with process/resource settlement. REV-001/002/003/004/005 and bootstrap/path repairs are addressed. Test Review SOUND was one reviewer/two skills, not two independent reviews. Only factual verdict/handoff documentation was reconciled afterward; approved code/harness/tests remain unchanged. **Corrected-head CI, actual merge and exact-main CI still remain.** This is whole-increment approval, not full BK-017/production acceptance. The pre-review full root command after qualification-document reconciliation passed **1160/0/0** at `2026-11-04T10:39:21Z`. No new commit/push/merge or production readiness is claimed or authorized by this qualification grant; PR #40 remains open at `17bc27e…` with its original failed CI. BK-017 remains Ready/partial, SPEC-004 In progress. Wider S8/Search/evaluation OQ-014/completion/activation/readers, production/persistence/supervision/Compose/distribution/full-chain/rebuild-equivalence/resources/scale/latency and standing trust/portability/approval/advisory gates remain unchanged. No further qualification retry or dependent feature implementation is authorized here.

Branch `bk-017-controller-payload-verification`, HEAD/upstream `17bc27e9d82630502ffce8a08994c70f8271b03a`, **0/0**; main/base `3ba887ad1385c0aac36144bf0393271e66e45f25`, main **+1/-0**. Preserve the same 16 uncommitted paths listed below and sibling five-file WIP. The retained native Build is `.principal/reports/bookie-bk017-current-harness-qualification-JPldHX/412b9f3ea9a25111/build.md`.

## Earlier authorized result — traced runtime passed; repaired harness then unqualified (historical)

The operator authorized sanitized bounded call-site tracing and **one** supervised qualification attempt. That permission is now consumed: exactly one `npm run test:runtime --workspace @bookie/service` ran with tracing enabled, **1/0/0**, exit 0/signal null, from `2026-11-04T00:31:08.197847Z` to `00:43:18.275432Z` (test 729,802.908 ms). No second attempt, selective image retry or `test:deployment` ran. That captured run followed closest **212/0/0**, full root **1138/0/0**. After the final shared-sink interaction repair, Dockerless 11-file closest checks pass **234/0/0** and full root **1160/0/0**; matching unchanged-production Redis **71/0/0** is retained, not rerun.

Two independently clean local images `b2b614…` and `34dbc9…` reproduce **`sha256:6d033e680c2bca2ee3076dcf2b0b53ad5d90e33b06da8efb33a5674f2b6621b7`**. All actual genuine controller/Redis, stored-only tamper, nested/empty, adversarial and fixture success/failure/cancellation cases passed. Primary trace: 1,716 records/378,936 bytes; 405 closed commands and 123 ACK-plus-exact-absence owners, no outstanding spans/exhaustion. Child fixture cleanup remains suite-assertion evidence, not primary-stream trace. Exact owned cleanup completed; foreign resources, old images and both old qualification directories were preserved. The earlier HOST900 cause remains **not established**—a successful later run does not explain or retroactively pass it.

Opt-in qualifier-only `BOOKIE_QUALIFICATION_TRACE=1` now records opaque IDs, static callsite/context and monotonic outcomes under **8,192-record/2-MiB** bounds. No argv, targets, source/payload/environment/credential/raw dependency error fields; incomplete tracing withholds the qualification record without interrupting/replaying cleanup. Existing time, security and capture budgets remain unchanged. Native Build and one-attempt evidence are retained in `.principal/reports/bookie-bk017-qualification-tracing-YrUSe9/61913f65abca190e/`; the old prepared-label freshness issue is explicitly reconciled with current authorized source references, not relabelled as an approval.

[Authorized evidence](evidence/BK-017.md#s8-authorized-qualification-tracing--2026-11-04-utc) records exact source/images/input/profile/failure history and limited permission. The first integrated diagnostic review requested REV-003 (real blocked stderr retained the process), REV-004 (proxy/outer getter leakage), and REV-005 (incomplete tracing still returned overall success). Those Dockerless repairs are now applied: a verified already-nonblocking Linux pipe/socket writer never queues callbacks, executable metadata is rejected statically, and qualification rejects after independent cleanup on trace incompleteness. A real unconsumed child-pipe regression now proves bounded nonzero exit after cleanup both with and without a command failure after backpressure, without parent drain. A second review found classic `console.error` could otherwise restart the queue; inline repair routes traced command/cancellation/startup diagnostics through the existing bounded path while retaining rejected errors/categories. Its deciding red was **1 pass/1 fail**; green is **2/0**, and complete cleanup controls **73/0**. Both original verdicts remain retained. No descriptor closure, flag change or new allowance is used. The harness changed after the captured runtime result and has **not** been requalified; the one-attempt limit is still respected. Final independent **integrated diagnostic APPROVE** is now retained for candidate `dirty:6bab38a98950d59559a2e09dbc9b2552501cd6ef12d4e0e1fd43487072ee3380`, covering all five diagnostic files/eight factual documents/owner interactions; REV-003/004/005 addressed and Test Review SOUND (one reviewer/two skills). Exact private final `.principal/reports/bookie-bk017-qualification-tracing-niCc6r/ad983792f48c9afd/review.md` and native settlement are retained. No code changed after approval; only this factual verdict/handoff was reconciled. **Current-harness qualification, current whole-feature approval, fresh deployment and corrected-head CI/merge/exact-main CI are not supplied by this diagnostic approval**. BK-017 remains Ready/partial, SPEC-004 In progress; Search/evaluation OQ-014/completion/activation/readers, production and resource/scale/latency gates remain. No requirement/ADR waiver was accepted; a stale spec status line was factually corrected.

Branch `bk-017-controller-payload-verification`, HEAD/feature upstream `17bc27e9d82630502ffce8a08994c70f8271b03a`, **0/0**. Base/main remains `3ba887ad1385c0aac36144bf0393271e66e45f25` (**+1/-0** against main). PR #40 remains unmerged with its original failed CI; no new commit/push occurred. Sibling WIP is untouched. Exact pending decision after diagnostic review: authorize the remaining fresh deployment gate if continuing delivery; do not run another runtime attempt under the consumed permission.

Current uncommitted paths (preserve, no reset/clean):
- `README.md`
- `apps/service/README.md`
- `apps/service/scripts/qualification-labels.mjs`
- `apps/service/scripts/qualify-runtime.mjs`
- `apps/service/src/rebuild-controller.ts`
- `apps/service/test/deployment/runtime.test.mjs`
- `apps/service/test/helpers/qualifier-runner.mjs`
- `apps/service/test/qualifier-cleanup.test.mjs`
- `apps/service/test/rebuild-controller.test.mjs`
- `apps/service/test/redis/candidate-store.test.mjs`
- `docs/INDEX.md`
- `docs/planning/backlog.md`
- `docs/planning/evidence/BK-017.md`
- `docs/planning/next-session.md`
- `docs/planning/principal-assessment.md`
- `docs/specs/004-retrieval-service.md`

## Prior blocker — ownership repair locally passing, fresh runtime unqualified (historical)

On `bk-017-controller-payload-verification`, HEAD/upstream remain **`17bc27e9d82630502ffce8a08994c70f8271b03a`**, divergence **0/0**; main/base remains `3ba887ad1385c0aac36144bf0393271e66e45f25`. PR #40 is unmerged and its original CI remains failed. New source/status repairs are uncommitted; inspect live status for the exact paths. Sibling WIP is untouched.

The next whole review found **REV-002**: a delayed original recovery-fence acknowledgement could regress the real store client's cached epoch after reload, breaking a replacement's status/renewal. That verdict is retained. The applied controller-only production fix joins the original raw fence method before replacement publication within the existing shared 2.5-second ownership window; rejected/unproved settlement quarantines admission, and late callbacks cannot regain authority. Actual-client five-case red/green and actual Redis race controls pass. Latest closest **200/0/0**, root **1126/0/0**, Redis **71/0/0**; no client/Lua/schema/profile/budget changes.

**Do not deliver or reuse old images for current bytes:** fresh `test:runtime` cancelled at the unchanged **900,000-ms** host-test deadline, with static image-command/container-copy categories; no successful qualification record/artifact was emitted. Deployment was not rerun. Failed Build `.principal/reports/bookie-bk017-s8-controller-payload-QYN2HA/97185c56d552429a/build.md` is retained/settled; original cleanup acknowledgement completeness is unproved. Current coordinator observation finds no owned runtime/deployment containers or former native processes and only the two known pre-existing qualification directories; it establishes current quiescence, not retrospective qualification. No retry/prune/cap increase occurred. Independent diagnosis is now settled **blocked**, cause not established/reproduced: `.principal/reports/bookie-bk017-s8-controller-payload-uQsF2W/f84fc81bad78b472/debug.md`. Protected no-op/extraction infrastructure controls passed (604 ms/3,644 ms; four relevant synthetic checks passed), but used an old image only as a control—not current qualification. Docker retained only 256 recent events, outside the failed interval; no historical command/callsite timing is available. Its exact copy/clients/two containers/directories/registration were disposed; caller bytes were unchanged. No behavioral fix or automatic retry is justified.

**Next necessary decision:** provide sanitized Docker stage/command start–settlement evidence for the approximately **21:41–21:57 UTC** failed run, or explicitly authorize bounded static callsite/body-versus-finalizer instrumentation and one supervised qualification attempt to capture it. Do not retry the uninstrumented command. Only after diagnosis/evidence repair obtain fresh runtime/deployment gates, independent whole-change approval, corrected-head CI, merge and exact-main CI. Last passing product commands remain actual `npm run check` **1126/0/0**, complete closest **200/0/0** and actual Redis **71/0/0**; fresh-image gate is unmet. No requirement/ADR drift was accepted.

Uncommitted files preserved for that decision (no reset/clean/stash):
- `README.md`
- `apps/service/README.md`
- `apps/service/src/rebuild-controller.ts`
- `apps/service/test/helpers/qualifier-runner.mjs`
- `apps/service/test/qualifier-cleanup.test.mjs`
- `apps/service/test/rebuild-controller.test.mjs`
- `apps/service/test/redis/candidate-store.test.mjs`
- `docs/INDEX.md`
- `docs/planning/backlog.md`
- `docs/planning/evidence/BK-017.md`
- `docs/planning/next-session.md`
- `docs/planning/principal-assessment.md`
- `docs/specs/004-retrieval-service.md`

At the last observed head this branch is one commit ahead/zero behind main, zero ahead/behind its feature upstream. All native operations are settled; no child remains active. Next accepted backlog item is still **BK-017**—finish this gate before its dependent work.

BK-017 remains Ready/partial, SPEC-004 In progress; all wider Search/evaluation (OQ-014)/completion/activation/readers, production/persistence/supervision/distribution and resource/scale/latency gates remain. [Writer evidence](evidence/BK-017.md#s8-owned-payload-writer--2026-11-03-utc) preserves all prior successes, failed CI, fixes and superseded snapshots below.

## Prior implementation checkpoint — owned S8 payload writer (historical)

The controller-owned bounded writer/actual-verifier continuation is implemented on `bk-017-controller-payload-verification`, based on delivered main **`3ba887ad1385c0aac36144bf0393271e66e45f25`**. First head `17bc27e9d82630502ffce8a08994c70f8271b03a` is published in [PR #40](https://github.com/mojomanyana/bookie-pi-skills/pull/40), **not merged** at this snapshot. Its original CI failed six synthetic bootstrap cases. The diagnosed helper-only fix and status reconciliation are currently uncommitted; no rerun/merge is inferred. The branch started from synchronized main (0 behind / 0 ahead). Native Build/Plan/Debug finals and owned cleanup are settled. The next gate is independent **whole-candidate integrated correctness/simplicity and test-quality review**, then actual merge and matching CI before dependent work. No future delivery is predicted; inspect live Git/receipts. Sibling WIP remains untouched.

Genuine complete S5 output now confirms its original attachment, writes ordered concept/chunk batches lazily through existing no-replace appends and invokes the real stored verifier with original recipe/descriptor/lease/signal and remaining claim-relative deadline. Exact encoded-byte/count endpoints remain legal; unknown writes never replay or cursor-resume. Guarded late continuations cannot affect a replacement reservation. Original renewal/capacity and lifetime retirement history survive; **integrity success still holds building, not complete/servable**. No public stage API, verification flag, default Redis client or production supervisor is added.

Fresh actual checks: closest **195/0/0**, root **1121/0/0**, Redis **70/0/0**, runtime **1/0/0**, deployment **10/0/0**. Four independent clean builds reproduce **`sha256:2292f66886ab383a581d3ad4f3450be29a06ca061534f7c4959c6ea810da4c46`**. Both protected-image suites demonstrate genuine S5/controller/actual-Redis writes and measurement of **137 concepts / 148 chunks**, storage-only tampering, nested SHA-256 and verified empty inventory/final checks. Test-only bounded Unix sockets retain the network-none/no-port, read-only/non-root/cap-free/NNP/source/runtime profile. [Writer evidence](evidence/BK-017.md#s8-owned-payload-writer--2026-11-03-utc) preserves exact images/inputs, the initial scope blocker, failed cancellation qualification, independently diagnosed unreferenced runner lifetime, controlled exact-resource recovery, applied IPC-reference fix, interrupted Redis command and integrated REV-001 outer-finalizer finding/repair with actual-boundary red/green regressions. Synthetic bootstrap now provisions and checks private ignore policy before instrumentation; short owned names preserve the 107-byte socket guard at CI-length checkout roots. Isolated clean-Git fixtures cover absent root/policy, preserved policy, fail-closed nonignoring policy and the exact socket endpoint. A full owned-checkout check starts without `.principal` and passes **1121/0/0** using copied fixed-lock dependencies (not fresh `npm ci`). Matching actual Redis/runtime/deployment closures remain unchanged and their evidence is reused. The cross-root candidate-ID collection assertion remains a historical wrapper failure; coordinator reconciliation matches exact tool-observed product state/references, without editing evidence or inventing an identity. Successful records follow owned cleanup; historical failures remain failures.

**BK-017 stays Ready/partial; SPEC-004 In progress.** After this increment's integrated approval and actual delivery, continue the remaining exact S8 Search/index readiness, evaluation/completion, atomic activation/rollback and leased reader/context contract. OQ-014 still requires an agreed corpus/threshold before dependent evaluation/completion/cutover; no default was invented. Production startup/supervision/persistence ACK/connections/secrets/Compose/distribution, full serving-chain/deletion-rebuild equivalence, 50k/250k/15-user resources, packed+loose admission ≤10 s, full build ≤6 h, warm p95 <500 ms during work and ambient-guard fit remain unqualified. Preserve OQ-001/005/006/007, trust/portability/heap-total-resource/legacy-consumer assumptions, blocked/deferred items and package-label/advisory follow-ups. A genuine private component chain is not production or populated-scale certification.

## Prior delivery checkpoint — first S8 integrity increment merged and verified (historical)

[PR #38](https://github.com/mojomanyana/bookie-pi-skills/pull/38) merged at `2026-11-03T13:54:11Z` as **`bb8ab6f4758a539993437dbbc94b092ae19e6cbd`**. Reviewed head `739a7d7d77f090e6e36523f09e74ce2659d02e6e` passed [PR CI 41647894833](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/41647894833); exact merged-main [CI 41648523307](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/41648523307) passed clean `npm ci` and full `npm run check`, **1031/0/0**, at `2026-11-03T13:56:52Z`. Final independent **integrated APPROVE** covers all 24 paths; one reviewer also assessed test quality as SOUND, not a second independent review. All native work/cleanup settled before Git and all 24 reviewed contents matched the committed/merged tree. [Delivery evidence](evidence/BK-017.md#s8-integrity-delivery-completed--2026-11-03-utc) preserves exact identities and original failures. Main was clean/synchronized at this delivered snapshot (0 behind / 0 ahead). This factual documentation reconciliation does not predict its own future commit/merge; inspect live Git for current branch/state. Sibling trusted-builder WIP is untouched.

`verifyStoredOutput` privately re-reads bounded actual Redis streams, validates full projection/recipe/descriptor/ownership, hashes the established JSON-plus-LF encoding, exhausts bounded inventory and rechecks ownership before returning frozen counts/hashes. Stored-only tampering with unchanged producer evidence/cursors fails. Reads never mutate lifecycle/TTL/protections, return partial evidence or replay uncertain writes. There is no consumer or durable verification flag. **S7 is unchanged: attachment remains building, with reservation and renewable lease held.**

Actual final checks: root **1031/0/0**, closest **110/0/0**, real Redis **49/0/0**, runtime **1/0/0**, deployment **10/0/0**. Four fresh clean images reproduce **`sha256:49e6e3029f0e7d610c08844c4c86f7b542faabda0391f4a54dbb2ae1e382d95f`** on Linux/amd64, Node24.19/Git2.39.5/npm11.9. [S8 evidence](evidence/BK-017.md#s8-stored-output-integrity--2026-11-03-utc) preserves exact inputs/images, original red/failures and native identities. First deployment9/1 and later runtime0/1 failures were independently diagnosed: competing teardown was repaired with shared ownership/drain; cumulative adversarial work was partitioned into named genuine invocations. All original checks and finite deadlines remain; records emit after cleanup. Private evidence remains intact, with only root `.principal/**` excluded from ESLint and product lint protected by regression.

**BK-017 stays Ready/partial; SPEC-004 In progress.** The next accepted S8 seam is controller-owned bounded payload writing and verification using genuine S5 output, original lease/signal/remaining claim-relative deadline, renewal/reservation and attempt-lifetime non-replay history. Search/citations/context, evaluation/completion, atomic activation/rollback, reader protections, full production startup/supervision/persistence/connection/secrets/Compose/distribution, deletion/rebuild equivalence and REQ-031/032 workload/resource/latency gates remain pending. [OQ-014](open-questions.md#oq-014-retrieval-evaluation-corpus-and-acceptance-threshold) records the missing agreed evaluation corpus/threshold, due before dependent evaluation/completion/cutover; no default was invented. Preserve OQ-001/005/006/007, trust/portability and no-external-legacy-ID assumptions, blocked/deferred dependents and package-label/advisory follow-ups. Compositional synthetic checks are not a qualified full production chain or scale result.

## Prior delivery checkpoint — S7 merged and verified (historical)

[PR #36](https://github.com/mojomanyana/bookie-pi-skills/pull/36) merged at `2026-10-30T21:20:27Z` as **`ca2c0e9fe71e10d17a16cd5ce745129adcc51c07`**. PR head `9186a1213ee4ea8791869750b77eeedc0d37a666` passed [PR CI 41129937743](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/41129937743); exact merged-main [CI 41130311607](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/41130311607) passed clean `npm ci` and full `npm run check`, **1000/0/0**, at `2026-10-30T21:22:57Z`. Final independent integrated review is **APPROVE**, all six findings addressed, native work/cleanup settled before Git. [S7 delivery evidence](evidence/BK-017.md#s7-delivery-completed--2026-10-30-utc) retains exact identities and the private report. All 22 reviewed contents matched the actual merged tree.

Repaired S7 real Redis **29/0/0**, runtime **1/0/0** and deployment **10/0/0** qualify the four recorded local images of **`sha256:dfe0162d30a2d2d9e24f438340bf8c76058d93d023bd4d446482d9f9833bbe96`**. These are compositional/local Linux/amd64 checks, not full production-chain, registry or scale certification. Optional rebuild/status/cancel exists; **attachment remains building with capacity/lease held**. No stored-stream completion or serving path exists.

**BK-017 stays Ready/partial; SPEC-004 In progress.** Next accepted unit is **S8 actual stored-output verification, lexical Search/context, evaluation/completion and atomic activation/rollback**, with production startup/supervision/persistence/connection/Compose/distribution and REQ-031/032 resources/scale/latency gates. Preserve all data-owner/license/provider approvals, trust/portability caveats, blocked/deferred dependents and package-label/advisory follow-ups. Sibling WIP is untouched. This factual closeout predicts neither its own future commit/merge nor S8 code; inspect live Git/CI before the next branch.

## S7 implementation and local verification checkpoint — 2026-10-30 UTC (historical)

Current work starts from delivered S6 `195e6468584738de084e86fcde085e102d869042` on `bk-017-owned-rebuild-controller`, uncommitted at this snapshot. Native S7 Build final is retained and settled. The next gate is independent **integrated** review of the assembled increment, then actual merge/matching CI before S8. This handoff does not predict its own future commit/merge; inspect live Git and receipts. Sibling trusted-builder WIP is untouched.

S7 implements private owned admission/lifecycle and optional existing-v1 rebuild/status/cancel routes: current auth/config publication, one preflight/builder, bounded submission, original-attempt reconciliation/quarantine, confirmed claim/building/single launch, socket-independent claim-anchored work, renewal, both-phase cancellation/failure/cleanup and supervised replacement. No production supervisor is supplied or defaulted. **Attachment stays `building` with the reservation/lease held**, not complete or servable. No payload/index/completion/evaluation/activation path is added. Legacy identities/layouts, v1 fields/states and protected data remain.

Actual repaired checks: root **1000/0/0**, real Redis **29/0/0**, fresh runtime **1/0/0**, deployment **10/0/0**; four final clean images reproduce **`sha256:dfe0162d30a2d2d9e24f438340bf8c76058d93d023bd4d446482d9f9833bbe96`**. [S7 evidence](evidence/BK-017.md#s7-owned-controller--2026-10-30-utc) retains actual red/green/timeout evidence, final qualification inputs/images/profile and native identity. The first integrated S7 review requested two cancellation-race repairs, a Lua-faithful fake failure transition and status wording. Its exact final/probes were retained before test-first repair. Lost-claim/confirmed-cancel and worker-failure/cancel-commit races now reach cancelled with safe retirement; unknown acknowledgement still quarantines without replay. Real Redis reproductions were red (26/3, including parent) then green (29/0/0); unit controls cover confirmed, committed-lost and unresolved acknowledgement. Earlier S7 `8d5…` runs and S6 `b95e…` are historical, not repaired-byte qualification. Self-review additionally reproduced and repaired a stopped-worker failure-reply/publication handoff: the active reload owns fencing/retirement, so an old callback cannot quarantine its conclusively resolved reservation. Its dedicated red0/1 is now green, together with all six targeted controls. Final fresh root995/0/0, realRedis29/0/0 and four final clean `ded0…` images supersede intermediate `b711…` qualification. The follow-up integrated review found mutation limits were invocation-local and failed publication could miss quarantine after claim release. Both were repaired test-first: lifetime histories now cover failure/acknowledgement/recovery-fence dispatch across late cancellation and shutdown, and publication failure always disables readiness. Targeted red4/5 is green9/0/0; current root1000/0/0 and four `dfe0…` qualified images supersede the intermediate ded0… source. Final integrated review/delivery remain required.

Evidence is compositional: genuine guarded S5/controller with fake store, real Redis/controller with fake builder, plus actual owned-process cancellation. It is not full production-chain or scale qualification. **BK-017 stays Ready/partial; SPEC-004 In progress.** After S7 review/delivery, next accepted unit is **S8 stored-output verification, lexical Search/context, evaluation/completion and atomic activation/rollback**, with full production startup/supervision/Compose, persistence acknowledgements and REQ-031/032 resource/scale/latency gates. Preserve all existing source/data-owner/license/provider approvals, trust/portability caveats and blocked/deferred items.

## Prior delivery checkpoint — S6 merged and verified (historical)

[PR #34](https://github.com/mojomanyana/bookie-pi-skills/pull/34) merged at `2026-10-30T02:33:27Z` as **`70604935bd10a915f55599d4dbc2806f7feaf67d`**. PR head `7cc721c3fce2d23ab777c23d12b31a48a5398a31` passed [PR CI 40992125043](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40992125043); exact merged-main [CI 40992381258](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40992381258) passed clean `npm ci` and full `npm run check`, **950/0/0**, at `2026-10-30T02:35:08Z`. Final independent integrated review is **APPROVE**, all accepted findings addressed, with native settlement/cleanup confirmed. [S6 delivery evidence](evidence/BK-017.md#s6-delivery-completed--2026-10-30-utc) retains exact identities and the private report. All 15 reviewed contents matched the actual merged tree.

S6 is delivered, not all of BK-017: **BK-017 stays Ready/partial; SPEC-004 In progress**. Repaired real Redis **25/0/0**, runtime **1/0/0** and deployment **10/0/0** qualify the recorded local `sha256:b95e259445577bee089c0220ee061fbc4e234c08c5c8a456aeaa8eda65468826` artifact. This is not a registry/production or scale qualification. No controller, HTTP rebuild, stored-stream completion verification, serving or provider path was added.

Next accepted work is **S7 controller-owned capacity, configuration-publication interlock, single launch, disconnect/unknown-outcome/restart reconciliation**, under the accepted admission/deadline/cancellation contract. S8 serving/deployment/scale and all source/data-owner/license/provider/blocked/deferred gates remain. Sibling trusted-builder WIP is untouched. This factual closeout does not predict its own future commit/merge or create S7 code; inspect live Git/CI before the next branch.

## S6 implementation and local verification checkpoint — 2026-10-30 UTC (historical)

Current increment starts at `5c579883848964756ed782e1e3d86f8499e2d558` (merged PR #33), on `bk-017-fenced-output-attachment`, no upstream at this snapshot. S5 is delivered with integrated approval/merge/CI recorded below. Native S6 Build final is retained and settled. This handoff does not predict its own commit/merge; inspect live Git and current review/delivery receipts before continuing. The sibling `/home/neman/Code/bookie-bk017-trusted-builder` WIP remains untouched.

**BK-017 stays Ready/partial; SPEC-004 In progress.** S6 implements private v2 absent-output claims, explicit live-fenced begin-building, immutable descriptor attachment, strict both-phase reconciliation and protected cancellation/failure/interruption/cleanup. It retains the original APIs/IDs/layout, five-field public job shape, namespace and serving-data protections. Preallocated attempt IDs and explicit unknown-outcome failures support later S7 reconciliation; they do not launch workers or release capacity.

Actual repaired checks: real Redis **25/0/0**, targeted **35/0/0**, author root **950/0/0**; fresh runtime **1/0/0** and deployment **10/0/0** reproduce four local images of **`sha256:b95e259445577bee089c0220ee061fbc4e234c08c5c8a456aeaa8eda65468826`**. Exact red/green, immutable image IDs/profile and native source identity are in [S6 evidence](evidence/BK-017.md#s6-fenced-output-attachment--2026-10-30-utc). S5 `0b55…` and earlier digests remain historical. Local synthetic/Linux qualification is not production/registry distribution or scale proof.

The first integrated S6 review requested complete-manifest admission/protection and negative-zero canonicalization repairs plus current-status wording. Its native final/probe evidence was retained before repair. All three regressions failed before correction; real Redis now passes 25/0/0, and four fresh repaired images qualify the digest above. Missing metadata no longer makes retained complete payloads replacement-cleanup-owned; raw/persisted literal negative-zero descriptors reject. Original `8436…` qualification is historical, not repaired-code evidence. Final independent integrated S6 review and actual merge/CI govern progression. Next accepted work after those gates is **S7 controller-owned capacity, configuration-publication interlock, single launch, disconnect/unknown-outcome/restart reconciliation**, under unchanged v1 semantics. No controller/new HTTP route, stored-stream completion verification, index, evaluation, activation, provider or serving path is enabled by S6. Preserve S8 production/scale gates, source/data-owner/license/provider approvals, blocked/deferred items and all established trust/portability assumptions.

## Prior delivery checkpoint — S5 merged and verified (historical)

[PR #32](https://github.com/mojomanyana/bookie-pi-skills/pull/32) merged at `2026-10-29T17:19:44Z` as **`9f50a205596db263acff01f01b108b743cf03d49`**. PR head `8f243121acdd9881410fa6b89a285457a16f7dda` passed [PR CI 40919854374](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40919854374); exact merged-main [CI 40920268072](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40920268072) passed clean `npm ci` and full `npm run check`, **944/0/0**, at `2026-10-29T17:22:18Z`. Independent final integrated review is **APPROVE** with native settlement/cleanup confirmed. [S5 delivery evidence](evidence/BK-017.md#s5-delivery-completed--2026-10-29-utc) retains exact source identities and the private report. All 23 reviewed contents matched the actual merged tree.

S5 is delivered, not all of BK-017: **BK-017 stays Ready/partial, SPEC-004 In progress**. Fresh runtime **1/0/0** and deployment **10/0/0** qualified four reproducible local images of artifact `sha256:0b55ad86368f2f9c7c58ead1fd0978d39c5f5e3b0eb0d5c2be00af486b11b4c7`; no production/scale qualification or registry pin is implied. Docker is available; the old WSL blockage is historical. No controller/Redis/HTTP/provider wiring was added.

Next accepted work is **S6: absent-output candidate claims, explicit live-fenced begin-building, immutable output attachment and both-phase cancellation/cleanup**, with real Redis tests before controller use. S7/S8, blocked/deferred backlog items and all existing source/data-owner/license/provider gates remain. The sibling trusted-builder WIP is untouched. This factual closeout does not predict its own commit/merge or create S6 code; inspect live Git/CI before starting the next branch.

## S5 implementation and local qualification checkpoint — 2026-10-29 UTC (historical)

Docker is restored (Linux/amd64 engine 29.8.0). This continuation starts from merged [PR #31](https://github.com/mojomanyana/bookie-pi-skills/pull/31), main `4cc04e9808d2b6d7e876d499678be2f2bcb22f0b`, with successful [merged-main CI 40877992904](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40877992904). Branch `bk-017-trusted-builder-qualified` has no upstream at this implementation snapshot. The separate `/home/neman/Code/bookie-bk017-trusted-builder` WIP is untouched. This handoff does not predict its own commit/merge; inspect live Git and delivery receipts when resuming.

**BK-017 remains Ready/partial; SPEC-004 In progress.** S5 implements deployment-owned external expected-identity loading, live runtime qualification, authenticated guarded preflight with process-local recipe provenance, and an isolated builder that independently checks the claimed v2 recipe, exact canonical sink bytes/counts and actual concept/chunk streams. It returns complete frozen private output/descriptor, not a job, controller, serving capability or Redis/provider write. Legacy IDs remain distinct.

Pre-S5 baseline runtime **1/0/0** and deployment **10/0/0** passed, reproducing artifact `sha256:86d4205399885ee6007e183fcd92a8c9b4891116e72410e6c615842eb3ab4e5a`. Changed S5 runtime **1/0/0** and deployment **10/0/0** also passed; four new clean builds reproduce **`sha256:0b55ad86368f2f9c7c58ead1fd0978d39c5f5e3b0eb0d5c2be00af486b11b4c7`**. These are retained immutable local image IDs, not registry distribution pins or production/scale qualification. New real-container cases cover both Git formats, nested/relocated sources, authentic/forged receipts, configuration/source/runtime drift, repeatability, genuine empty output, policy failures and cancellation/deadline behavior. Details and exact evidence are in [BK-017](evidence/BK-017.md#s5-changed-candidate-qualification--2026-10-29-utc).

The first changed-image run failed because the relocation fixture cloned a UID-65534 repository as root (Git exit 128), not because a source guard should be bypassed. Independent native Debug confirmed narrow red/green and removed its disposable workspace/containers. Inline Build applied the proved fixture-only owner-aligned clone: read-only source, separately owned destination, non-root/capability-free execution and no shared objects/ownership exceptions. Production guards were unchanged.

Native S5 Build and Debug finals are retained and settled. Initial changed-code Dockerless root check passed **944/0/0**; coordinator final checks and independent integrated review/delivery remain explicit gates, not claims made by those leaf results. No S6/S7 controller/Redis/HTTP path is enabled. Record actual integrated approval, merge and matching CI before dependent S6 absent-output claims/immutable attachment, then S7 ownership/capacity and S8 serving/deployment/scale work. BK-018/019/020 blocks, BK-021/022 deferrals, OQ-001/005/006/007, trusted host/mount/invisible-alias limits and the no-external-legacy-ID-consumer assumption remain.

## Prior delivery checkpoint — merged; S5 qualification blocked (historical)

[PR #30](https://github.com/mojomanyana/bookie-pi-skills/pull/30) **MERGED** at `2026-10-29T12:17:53Z` as **`eb2a34f31977165b866927ce0ac0d04bc5f34376`**. PR head `d60a2bec3e3599464307b8cfa1b3e82e1f8145e6` passed [PR CI 40862380770](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40862380770). [Merged-main CI 40872106782](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40872106782), job [123441504170](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40872106782/job/123441504170), passed on that exact integration SHA at `2026-10-29T12:20:06Z`: clean `npm ci` and `npm run check`, **938 passed / 0 failed / 0 skipped**. Independent final integrated review is APPROVE; native settlement/cleanup and source identities are recorded in [BK-026 delivery evidence](evidence/BK-026.md#post-merge-delivery-reconciliation--2026-10-29-utc). Reports remain private.

**BK-026–029 are Done. BK-017 remains Ready/partial; SPEC-003/004 remain In progress.** At the start of this reconciliation, main was fast-forwarded to the integration commit and branch `bk-017-verified-builder` started there (upstream none). This update contains only delivery reconciliation, not S5 implementation; it does not predict its own future commit/merge. Inspect live Git for the current checkout and upstream. The separate `/home/neman/Code/bookie-bk017-trusted-builder` worktree remains untouched.

The user authorized merge and continuation. Fresh qualification is blocked: `docker info --format '{{.ServerVersion}} {{.Architecture}}'` exits **1**, reporting Docker unavailable in this WSL distro. Docker Desktop WSL integration must be enabled, or an approved Docker environment supplied. No runtime/deployment suite was run, no new image was built, and historical image/artifact digests do not qualify the changed bytes. No controller, Redis, provider or production/scale feature was enabled.

Next, after `docker info` succeeds, use Node 24 and run:

```bash
npm run test:runtime --workspace @bookie/service
npm run test:deployment --workspace @bookie/service
```

Both must pass before S5 relies on runtime identity. Then implement the accepted plan's trusted authorized preflight/deployment-owned expected identity loading and independent builder recipe/canonical-output comparison, with test-first regressions and integrated review. No guessed identity, forged receipt, skipped qualification or controller shortcut. Provider/data-owner/license/attachment/deferred-write/export gates are unchanged. Check live Git state before resuming; the historical inventories below are not current worktree state.

## Pre-merge delivery checkpoint — 2026-10-29 UTC (historical)

At `2026-10-29T11:00:18Z`, [PR #30](https://github.com/mojomanyana/bookie-pi-skills/pull/30) is **OPEN**, targeting `main`, mergeable with a clean check state. The user selected commit/push/open-PR delivery. Four focused commits (`e13b0bb`, `6ecfbe1`, `a7c265d`, `8442d1f`) captured all 44 reviewed files without changing their bytes; the worktree was clean and the branch synchronized with `origin/bk-017-provenance-policy-hardening`, four commits ahead of `origin/main`.

Reviewed source head **`8442d1fa6fce6cc2cc7a2a36897e02b8e889b367`** passed [CI run 40861363965](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40861363965), job [123405129041](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40861363965/job/123405129041), completed successfully at `2026-10-29T10:58:00Z`; both `npm ci` and `npm run check` passed. The independent final integrated review is APPROVE and the matching local post-review check passed **938 / 0 failed / 0 skipped**. Native reports remain private. This subsequent handoff-only update does not predict its own commit or CI run; inspect the live PR for its latest head/checks.

**No merge, main update, release or publication has occurred.** BK-026–029 remain Ready until actual merge and matching CI evidence is recorded; BK-017 remains partial. Next: review/merge PR #30, record the actual integration commit and CI before marking safety items Done, then perform fresh runtime/deployment qualification before the trusted-builder stage. Existing provider, non-public-data, license, attachment, deferred-write/export and production/scale gates remain unchanged.

The October 28 sections below preserve the implementation history. Their uncommitted-file inventory and unselected-destination statements describe that earlier snapshot, not the current delivery checkpoint. Always inspect the live checkout before switching branches or starting work.

## Implementation snapshot — 2026-10-28 UTC (historical)

The [principal assessment](principal-assessment.md) supersedes historical next-work priority below. On `bk-017-provenance-policy-hardening`, HEAD/base `e016f214e380014dd94643d34d8421508bdc606e` (no upstream; local main 0 behind / 0 ahead), the prior bounded BK-017 blob-integrity/final-field-policy/owned-process repair is independently **APPROVE** at `.principal/reports/principal-repository-assessment-QbNmJc/c39901621882c9d7/review.md`, candidate `dirty:a6acb26171e656c415b0e4701f95c2187fe441c1816defefa8e6db9cefdb1ddb`. That approval is bounded, not service completion. The sole product writer then implemented **BK-026 → BK-027 → BK-028 → BK-029** sequentially, preserving all 21 inherited dirty paths and the inherited tests/approval. No service-runtime or sibling-worktree edits, delegation, commit/push/merge, publication or provider calls were made in this increment.

Current behavior/evidence: [BK-026](evidence/BK-026.md) real-loader host queue sharing for root/local entries and clean production-shaped installs; [BK-027](evidence/BK-027.md) explicit hash-free excluded result union and Pi serialization; [BK-028](evidence/BK-028.md) actual FIFO/substitution/abort rejection with released checkpoint slots; [BK-029](evidence/BK-029.md) supervised read-only CLI operations, synchronized parser stalls and owned Git teardown. SPEC-002/003 and package docs were updated; SPEC-002's additive final ordered timeout option was explicitly authorized and documented before implementation. These four items remain **Ready / implemented-pending-review-delivery**, not Done. SPEC-003 remains In progress; BK-017 stays Ready/partial and SPEC-004 In progress. No retrieval/controller feature was added. Original CPI source identity remains `.principal/reports/principal-repository-assessment-wwbTE2/ef2e9a8db2a25156/review.md`.

Inherited baseline: Node `v24.19.0`, npm `11.5.2`, `npm run check` **867/0/0**, `.principal/reports/principal-repository-assessment-B0PwOK/ef2e9a8db2a25156/artifacts/post-review-check.log`. New forced build/four closest suites passed **107/0/0** (`safety-closest-WNZIfA.log`); final Node 24 `npm run check` **exit 0, 901 passed / 0 failed / 0 skipped** (`safety-final-check-AVq4QI.log`: 461 repository, 102 service, 22 CLI, 273 core, 43 Pi), including formatting/lint/forced types/schema build and packaging. New uniquely named logs are under `.principal/reports/bookie-accepted-delivery-continuation-hrIJWH/c39901621882c9d7/artifacts/`; the native final report is coordinator-retained, not separately written. npm **11.5.2**, not default npm 12, made a classification-only lockfile change offline; dependency versions/integrities and unrelated platform annotations remain unchanged. Remote freshness was not queried.

The first assembled integration review requested three concrete edge repairs: bounded parent exit on kill refusal, command-specific worker-result validation before output, and static cancellation after final request stat/close before approval. All three are implemented with observed regressions; a malformed staged test fixture was corrected without weakening its approval contract. Archived BK-026 red counts and CLI inspect synopsis were corrected. Latest Node 24 root `npm run check`: **exit 0, 938 passed / 0 failed / 0 skipped** (461 repository, 102 service, 48 CLI, 273 core, 54 Pi); expanded focused repair suites **37/0/0**. Static cancellation now also covers resolved/rejected host dialogs, with three further red cases observed before repair; prior 33-test/934-test checks remain historical. Logs and exact dispositions are appended to BK-028/BK-029 evidence. The earlier 901-test entry remains historical. The original changes-requested review is retained immutably; inspect the coordinator-retained final integrated report for the current verdict rather than treating this Build note or test count as approval.

Inspect `git status --short --untracked-files=all` and preserve all current uncommitted files; do not execute a main switch/pull over this work. The delivery records and clean-main resume commands below describe the earlier 2026-10-10 snapshot, not the current checkout.

## Pre-commit path inventory — 2026-10-28 UTC (historical)

All 21 starting dirty paths were retained; service/runtime and prior integrity tests have no additional edits from this increment. BK-017/BK-025 evidence and SPEC-004 remain inherited. The complete current uncommitted inventory (including new files) is:

```text
README.md
apps/service/src/build-input-versions.ts
apps/service/src/ingestion-isolation.ts
apps/service/src/projection-worker.ts
apps/service/test/build-input-assembly.test.mjs
apps/service/test/ingestion-cleanup.test.mjs
apps/service/test/ingestion.test.mjs
apps/service/test/projection.test.mjs
docs/INDEX.md
docs/planning/backlog.md
docs/planning/evidence/BK-017.md
docs/planning/evidence/BK-025.md
docs/planning/evidence/BK-026.md
docs/planning/evidence/BK-027.md
docs/planning/evidence/BK-028.md
docs/planning/evidence/BK-029.md
docs/planning/next-session.md
docs/planning/principal-assessment.md
docs/planning/toolchain.md
docs/specs/002-core-and-cli.md
docs/specs/003-pi-extension.md
docs/specs/004-retrieval-service.md
package-lock.json
package.json
packages/cli/README.md
packages/cli/src/cli.ts
packages/cli/src/operation-process.ts
packages/cli/src/operation-worker.ts
packages/cli/test/cli.test.mjs
packages/cli/test/fixtures/parser-control.mjs
packages/core/README.md
packages/core/src/checkpoint-preparation.ts
packages/core/src/concept-mutation-model.ts
packages/core/src/concept-mutation.ts
packages/core/src/index.ts
packages/core/src/vault-git-base.ts
packages/core/test/canonical-export.test.mjs
packages/core/test/checkpoint-preparation.test.mjs
packages/core/test/concept-mutation.test.mjs
packages/core/test/git-base-validation.test.mjs
packages/pi-extension/README.md
packages/pi-extension/package.json
packages/pi-extension/src/index.ts
packages/pi-extension/test/extension.test.mjs
```

Next delivery action: inspect the fresh candidate-bound independent integration/test-quality verdict and native cleanup/settlement retained by the coordinator, resolving any non-approval before delivery; then ask the user to select the PR/merge destination; **no destination has been chosen**. Keep all work uncommitted until that choice. After review fixes, rerun affected checks and Node 24 `npm run check`; only actual merge and matching CI evidence can move BK-026–029 to Done.

Next qualification/feature action after that delivery gate: run fresh `npm run test:runtime --workspace @bookie/service` and `npm run test:deployment --workspace @bookie/service` before S5 trusts the changed runtime identity, then continue BK-017 trusted authorized preflight/expected-runtime loading and independent builder recipe/canonical-output comparison. No Docker/Redis/provider qualification is required for these four local safety repairs. Historical digests below remain historical. Retain Linux measured-process scope (non-Linux teardown unqualified), trusted host/mount and invisible-alias limits, V8-versus-total-resource caveats, ADR-0011's no-external-legacy-ID-consumer assumption, OQ-005 attachment defaults, OQ-001 license, OQ-006 provider choice, OQ-007 non-public approval, BK-018/BK-020 blocks and deferred CLI writes/export and destination adapters.

## Historical development and delivery status

[PR #28](https://github.com/mojomanyana/bookie-pi-skills/pull/28) **MERGED** at `2026-10-10T00:12:09Z`, integration SHA **`4774ce18f47a5e979ab1d09365a2b2377af26458`**. Reviewed/passing PR head **`71db3eada4536bedfd13ef55a0845b326e2fe43c`** passed [PR CI run 38007910104](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/38007910104), conclusion **success**. [Merged-main CI run 38008015017](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/38008015017) concluded **success** on the exact integration SHA; job **114081217750** passed `npm ci` and full `npm run check`. These are definitive live facts supplied by coordinator, not a new builder remote lookup. All existing open PRs are now none at that observation; no tag or package publication is claimed.

Commits `7fc28cc` (retrieval foundations), `786ebea` (BK-025 refactor), `757cb19` (immutable retrieval runtime) and `71db3ea` (documentation closeout) merged together. Independent integrated runtime and documentation reviews are **APPROVE**; coordinator confirmed all native outcomes settled. The collective whole-baseline semantic review covered all 12,835 patch lines; strict projection configuration, optional dependency precedence and redundant hash-test findings are resolved, and the descendant-alias repair is approved. Earlier unmerged/review-pending evidence entries remain historical snapshots, not current delivery status.

Docs-only delivery reconciliation merged in [PR #29](https://github.com/mojomanyana/bookie-pi-skills/pull/29) at `2026-10-10T00:25:56Z` as **`e016f214e380014dd94643d34d8421508bdc606e`**. Its [PR CI run 38008861767](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/38008861767) and [merged-main CI run 38009021934](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/38009021934) both succeeded. At that verified closeout snapshot, local `main` was clean and synchronized with `origin/main` (0 behind / 0 ahead), with no open PRs. These are dated delivery facts, not a prediction of later documentation commits. **BK-025 is Done**; **BK-017 remains Ready/partial** and **SPEC-004 In progress**.

## Verification

Fresh docs-only reconciliation check: Node **v24.19.0** `npm run check`, **exit 0: 842 passed / 0 failed / 0 skipped** (461 repository, 95 service, 10 CLI, 255 core, 21 Pi). No runtime/test changes or new tests. This matches the inherited final approved full check; successful exact-integration merged-main CI is recorded above.

Final runtime qualification: `npm run test:runtime --workspace @bookie/service`, **exit 0, 1 passed / 0 failed / 0 skipped**. Final deployment qualification: `npm run test:deployment --workspace @bookie/service`, **exit 0, 10 passed / 0 failed / 0 skipped**. Closest suites: **exit 0, 77 passed / 0 failed / 0 skipped**. These are inherited final approved runtime results, not Docker reruns during documentation reconciliation. Four independent clean builds reproduced runtime digest `sha256:c41e3efd0ed3f9476122364b2664462f710b9df1579f1f4c2eff24ebf0d9066f` and packaging-input digest `sha256:efbb4ebc3708596abba169053b9705f0025503e9782cb7022af83d433e249523`; old digests/totals remain historical. Docker worked for those runtime/deployment suites. Real Redis was **not rerun**; production distribution/Compose and scale are not qualified. See [BK-017 delivery evidence](evidence/BK-017.md#post-merge-delivery-reconciliation--2026-10-10-utc) and [BK-025 delivery evidence](evidence/BK-025.md#post-merge-delivery-reconciliation--2026-10-10-utc).

## Next accepted work and boundaries

Canonical core, read/query CLI and approved Pi write/checkpoint workflows are available. The merged HTTP contract, projection, fenced candidate storage, ingestion, source guards/preflight, recipes, inventory, output descriptors and qualified immutable local runtime are prerequisites, not integrated shared retrieval.

BK-017 remains the accepted feature item; the current safety-priority exception above governs next work. Implement trusted authorized preflight provenance and deployment-owned expected identity loading, then independent builder claimed-recipe and exact canonical-output comparison **before any recipe/controller use**. Next come fenced absent-output claims/attachment and bounded controller ownership/capacity/disconnect/unknown-outcome handling; then Redis search/citations/evaluation/activation/rollback, production distribution/Compose and initial-scale qualification. Preserve existing guards and legacy primitives until replacements have acceptance evidence. BK-018/BK-020 remain blocked; no embedding/provider or destination work is activated.

OQ-007 data-owner/security approval remains due before real non-public indexing; OQ-001 license before public distribution/external contribution; OQ-006 provider choice before BK-019 smoke testing. Principal package-version-label metadata discrepancy remains an unresolved coordinator follow-up, not a new guessed definition or runtime defect. Historical dependency-advisory triage remains separate; no dependency refresh/audit occurred. Trusted host/mount administration and invisible-alias limits, plus ADR-0011's no-external-consumer compatibility assumption, remain unchanged.

Read [README](../../README.md), [AGENTS](../../AGENTS.md), [backlog](backlog.md), [requirements](../product/requirements.md), [open questions](open-questions.md), [SPEC-004](../specs/004-retrieval-service.md) and its cited ADRs before feature work.

## Historical clean-main resume commands

The documentation delivery gate is closed; no commit/PR decision remains for the recorded PR #28/#29 work. Inspect the live checkout rather than assuming this snapshot is still current. Resume from main only with a clean worktree:

```bash
git switch main
git pull --ff-only origin main
git status --short --untracked-files=all
nvm use
npm run check
```

Before starting BK-017 feature work, create a new feature branch from synchronized main and follow the required reading and test-first acceptance gates. Merging prerequisites does not complete BK-017, authorize recipe/controller use, unblock dependents or qualify production retrieval. Historical evidence entries naming dirty paths or temporary branches describe their own earlier handoffs, not current checkout state.
