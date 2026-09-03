# `@bookie/core`

Pure canonical-domain package for Bookie. It implements OKF/Profile lossless parsing, current-tree and Git-base validation, lifecycle/immutability policy, Evidence hashing and capture, conflict-safe atomic concept creation/amendment, and bounded local filesystem query. A later SPEC-002 slice adds canonical export.

It must not depend on Pi, Redis, an HTTP framework, or a concrete embedding provider. Implement against [SPEC-001](../../docs/specs/001-canonical-ledger.md) and [SPEC-002](../../docs/specs/002-core-and-cli.md).

## Lossless concept loading

`loadConcept(bytes, { file, maxBytes?, maxDepth? })` validates bounded UTF-8 and a strict YAML 1.2 frontmatter envelope without filesystem access or schema policy. Success returns recursively readonly, frozen decoded frontmatter plus the untouched frontmatter, body, and complete source text while retaining parser/envelope state privately. `serializeConcept(concept)` accepts that nominally loader-owned object and returns a new byte array equal to the original source; forged or spread copies are rejected by TypeScript and throw `TypeError` at runtime rather than claiming lossless provenance.

Content failures are returned as stable `ConceptDiagnostic` values with remediation and source ranges where available; malformed content does not throw. Invalid programmer options such as non-positive or above-default limits throw `TypeError`. The default limits are exported as `DEFAULT_MAX_CONCEPT_BYTES` and `DEFAULT_MAX_YAML_DEPTH`.

## Vault validation

`await validateVault(root, options?)` resolves one explicit vault, consumes exactly one direct YAML manifest document, requires OKF 0.2 root bundle metadata, validates the packaged canonical schemas, checks CommonMark local links and current-tree profile relations, and streams exact Evidence bytes through SHA-256. With `baseRef`, it resolves one local commit from the containing non-bare Git worktree and additionally enforces tracking, Activity/Evidence exact-byte immutability, Decision retention, immutable-record target identity, and Evidence resource retention. Success exposes the resolved `baseCommit`; infrastructure or bounded-base failures emit static `GIT-BASE` and make validation incomplete.

Git-base reads require local Git 2.29+ and use bounded NUL-delimited plumbing plus exact object blobs without worktree filters. They disable configured hooks, lazy remote object fetching, alternate inherited indexes/object stores, shell interpolation, and Git replacement objects. The working tree remains the proposed tree; stage-zero ordinary index entries establish tracking but staged blob contents are not substituted. Validation never fetches, commits, pushes, or executes repository hooks.

Results expose `valid`, `complete`, `diagnosticsTruncated`, the real root, and deterministic static diagnostics. Content failures do not throw. Invalid options throw `TypeError`; cancellation consistently rejects with `AbortError`. Entry, concept, aggregate-byte, YAML-depth, CommonMark container-depth, resource, and diagnostic bounds fail closed; suspicious CommonMark container input runs in a cancellable worker with a five-second deadline. Exported caller options may only lower their corresponding defaults.

Traversal never accepts symlinks, multiply linked files, or a platform without no-follow opens: each directory/file ancestor is snapshotted with high-resolution identity metadata around enumeration or reading, and deduplicated identities are rechecked at completion. Resources are hashed incrementally without loading the entire file, and failed reads still debit streamed-byte limits. Diagnostics for parsed records assigned an excluded sensitivity class redact source and field-derived path hierarchies as `<excluded>`.

## Safe concept mutation

`createConcept(root, request, options?)` writes one complete schema-valid profile concept to an absent canonical vault-relative path. `amendConcept(root, request, options?)` applies non-overlapping set/remove paths to the retained private YAML Document and optionally replaces the exact body text. Amend requires the `sha256:...` token returned by `computeConceptSourceHash()` over the bytes previously read, preserves stable type/profile/UID identity, checks again immediately before publication, and returns an observable conflict instead of overwriting a changed source.

Both operations reject host-absolute, traversal, encoded, reserved, manifest-excluded, symlink, hardlink, missing-parent, invalid schema, disallowed type, and duplicate-UID cases before publication. They stage a flushed exclusive temporary file beside the target and rename it atomically only after rechecking the parent chain and target. A semantic no-op keeps the original inode and bytes. Success reports the changed bundle path and resulting exact source hash; content and filesystem failures return static structured diagnostics plus any canonical path that may already have published, invalid limits throw `TypeError`, and cancellation rejects with `AbortError` before publication.

Core serializes its mutations per real vault root. Pi callers must also pass `runExclusive: (path, mutation) => withFileMutationQueue(path, mutation)` so the complete read/validate/stage/replace window shares Pi's target-file queue. Core does not import Pi, invoke Git, use the network, generate UIDs/timestamps, or claim multi-file relation validity; run `validateVault()` after a related mutation set.

## Evidence capture

`captureEvidence(root, request, options?)` accepts an explicit local source, absent descriptor and resource paths, a complete Evidence frontmatter candidate without `resource` or `bookie.sha256`, and exact body text. It streams the source into a same-directory temporary beneath a configured evidence root, enforces manifest and optional lower byte limits, hashes and reopens the staged bytes, inserts the verified resource path/digest, schema- and UID-validates the descriptor, then stages both files under the full mutation coordinator window.

Absent targets publish with atomic no-replace semantics. The resource file and directory are flushed before descriptor publication, and the descriptor directory is flushed before success. Success reports both changed paths, exact descriptor source hash, resource SHA-256, and byte count. Cancellation before resource publication cleans both temporaries. After the resource becomes durable, a descriptor conflict or I/O uncertainty leaves an explicit orphan rather than risking check-then-unlink deletion of another writer's file; failure `changedPaths` identifies every canonical path that may exist. Capture does not infer identity, timestamps, media type, project, support links, actor, or body and never invokes Git or the network.

## Filesystem query

`searchVault(root, { query, filters? }, options?)` scans one safe working-tree snapshot for a case-sensitive exact Unicode substring in schema-valid Bookie titles and Markdown bodies. Type, project, lifecycle status, workflow state, sensitivity, and tag filters use exact decoded equality. Results are deterministic by canonical path and identify filesystem mode, working-tree state, a null commit, exact source hash, declared verification/freshness signals, and untrusted handling. Result count, per-hit title/excerpt bytes, aggregate returned text, traversal, parsing, aggregate input, diagnostics, and cancellation are bounded and independently disclose incompleteness or truncation.

Search omits every record assigned a manifest-excluded sensitivity class from hits, matched counts, and truncation decisions. Missing and undeclared classes remain labelled local-only data and gain no provider/index/export eligibility. Generic OKF remains valid content but is outside this first Bookie-profile query API.

`inspectConcept(root, { path } | { uid }, options?)` resolves one exact schema-valid Bookie record without fallback or fuzzy matching. It returns a bounded exact UTF-8 source prefix, full/returned byte counts, the complete-source hash, and explicit truncation. Exact inspection may return excluded content with `handling: "excluded"`; callers must not log, index, checkpoint, or export it. Ambiguous UIDs, malformed selectors, invalid concepts, missing targets, bounds, and raced snapshots return no source text. Query APIs never invoke Git, Redis, Pi, a network service, commit, push, or process exit.

The package declares Node `>=24`; `npm pack` builds code, declarations, and canonical schema assets from a clean source checkout. `npm run benchmark:vault --workspace @bookie/core -- 50000` and `npm run benchmark:query --workspace @bookie/core -- 50000` reproduce the bounded scale probes.
