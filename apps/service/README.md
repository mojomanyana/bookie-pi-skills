# `@bookie/service`

Authenticated indexing and retrieval service backed by a disposable Redis projection. Follow [SPEC-004](../../docs/specs/004-retrieval-service.md), the [retrieval architecture](../../docs/architecture/retrieval.md), and the [security architecture](../../docs/architecture/security.md).

The production service must mount canonical vaults read-only and never become a write path. A strict Linux source-deployment guard and immutable local-runtime qualification are merged prerequisites; full startup/controller/production Compose integration remains pending.

## Current implementation

BK-017's merged Dockerless Fastify contract slice provides:

- static liveness/readiness envelopes;
- strict protocol-v1 search request and response validation;
- digest-only opaque bearer-token verification with expiry windows;
- explicit per-vault `index:read` and `search` authorization before store access;
- static redacted authentication, request, and dependency errors;
- generated request IDs, `Cache-Control: no-store`, disabled automatic logging, and request-abort propagation to the store boundary.

The merged in-memory lexical projection slice provides: exact-commit validation, commit-derived vault/manifest identity, explicit deployment sensitivity approval, deterministic build IDs, cited heading-aware UTF-8 chunks, tags/links/relations, trust/freshness metadata, and an untrusted-content label. Excluded records are omitted; malformed input, policy failures, chunk overflow, worker failure, and cancellation produce no partial projection. Core also checks decoded headings and links against exclusion/secret policy before returning any export bytes.

