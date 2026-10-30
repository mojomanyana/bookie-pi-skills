# `@bookie/service`

Authenticated indexing and retrieval service backed by a disposable Redis projection. Follow [SPEC-004](../../docs/specs/004-retrieval-service.md), the [retrieval architecture](../../docs/architecture/retrieval.md), and the [security architecture](../../docs/architecture/security.md).

The production service must mount canonical vaults read-only and never become a write path. A strict Linux source-deployment guard and immutable local-runtime qualification are merged prerequisites. This increment adds the private S7 owned controller and optional existing-v1 rebuild/status/cancel routes below; deployment supervision, production startup/Compose and serving remain pending.

## Current implementation

BK-017's merged Dockerless Fastify contract slice provides:

- static liveness/readiness envelopes;
- strict protocol-v1 search request and response validation;
- digest-only opaque bearer-token verification with expiry windows;
- explicit per-vault `index:read` and `search` authorization before store access;
- static redacted authentication, request, and dependency errors;
- generated request IDs, `Cache-Control: no-store`, disabled automatic logging, and request-abort propagation to the store boundary.

The merged in-memory lexical projection slice provides: exact-commit validation, commit-derived vault/manifest identity, explicit deployment sensitivity approval, deterministic build IDs, cited heading-aware UTF-8 chunks, tags/links/relations, trust/freshness metadata, and an untrusted-content label. Excluded records are omitted; malformed input, policy failures, chunk overflow, worker failure, and cancellation produce no partial projection. Core also checks decoded headings and links against exclusion/secret policy before returning any export bytes.

