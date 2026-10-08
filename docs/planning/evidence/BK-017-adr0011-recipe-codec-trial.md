# BK-017 / ADR-0011 version-2 recipe codec increment

## Scope and authority

**Local/uncommitted/unmerged; BK-017 remains Ready/partial.** This separately measured trial increment begins at the user's “go next” request, `2026-09-17T11:22:00.393Z`. Earlier work and the gap between requests are excluded.

Authority: requirements, accepted ADR-0010/ADR-0011, SPEC-004. Scope and acceptance checks were stated before coding. This implements the explicit v2 input/policy/scope encoding and golden-vector prerequisite only. It does **not** implement or attest runtime-artifact generation, assemble authorized deployment inputs, migrate existing IDs, claim a build, write Redis, or expose HTTP. A syntactically valid supplied digest is not evidence of a real runtime artifact. No caller uses this codec in admission or ingestion; those paths must remain disconnected until artifact and integration gates pass.

Astra is the sole writer; Sol/high independently reviewed the implementation and rechecked the accepted repair read-only, as recorded below. All 46 inherited paths were copied to `/tmp/bookie-recipe-baseline-4djuj2e0`; measurements are in `/tmp/bookie-recipe-trial.json`. No reset/stash/commit/push or shared-skill/default change.

## Implementation and tests

- New `apps/service/src/build-recipe.ts`: pure `encodeBuildInputRecipe`, explicit domain/version/ordered UTF-8 JSON tuples, mandatory detection policy/version and null lexical provider/generation, bounded data-only inputs, static `TypeError`, frozen string-only result. Scope and policy hashes are independent. The private serialization contains UID/manifest identity and must not become a log/HTTP/control-record field.
- New `apps/service/test/fixtures/build-recipe-v2.json`: two literal golden vectors. Python standard-library compact `json.dumps(ensure_ascii=False)` and `hashlib.sha256` independently calculated the expected bytes/hashes before the TypeScript codec existed; tests do not regenerate expectations using the codec. Fixture artifact hashes and version labels are explicitly synthetic, not deployment claims.
- New `apps/service/test/build-recipe.test.mjs`: nine initial tests plus one review regression for golden intermediate/final hashes, both Git formats, root and Unicode/quoted scope, empty approval, insertion/class-order invariance, immutability, every supported varying identity input, rejection of operational/authorization/output extras, missing fields/defaults, malformed values, lexical-only policy, byte/segment/depth limits, and accessor/serialization-hook rejection. An external temporary TypeScript consumer compiles without ambient Node types and verifies readonly/lexical declarations.
- SPEC-004 records the exact tuple order and limits before production implementation. No accepted ADR, requirement, canonical format, existing projection version/ID, core runtime, preflight, Redis, provider, or Pi behavior changes.

### Observed verification

- Baseline: `node --test apps/service/test/projection.test.mjs apps/service/test/preflight.test.mjs` — **20 passed / 0 failed / 0 skipped**.
- Red: `node --test apps/service/test/build-recipe.test.mjs` failed with missing `dist/build-recipe.js`, before implementation. The initial eight behavior tests preceded production code; the external consumer characterization was added after the first green codec run and before full verification.
- `npx tsc -b apps/service` and the first eight codec tests passed; lint passed.
- Early consumer/targeted check after formatting: **9 passed / 0 failed / 0 skipped**, **603.539 ms**; consumer compilation **510.619 ms**. Exact 4,096-byte scope acceptance and 4,097-byte rejection are covered alongside Unicode byte boundaries.
- Initial full check passed **811 tests / 0 failures / 0 skips**, but this did not close the independent review gate. Sol/high ran **29 targeted tests / 0 failures / 0 skips** (**9,165.942 ms**), independently recomputed both golden vectors using Python, and confirmed no runtime imports. Specification and quality verdicts were **CHANGES-REQUESTED** for `REV-SPEC-001`: array length was observed repeatedly, allowing a changing-length proxy to supply 65 classes after passing the 64 bound; named/accessor/symbol array extras were ignored. Astra accepted this concrete finding; no user clarification was needed.
- Repair red: the new `REV-SPEC-001` regression failed with `Missing expected exception (TypeError)` on array extras before the repair. Sol had separately reproduced the 65-class proxy acceptance. The fix rejects proxies before reflective/property access, bounds native array length, captures descriptors once, checks a closed contiguous key set, and consumes only the snapshot. All golden vectors remain unchanged.
- Repair green: `npx tsc -b apps/service && node --test apps/service/test/build-recipe.test.mjs`, **10 passed / 0 failed / 0 skipped**, including the external consumer and proxy/extra-property regression. The final full check and independent repair recheck subsequently passed as recorded below. No Docker run is needed for this pure disconnected codec; the parent owns the full check and reviewers must not duplicate builds/Docker.

## Workflow observations

