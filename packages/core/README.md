# `@bookie/core`

Pure canonical-domain package for Bookie. It implements OKF/Profile lossless parsing, current-tree validation, lifecycle policy, Evidence hashing, and conflict-safe atomic concept creation/amendment. Later SPEC-002 slices add Git-base policy, local search, and canonical export.

It must not depend on Pi, Redis, an HTTP framework, or a concrete embedding provider. Implement against [SPEC-001](../../docs/specs/001-canonical-ledger.md) and [SPEC-002](../../docs/specs/002-core-and-cli.md).

## Lossless concept loading

`loadConcept(bytes, { file, maxBytes?, maxDepth? })` validates bounded UTF-8 and a strict YAML 1.2 frontmatter envelope without filesystem access or schema policy. Success returns recursively readonly, frozen decoded frontmatter plus the untouched frontmatter, body, and complete source text while retaining parser/envelope state privately. `serializeConcept(concept)` accepts that nominally loader-owned object and returns a new byte array equal to the original source; forged or spread copies are rejected by TypeScript and throw `TypeError` at runtime rather than claiming lossless provenance.

Content failures are returned as stable `ConceptDiagnostic` values with remediation and source ranges where available; malformed content does not throw. Invalid programmer options such as non-positive or above-default limits throw `TypeError`. The default limits are exported as `DEFAULT_MAX_CONCEPT_BYTES` and `DEFAULT_MAX_YAML_DEPTH`.

## Vault validation

`await validateVault(root, options?)` resolves one explicit vault, consumes exactly one direct YAML manifest document, requires OKF 0.2 root bundle metadata, validates the packaged canonical schemas, checks CommonMark local links and current-tree profile relations, and streams exact Evidence bytes through SHA-256. It does not discover parent vaults, mutate files, read Git bases, commit, push, render Markdown, or fetch network links.

Results expose `valid`, `complete`, `diagnosticsTruncated`, the real root, and deterministic static diagnostics. Content failures do not throw. Invalid options throw `TypeError`; cancellation consistently rejects with `AbortError`. Entry, concept, aggregate-byte, YAML-depth, CommonMark container-depth, resource, and diagnostic bounds fail closed; suspicious CommonMark container input runs in a cancellable worker with a five-second deadline. Exported caller options may only lower their corresponding defaults.

Traversal never accepts symlinks, multiply linked files, or a platform without no-follow opens: each directory/file ancestor is snapshotted with high-resolution identity metadata around enumeration or reading, and deduplicated identities are rechecked at completion. Resources are hashed incrementally without loading the entire file, and failed reads still debit streamed-byte limits. Diagnostics for parsed records assigned an excluded sensitivity class redact source and field-derived path hierarchies as `<excluded>`.

## Safe concept mutation

`createConcept(root, request, options?)` writes one complete schema-valid profile concept to an absent canonical vault-relative path. `amendConcept(root, request, options?)` applies non-overlapping set/remove paths to the retained private YAML Document and optionally replaces the exact body text. Amend requires the `sha256:...` token returned by `computeConceptSourceHash()` over the bytes previously read, preserves stable type/profile/UID identity, checks again immediately before publication, and returns an observable conflict instead of overwriting a changed source.

Both operations reject host-absolute, traversal, encoded, reserved, manifest-excluded, symlink, hardlink, missing-parent, invalid schema, disallowed type, and duplicate-UID cases before publication. They stage a flushed exclusive temporary file beside the target and rename it atomically only after rechecking the parent chain and target. A semantic no-op keeps the original inode and bytes. Success reports the changed bundle path and resulting exact source hash; content and filesystem failures return static structured diagnostics, invalid limits throw `TypeError`, and cancellation rejects with `AbortError` before publication.

Core serializes its mutations per real vault root. Pi callers must also pass `runExclusive: (path, mutation) => withFileMutationQueue(path, mutation)` so the complete read/validate/stage/replace window shares Pi's target-file queue. Core does not import Pi, invoke Git, use the network, generate UIDs/timestamps, or claim multi-file relation validity; run `validateVault()` after a related mutation set.

The package declares Node `>=24`; `npm pack` builds code, declarations, and canonical schema assets from a clean source checkout. `npm run benchmark:vault --workspace @bookie/core -- 50000` reproduces the bounded scale probe. Git-base immutability remains BK-009.