The merged prerequisites have final integrated repair review **APPROVE**, including descendant-mount alias, strict-config and optional-dependency repairs. [PR #28](https://github.com/mojomanyana/bookie-pi-skills/pull/28) merged at `2026-10-10T00:12:09Z` as `4774ce18f47a5e979ab1d09365a2b2377af26458`; matching PR and merged-main CI succeeded. BK-025 is Done, while BK-017 remains Ready/partial and SPEC-004 In progress. Final runtime/deployment suites passed **1/0/0 skipped** and **10/0/0 skipped**; four clean builds reproduce `sha256:c41e3efd0ed3f9476122364b2664462f710b9df1579f1f4c2eff24ebf0d9066f`. Docker worked for those historical checks; real Redis was not rerun. The subsequent bounded integrity/policy/teardown repair merged in [PR #30](https://github.com/mojomanyana/bookie-pi-skills/pull/30) as `eb2a34f31977165b866927ce0ac0d04bc5f34376`, with successful [merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40872106782) (938/0/0). The subsequent exact baseline `4cc04e9808d2b6d7e876d499678be2f2bcb22f0b` passed fresh local runtime **1/0/0** and deployment **10/0/0** qualification; four clean builds reproduced `sha256:86d4205399885ee6007e183fcd92a8c9b4891116e72410e6c615842eb3ab4e5a`. The earlier Docker-unavailable statements are historical. The S5 private trusted-builder continuation below changes runtime bytes again. Its fresh runtime **1/0/0** and deployment **10/0/0** suites now pass; four independent clean builds reproduce `sha256:0b55ad86368f2f9c7c58ead1fd0978d39c5f5e3b0eb0d5c2be00af486b11b4c7`. Independent integrated review and actual delivery remain coordinator gates, not consequences of test counts. None of these local images is a production distribution pin. See [handoff](../../docs/planning/next-session.md) for delivery, remaining gates and the unresolved coordinator package-version-label metadata follow-up.

### Try the projection slice

From the repository root, using only the checked-in demo fixture:

```bash
npm run build --workspace @bookie/service
SOURCE_COMMIT=$(git rev-parse HEAD) node --input-type=module <<'JS'
import { prepareLexicalProjection } from './apps/service/dist/projection.js';
const result = await prepareLexicalProjection('./examples/vault', {
  sourceRef: process.env.SOURCE_COMMIT,
  config: {
    vaultUid: 'VLT-01ARZ3NDEKTSV4RRFFQ69G5FAY',
    approvedSensitivityClasses: ['public', 'internal'],
    maxChunkBytes: 8192,
    maxChunks: 250000,
  },
});
if (!result.ok) throw new Error(result.reason);
console.log({
  build: result.projection.buildId,
  concepts: result.projection.concepts.length,
  chunks: result.projection.chunks.length,
});
JS
```

`sourceRef` is a full lowercase object ID, not `HEAD` or a caller-supplied approval. Configuration is deployment-owned: at most 64 unique profile-valid approved classes, chunk bytes 16–65,536, and chunk count 1–250,000. Empty approval permits only an empty included corpus. The source manifest's excluded classes always win. Invalid configuration throws static `TypeError`; source/policy/worker/bounds failures return `ok: false` with a static reason; cancellation rejects with `AbortError`. Data from the worker is disposable, not an evaluated or activatable build. Parser dependency or projection-semantic changes must bump the worker's version identifiers.

This example is not approval to index a real non-public vault (OQ-007). There is no network, Redis write, canonical write, commit, or push. The projection worker isolates Markdown chunk parsing only. The approved-ingestion entry point below additionally isolates complete core ingestion; controller integration still must compose its deadlines/shutdown signals.

### Private trusted recipe and complete builder (S5)

`createTrustedLexicalBuilder` in `dist/trusted-builder.js` is a **non-serving private boundary**, not a controller, durable job, or write/activation capability. Startup takes deployment-owned `runtimeIdentityFile`, token verifiers, and a `configuration()` callback returning `{ epoch, sources }` (the existing strict source deployments). The callback is deployment-owned, not request data; its epoch must advance on authorization/policy changes. The S7 controller below now supplies atomic reload publication, capacity, claims, shutdown and claim-relative deadlines. Token verifiers may also be supplied through a deployment-owned callback so the controller's published snapshot, rather than an independent stale verifier, governs preflight.

The identity file contains exactly one `sha256:` token with optional LF, is an ordinary singly-linked read-only mounted file with protected real ancestors **outside** the hashed runtime, and is provisioned by the deployment owner from matching clean-image qualification. Startup qualifies the actually loaded installation; no runtime root, inline hash, qualification boolean or caller-authored receipt can replace it. This measurement stays outside admission.

- `builder.preflight({ authorization, vault, sourceRef, timeoutMs, signal? })` uses the existing digest-token authentication and per-vault `rebuild:create` grant **before** source lookup. It obtains metadata only through isolated, twice-guarded source preflight, then returns a frozen private recipe. Structural copies, raw metadata and receipts from another startup instance have no provenance. Epoch/source/policy and protected Git PATH selection are rechecked across asynchronous work. Timeout is independently bounded to 1–7,000 ms; there is no capacity scheduler here.
- `builder.build(recipe, { signal? })` accepts only that instance's genuine preflight recipe under unchanged deployment configuration. The owned subprocess repeats full source guard, history/manifest/policy validation and live runtime qualification, independently derives and compares every claimed recipe field, then validates/exports/projects the complete exact commit. It rechecks source eligibility, boundary and runtime before successful output. The signal belongs to the future controller, never the submission socket.
- The projection parent privately hashes/counts **actual included canonical JSONL sink bytes**, before decoding them. It compares that independent witness with both export and worker receipts and rehashes actual ordered concept/chunk JSONL streams. Errors discard all evidence/output, including consistent-looking forged empty receipts. No canonical bytes are inferred from projections and no unchecked records-to-projection interface is added.
- Complete success returns `{ recipe, approvedTip, outputDescriptor, concepts, chunks }`, with frozen records and nested data. The descriptor uses the accepted encoding and genuine included counts/hashes, including valid empty output. Legacy local projection APIs and output-derived IDs remain separate and unchanged; the builder never aliases them to a v2 ID.

Static failures expose no partial content. Abort/deadline and confirmed process-group settlement retain the existing isolation contract; `ingestion-error` still does **not** prove teardown. S6 now supplies the private fenced storage operations below; actual stored-stream verification remains a later completion gate. The S7 controller below supplies ownership/capacity and publication interlocks for optional HTTP rebuild use. The S5 API itself permits no content writes, creates no route, and makes no build servable. New production-shaped immutable-image cases cover authentic preflight, forged receipts, drift, independent output comparison, both Git formats, nested/relocated clones, repeatability and empty output; their changed-candidate Docker execution passed on the recorded immutable local profile, independently of the older baseline qualification. BK-017 remains Ready/partial; OQ-007 still blocks real non-public indexing.

### Owned rebuild admission and lifecycle (S7)

`createOwnedRebuildController` in `dist/rebuild-controller.js` is the deployment composition boundary. It takes a deployment-owned `runtimeIdentityFile`, immutable `{ epoch, sources, tokens }` configuration, a handle-to-`RedisCandidateStore` registry, and a **required** `confirmPreviousWorkersStopped(): Promise<void>` supervision operation. It obtains the genuine qualified S5 builder outside admission; requests cannot supply a runtime hash/path/proof, recipe, output receipt or raw records. Store namespaces must be unique and match their configured vault UIDs. Namespace/UID registry changes require replacement startup, not a partial reload.

Startup initializes/fences **every** configured vault, including prior queued claims, and never resumes old work. Admission stays disabled until the deployment supervisor confirms all old worker groups stopped; Redis leases/fences, structural receipts, or mount checks are not process-death evidence. Only then does bounded terminal cleanup run, preserving retained job status and serving/previous/complete/reader protections. **No production supervisor or default confirmation is supplied by this increment.** `OwnedRebuildController` is the explicit builder/store component boundary used by deployment composition and isolated component tests, not an HTTP injection surface.

- Authentication, configured-vault scope and the two-per-minute principal/vault submission limit precede all admission source/store lookups. One service-wide preflight permit coexists with one builder reservation; neither has a wait queue. Duplicates repeat genuine current preflight/approval and read their existing live job without acquiring or releasing another reservation. Other vaults saturate with static retryable `RATE_LIMITED`; different live inputs in the same vault conflict.
- Submission has a ten-second total deadline. Preflight is at most seven seconds, leaving the existing one-second teardown allowance and Redis time. Every Redis operation is at most two seconds and the remaining submission budget. Exhausted phases do not dispatch. Runtime qualification remains outside admission; the source guard is not skipped or replaced by descriptor parsing.
- A generated attempt ID and reservation precede dispatch. Confirmed claim precedes confirmed fenced `beginBuilding`; the single-launch flag is set before invoking S5. Builder cancellation/deadline is independent of the submission socket. The six-hour ceiling uses a conservative **pre-claim-dispatch** monotonic anchor, never a later parsing/acknowledgement time. Ownership renews every ten seconds, including while attached output awaits S8.
- Timeout, disconnect or unusable replies after possible dispatch mean **unknown**, not “no job.” Up to three bounded original-attempt, owner-epoch reads reconcile claim/building/attachment/terminal outcomes without replaying mutations. A matching live `cancelling` observation retains the original lease, prevents launch and acknowledges only after teardown; a concurrent failure may advance once to that distinct acknowledgement, never replaying either mutation. Fixed attempt-lifetime dispatch history also prevents shutdown or late callbacks from resending an uncertain failure, acknowledgement or recovery fence; it is not reset between retirement calls. Unresolved ownership or teardown quarantines capacity and disables admission (`ready === false`) pending supervised recovery/replacement; late replies have no reservation authority. `ingestion-error` never proves teardown, and TTL expiry never proves process death.
- `reload(next)` closes admission, aborts old preflight/owned work, interlocks with claim dispatch, fences every namespace and interrupts prior nonterminal jobs before publishing the next strictly increasing epoch and frozen auth/source snapshot. Confirmed teardown is still required for capacity release. Any failed publication disables controller admission/readiness even if a pre-dispatch claim already released its captured reservation. Revoked credentials cannot use a stale HTTP or S5 verifier. Shutdown closes admission and uses bounded teardown/terminal recovery; returning from shutdown is **not** an assertion that an unconfirmed group died. Deployment supervision must handle quarantined/stuck groups.
- Terminal cleanup runs off submission, with at most 128 ordinal keys per operation and a finite full-range bound, before normal reservation retirement. Uncertain cleanup disables admission rather than silently retrying. Cancellation works before and after attachment; capacity releases only with proved worker teardown and a confirmed terminal transition or superseding owner fence.

Pass an already-started, ready controller as `rebuilds` to `createBookieService` to register **only** `POST /v1/admin/rebuild`, `GET /v1/admin/rebuild/:id`, and `DELETE /v1/admin/rebuild/:id`. Without it these routes remain absent. The unchanged strict v1 schemas, five public job fields and eight states remain; status/cancel accept **no vault query selector** and search only currently authorized configured namespaces. Foreign/nonexistent jobs are indistinguishable. Errors are static and contain no source, recipe, UID/path, dependency diagnostics or excluded inventory. No automatic request logging is enabled. Readiness includes controller admission health; HTTP close shuts the controller down.

**S8 boundary:** genuine complete S5 output attaches exactly once under live ownership/configuration/fence. S7 performs **no payload append, index creation, stored-stream verification, evaluation, completion, activation or serving**. Attachment is not completion: status remains `building`, the accepted reservation and renewable lease stay held, and cancellation/failure/shutdown/six-hour expiry still apply. S8 must supply actual stored streams and completion/evaluation/serving; it must not release this reservation merely because S5 computation ended. Legacy APIs, IDs, layouts, namespace and serving protections remain separate and unchanged.

Checks include component fault/race/deadline tests, real TCP disconnects, actual owned leader/descendant teardown, and real Redis lifecycle/restart/cleanup. Immutable-image fixtures additionally exercise genuine guarded S5 preflight/build through the controller (with only the store component faked); real Lua/storage coverage is separate. These are not maximum-scale measurements, persistence acknowledgements, or production supervision qualification. Final changed-runtime qualification passed **runtime 1/0/0** and **deployment 10/0/0**, with four independent clean builds reproducing `sha256:dfe0162d30a2d2d9e24f438340bf8c76058d93d023bd4d446482d9f9833bbe96`; corrected real Redis passes **29/0/0** and root checks **1000/0/0**. See [S7 evidence](../../docs/planning/evidence/BK-017.md#s7-owned-controller--2026-10-30-utc) for exact final inputs/images/profile and retained red/green failures. Older S6/S5/intermediate images do not qualify these bytes. S7 is delivered in [PR #36](https://github.com/mojomanyana/bookie-pi-skills/pull/36), with final integrated APPROVE and [matching merged-main CI 1000/0/0](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/41130311607); [delivery evidence](../../docs/planning/evidence/BK-017.md#s7-delivery-completed--2026-10-30-utc) retains exact identities. S8 duties below remain pending; tests alone were not treated as delivery.

```bash
npm run test --workspace @bookie/service
npm run test:redis --workspace @bookie/service
npm run test:runtime --workspace @bookie/service
npm run test:deployment --workspace @bookie/service
npm run check
```

### Fenced Redis candidate storage

`RedisCandidateStore` is a private, trusted, non-serving primitive. S6 adds input-identified v2 candidates without changing the existing count-bearing `claim()` API, output-derived IDs, legacy layout, key namespace, or v1 HTTP fields/states. Legacy and v2 duplicate recognition are deliberately distinct; neither layout is aliased, relabelled, overwritten, or dual-written. Redis keys still use the deployment-HMAC namespace, not a canonical vault UID or path.

The new private sequence is:

1. `startProcess()` establishes the vault owner. `setConfigurationEpoch(epoch)` stores the current deployment-owned epoch under that owner; publication/interlocking with configuration reload belongs to S7. Epochs are positive safe integers through `9007199254740991`. The Redis wire/hash representation is a canonical decimal **string**, compared without Lua/cjson numeric rounding; publication is monotonic and stale processes cannot publish.
2. Allocate `attemptId = createCandidateJobId()` and retain it **before** calling `claimInput(recipe, attemptId, signal?)`. Supply an authentic S5 `TrustedBuildRecipe`, not raw HTTP metadata. The store validates its canonical codec result and sends only allowed source/digest/ownership/configuration fields. The queued v2 manifest has `manifestVersion: 2` and **no** `outputDescriptor`, expected counts, canonical UID/path, raw recipe, content, or excluded inventory. Its zero append/cleanup cursors record work, not invented expected output.
3. Confirm ownership, then `beginBuilding(lease, signal?)`, then launch at most once under the future controller. This explicit queued-to-building transition does not attach output. Same-live-owner repeats are no-ops only while building. No v2 payload append is possible yet.
4. After complete S5 builder verification, call `attachOutput(lease, output.outputDescriptor, signal?)`. One atomic whole-descriptor HSET binds the recipe and genuine included counts/bytes/stream hashes. Redis independently validates the exact existing descriptor encoding, live process/controller/build/fence/lease and current configuration epoch, building state, and serving/reader protections. An identical replay is allowed only under that same still-live ownership/building state; a conflict preserves the first descriptor. The controller must fail a conflicting non-serving attempt with `INTERNAL`. Parsing alone is not source authorization. Numeric zero has the exact canonical spelling `0`; Node and Lua both reject literal negative-zero descriptors, including persisted corruption.
5. Use the same lease for bounded `append()`/`renew()` and terminal acknowledgement/failure. `readCandidate(jobId)` strictly validates either v2 phase and returns frozen private metadata with an optional encoded descriptor; malformed present fields never become absence. `null` means a terminal candidate's manifest is absent after cleanup, not a valid empty corpus. A live legacy manifest is not interpreted as v2. `readJob()` keeps its existing five-field public shape, including retained terminal status after cleanup/retry.

Cancellation, failure and startup interruption accept both well-formed phases under their ownership/state rules. Replacement startup interrupts **every** prior nonterminal claim, including queued claims without launch evidence; it never resumes work or proves CPU/process teardown. Active, previous, complete, live-reader-leased and nonterminal data remain protected. A missing current complete manifest or manifestless retained payload refuses replacement admission rather than surrendering payloads to another attempt's cleanup. No method creates an index, verifies stored streams, evaluates, completes or activates a build; all are unavailable before attachment and still require later implementation.

Run its real Redis integration tests:

```bash
npm run test:redis --workspace @bookie/service
```

This requires Docker. The test owns and removes one digest-pinned Redis 8.2.1 container, with `--network none`, no published port, no host bind mounts, no persistence, and container resource/security limits. It does not use existing Redis instances or application containers. The fixture image is not approved for production deployment.

A future controller supplies the deployment Redis executor and passes only approved, policy-filtered projections. A new v2 worker requires `created: true`, confirmed `beginBuilding`, and a controller-owned single-launch record. Renew the 30-second lease before expiry. Append batches remain at most 128 records / 1 MiB encoded JSON and are bounded by the attached final counts. Before-output terminal cleanup requires zero cursors and removes only owned candidate metadata and its matching current-job link; unexpected cursors fail closed without guessed payload deletion. After-output cleanup scans the **full declared ranges**, at most 128 ordinal keys per call, including uncertain unacknowledged writes. Retry the same build only after `done: true`; retained job status is not garbage-collected.

Errors remain static `BUILD_CONFLICT`, `FENCED`, `NOT_FOUND`, or `INDEX_UNAVAILABLE`; cancellation throws static `AbortError`. Calls wait at most two seconds (a lower constructor limit and caller signal can enforce remaining time). Dispatched mutation timeouts/cancellation, dependency failures and unusable acknowledgements carry `outcome: "unknown"`. Retain the preallocated attempt ID and reconcile through `readCandidate()`/`readJob()` under the current owner; never infer no write, blindly replay, launch again or release capacity. Exact descriptor replay still requires confirmed same-live ownership. No automatic retry or success-shaped fallback is added. The executor must honor cancellation and must never log command arguments. Redis fencing does not prove worker teardown; S7 owns quarantined capacity and bounded recovery.

Migration/rollback follows ADR-0011: no in-place migration of legacy data, zero-count readiness inference, or deletion of another deployment's data. Disable new admission, fence/cancel builders, preserve serving/rollback data and pin a compatible runtime/configuration; otherwise report unavailability and retain filesystem fallback while rebuilding from approved Git. The no-external-legacy-ID-consumer assumption still applies. Historical S6 qualification passed runtime **1/0/0** and deployment **10/0/0**; four clean builds reproduced `sha256:b95e259445577bee089c0220ee061fbc4e234c08c5c8a456aeaa8eda65468826`, delivered in PR #34/#35. That profile and S5 `0b55…` do not qualify later S7 changes; use the S7 final qualification above. Local qualification is not a production/registry distribution pin.

BK-017 stays **Ready/partial**, SPEC-004 **In progress**. S7 adds only the optional owned admission/lifecycle component above. Redis Search execution, production startup/supervision, actual stored-stream verification, complete/evaluation gates, activation/rollback, reader-lease acquisition, context/activation routes, production persistence/connection configuration, remaining retrieval rate/deadline controls, initial-scale evaluation, and hardened Compose remain pending. Boundary-count tests are not REQ-031/032 or production-distribution certification. OQ-001/005/006/007, Linux service qualification versus portable core fallback, trusted host/mount and invisible-alias assumptions, and blocked/deferred dependents are unchanged. See [partial evidence](../../docs/planning/evidence/BK-017.md).

### Approved-history ingestion

The merged prerequisites include `prepareApprovedLexicalProjection`. It proves tip/first-parent eligibility before exact-commit validation and policy checks, running the complete ingestion in a killable subprocess rather than parsing canonical YAML on the caller's event loop. It returns the same build identity plus the once-resolved approved tip. No Redis write, canonical write, commit, push, or activation occurs.

Try it on the checked-in demo (Node 24, Linux):

```bash
npm run build --workspace @bookie/service
SOURCE_COMMIT=$(git rev-parse refs/heads/main) node --input-type=module <<'JS'
import { prepareApprovedLexicalProjection } from './apps/service/dist/ingestion.js';
const result = await prepareApprovedLexicalProjection('./examples/vault', {
  sourceRef: process.env.SOURCE_COMMIT,
  approvedRef: 'refs/heads/main',
  rollbackWindow: 0,
  timeoutMs: 10000,
  config: {
    vaultUid: 'VLT-01ARZ3NDEKTSV4RRFFQ69G5FAY',
    approvedSensitivityClasses: ['public', 'internal'],
    maxChunkBytes: 8192,
    maxChunks: 250000,
  },
});
if (!result.ok) throw new Error(result.reason);
console.log({
  approvedTip: result.approvedTip,
  build: result.projection.buildId,
  concepts: result.projection.concepts.length,
  chunks: result.projection.chunks.length,
});
JS
```

The full `refs/...` name and rollback window are **deployment-owned**, not HTTP inputs. The literal ref is captured once without Git name guessing; annotated tags are peeled through the captured object ID. The window allows 0–1,024 first-parent edges (zero: tip only); side-branch reachability is insufficient. Raw commit reads are bounded to 1 MiB and hash-verified, so graft/replacement/shallow graph rewrites cannot grant eligibility. The requested commit and any needed parents must exist locally. The approved tip is not added to build identity; activation must recheck current approval and policy.

The outer deadline is required and at most six hours. Subprocess V8 old-generation memory is capped at 1 GiB, inherited Node flags are removed, and stdout/stderr are discarded. Normal cancellation kills the entire process group, including Git descendants, and rejects static `AbortError` only after teardown. Deadline returns `deadline-exceeded`; process/IPC faults return `ingestion-error`. A missing teardown acknowledgement returns `ingestion-error` after a further one-second allowance, not proof of cleanup. The deployment supervisor must handle an OS-denied/stuck process. Windows fails closed without spawning; portable core/filesystem reads remain available. This is cancellation isolation, not a complete sandbox or RSS/scale qualification.

This fixture demo is not approval for real non-public data (OQ-007) and does not prove a read-only mount. No controller or route calls this function yet. Production wiring must use the deployment entry point below after authorized handle resolution and admission checks, then pass a builder-owned cancellation/shutdown signal rather than a submission socket's disconnect. Tests: `node --test apps/service/test/ingestion*.test.mjs packages/core/test/approved-git-source.test.mjs` after building; the real Redis suite now round-trips this approved-ingestion output.

### Clean-install immutable runtime qualification

```bash
npm run test:runtime --workspace @bookie/service
```

This explicit Docker/network-install command builds **two cache-independent clean images** at different private locations. It uses an allowlisted context (no host dependencies, compiled output, Git data, credentials, vaults or tests), npm **11.9.0** with install scripts disabled, a forced service/core build and a separate production-only workspace install. Final staging includes only the declared runtime dependency closure and materializes core's workspace link. It leaves the developer install and lockfile unchanged. Default `npm run check` remains Dockerless; `test:deployment` also discovers this image suite.

The initial pinned profile is Linux/amd64, `node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b`, observed Node **v24.19.0** and Git **2.39.5**. The ordinary inventoried `runtime-profile.json` binds the base digest, platform, Node/Git identity (including Git executable hash) and npm/build profile. Packaging normalizes modes before image-side measurement. The final base's bundled npm is not the build/install npm; npm is not used by ingestion. Runtime artifact identity covers final bytes/modes plus the actual image Node binary/ABI, not host Node, image timestamps or an image-ID self-reference.

On success the command emits an external bounded JSON qualification record (as a test diagnostic), containing both immutable local image IDs, input/lock hashes, observed profile, equal artifact hashes and synthetic output hashes. Only after all checks and fixture/container cleanup succeed is the record emitted; successful local candidate images remain available. Failures emit no successful record. Execute a candidate only by its returned `sha256:` local image ID, never a floating tag. A local image ID is **not** a published registry deployment digest. No registry publication or operational service entry point/configuration is supplied.

The private `qualifyRuntime(expectedDigest)` in `dist/runtime-qualification.js` derives `/opt/bookie` from its own loaded module. Deployment-owned expected identity must stay outside requests and outside the hashed tree. It checks bounded real procfs metadata, matching non-root UIDs, zero capabilities, NNP, per-mount read-only runtime/executable ancestors, no writable nested mounts or visible writable aliases overlapping the backing range of **any** protected descendant mount (including separately mounted dependencies), real directory boundaries and ordinary singly-linked runtime files, and the protected actual Git PATH search prefix (no writable/alternate selector), then validates the observed baked profile and remeasures the expected digest. Errors are only `TypeError` / `Runtime qualification failed.` Chmod or caller-authored metadata cannot qualify an installation. This work remains outside HTTP admission.

The suite runs network-none/no-port, read-only-root, non-root, capability-free/NNP containers with bounded tmpfs/CPU/memory/PIDs. It imports the packaged HTTP/core/service modules without host `node_modules`, checks static liveness and unavailable-store readiness, then runs exact-approved synthetic root/nested preflight and ingestion, included-only canonical/stream hashes, secret/invalid corpus failures and adversarial mount/profile/file cases. It confirms teardown, including explicit cancellation. No real vault, Redis or provider is involved.

The trusted host/root administrator must protect the namespace/ancestors and prevent aliases outside this supported visible namespace; this is installation evidence, **not** a signature service, source approval or authority to index. The private S5 builder above now consumes live qualification and trusted preflight, with independent recipe/canonical-output comparison. S5/S6 runtime/deployment records remain historical for later changed bytes; the current S7 artifact and qualification are recorded above. S7 now composes that genuine producer with the private storage lifecycle and optional rebuild/status/cancel routes. Stored-stream completion, Search/activation, production supervision/startup/Compose and scale qualification remain S8 gates; BK-017 remains Ready/partial and SPEC-004 In progress. OQ-007 still blocks real non-public indexing.

Rollback: remove only this command's recorded local images with `docker image rm --no-prune <image-id>` (do not prune shared caches/application images), and revert the packaging/qualifier changes. Successful and ordinary failed runs remove owned containers/private fixture directories; unconfirmed cleanup fails qualification. Interrupts terminate owned containers/child processes and emit no success record, but private interrupted build workspaces may remain; remove only the exact directory allocated by that run after teardown is confirmed. No canonical or serving data changes. See [partial evidence](../../docs/planning/evidence/BK-017.md).

### Version-2 input-recipe codec

`encodeBuildInputRecipe` in `dist/build-recipe.js` implements the private ordered UTF-8 JSON encoding specified in [SPEC-004](../../docs/specs/004-retrieval-service.md#bk-017-version-2-input-recipe-codec). It hashes scope and normalized lexical policy, binds all explicit source/version/chunk/artifact inputs, and returns frozen `serialized`, `scopeHash`, `policyHash`, `recipeHash`, and `buildId` strings. Unknown/omitted fields and malformed values throw a static `TypeError`.

**Encoding is not authorization or artifact verification.** The S5 private orchestration and isolated builder use this codec only with guarded source metadata and process-local live runtime qualification; the private S6 claim consumes that result without storing its serialization. Optional HTTP rebuild reaches only the genuine qualified S7 composition; requests cannot supply this serialization. The artifact digest and version labels are syntactic inputs, not measured facts. A disconnected `hashRuntimeArtifact(root)` / `verifyRuntimeArtifact(root, expected)` inventory primitive now measures all files, directories and permission modes in a sealed, self-contained staging tree plus the running Node executable, version and ABI. It requires the root lockfile and manifests, compiled service/core entry points, all runtime-loaded profile/type schemas in core's dist, the two schemas loaded by the HTTP service at repository root (identical to their core copies), and materialized runtime `node_modules`. It rejects symlinks/special files and fails with a static error on missing/mutated inputs or budget overflow. The export schema is included in the inventory if packaged but is not mandatory for the current runtime. Hashes are stable across equivalent staging-root relocation. This inventory alone is not production attestation: the opt-in clean-image qualification above supplies one local immutable installation profile, while trusted orchestration and builder-side comparison to the claimed recipe remain required. Do not use a caller-supplied path or hash as admission authority. A separate build-time `stageRuntimeArtifact(source, destination)` can now assemble a symlink-free stage from an **already built and installed trusted workspace**. It copies the compiled service/core, their declared installed dependency closure, root HTTP schemas, manifests and lockfile; it materializes the core workspace link, omits unrelated packages, hashes the stage, and removes partial output on failure. After `npm run build --workspace @bookie/service`, `node --test apps/service/test/stage-runtime.test.mjs` includes an offline real-repository staging smoke that imports the staged service and serves `/health/live`. The helper accepts absolute normalized paths and a new destination under a private build directory, not an in-place canonical path; it handles installed npm aliases and optional peers but rejects links escaping the source. The destination must be new and under a private build directory; the helper does not verify `npm ci` provenance, seal the stage, pin an OCI image or attest that all dynamic/provider paths boot. An operator must provision an immutable deployment with the same measured Node binary before using its digest. A disconnected `assembleMeasuredInputRecipe(deployment, preflightReceipt, runtimeRoot)` now rejects mismatched receipt/deployment fields, uses worker-shared parser/projection/chunker/preprocessing labels and the service's canonical-export/secret-policy labels, and hashes the staged runtime itself. It returns only private codec metadata, not authorization. The caller must supply a receipt from authorized isolated preflight and an immutable deployment-owned qualified artifact; structural matching and hashing cannot prove either source authenticity or clean-install provenance. It performs artifact I/O outside the ten-second HTTP admission budget. The S5 builder instead uses `assembleQualifiedInputRecipe` with a non-forgeable process-local runtime proof and internally acquired source metadata, and independently compares the recipe in its full builder. The path-based measurement helper remains disconnected from that trusted path. S5/S6 image/deployment records are historical for later changed bytes; use the current S7 qualification record above. The S7 composition above now integrates the controller; fresh qualification after runtime changes remains required before admission; no developer-entered placeholder may become a production artifact digest. Existing projection IDs are unchanged. Do not log the private serialization or put it in Redis control metadata.

After building, run the codec and external-consumer tests:

```bash
node --test apps/service/test/build-recipe.test.mjs apps/service/test/build-input-assembly.test.mjs
```

The [literal golden vectors](test/fixtures/build-recipe-v2.json) use synthetic artifact hashes and policy/parser version labels. They prove encoding, not a qualified runtime. See [increment evidence](../../docs/planning/evidence/BK-017-adr0011-recipe-codec-trial.md).

### Output-descriptor codec

`encodeOutputDescriptor` / `parseOutputDescriptor` from `dist/output-descriptor.js` provide a closed, versioned, bounded private representation for later validated-output attachment. Successful local/approved projection preparation now returns core's included-only canonical JSONL receipt and worker-computed hashes of ordered concept/chunk JSON lines (`JSON.stringify` plus LF, UTF-8), including genuine empty-stream hashes. They remain evidence only; the S5 builder verifies them against its private canonical sink witness and derives the v2 output descriptor consumed by private S6 attachment. They reject fabricated zero counts, malformed/extra fields, inconsistent canonical record/concept counts and non-canonical stored serialization. The descriptor's hash is pinned by an independently calculated literal vector. The descriptor codec itself does not calculate output-stream hashes, validate a source, or write to Redis; the legacy count-bearing claim remains separate and unchanged. The isolated ingestion subprocess now recomputes those stream hashes over the returned worker data and rejects mismatches before reporting success, with no raw record diagnostics. This is an internal integrity check, not proof of source approval or a Redis build. The S5 builder verifies the claimed v2 recipe and exact canonical sink receipt before returning complete output; S6 supplies live-fenced attachment through S7; S8 must verify actual stored Redis output before completion. Do not attach caller-supplied hashes or expose this private serialization over HTTP. See SPEC-004 for the tuple and remaining stored-stream/serving gates.

### Isolated source preflight

`preflightDeploymentSource(deployment, { sourceRef, timeoutMs, signal? })` from `dist/ingestion.js` now runs the full Linux source guard, approved-history/exact-manifest read, deployment class-declaration check, and final boundary recheck in the same killable process isolation used by ingestion. It reads no concept/resource content and returns frozen **private metadata only**, not a validated corpus, build ID, job, or permission to index. Do not log the receipt. The existing full-ingestion APIs and IDs remain unchanged.

The independent request timeout must be 1–7,000 ms, plus at most the existing one-second teardown allowance; a six-hour deployment builder limit cannot enlarge it. The S7 authorized controller owns the single preflight permit and clamps to its remaining ten-second submission budget, leaving teardown/Redis time. S5 consumes authentic preflight metadata into qualified private recipes; its recorded runtime/deployment execution passed for that historical candidate. S6 supplies private storage operations and S7 now composes global admission/capacity and optional HTTP rebuild/status/cancel; initial-scale and production qualification remain pending S8 gates, with current local qualification recorded above. An `ingestion-error` is not proof of teardown: uncertain capacity must remain quarantined pending recovery. Other failures are static and contain no metadata; cancellation rejects `AbortError` only after confirmed teardown.

After building, run the targeted tests and optional real Linux mount fixtures:

```bash
node --test apps/service/test/preflight.test.mjs apps/service/test/ingestion*.test.mjs
npm run test:deployment --workspace @bookie/service
```

The Docker suite uses only disposable synthetic sources, including a deliberately missing corpus blob to prove preflight does not read it. An ordinary writable developer checkout is expected to return `deployment-rejected`. See [SPEC-004](../../docs/specs/004-retrieval-service.md#bk-017-isolated-source-preflight-slice) and [trial evidence](../../docs/planning/evidence/BK-017-adr0011-source-preflight-trial.md).

### Linux read-only deployment guard

Run the real mount tests (Docker required):

```bash
npm run test:deployment --workspace @bookie/service
```

Tests use disposable official Node 24.19.0/Git containers pinned by digest, no network or published ports, staged compiled code and read-only dependency/source mounts. Negative cases deliberately relax a mount/process constraint on synthetic fixtures. They neither use running application containers nor mount a real vault. The image is not production-qualified.

`compileSourceDeployments([...])` snapshots/freezes up to 64 deployment-owned source configurations:

```js
{
  handle: 'demo',
  root: '/vault',
  repositoryRoot: '/vault',
  approvedRef: 'refs/heads/approved',
  rollbackWindow: 0,
  timeoutMs: 10000,
  projection: {
    vaultUid: 'VLT-01ARZ3NDEKTSV4RRFFQ69G5FAY',
    approvedSensitivityClasses: ['public'],
    maxChunkBytes: 8192,
    maxChunks: 250000,
  },
}
```

Handles/UIDs must be unique; vault roots cannot overlap. Sibling vault directories in a single repository are supported. Unknown fields, unbounded limits, non-absolute/unnormalized paths, or a vault outside its repository fail with static `TypeError`. This is not the full token/Redis/provider secret-file loader.

In a correctly provisioned container, call `prepareDeploymentLexicalProjection(deployment, { sourceRef, signal? })` from `dist/ingestion.js`. The existing subprocess checks the deployment **before Git approval and again before returning a projection**. It requires a read-only Linux root/source/ancestor mount hierarchy, matching nonzero real/effective/saved/filesystem UIDs, all capability sets empty, and no-new-privileges. It reads bounded kernel mount/status metadata from procfs; chmod is not mount proof. Writable nested mounts and visible overlapping writable bind aliases fail. Alias checks cover each protected descendant mount's backing device/root, including separately mounted read-only Git object metadata; checking only the source's containing mount is insufficient.

The initial Git profile is deliberately narrow: an ordinary self-contained `.git` directory, no symlinked/multiply-linked/special metadata, gitfiles, linked-worktree metadata, shadow repositories, or alternates. Metadata traversal is bounded to 100,000 entries/depth 64. Git parses captured config bytes (64 KiB/256 keys) with includes disabled; only the ordinary keys listed in [SPEC-004](../../docs/specs/004-retrieval-service.md#bk-017-linux-read-only-source-deployment-slice) are accepted. A fresh ordinary clone may be needed. Use a non-root container UID compatible with Git's checkout ownership policy; the guard does not disable Git ownership checks.

A changed mount/directory/config fingerprint or unsupported deployment returns `{ ok: false, reason: 'deployment-rejected' }`, with no projection or raw diagnostic. Deadline/cancellation retains the existing bounded subprocess behavior. Running this entry point in an ordinary writable developer checkout is expected to fail; use the test command above for a positive example.

This verifies a supported profile under a trusted host/mount administrator, not every possible filesystem alias or a hostile host. It does not qualify cgroups/network/credential mounts, create jobs, call Redis, activate builds, or start a production service. The unguarded local projection APIs remain separate and must not be used as the future controller's deployment path. OQ-007 still requires data-owner approval before indexing real non-public data.
