# Next-session handoff — 2026-10-29 UTC

## Latest delivery checkpoint — PR open, CI passed

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
