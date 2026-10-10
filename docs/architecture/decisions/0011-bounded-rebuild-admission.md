# ADR-0011: Admit input-identified rebuilds before full ingestion

- **Status:** Accepted
- **Approval:** User explicitly replied “approved” at `2026-09-16T20:11:21.320Z` to the request to approve option B, the proposed limits, and the assumption that no external consumer relies on experimental output-derived IDs. This is design approval, not implementation or deployment verification.
- **Date:** 2026-09-16
- **Decision owners:** Repository owner, service architect, and deployment owner
- **Scope:** OQ-013 and the remaining BK-017 lexical controller integration
- **Relationship:** Refines ADR-0010's build admission/state machine and initial service-wide capacity limits; supersedes SPEC-004's local output-hash-derived identity refinement for controller integration. ADR-0010 remains accepted and unchanged on disk; all its other protocol, authorization, fencing, serving, and deployment requirements remain in force.

## Context and drivers

The accepted workload is at most 50,000 concepts, 250,000 chunks, 512 MiB aggregate concept input, and 15 users on one Docker host without dedicated on-call staff. Warm retrieval targets p95 below 500 ms. ADR-0010 requires asynchronous rebuilds with a six-hour ceiling, durable duplicate convergence, one non-terminal controller per vault, two-second Redis deadlines, and accepted work surviving submission disconnect. These are requirements, not measurements achieved by the current branch.

At acceptance, the actual local primitives leave an integration seam:

- `projection-worker.ts` computes its build ID only after complete canonical export and Markdown projection, using the export's output hash.
- `RedisCandidateStore.claim()` requires final concept/chunk counts and creates both job and candidate with them. Its current contract requires a fully validated projection before claim.
- Deployment-checked ingestion includes a Git metadata walk of up to 100,000 entries and complete source validation. It is not a cheap submission preflight.
- `server.ts` has no rebuild route/controller. The strict v1 schemas already require a definitive `build_id` in rebuild and status responses; they expose neither counts nor output hashes.

A six-hour ingestion cannot be hidden inside a prompt submission path. Conversely, creating a job is not permission to persist unvalidated concept content. We need a durable control record before expensive work without weakening the policy boundary.

## Options

| Option | Fit to drivers | Cost / reason to reject |
| --- | --- | --- |
| A. Complete projection, then use the current claim unchanged | Simplest reuse; preserves output-addressed local IDs and final-count manifests | Submission scales with full validation/parsing of up to 512 MiB; interruption before claim has no durable job. No initial-scale evidence establishes a short admission bound. A deadline alone is not evidence of supporting the required corpus. |
| B. Definitive input ID; claim without output; attach validated output once | Separates bounded source approval from six-hour ingestion; retains one immutable ID, existing wire shape, and fenced ownership | Requires an exact input recipe, implementation-version discipline, a bounded source preflight, and changes to internal claim/manifest semantics. ID no longer commits to output bytes. |
| C. Durable provisional job, later final output-addressed build ID | Preserves final output addressing and permits immediate job creation | Introduces aliases/two identities across retries, cancellation, activation, and status. Missing, provisional, or changing `build_id` is a v1 semantic/schema change; requires a separately accepted v2 design. |

**Decision: B.** Keep output integrity evidence, not synchronous output computation, as the price of admission. Reconsider A only if representative maximum-scale measurements put complete preparation inside the entire accepted admission budget while preserving retrieval p95 and cancellation bounds. Choose C only if a real consumer requires public content-addressed output identity before using a build; accept a v2 migration first. Do not add a queue service or distributed scheduler at the one-host scale.

## Accepted contract

This section is normative for implementation under BK-017. Acceptance does not claim that the current local primitives implement it or that production behavior is verified.

### 1. Immutable identity names a recipe, not produced bytes

Use `bld_` plus SHA-256 over a domain-separated, versioned, explicitly ordered UTF-8 JSON tuple. The new domain is `bookie-build-inputs`, recipe version `2`; implementation must publish golden serialization vectors before use. No locale ordering, implicit defaults, timestamps, or mutable object references enter the encoding.

Identity inputs are:

