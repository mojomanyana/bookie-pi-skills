# BK-017 / ADR-0011 isolated source-preflight increment

## Authority, scope, and preservation

**Local/uncommitted/unmerged; BK-017 stays Ready/partial.** Continues the workflow trial in a separately measured increment beginning with “ok go next” at `2026-09-16T22:28:17.019Z`. Earlier source-manifest/design/approval work is not counted in this increment.

Authority: product requirements, accepted ADR-0010/ADR-0011, SPEC-004. Scope was stated before coding: isolate deployment-checked source metadata under a seven-second ceiling, preserve the full guard and teardown behavior, and expose no corpus result. Recipes/artifact identity, Redis claims, global admission/capacity, controller/HTTP, full validation and activation, and initial-scale qualification remain deferred. This is the preflight prerequisite within the next accepted BK-017 work, not a reordered dependent backlog item.

Astra is the sole writer; Sol/high independently reviewed read-only after implementation. Shared skills/defaults are untouched. All **42 inherited paths** were copied to `/tmp/bookie-preflight-baseline-rjnsrhi8`; trial metadata/timestamps are in `/tmp/bookie-preflight-trial.json`. Nothing was reset, stashed, committed, pushed, or merged.

## Behavior and files

- New `apps/service/src/source-preflight.ts`: strict deployment/request snapshot; independent 1–7,000 ms request deadline; private source receipt validation and restored freezing across IPC; static failures. It does not grant provider/corpus permission or create a recipe/build/job.
- New `apps/service/src/ingestion-isolation.ts`: extracted the existing process-group/IPC/deadline/one-second-teardown mechanism for two real callers. Existing ingestion still uses the same transport semantics, static errors, child program, and legacy projection identity.
- `apps/service/src/ingestion.ts` re-exports `preflightDeploymentSource` and delegates its existing transport. `ingestion-process.ts` adds a mandatory-guard metadata mode: guard, approved exact manifest, class-declaration membership, repeated equal boundary fingerprint, then metadata only. There is no unguarded preflight mode.
- New `apps/service/test/preflight.test.mjs`: six tests covering immutable snapshots/IPC/options, independent deadline bounds, malformed and mismatched receipts, SHA-256/root scope, manifest declarations beyond the 64 approved-class limit, static failures, and writable-host rejection.
- Existing ingestion fault, blocked-descendant cancellation/deadline, and unconfirmed/late-close tests now exercise both entry points. The Docker deployment matrix also exercises both modes; missing corpus content proves preflight does not require/read it, and a synchronized configuration edit discards a receipt.
- README, service/core documentation, INDEX, SPEC-004, backlog and main BK-017 evidence track the local boundary and remaining gates. No core runtime, v1 schema, Redis code, provider, Pi extension, or shared skill changes.

## Test-first and validation evidence

- Baseline: `node --test apps/service/test/ingestion*.test.mjs apps/service/test/deployment.test.mjs`, **11 passed / 0 failed / 0 skipped**.
- Red: the new preflight test failed because `ingestion.js` did not export `preflightDeploymentSource`, before production changes.
- First build exposed an IPC parameter typing error; fixed from `unknown` to a readonly record matching the actual internal payload. Targeted build and tests then passed: **17 passed / 0 failed / 0 skipped**.
- First Docker run: **6 passed / 2 failed** (one fixture setup failure plus its parent). The positive missing-corpus preflight and policy checks had passed, but the fixture then tried to create another Git commit while its deliberately removed blob was still absent. Restored that blob only after the no-read assertions, before constructing the next malformed-manifest commit.
- Recheck: **8 passed / 0 failed / 0 skipped**, **42,404.467 ms**, all Docker deployment subtests. An intended name-filtered repair check actually selected the entire parent suite. No further Docker repeat is needed merely for bookkeeping. Synthetic fixture only: digest-pinned Node 24.19.0/Git image, no network or ports, owned disposable containers, readonly source/dependencies, bounded resources; negative cases intentionally relax one constraint. This is not production image or initial-scale qualification.
- Final Node `v24.19.0` `npm run check`: **exit 0, 802 passed / 0 failed / 0 skipped**, formatting/lint/typecheck passed; **115.05 seconds**. Breakdown: 470 repository + 46 service + 10 CLI + 254 core + 22 Pi. Completed inside the `22:54:31Z`–`22:56:27Z` repair/check window; `/tmp/bookie-preflight-check.log` and `.time` retain the final result. Its initial attempt stopped at a formatting warning in the repaired Docker fixture; formatting-only correction followed, with no production-code repair.
- Sol/high independently ran the compiled targeted command: **17 passed / 0 failed / 0 skipped**, **9,248.589 ms**. **Specification APPROVE; quality APPROVE; overall UNVERIFIED**, because no verified candidate-tree receipt was supplied. Findings: **none**. The shared transport was retained as a justified two-caller boundary centralizing cancellation/teardown. No edits, builds, Docker, further delegation, or full-check reruns by Sol. Review covers implementation before the subsequent formatting-only test change and evidence closeout; it is not merge or production approval.