The merged prerequisites have final integrated repair review **APPROVE**, including descendant-mount alias, strict-config and optional-dependency repairs. [PR #28](https://github.com/mojomanyana/bookie-pi-skills/pull/28) merged at `2026-10-10T00:12:09Z` as `4774ce18f47a5e979ab1d09365a2b2377af26458`; matching PR and merged-main CI succeeded. BK-025 is Done, while BK-017 remains Ready/partial and SPEC-004 In progress. Final runtime/deployment suites passed **1/0/0 skipped** and **10/0/0 skipped**; four clean builds reproduce `sha256:c41e3efd0ed3f9476122364b2664462f710b9df1579f1f4c2eff24ebf0d9066f`. Docker worked for those historical checks; real Redis was not rerun. The subsequent bounded integrity/policy/teardown repair merged in [PR #30](https://github.com/mojomanyana/bookie-pi-skills/pull/30) as `eb2a34f31977165b866927ce0ac0d04bc5f34376`, with successful [merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/40872106782) (938/0/0). Its changed runtime bytes are not qualified by the old image digest. Fresh `test:runtime` and `test:deployment` are required before trusted recipe/runtime use; currently Docker is unavailable in this WSL distro, so neither suite was rerun and no new image identity is claimed. Trusted preflight/expected identity loading and builder recipe/canonical-output comparison remain the next seam before recipe/controller use. See [handoff](../../docs/planning/next-session.md) for delivery, remaining gates and the unresolved coordinator package-version-label metadata follow-up.

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

### Fenced Redis candidate storage

The merged prerequisites also include `RedisCandidateStore`, a low-level, non-serving builder primitive. It supports per-vault owner startup, idempotent claims, contiguous RedisJSON batches through renewable fenced leases, cancellation acknowledgement, static failure status, and bounded terminal-candidate cleanup. Redis keys use a deployment-HMAC namespace; stale/expired workers cannot mutate a replacement attempt. Active, previous, complete, and live-reader-leased generations are protected. No method marks a build complete or activates it.

Run its real Redis integration tests:

```bash
npm run test:redis --workspace @bookie/service
```

This requires Docker. The test owns and removes one digest-pinned Redis 8.2.1 container, with `--network none`, no published port, no host bind mounts, no persistence, and container resource/security limits. It does not use existing Redis instances or application containers. The fixture image is not approved for production deployment.

A future controller supplies the deployment Redis executor and passes only approved, policy-filtered projections. Start a worker only for a claim with `created: true`; retain the returned lease for each batch/renewal/terminal update. Renew the 30-second lease before expiry. Append batches contain at most 128 records / 1 MiB encoded JSON. Repeated cleanup calls remove at most 128 ordinal keys each; retry the build only after `done: true`. Failure/cancellation never activates implicitly. Errors expose only `BUILD_CONFLICT`, `FENCED`, `NOT_FOUND`, or `INDEX_UNAVAILABLE`; caller cancellation throws static `AbortError`. A timed-out dispatched command has an unknown outcome: re-read/recover before proceeding, do not blindly retry. The executor must honor the signal and must never log command payloads. Terminal job retention is not yet garbage-collected.

Redis Search execution, full startup/controller integration, complete/evaluation gates, activation/rollback, reader leases, context/admin routes, production connection configuration, service-wide rate/deadline controls, initial-scale evaluation, and hardened Compose remain part of BK-017 and are not implemented yet. See [partial evidence](../../docs/planning/evidence/BK-017.md).

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

The trusted host/root administrator must protect the namespace/ancestors and prevent aliases outside this supported visible namespace; this is installation evidence, **not** a signature service, source approval or authority to index. Trusted preflight orchestration, independent builder recipe/canonical-output comparison, Redis v2 lifecycle, controller/search/activation, Compose distribution pins and scale qualification remain pending. Recipe/controller paths stay disconnected; BK-017 remains Ready/partial and SPEC-004 In progress. OQ-007 still blocks real non-public indexing.

Rollback: remove only this command's recorded local images with `docker image rm --no-prune <image-id>` (do not prune shared caches/application images), and revert the packaging/qualifier changes. Successful and ordinary failed runs remove owned containers/private fixture directories; unconfirmed cleanup fails qualification. Interrupts terminate owned containers/child processes and emit no success record, but private interrupted build workspaces may remain; remove only the exact directory allocated by that run after teardown is confirmed. No canonical or serving data changes. See [partial evidence](../../docs/planning/evidence/BK-017.md).

### Version-2 input-recipe codec

`encodeBuildInputRecipe` in `dist/build-recipe.js` implements the private ordered UTF-8 JSON encoding specified in [SPEC-004](../../docs/specs/004-retrieval-service.md#bk-017-version-2-input-recipe-codec). It hashes scope and normalized lexical policy, binds all explicit source/version/chunk/artifact inputs, and returns frozen `serialized`, `scopeHash`, `policyHash`, `recipeHash`, and `buildId` strings. Unknown/omitted fields and malformed values throw a static `TypeError`.

**Encoding is not authorization or artifact verification.** This codec is deliberately unused by preflight, ingestion, Redis and HTTP. The artifact digest and version labels are syntactic inputs, not measured facts. A disconnected `hashRuntimeArtifact(root)` / `verifyRuntimeArtifact(root, expected)` inventory primitive now measures all files, directories and permission modes in a sealed, self-contained staging tree plus the running Node executable, version and ABI. It requires the root lockfile and manifests, compiled service/core entry points, all runtime-loaded profile/type schemas in core's dist, the two schemas loaded by the HTTP service at repository root (identical to their core copies), and materialized runtime `node_modules`. It rejects symlinks/special files and fails with a static error on missing/mutated inputs or budget overflow. The export schema is included in the inventory if packaged but is not mandatory for the current runtime. Hashes are stable across equivalent staging-root relocation. This inventory alone is not production attestation: the opt-in clean-image qualification above supplies one local immutable installation profile, while trusted orchestration and builder-side comparison to the claimed recipe remain required. Do not use a caller-supplied path or hash as admission authority. A separate build-time `stageRuntimeArtifact(source, destination)` can now assemble a symlink-free stage from an **already built and installed trusted workspace**. It copies the compiled service/core, their declared installed dependency closure, root HTTP schemas, manifests and lockfile; it materializes the core workspace link, omits unrelated packages, hashes the stage, and removes partial output on failure. After `npm run build --workspace @bookie/service`, `node --test apps/service/test/stage-runtime.test.mjs` includes an offline real-repository staging smoke that imports the staged service and serves `/health/live`. The helper accepts absolute normalized paths and a new destination under a private build directory, not an in-place canonical path; it handles installed npm aliases and optional peers but rejects links escaping the source. The destination must be new and under a private build directory; the helper does not verify `npm ci` provenance, seal the stage, pin an OCI image or attest that all dynamic/provider paths boot. An operator must provision an immutable deployment with the same measured Node binary before using its digest. A disconnected `assembleMeasuredInputRecipe(deployment, preflightReceipt, runtimeRoot)` now rejects mismatched receipt/deployment fields, uses worker-shared parser/projection/chunker/preprocessing labels and the service's canonical-export/secret-policy labels, and hashes the staged runtime itself. It returns only private codec metadata, not authorization. The caller must supply a receipt from authorized isolated preflight and an immutable deployment-owned qualified artifact; structural matching and hashing cannot prove either source authenticity or clean-install provenance. It performs artifact I/O outside the ten-second HTTP admission budget. Controller-owned trusted orchestration and builder recipe comparison remain required before admission; no developer-entered placeholder may become a production artifact digest. Existing projection IDs are unchanged. Do not log the private serialization or put it in Redis control metadata.

After building, run the codec and external-consumer tests:

```bash
node --test apps/service/test/build-recipe.test.mjs apps/service/test/build-input-assembly.test.mjs
```

The [literal golden vectors](test/fixtures/build-recipe-v2.json) use synthetic artifact hashes and policy/parser version labels. They prove encoding, not a qualified runtime. See [increment evidence](../../docs/planning/evidence/BK-017-adr0011-recipe-codec-trial.md).

### Disconnected output-descriptor codec

`encodeOutputDescriptor` / `parseOutputDescriptor` from `dist/output-descriptor.js` provide a closed, versioned, bounded private representation for later validated-output attachment. Successful local/approved projection preparation now returns core's included-only canonical JSONL receipt and worker-computed hashes of ordered concept/chunk JSON lines (`JSON.stringify` plus LF, UTF-8), including genuine empty-stream hashes. They remain evidence only; no v2 recipe or Redis write uses them. They reject fabricated zero counts, malformed/extra fields, inconsistent canonical record/concept counts and non-canonical stored serialization. The descriptor's hash is pinned by an independently calculated literal vector. The descriptor codec itself does not calculate hashes, validate a source, or write to Redis; the legacy candidate store remains unchanged. The isolated ingestion subprocess now recomputes those stream hashes over the returned worker data and rejects mismatches before reporting success, with no raw record diagnostics. This is an internal integrity check, not proof of source approval or a Redis build. The future controller still must verify the claimed v2 recipe and canonical receipt, then verify stored Redis output before completion. Do not attach caller-supplied hashes or expose this private serialization over HTTP. See SPEC-004 for the tuple and remaining builder/attachment gates.

### Isolated source preflight

`preflightDeploymentSource(deployment, { sourceRef, timeoutMs, signal? })` from `dist/ingestion.js` now runs the full Linux source guard, approved-history/exact-manifest read, deployment class-declaration check, and final boundary recheck in the same killable process isolation used by ingestion. It reads no concept/resource content and returns frozen **private metadata only**, not a validated corpus, build ID, job, or permission to index. Do not log the receipt. The existing full-ingestion APIs and IDs remain unchanged.

The independent request timeout must be 1–7,000 ms, plus at most the existing one-second teardown allowance; a six-hour deployment builder limit cannot enlarge it. The future authorized controller must own the single preflight permit and clamp to its remaining ten-second submission budget, leaving teardown/Redis time. Global admission/capacity, recipes/artifact digests, Redis/controller/HTTP wiring, and initial-scale qualification remain pending. An `ingestion-error` is not proof of teardown: uncertain capacity must remain quarantined pending recovery. Other failures are static and contain no metadata; cancellation rejects `AbortError` only after confirmed teardown.

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