1. Expected canonical vault UID, checked against the exact-commit manifest.
2. Full source commit object ID, with Git object format made explicit.
3. A scope digest of the normalized repository-relative vault directory (empty string for repository root). The commit binds its tree contents. This distinguishes two vault directories with identical manifest/UID bytes in the same commit; a UID alone is not a path selector.
4. Profile and exact manifest byte hash.
5. Normalized deployment sensitivity/provider policy hash, including mandatory secret detection and its policy version. Exclusions remain bound through the manifest hash. Sorted approved classes are order-independent.
6. Projection schema, parser, chunker, and preprocessing versions; chunk byte size; canonical export format version.
7. A reproducible SHA-256 implementation-artifact digest covering the core/service ingestion, policy, and projection runtime and resolved runtime dependencies. No developer-entered placeholder or Git branch label substitutes for this digest. Packaging must pin the Node/runtime profile it depends on; different supported runtime artifacts receive distinct digests. The digest/serialization recipe is a testable implementation prerequisite.
8. Embedding-generation identity, explicitly null for BK-017 lexical work.

The repository-relative scope is hashed privately; it is not a new public response/log field. Do not include an absolute host path, inode, remote URL, repository clone location, namespace HMAC key, request/job ID, owner/fence/configuration epoch, approved-ref tip/name, rollback window, timeout, or operational count ceiling in immutable identity. Identical approved Git data and runtime artifacts remain reproducible across equivalent clones. Full commit identity plus vault scope and UID bind the logical source; adding a host-specific repository identity would damage portability without adding authorization.

Approval inputs/epochs remain authorization and freshness checks outside the recipe, as in ADR-0010. Effective sensitivity/secret/provider policy **does** affect identity. Admission/resource limits cannot truncate or change successful output; exceeding one fails the attempt. If a future setting changes output, it must enter a versioned recipe.

The canonical JSONL output hash is no longer an ID input. It remains mandatory verification evidence alongside hashes of the actual projected concept/chunk streams. This is an intentional change from the current local SPEC-004 slice, not an assertion that the old algorithm already does this.

### 2. Bounded admission before any expensive corpus preparation

Accepted additional limits: ten seconds total for rebuild submission, one service-wide preflight at a time, and one service-wide full builder at a time. They are conservative initial capacity settings, not benchmark results. One bounded preflight may coexist with the single builder so duplicates can be reauthorized during a build. No unbounded wait queue is introduced. The existing per-vault controller and per-admin-vault rate limits remain.

The ten-second budget includes authentication, source checks, process teardown, capacity reservation, and Redis claim. Cap the preflight subprocess at seven seconds, reserve its existing one-second teardown allowance, and clamp each Redis operation to the lesser of two seconds and remaining request time. Do not start a phase when its remaining budget is exhausted. A completed response is subject to ordinary scheduler/network delays; these are cancellation bounds, not a hard-real-time promise.

Admission order:

1. Authenticate, authorize the configured vault handle, apply rate limits, and snapshot immutable source/runtime/policy configuration and its current authorization epoch. No unauthorized Git/Redis lookup.
2. Acquire the bounded preflight permit or return static retryable `RATE_LIMITED`. Before any Git operation, run the existing supported read-only mount/ancestor/Git metadata/config guard. Retain its full checks initially; its walk is not magically constant-time. Repeat its boundary checks before accepting the preflight receipt.
3. In that isolated, cancellable preflight, prove exact approved history with the existing literal-ref rule, resolve the vault's repository-relative scope, and read/validate only the exact manifest and its expected UID/profile/policy declarations through bounded hardened Git/core APIs. Reuse the core manifest byte/YAML limits. No concept/resource scan, canonical export, Markdown projection, or provider work. This needs a new bounded core facade; the existing successful-export manifest result is not a substitute.
4. Derive the definitive input ID. Resolve the existing current job only inside the authorized namespace. A same-input live attempt returns its existing job/state after current approval checks; it does not start another worker or reserve another builder slot. A different live attempt in that vault returns `BUILD_CONFLICT`.
5. For a new attempt, reserve the single builder capacity immediately or return retryable `RATE_LIMITED`. Under the same configuration-publication interlock used for reload, atomically claim in Redis using the current server-written configuration epoch, owner epoch, build ID, and bounded input descriptor digest. A changed epoch rejects the claim. Store no canonical paths, raw manifest, concept content, excluded data, or excluded counts in the control record.
6. Return the existing v1 job/build/state response after confirmed claim. The controller owns the builder signal and reserved capacity independently of the socket. The six-hour deadline begins at durable claim, not whenever parsing eventually starts.