## Workflow measurements

Definitions retained from the [first increment](BK-017-adr0011-source-manifest-trial.md): clarification turns resolve material choices; working-window wall time includes tools/tests/review, separately from waiting for the user. Hands-on/model CPU time is not observable. Planned test-first red evidence is not avoidable rework.

- Clarification turns: **0**; waiting for user during this increment: **0 seconds**. Earlier gaps between user requests are excluded.
- Avoidable rework so far: **3 events in 2 repair episodes**: R1 IPC typing error; R2 missing-blob fixture setup error; R3 ineffective test filter within R2. The filter error reran the full Docker suite instead of only the intended case.
- The prior proposed experiment was exercised: timestamps bracket two repair windows. R1: `22:39:07.749219Z`–`22:39:31.123638Z`, **23.374419 seconds**. R2 (including R3): `22:41:40.876966Z`–`22:42:38.552286Z`, **57.675320 seconds**. Total instrumented repair-window time: **81.049739 seconds**, including verification. These are not complete end-to-end rework time: the preceding failed check and diagnosis before the start marker are excluded; separate R3 duration and hands-on time are unknown. Do not double-count R3.
- R4: full check found the Docker fixture's repair had not been reformatted. This is a fourth avoidable event in a third repair episode. Window `22:54:31.386872Z`–`22:56:26.993062Z`: **115.606190 seconds**, including the required full regression check. Total instrumented windows: **196.655929 seconds**. That total is not pure wasted time or hands-on time: verification is included, diagnosis before markers is excluded, and R3 overlaps R2.
- At `2026-09-16T22:57:36.441407Z`, working-window wall time was **1,759.422407 seconds (29 minutes 19.422407 seconds)**, including tools/tests/review, versus **0 seconds waiting for the user**. Later evidence closeout is excluded from that snapshot; separate hands-on time remains unknown.
- Parent usage snapshot: **224,646 input / 39,417 output / 3,222,528 cache-read / 0 cache-write**, **3,486,591 total tokens**, provider-estimated **$7.439838**, excluding later closeout and child usage. Sol's rounded footer: **98k input / 9.2k output / 945k cache-read**, estimated **$1.241**. These are estimates, not billing receipts; separate Sol wall time is unavailable from the parallel result.
- No user intervention, parallel writer, duplicate delegated build, or shared-skill/default change. One increment is not a model comparison or proof of workflow improvement. The timing experiment produced usable window measurements but not complete rework attribution. Proposed next experiment: format the changed test files immediately before launching the review/full-check pair, and record whether another formatting-only full-check restart occurs; do not alter defaults from this observation.

## Handoff and current worktree

Source additions/changes are the four service modules above; test additions/changes are the new preflight test and the three expanded ingestion/deployment tests. Documentation records capabilities, how to try them, current local status and remaining gates. All 42 inherited paths remain present and only intended files differ from the baseline. Four new files bring the uncommitted inventory to **46 paths**, fully listed in [main BK-017 evidence](BK-017.md).

Branch `bk-017-redis-projection`, no upstream; HEAD/base `a91c82c18f7c4fcce6b4d818ed2b8c47f960bee6`; local `main...HEAD` divergence **0 0**. No commit/push/PR/merge. `git diff --check` passed at the usage checkpoint and no owned `bookie-deployment-*` container remained. No requirement/ADR drift or unrelated defect was found. Full delivery remains blocked on the gates below, not on a new design-approval request.

### Final closeout checkpoint

At `2026-09-16T23:00:18Z`, elapsed turnaround/working-window time was **1,920.981 seconds (32 minutes 0.981 seconds)**, including tools/tests/review/documentation. Assistant-blocked waiting for user input was **0 seconds**; the user's actual attentive waiting time is unobservable and is not claimed to be zero. Separate hands-on time remains unknown. This checkpoint excludes the final evidence annotation and response.

Final `npm run test:repo`: **exit 0, 470 passed / 0 failed / 0 skipped**; `git diff --check` clean. The complete **46-path** inventory exactly matched Git status; all **42 inherited paths** remained present. Log `/tmp/bookie-preflight-closeout.log`. These documentation checks do not upgrade the independent review to verified-tree/merge assurance.

## Remaining gates

The future controller must authorize before lookup, own the single preflight permit, reserve teardown/Redis time inside the ten-second budget, and quarantine on uncertain teardown. The primitive does not implement those duties. Next accepted BK-017 work: versioned input/artifact recipes, then phase-aware Redis claim/attachment and controller admission/capacity. Full validation/output verification, serving/search/evaluation/activation, production packaging/configuration, and scale gates remain. OQ-007 still blocks real non-public indexing without data-owner approval; BK-018/BK-020 remain blocked pending BK-017 merge/evidence.
