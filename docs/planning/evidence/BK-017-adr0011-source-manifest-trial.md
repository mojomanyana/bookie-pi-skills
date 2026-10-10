# BK-017 / ADR-0011 source-manifest implementation trial

## Scope and trial boundary

**Locally verified; uncommitted/unmerged; BK-017 remains Ready/partial.** Trial starts with the user's implementation request at `2026-09-16T20:18:05.869Z`, not the earlier design or approval work. The prior approval-recording check (788 tests, ending `20:18:05Z`) is explicitly outside the trial. No earlier work is retroactively described as trial-compliant.

Accepted authority: ADR-0011, SPEC-004, and the existing canonical/core constraints. Before coding, the user was told this slice enables portable approved-history/exact-manifest metadata without corpus reads; build recipes/artifact digests, service isolation/admission, Redis lifecycle/controller/HTTP, and scale qualification remain deferred. The acceptance checks stated then cover both Git object formats/nested scope, exact bytes, malformed/unsafe/oversized/missing/mismatched manifests, cancellation/snapshots, absence of corpus reads, public declaration portability, full regression, and independent Sol review.

Astra is the sole writer. Sol received a combined independent read-only review after implementation, with compiled targeted tests permitted but no edits/builds/Docker. This is behavioral read-only scope, not a claimed OS sandbox. Shared skills are untouched.

Baseline preserves all 39 inherited uncommitted paths, copied for scoped review to `/tmp/bookie-adr11-trial-baseline-lt5q894n`; metadata is in `/tmp/bookie-adr11-trial.json`. No reset/stash/commit/push occurs. The source facade is new; only a targeted helper is added to the inherited Git module, and the core index exports the new explicitly typed API.

## Implementation and verification log

- Trial baseline: compiled `approved-git-source.test.mjs`, **7 passed / 0 failed**.
- Red: new manifest test file failed because `readApprovedSourceManifest` was not exported, before implementation.
- Added `packages/core/src/approved-source-manifest.ts`, a targeted `readLocalGitCommitManifest` in `vault-git-base.ts`, core exports, and eight new tests in `approved-source-manifest.test.mjs`.
- Metadata lookup uses existing bounded sanitized local Git plumbing, one non-recursive literal manifest path selection, and a size/hash-verified blob. Strict UTF-8/YAML/schema/UID checks run before returning frozen metadata. No complete-vault validity, counts, raw text, indexing permission, or mount proof is claimed.
- Red: a relative-root request changed meaning after `process.chdir()` during asynchronous approval; fixed by resolving root interpretation before the first await. URL/request mutation is independently covered.
- Latest targeted run: **15 passed / 0 failed** (8 new manifest + 7 existing approved-history tests). Early consumer/declaration probe: **2 passed / 0 failed** using existing nominal-loader and public-declaration tests. Lint passed. Full check and Sol review subsequently completed as recorded below.

## Trial measurements

Count clarification turns as assistant questions needed to resolve a material choice and the user's replies to them. Count avoidable rework as repairs/reruns attributable to controllable mistakes, not planned test-first red evidence or new requirements. Track working-window wall time separately from time waiting for the user. Working-window time includes tool/test/review waits; model CPU/hands-on time is not observable here and must not be invented.

- Clarification turns so far: **0**. No material-choice question has been needed.
- Waiting for user during this trial so far: **0 seconds**. Earlier approval waiting is excluded.
- Avoidable-rework observations so far: **5 events**: an initially assumed extra fixture sensitivity class (corrected before the first green run); a test treating `cat-file commit` as a Git commit write; one malformed edit-tool invocation (no write); an ineffective first CWD-change fixture whose relative path still resolved to the same `/tmp` target; and the implementation's initially uncaptured relative-root interpretation. The last two are separate test-quality and implementation defects in one repair episode. Total episode count is **4** when those are grouped. Attribution is explicit; no exact rework duration was instrumented, so it is **unknown**.
- Closeout added one more avoidable event/episode: an ambiguous exact-text replacement in the cumulative evidence file was rejected without writes and then targeted uniquely. Final count: **6 events in 5 episodes**. This bookkeeping mistake is counted in the trial, unlike the similar approval-recording mistake before the trial began.
- No duplicate full builds or Docker runs have been delegated. Core-only builds after edits are ordinary test-first iteration, not counted as avoidable by themselves.
- At `2026-09-16T20:35:27.413999Z`, working-window elapsed time was **1,041.545 seconds (17 minutes 21.545 seconds)**, including tools/tests/review; waiting for user was **0 seconds**. This snapshot excludes later documentation closeout. Separate hands-on/model-CPU time and exact avoidable-rework duration are **unknown**, not silently included as measured active work.
- Parent usage at that snapshot: **315,449 input / 23,994 output / 6,640,640 cache-read / 0 cache-write**, **6,980,083 total tokens**, provider-estimated **$10.99483**, excluding later closeout and child usage. Sol's rounded footer: **87k input / 7.9k output / 350k cache-read**, estimated **$0.847**. These are estimates, not billing receipts. Separate Sol wall time is unavailable from the parallel-call result.
- No model superiority or workflow improvement is inferred from this single trial. The early declaration check passed and no late declaration failure occurred; there is no counterfactual proving avoided reruns.