A read-only guard/manifest/approval timeout before claim produces no job **only if no claim was dispatched**. Once a Redis mutation has been dispatched, a disconnect or timeout is an unknown outcome, not proof of no job. Generate the attempt job ID before dispatch and retain it in controller-owned state. Reconcile with bounded reads under the same owner epoch; never blindly replay a mutation. A confirmed matching job ID/lease proves the original creation, not a new duplicate worker. If ownership/outcome cannot be resolved, quarantine that builder reservation and refuse new rebuilds until controlled recovery fences the uncertain attempt. Existing serving data is untouched. A client retry is reauthorized and converges on the same surviving live job; request disconnect never becomes explicit job cancellation.

Capacity is owned by a single active controller process, not by HTTP handlers or Redis TTL expiry. Its in-memory reservations are keyed by generated attempt ID; durable job/lease records are the recovery evidence, not a second capacity queue. Release the preflight permit after confirmed subprocess teardown. Release a new builder reservation on a proven pre-dispatch abort or a confirmed non-mutating claim rejection; a fenced creator first tears down any owned process. For an accepted job, release only after worker teardown is confirmed and a terminal transition or superseding owner fence is confirmed. A duplicate never acquires/relinquishes the original attempt's reservation. Unknown mutation or teardown outcomes remain quarantined, with bounded reconciliation attempts; exhausting them disables further rebuild admission pending supervised recovery, not an endless retry loop. Shutdown stops admission and retains reservations until teardown/fencing or process exit. A replacement process initializes all configured vault epochs, marks old jobs interrupted, and becomes ready for builds only after supervision confirms old worker groups are stopped. Redis fencing protects writes; it does not itself reclaim CPU or prove process death. Horizontal or overlapping controller instances are outside this single-process capacity design.

Preflight is not complete-vault validation, provider authorization, or activation eligibility. Full source approval and deployment checks run again in the builder. Policy reload fences descriptor attachment and subsequent writes by epoch; current approval/policy is rechecked at activation. Token revocation prevents subsequent API use but does not retroactively turn an accepted job's socket into its cancellation authority.

If the current metadata guard cannot meet the admission budget at supported initial scale, this decision's performance gate fails. Do not skip its walk, cache an unproved mount assertion, or silently narrow REQ-031. Measure first, then seek an explicit revised proof/deployment contract or budget decision. Packed and ordinary loose-object checkout layouts must be represented in that evidence.

### 3. Admit control metadata; attach validated output once

The new claim creates `queued` job/control metadata and a candidate manifest whose **output descriptor is absent**. It does not invent zero counts or mark validation complete. This requires a new internal layout/parser and lifecycle operations, not passing missing counts to today's Lua script.

The version-2 Redis hash keeps bounded input/ownership fields (`manifestVersion`, job ID, source commit, manifest/policy/recipe digests, configuration epoch, and state). `outputDescriptor` is initially absent, not an empty string, JSON null, or a zero-count descriptor. Actual append and cleanup cursors start at zero; they count writes/work already performed, not an expected output total. A present `outputDescriptor` is one bounded, strictly validated encoded object containing the fields below. Its presence is the phase discriminator. A corrupt descriptor or version mismatch fails closed; it is not interpreted as the absent phase. The attachment uses one HSET for the whole descriptor, avoiding separately published count/hash flags.

Crash-order invariant: reserve capacity before claim, confirm claim ownership before `beginBuilding`, and confirm that transition before worker launch. The originating process keeps a single-launch flag in its controller-owned attempt record, set before spawning; duplicate/reconciliation callbacks cannot launch again. A replacement process never infers whether work started from `queued` versus `building`: it advances the owner epoch and marks **every** prior-epoch non-terminal claim `failed`/`INTERRUPTED`, including queued claims with no launch evidence. It launches none of them. A crash before any claim leaves no durable attempt to recover; a dispatched but unconfirmed claim is resolved/fenced before new admission. Only after old worker teardown and startup fencing are confirmed may fresh capacity be granted. Authorized status reads expose interruption; a later explicitly submitted retry creates a new job/fence after normal cleanup.

Add an explicit fenced `beginBuilding` operation: current owner/controller/build/fence/live lease and configuration epoch are required; `queued` becomes `building`, with output still absent. Exact repeat under the same live ownership is a no-op only while already `building`; cancelling/terminal/stale ownership rejects. Launch full ingestion only after this transition is confirmed. It must not rely on `append()` to enter `building`, because appends are forbidden before attachment. The existing eight public states suffice.