Definitions continue from the previous increments: count material-choice clarification turns; separate assistant-blocked waiting for user input from elapsed turnaround; working-window time includes tools/tests/review. User attention and model hands-on/CPU time remain unobservable.

- Clarification turns so far: **0**. Waiting for user input: **0 seconds**. Actual human attentive waiting is unknown.
- Avoidable rework: **1 event / 1 repair episode**, accepted `REV-SPEC-001`. Window `2026-09-17T11:41:08.642698Z`–`11:42:21.765053Z`: **73.122355 seconds**, including regression creation, observed red, implementation repair, formatting, compile and targeted green. Review/probe time before the marker and final full/review rechecks are outside this window; total hands-on or complete rework duration is unknown. Planned missing-module red evidence is not rework.
- The prior proposed experiment was exercised: changed code/tests/JSON fixtures were formatted before both review/full-check pairs. Neither full check required a formatting-only restart. This observation does not prove causation or justify changing defaults.
- No parallel writer, duplicate delegated build, shared-skill/default change, or model comparison. The second full check is necessary verification after the accepted repair, not a parallel duplicate.
- At `2026-09-17T11:47:13.761955Z`, elapsed turnaround/working-window time was **1,513.368955 seconds (25 minutes 13.368955 seconds)** including tools/tests/review. User-input waiting was **0 seconds**; user attention and separate hands-on time remain unknown. Later evidence closeout is excluded from this snapshot.
- Parent usage snapshot: **480,044 input / 33,628 output / 4,424,960 cache-read / 0 cache-write**, **4,938,632 total tokens**, estimated **$10.9068**, excluding child usage and later closeout. Sol rounded footers: first review **73k input / 9.5k output / 307k cache-read**, estimated **$0.805**; repair recheck **38k input / 3.0k output / 83k cache-read**, estimated **$0.319**. These are provider estimates, not billing receipts; separate child wall times are unavailable from the parallel results.

## Final verification and handoff

- Node `v24.19.0`, `npm run check`: **exit 0, 812 passed / 0 failed / 0 skipped**, with formatting/lint/typecheck passed; **119.24 seconds**, completed `2026-09-17T11:45:55Z`. Breakdown: 470 repository + 56 service + 10 CLI + 254 core + 22 Pi. Logs `/tmp/bookie-recipe-final-check.log` and `.time`. No Docker run; existing runtime files are byte-identical to the preserved baseline.
- Independent **Sol/high** repair recheck: **10 passed / 0 failed / 0 skipped**, **621.489 ms**. `REV-SPEC-001` **RESOLVED**; specification and quality **APPROVE**, overall **UNVERIFIED** because no verified candidate-tree receipt was supplied. No new material findings in the bounded repair scope. This closes the code finding, not merge/production/artifact-attestation gates. No code changes followed that recheck.
- The codec has no active runtime importer. Golden bytes/hashes remain unchanged after the repair. No outstanding requirements/ADR conflict was found; the implementation's closed-input mismatch was repaired rather than weakening the specification.
- All 46 inherited paths remain present. New files are the codec, test, golden JSON and this record; the complete **50-path uncommitted inventory** is in [main BK-017 evidence](BK-017.md). Other changes are README, service README, INDEX, backlog, SPEC-004 and the main evidence. No existing runtime file changed.
- Branch `bk-017-redis-projection`, no upstream; HEAD/base `a91c82c18f7c4fcce6b4d818ed2b8c47f960bee6`; local `main...HEAD` divergence **0 0**. No commit/push/PR/merge. `git diff --check` passed at the usage checkpoint.
- Next proposed workflow experiment: add the documented collection-shape failure cases to the initial test matrix before a future bounded codec implementation, then count review-discovered validation gaps. This is a hypothesis, not a model/default change.

### Closeout checkpoint

At `2026-09-17T11:50:00Z`, elapsed turnaround/working-window time was **1,679.607 seconds (27 minutes 59.607 seconds)** including tests/review/documentation; blocked waiting for user input remained **0 seconds**, while actual attentive waiting and separate hands-on time remain unknown. This excludes the final annotation/response. Final `npm run test:repo`: **exit 0, 470 passed / 0 failed / 0 skipped**; `git diff --check` clean. The exact **50-path** inventory matched Git status and all **46 inherited paths** were preserved. Log `/tmp/bookie-recipe-closeout.log`. No verified-tree/merge assurance is inferred from these checks.

## Remaining gates

Next accepted work remains BK-017: reproducible runtime-artifact generation/verification with pinned Node/runtime profile and resolved runtime dependencies, then trusted recipe assembly and builder comparison, absent-output Redis claim/attachment, and controller-owned admission/capacity. Output hashes/counts remain mandatory verification evidence. Legacy IDs are untouched; no aliasing/relabeling or production placeholder digest is permitted. OQ-007 still requires separate data-owner approval; BK-018/BK-020 remain blocked until BK-017 is merged and evidenced.