## Final validation and independent review

- Node `v24.19.0`, `PATH=/home/neman/.nvm/versions/node/v24.19.0/bin:$PATH npm run check`: **exit 0, 796 passed / 0 failed / 0 skipped**; formatting, lint, and typecheck passed. Breakdown: 470 repository, 40 service, 10 CLI, 254 core, 22 Pi. Ran `2026-09-16T20:31:04Z`–`20:33:19Z`; log `/tmp/bookie-source-manifest-check.log`, timing `/tmp/bookie-source-manifest-check.time`. This is regression evidence, not the deferred service-preflight performance qualification. No Docker suite was needed for this core-only slice.
- **Sol/high** independently compared the scoped code against the preserved trial baseline, inspected compiled/public declarations, and ran the 15 compiled targeted tests: **15 passed / 0 failed / 0 skipped**, **2,461.165 ms**. No edits, builds, Docker, or further delegation. **Specification APPROVE; quality APPROVE; overall UNVERIFIED** because no verified candidate-tree receipt was supplied. Findings: **none**. This is an independent read-only code review, not merge approval or a verified-tree claim. No post-review code repairs were needed.
- Astra self-review confirmed no public private-type leakage, no legacy API change, no corpus read/output claims, and no unsafe weakening of full-validation/mount/activation boundaries. All 39 inherited paths remain present; a byte comparison with the baseline identified only the intended trial changes. `git diff --check` passed at `20:35:27Z`.

### Closeout checkpoint

At `2026-09-16T20:40:11Z`, working-window elapsed time was **1,325.131 seconds (22 minutes 5.131 seconds)**, including tools, tests, review, and documentation; waiting for user remained **0 seconds**. Final repository/documentation check: `npm run test:repo`, **exit 0, 470 passed / 0 failed / 0 skipped**; `git diff --check` clean. The exact 42-path inventory matched Git status and all inherited paths were preserved. Log: `/tmp/bookie-source-manifest-closeout.log`. These measurements exclude this final evidence annotation and response; separate hands-on and rework durations remain unknown.

## Handoff

New files: `packages/core/src/approved-source-manifest.ts`, `packages/core/test/approved-source-manifest.test.mjs`, and this trial record. Modified inherited files: `packages/core/src/vault-git-base.ts`, `packages/core/src/index.ts`, `packages/core/README.md`, `README.md`, `docs/specs/002-core-and-cli.md`, `docs/specs/004-retrieval-service.md`, `docs/planning/backlog.md`, and the linked main BK-017 evidence during closeout. The complete **42-path uncommitted set**, comprising 39 inherited and three new paths, is listed in [BK-017 evidence](BK-017.md).

Branch `bk-017-redis-projection`; HEAD/base `a91c82c18f7c4fcce6b4d818ed2b8c47f960bee6`; no upstream; local `main...HEAD` divergence `0 0`. No repository commit, push, PR, or merge was made. Approval recording and earlier work remain outside the trial. No unresolved material choice required another user question.

Next accepted item remains BK-017: versioned input/artifact recipes and the isolated deployment-checked service preflight, then the new Redis lifecycle/controller. No dependent item advances from this local slice. Proposed next workflow experiment: record phase start/stop timestamps around one bounded repair episode to distinguish repair time from general working-window time; do not change shared skills or infer benefits before measurement.

## Remaining gates

The seven-second service preflight and total ten-second admission budget are not implemented or measured here. The service must run its existing deployment guard before Git and isolate synchronous YAML parsing. Input recipe/artifact generation, private absent-output Redis manifests and attachment, controller signals/capacity/reconciliation, Search/evaluation/activation/deployment gates remain BK-017 work. OQ-007 remains open for real non-public data; BK-018/BK-020 remain blocked until BK-017 delivery is merged and evidenced.