The new private manifest reader/reconciliation operation validates either phase without fabricating counts. `readJob` remains phase-independent and keeps its existing public shape. Renew, cancellation, failure, and startup interruption accept either well-formed phase under their existing ownership/state rules. No projection append, index creation, verification, evaluation, completion, or activation is allowed on an absent descriptor. Absent-phase cleanup requires a terminal non-serving attempt, matching manifest ownership, zero append cursors, and the usual serving/reader protections, then deletes only its candidate metadata and matching current-job control link, preserving job status. Unexpected nonzero cursors fail closed rather than deleting guessed payloads. Payload keys cannot be created by any accepted operation in this phase; out-of-band Redis writers are not trusted participants.

The isolated builder performs the complete deployment/history/core/policy/export/projection window. Before any concept/chunk reaches Redis or any provider, it verifies the returned immutable input recipe against the claimed recipe. Only a complete successful result can call a new one-time fenced output-attachment operation.

The internal descriptor contains a format version, claimed recipe digest, canonical JSONL hash/byte length/included record count, concept and chunk counts, and SHA-256 digests of the complete ordered concept/chunk projection streams. Canonical record count must equal concept count. Encodings are versioned and covered by golden vectors; projection stream digests exclude their self-referential digest fields. Counts are included-only and within the existing limits. Zero is legitimate only after validating an empty included corpus. No raw text or excluded inventory belongs in this descriptor.

Attachment atomically checks current process/configuration epoch, controller/job/build/fence, live lease, `building` state, input recipe, and serving/reader protections. Identical attachment is an idempotent no-op only in `building` under the same still-live owner/configuration epoch and fence, for reconciliation of an uncertain attachment. Restart never resumes an old worker or grants a new fence permission to reattach an old attempt. Different attachment fails without modifying the first descriptor, and the controller fails the non-serving attempt with static `INTERNAL`. No endpoint is added. Every batch retains the current fencing checks and is bounded by the attached final counts. Verification recomputes stored projection digests/counts and requires exact agreement; a disagreement blocks completion rather than generating a different build ID.

A recipe ID alone cannot detect arbitrary runtime nondeterminism across deleted attempts. Golden repeatability tests, artifact binding, and comparison with any retained same-recipe descriptor are required; do not claim a permanent global output registry. The current attempt's descriptor is immutable. Changing output semantics requires a changed version/artifact digest, not overwriting evidence under the old identity.

Cancellation, failure, and startup interruption must work both before and after attachment. Before attachment no payload keys can exist by contract, so cleanup removes only the owned terminal control/candidate metadata. After attachment, bounded cleanup scans the entire declared ordinal ranges, not only acknowledged offsets, preserving the existing uncertain-write defense. Unexpected partial Lua errors remain non-serving and require recovery; Lua is not a rollback transaction. Never remove active, previous, complete, or reader-leased data. Job status remains addressable after candidate cleanup.

A successful claim means the control record has committed to the configured Redis persistence boundary, not that Redis has become canonical or lossless. Production delivery must document/test the chosen Redis persistence/acknowledgement guarantees; this decision does not invent zero-RPO persistence from an EVAL reply. Loss of the disposable Redis store may lose jobs and indexes, not canonical records. Restarts retain ADR-0010's fencing/`INTERRUPTED` behavior, with no automatic resume.

## Compatibility, migration, and rollback

**[ONE-WAY] Public identity interpretation.** The v1 schema already requires an opaque definitive ID and ADR-0010 defines an input-derived identity. B preserves both. The conflicting output-hash refinement and current candidate layout are local/unmerged, and no rebuild route is implemented. Approval includes the stated assumption that there is no externally relied-upon output-hash contract; no v1 field or public state changes are needed. If that assumption is false, stop and design v2; do not invoke “opaque” to bypass ADR-0010's breaking-change rule. C always needs that separate decision.

**[ONE-WAY] Stored recipe/manifest layout.** Version the recipe and internal manifest layout explicitly. Never alias old local IDs to new IDs, infer readiness from old zero counts, or relabel existing manifests. No in-place migration is required for disposable local test data. Any retained complete legacy build stays immutable and can be served/rolled back only by a runtime that explicitly supports its validated layout and current authorization checks; otherwise remain unavailable and rebuild from Git. Do not clear another deployment's Redis or serving pointers to make a migration easy.

Incremental gates, each independently reversible before HTTP enablement:

1. Record owner acceptance and reconcile the affected SPEC-004 requirements (completed as documentation on 2026-09-16); keep the HTTP rebuild route absent until the following gates pass.
2. Verify the bounded source facade and versioned identity/artifact recipes against golden, nested-vault, clone-relocation, and consumer-declaration tests. Existing lower-level output-derived APIs remain clearly separate until migrated; no runtime claims authority from both recipes interchangeably.
3. Verify absent-output claims, immutable attachment, cancellation/restart, and bounded cleanup with real Redis. Old private layouts use separate disposable fixtures; no dual-write production path.
4. Integrate isolated controller admission and capacity ownership; prove disconnect/unknown-outcome handling before exposing the existing v1 route. Then complete the remaining Search/evaluation/activation/deployment gates already required by BK-017.

Rollback disables new rebuild admission, fences/cancels new builders, preserves all serving/rollback data, and pins the previous compatible runtime/configuration. If no compatible complete index is available, report unavailability and retain filesystem fallback; rebuild from approved Git. No canonical migration, Git write, automatic commit/push, or new infrastructure is introduced.

## Validation and observability gates

Before implementation is called complete, demonstrate:

- Golden recipe encoding; class-order invariance; equivalent-clone relocation invariance; distinct nested-vault scope; different artifact/policy/chunk settings change identity; approved-tip/configuration-epoch changes reauthorize without changing otherwise identical identity.
- Missing/oversized/invalid manifest, mismatched UID, unsupported Git/mount profile, stale configuration, full/aborted preflight slot, and deadline rejection before claim. Authentication precedes all lookup. No raw dependency or source values in diagnostics.
- Duplicate submissions return one job/worker while another builder runs; cross-vault capacity saturation rejects without queuing; another live build in the same vault conflicts. Complete retained builds are protected and never rewritten by submission.
- Disconnect before dispatch, after Redis dispatch, and after commit/before response; late Redis response; unknown outcome reconciliation; lost ownership; shutdown/restart; six-hour expiry. No phantom “not created” claim and no double worker.
- Before-attachment append/complete/activation rejection; stale lease/epoch and cancelling/terminal attachment rejection; exact attachment replay; conflicting descriptor rejection; genuine zero-output success; 50,000/250,000 boundaries and over-limit failure.
- Secret/excluded canaries absent from Redis payload/control/status/log/metric surfaces on full-validation failure; included controls still appear on success. OQ-007 approval remains separately required for real non-public data.
- Partial/uncertain batch failure and cleanup both before/after descriptor; active/previous/complete/live-reader data survives. Verified stored hashes/counts must match before completion/evaluation.
- Representative maximum-scale admission latency within the accepted ten-second budget, warm retrieval p95 below 500 ms during admission/build, full build within six hours, and bounded process/RSS/CPU/PID/teardown behavior. No such measurements are claimed here.

Observe only bounded route/status/degradation, generated request/job/build identifiers, HMAC audit handles, stage durations, permits in use, static failure codes, and validated included counts. No raw source scope, manifest bytes, paths/UIDs, errors, or excluded counts. A build ID identifies a recipe, never a trust or readiness signal.

Abort rollout on identity ambiguity, accidental output before policy success, stale-worker mutation, lost accepted work on socket close, candidate visibility before completion, or failed resource/latency gates. Preserve the previous serving build and investigate; do not raise limits or weaken proof silently.

## Consequences and approval record

Positive: prompt bounded admission no longer requires whole-corpus projection; one immutable build ID survives every public job state; existing fencing and no-partial-serving rules remain; no extra service is needed.

Negative: more internal manifest phases and cancellation cases; deterministic artifact packaging becomes a requirement; the ID is no longer an output-content commitment; a global builder limit delays unrelated vaults; full metadata checks may miss the accepted admission budget. Source preflight still needs hostile-input isolation and does not replace full validation.

**Approved on 2026-09-16:** B, the private recipe/output-descriptor split, unchanged v1 wire shape under the stated compatibility assumption, and the ten-second/one-preflight/one-builder limits, subject to the implementation and measured acceptance gates above. OQ-013 is resolved. Recording approval changes architecture/specification authority, not runtime code, the v1 schema, existing stored IDs, or deployed settings. BK-017 remains partial; no production or merge approval is implied.
