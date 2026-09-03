# SPEC-002: Core library and CLI

## Status

In progress — lossless loading, current/Git-base validation, safe mutation, Evidence capture, and bounded filesystem search/inspect through BK-010 are merged and verified; BK-011 deterministic canonical JSONL export is next

Owner: unassigned  
Target release: 0.1  
Depends on: SPEC-001, ADR-0004, ADR-0005

## Goal

Implement one deterministic core for loading, validating, mutating, hashing, searching, and exporting a Bookie vault, then expose it through a non-interactive CLI suitable for humans, CI, the Pi extension, and the indexing service.

## Non-goals

- TUI behavior or Pi hooks.
- Redis, HTTP, auth, or embeddings.
- Automatic Git commit or push.
- Destination API calls.
- Parsing arbitrary binary document formats.

## Requirements

1. Resolve a vault from an explicit path or upward configuration search without escaping the trusted root.
2. Parse strict YAML 1.2 frontmatter and Markdown through the ADR-0005 source-retaining Document strategy while preserving unknown fields and body bytes when untouched.
3. Return structured diagnostics with stable rule codes, file, location where possible, severity, and remediation.
4. Validate one concept or a complete vault against schemas and cross-file policy.
5. Compare a proposed tree with a supplied Git base ref to enforce immutable Activity/Evidence records and decision supersession.
6. Create and amend concepts through typed operations; reject arbitrary path traversal and UID collision.
7. Capture evidence by hashing exact bytes and writing a descriptor only after the resource is durable.
8. Provide exact and metadata filesystem search with bounded excerpts and explicit truncation.
9. Emit deterministic canonical JSONL sorted by stable UID.
10. Never invoke `git commit`, `git push`, or network services.
11. Expose library APIs without process exits; confine CLI exit codes and formatting to the CLI package.

## Lossless loading contract

BK-006 introduces a pure byte-to-concept boundary before filesystem and schema policy:

- input is bounded before fatal UTF-8 decoding; defaults are 1 MiB and YAML depth 64, and callers may supply lower positive limits;
- frontmatter starts at byte zero with an exact `---` line and ends at the next exact, unindented `---` line; LF and CRLF are preserved rather than normalized;
- the YAML document uses version 1.2, has one string-keyed mapping root, contains no aliases or unsupported tags, and represents integers without precision loss;
- loaded concepts retain original source, frontmatter, delimiter, and body text so no-op serialization is byte-identical;
- decoded frontmatter is an immutable plain value view; parser AST types do not cross the public core boundary;
- diagnostics have a stable code, severity, caller-supplied file label, bounded message, remediation, and a byte/line/column range where available;
- parser-native exception classes and messages are not public contracts and malformed content does not throw through the content-loading API;
- a near-limit hostile concept must fail closed within five seconds on the supported Node baseline; bulk CLI/service ingestion adds worker or process isolation with a caller deadline because synchronous parsing cannot be interrupted honestly.

Stable BK-006 diagnostic codes are:

| Code                | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `CONCEPT-SIZE`      | Input exceeds the configured byte limit.                                 |
| `CONCEPT-UTF8`      | Input is not valid UTF-8.                                                |
| `FRONTMATTER-OPEN`  | The exact opening delimiter is missing at byte zero.                     |
| `FRONTMATTER-CLOSE` | No exact closing delimiter line exists.                                  |
| `YAML-SYNTAX`       | Strict YAML 1.2 parsing failed, including duplicate or non-string keys.  |
| `YAML-UNSUPPORTED`  | The document uses an unsupported version, tag, alias, or unsafe integer. |
| `YAML-ROOT`         | The parsed document root is not a mapping.                               |

Schema, profile, and current-tree cross-file diagnostics are introduced by BK-007. BK-009 adds the Git-base diagnostics documented below.

## Safe mutation contract

BK-008 adds `createConcept(root, request, options?)`, `amendConcept(root, request, options?)`, and pure `computeConceptSourceHash(bytes)`. `root` is an explicit filesystem path or file URL. Request paths are canonical vault-relative POSIX concept paths such as `projects/demo/tasks/task.md`: host-absolute paths, a leading slash, empty or dot segments, backslashes, percent-encoded input, controls, query/fragment syntax, any case variant of a `.git` segment, reserved `index.md`/`log.md` basenames, configured Evidence-resource namespaces, manifest-excluded paths, and non-Markdown targets are rejected. Mutation paths contain at most 64 segments and 4,096 UTF-8 bytes total, with at most 255 UTF-8 bytes per segment; these lexical bounds are checked before the coordinator receives a queue key. Relation, project, and support values inside frontmatter retain their separate bundle-absolute `/...md` contract.

The public request shapes are:

```ts
type ConceptSourceHash = `sha256:${string}`;
type FrontmatterPathSegment = string | number;

type FrontmatterEdit =
  | {
      readonly op: "set";
      readonly path: readonly [
        FrontmatterPathSegment,
        ...FrontmatterPathSegment[],
      ];
      readonly value: ReadonlyYamlValue;
    }
  | {
      readonly op: "remove";
      readonly path: readonly [
        FrontmatterPathSegment,
        ...FrontmatterPathSegment[],
      ];
    };

interface CreateConceptRequest {
  readonly path: string;
  readonly frontmatter: ReadonlyYamlMapping;
  readonly bodyText: string;
}

interface AmendConceptRequest {
  readonly path: string;
  readonly expectedSourceHash: ConceptSourceHash;
  readonly edits: readonly FrontmatterEdit[];
  readonly bodyText?: string;
}

interface ConceptMutationOptions {
  readonly maxConceptBytes?: number;
  readonly maxYamlDepth?: number;
  readonly signal?: AbortSignal;
  readonly runExclusive?: ConceptMutationCoordinator;
}

type ConceptMutationCoordinator = <T>(
  absoluteTargetPath: string,
  mutation: () => Promise<T>,
) => Promise<T>;
```

`bodyText` is the exact UTF-8 text after the closing frontmatter delimiter line. Create emits LF delimiters and does not add, remove, or normalize body text. Amend applies at most 256 non-overlapping frontmatter paths to a clone of the retained ADR-0005 YAML Document; set may replace an existing value or add a mapping key, remove requires an existing value, and numeric segments address existing sequence elements. Duplicate and ancestor/descendant edit paths are rejected so result semantics do not depend on edit order. The UTF-8 bytes across edit path segments, set values, and changed body text share the per-concept preparation budget. Omitting `bodyText` preserves the original body bytes. A body-only amendment preserves the original frontmatter and delimiter bytes exactly, and a semantically no-op request returns unchanged without serializing or replacing the file. Only changed frontmatter may undergo the serializer normalization accepted by ADR-0005, while unknown nodes, comments, key order, scalar styles, and untouched body bytes remain preserved. The collision scan uses the BK-007 ceilings of 100,000 entries, 50,000 concepts, 512 MiB aggregate concept bytes, and 1,000 diagnostics; mutation options may lower, but not raise, the 1 MiB per-concept and depth-64 parser bounds.

Create requires a complete schema-valid profile 1.0 Bookie frontmatter mapping, a type allowed by `bookie.yaml`, a correctly prefixed caller-generated ULID not already present in the vault, an existing safe parent directory, and an absent target. It does not generate identity or timestamps; the caller remains responsible for global UID uniqueness beyond the scanned vault. Amend requires an existing singly linked regular target and a source hash from the exact bytes previously read; it may not change `type`, `bookie.profile`, or `bookie.uid`. Both operations validate the complete proposed target document and perform a bounded safe vault scan for UID collision. They do not claim that separately authored relation inverses or other multi-file changes are complete; callers run `validateVault()` after the related mutation set and before submission.

`ConceptSourceHash` is lowercase SHA-256 over exact source bytes with the `sha256:` prefix. Amend checks the expected token after its initial no-follow read and again immediately before publication. A mismatch returns a conflict and never retries or overwrites silently. The result is a discriminated union: success has `ok: true`, `operation`, `outcome: "created" | "amended" | "unchanged"`, canonical bundle path, exact resulting `sourceHash`, optional `previousSourceHash`, an empty diagnostic list, and `changedPaths` containing the one bundle path only when bytes changed; failure has `ok: false`, `operation`, `conflict`, `changedPaths`, and one or more static `MutationDiagnostic` values. Ordinary pre-publication failures have no changed paths; a post-publication I/O uncertainty reports every canonical target that may exist rather than claiming no write. Conflict results do not return current bytes or a replacement token: callers must reread before retrying.

Core serializes its own mutations per resolved real vault root. `runExclusive`, when supplied, is called exactly once with the resolved absolute target and wraps the complete target read, manifest/UID checks, candidate preparation, final conflict check, temporary write, and publication. A coordinator must invoke the callback exactly once and await and return its result unchanged. A coordinator failure before the callback completes returns `MUTATION-IO`; a contract violation after it completes throws a static error that explicitly says the mutation completed rather than returning a false failure. The Pi extension MUST pass `(path, mutation) => withFileMutationQueue(path, mutation)` so Bookie participates in Pi's shared per-file queue; wrapping only final publication is invalid. Initial lexical request validation and real-root resolution happen before the callback so unsafe input is never offered as a queue key, and all filesystem assumptions are rechecked inside it.

Writes use an exclusively created temporary regular file in the existing target directory, flush and close it, then recheck the root, parent chain, target state, and expected source hash. Absent-target publication uses an atomic same-filesystem no-replace link so a target created after the final check is never overwritten; amendment replaces its existing hash-checked target atomically under the required coordinator. This gives no partial target and no lost update among participating writers. An uncoordinated external process is outside that lock contract, but changes observed before publication still fail closed. Node exposes pathname operations rather than portable `openat`/`renameat2`; a hostile local process permitted to rename a validated ancestor between syscalls is therefore outside the atomicity guarantee. A detected late race returns I/O with any possibly published path, while OS permissions or sandboxing must prevent adversarial ancestor renames. Cancellation is honored through the final pre-publication check; after atomic publication starts, the operation completes and reports its committed result rather than returning an ambiguous cancellation. No mutation invokes Git, a network service, or a process exit.

Stable BK-008-only diagnostic codes are:

| Code                | Meaning                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `MUTATION-INPUT`    | The body, frontmatter value, edit set, or source-hash token is invalid. |
| `MUTATION-PATH`     | The requested path is non-canonical, reserved, excluded, or unsafe.     |
| `MUTATION-TARGET`   | Create found an existing target, or amend found no safe regular target. |
| `MUTATION-IDENTITY` | Amend attempted to change stable type, profile, or UID identity.        |
| `MUTATION-CONFLICT` | Exact target bytes no longer match the expected source hash.            |
| `MUTATION-BOUNDS`   | Candidate preparation or the collision scan reached a fixed bound.      |
| `MUTATION-IO`       | Safe staging, cleanup, or atomic publication could not complete.        |

Candidate format/schema failures reuse BK-006 concept codes plus `CONCEPT-SCHEMA`, `TYPE-ALLOWED`, and `UID-UNIQUE`; an invalid explicit root reuses `VAULT-ROOT`; manifest failures reuse `MANIFEST-MISSING`, `MANIFEST-SIZE`, `MANIFEST-SYNTAX`, and `MANIFEST-SCHEMA`. Invalid programmer limits throw `TypeError`, cancellation rejects with `AbortError`, and expected content, conflict, path, target, bounds, and I/O failures return the failure union rather than throwing parser or filesystem messages.

## Evidence capture contract

BK-009 adds `captureEvidence(root, request, options?)` as the two-file primitive beneath the later CLI command. It copies one caller-selected local source file into the vault and creates its Evidence descriptor; it does not infer a UID, timestamp, media type, project, support target, title, actor, or body.

```ts
interface CaptureEvidenceRequest {
  readonly source: string | URL;
  readonly path: string;
  readonly resourcePath: string;
  readonly frontmatter: ReadonlyYamlMapping;
  readonly bodyText: string;
}

interface CaptureEvidenceOptions extends ConceptMutationOptions {
  readonly maxResourceBytes?: number;
}
```

`path` is the descriptor's canonical vault-relative Markdown path. `resourcePath` is a canonical vault-relative POSIX file path with the same 64-segment, 255-byte component, 4,096-byte total, character, traversal, host-path, percent-encoding, `.git`, and existing-safe-parent limits as mutation paths, except that its basename need not end in `.md`; it must be strictly beneath one configured literal evidence root and outside manifest exclusions. The descriptor and resource targets must both be absent. The explicit source may be a filesystem path or file URL, is opened without following its final component, must remain one stable regular file throughout capture, and is never interpreted as vault-relative input.

The caller supplies a complete Evidence frontmatter candidate except that top-level `resource` and `bookie.sha256` MUST be absent. Core clones the bounded input, streams exact source bytes into an exclusively created same-directory resource temporary, enforces both `policy.attachment_max_bytes` and an optional lower `maxResourceBytes`, computes lowercase SHA-256 without decoding, flushes the temporary, and reopens and hashes the staged file to verify the durable bytes. It then inserts bundle-absolute `resource` and the verified digest, validates the complete Evidence schema/type/manifest/UID candidate, and stages the descriptor. A source change, short/extra write, staged digest mismatch, unsafe path, collision, bound, or candidate error publishes neither descriptor nor resource.

Core's per-real-root queue and an optional `runExclusive` coordinator wrap the complete source read, manifest/UID checks, both staging operations, final source/parent/target checks, and publication; the coordinator key is the resolved descriptor target and follows the same exactly-once contract as concept mutation. Publication uses atomic no-replace links and synchronizes the resource directory before attempting the descriptor, then synchronizes the descriptor directory before success. Thus a visible descriptor never points at a resource this operation has not first made durable, and neither target can overwrite a file created after the final check. Cancellation is honored until resource publication begins; after that point the operation finishes descriptor publication or reports the exact canonical paths already published instead of returning an ambiguous cancellation. Core never rolls back a published pathname with a check-then-unlink sequence because another process could replace that path between the check and deletion. A descriptor-publication conflict therefore leaves the durable resource as an explicit orphan and reports it in `changedPaths`; a post-publication I/O failure conservatively reports every target that may exist.

Success returns `ok: true`, `operation: "capture-evidence"`, `outcome: "captured"`, descriptor `path`, bundle-absolute `resourcePath`, exact descriptor `sourceHash`, lowercase resource `sha256`, resource `byteLength`, `changedPaths` in resource-then-descriptor publication order, and no diagnostics. Failure returns `ok: false`, `operation: "capture-evidence"`, `conflict`, observable `changedPaths`, and static mutation, manifest, schema, type, UID, or Evidence diagnostics. Invalid programmer limits throw `TypeError`; cancellation before publication rejects with `AbortError`. Capture never invokes Git, a network service, a process exit, commit, or push. It is a policy-neutral core primitive and does not guess the unresolved secret detectors or overrides in OQ-009; no CLI or Pi write surface may expose it until that boundary is accepted.

## Vault validation contract

BK-007 adds asynchronous `validateVault(root, options?)` for one explicit filesystem vault root. BK-008 adds mutation paths, and BK-009 adds the optional Git-base comparison documented below.

Validation:

- resolves one real vault root, never follows traversed symlinks, rejects multiply linked or special file entries, ignores `.git`, counts traversed entries before exclusions, treats `policy.exclude` as anchored segment globs, treats a file strictly beneath a configured literal Evidence root as resource bytes rather than a concept when a schema-valid Evidence descriptor names it, even when its name ends in `.md`, while unreferenced Markdown remains a concept candidate, and uses deterministic POSIX-relative ordering;
- parses the complete `bookie.yaml` byte stream directly as exactly one bounded strict YAML 1.2 mapping, with the same precision, alias, tag, and depth policy as concept loading, then validates it and Bookie records with the canonical JSON Schemas through Ajv 2020;
- requires root `index.md` to be a bounded frontmatter document declaring exact `okf_version: "0.2"`; other reserved Markdown remains content/link input rather than a Bookie concept;
- treats any concept with a `bookie` mapping as an attempted Bookie record; type names alone are never reserved, so generic OKF Markdown without `bookie` remains outside Bookie schema and relation policy but still requires a non-empty `type`;
- resolves project, relation, inverse, Decision lifecycle, and Evidence support rules only through schema-valid Bookie targets. Independently trustworthy project, relation, support, and Evidence fields in a source with an unrelated schema error are still checked, while malformed policy structures do not generate speculative cascades;
- parses inert CommonMark inline links, images, and referenced definitions without rendering or fetching, rejects AST block-container nesting above 256, and isolates lexically suspicious container input in a cancellable worker with a five-second deadline. It checks used local targets from concept bodies and complete reserved `index.md`/`log.md` files; fragment-only and query-only references and explicit external schemes/network-path references are ignored; query/fragment suffixes do not affect local file resolution; relative links resolve from the source file, one-leading-slash links from the vault root, URI escapes are decoded except encoded path separators are rejected, and local targets must remain inside the non-symlink enumerated tree. Heading fragments, unused definitions, and raw-HTML attributes are not validated in BK-007;
- opens Evidence resources only when no-follow support is available, rejects symlinks, special files, and multiply linked files, verifies real-root and configured-root containment, hashes bounded exact bytes from one file handle, and detects metadata/path identity changes around the read;
- applies per-concept, manifest, entry, concept-count, aggregate concept-byte, aggregate streamed-resource-byte and diagnostic limits; bytes streamed by failed hashes still debit the aggregate allowance. Cancellation consistently rejects with `AbortError`, while bounds and unreadable or torn required input return `complete: false`. `diagnosticsTruncated` separately identifies diagnostic-cap exhaustion, and `valid` is true only when validation is complete and has no error diagnostics;
- returns deterministic static diagnostics that never include parser messages or source values. Default bounds support 50,000 concepts when their aggregate UTF-8 bytes fit 512 MiB, with at most 100,000 traversed entries and 2 GiB of streamed Evidence bytes; diagnostic limits qualify the all-independent-errors guarantee rather than implying unbounded output. Diagnostics for a loaded record assigned an excluded sensitivity class use `<excluded>` instead of its path and never include its UID, title, body, or field values.

Stable BK-007 infrastructure/schema codes are:

| Code                    | Meaning                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `VAULT-ROOT`            | The explicit root is missing, unreadable, or not a directory.                               |
| `VAULT-IO`              | A required entry cannot be safely enumerated or read, or is a symlink/special file.         |
| `VAULT-BOUNDS`          | An entry, concept-count, aggregate-byte, or cancellation-safe validation bound was reached. |
| `MANIFEST-MISSING`      | `bookie.yaml` is absent or not a regular file.                                              |
| `MANIFEST-SIZE`         | The manifest exceeds its configured byte limit.                                             |
| `MANIFEST-SYNTAX`       | Manifest UTF-8/YAML mapping parsing failed or uses an unsupported feature.                  |
| `MANIFEST-SCHEMA`       | Decoded manifest data fails the profile schema.                                             |
| `CONCEPT-PATH`          | A Bookie concept's derived bundle path is not canonical.                                    |
| `CONCEPT-SCHEMA`        | A generic envelope or decoded Bookie record fails its schema.                               |
| `MARKDOWN-LINK`         | A local CommonMark link target is malformed, escaping, missing, or a symlink.               |
| `DIAGNOSTICS-TRUNCATED` | The diagnostic limit was reached and additional findings were omitted.                      |

BK-007 also emits current-tree SPEC-001 codes `TYPE-ALLOWED`, `UID-UNIQUE`, `PROJECT-TARGET`, `RELATION-TARGET`, `RELATION-INVERSE`, `DECISION-SUPERSESSION`, `EVIDENCE-RESOURCE`, `EVIDENCE-DIGEST`, and `EVIDENCE-SUPPORT`.

## Git-base validation contract

BK-009 extends `ValidateVaultOptions` with `baseRef?: string` and successful base resolution adds `baseCommit` to `ValidateVaultResult`. Omitting `baseRef` preserves the BK-007 filesystem-only behavior exactly. A supplied base is either a full 40- or 64-hex object ID matching the repository's declared SHA-1 or SHA-256 object format, or a bounded canonical Git ref name such as `main`, `origin/main`, or `refs/remotes/origin/main`; abbreviated object IDs, revision expressions, option-like values, controls, whitespace, reflog selectors, and path selectors are rejected. It must resolve locally to a commit in the non-bare Git worktree containing the explicit vault root. Validation never fetches, invokes hooks, applies filters, commits, pushes, or interpolates a shell command.

The resolved commit object, not a checkout or caller-controlled textual command, supplies the base tree. Base traversal is NUL-delimited and bounded by the same per-tree entry, concept-count, concept-byte, YAML-depth, resource-byte, and diagnostic ceilings as the current tree. It rejects non-UTF-8 paths, symlink entries, submodules, special modes, malformed/missing base manifest or bundle metadata, unreadable/oversized Bookie candidates, and incomplete Git output. The current non-excluded filesystem entries consumed by validation must have one ordinary stage-zero `100644` or `100755` index entry; this makes Git tracking and submodule rejection explicit while still comparing the working-tree bytes, not staged blobs. New canonical files therefore must be added to the index before a base-aware validation can pass.

For every schema-valid Activity and Evidence in the base tree, the proposed filesystem tree retains the same path, UID, and exact Markdown blob bytes. Deletion, rename, replacement, or edit emits `ACTIVITY-IMMUTABLE` or `EVIDENCE-IMMUTABLE`. Every base Decision UID remains addressable by a schema-valid Decision in the proposed tree; current-tree lifecycle and reciprocal-edge validation then enforces valid supersession. Project, relation, and support paths stored by base Activity/Evidence must resolve in both trees at the stored path to the same UID, emitting `PROJECT-TARGET`, `RELATION-TARGET`, or `EVIDENCE-SUPPORT` on replacement or loss. Every base Evidence resource remains an ordinary blob at its stored path and the current singly linked regular tracked file has the same exact-byte SHA-256 and size; change, deletion, unsafe replacement, or submodule conversion emits `EVIDENCE-RESOURCE` independently of current `EVIDENCE-DIGEST` checks.

Base records assigned a sensitivity class excluded by either parseable base or current manifest use `<excluded>` diagnostics and never expose their paths, UIDs, titles, bodies, references, resource names, or values. Policy violations are complete validation failures. An invalid/unavailable ref, non-worktree root, unsafe/incomplete base, tracking ambiguity, Git executable failure, or Git bound emits static `GIT-BASE`, marks the result incomplete, and never includes Git stderr, object contents, or ref-derived command text. Cancellation kills an active Git reader and consistently rejects with `AbortError`. Invalid option types or limits throw `TypeError`.

The BK-009 diagnostic additions are:

| Code                 | Meaning                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `GIT-BASE`           | Local base resolution, bounded tree reading, or current tracking was unsafe. |
| `ACTIVITY-IMMUTABLE` | A Git-base Activity was edited, deleted, renamed, or replaced.               |
| `EVIDENCE-IMMUTABLE` | A Git-base Evidence descriptor was edited, deleted, renamed, or replaced.    |

## Filesystem search and inspect contract

BK-010 adds `searchVault(root, request, options?)` and `inspectConcept(root, selector, options?)`. Both operate on one explicit filesystem vault path or file URL, use exact current working-tree bytes, and return `mode: "filesystem"`. They do not invoke Git and therefore return `commit: null` rather than claiming that local bytes equal a commit or are merged. A later CLI or Pi caller may label an actual service outage as degraded; core itself does not invent a fallback reason.

The public request and shared signal shapes are:

```ts
interface FilesystemSearchFilters {
  readonly type?: string;
  readonly project?: string;
  readonly status?: string;
  readonly state?: string;
  readonly sensitivity?: string;
  readonly tag?: string;
}

interface SearchVaultRequest {
  readonly query: string;
  readonly filters?: FilesystemSearchFilters;
}

type InspectConceptSelector =
  | { readonly path: string; readonly uid?: never }
  | { readonly uid: string; readonly path?: never };

interface FilesystemConceptSource {
  readonly path: string;
  readonly state: "working-tree";
  readonly commit: null;
  readonly sourceHash: ConceptSourceHash;
}

type FilesystemSensitivityClassification =
  | "missing"
  | "declared"
  | "undeclared"
  | "excluded";

interface FilesystemConceptSignals {
  readonly type: string;
  readonly uid: string;
  readonly project: string | null;
  readonly status: string;
  readonly state: string | null;
  readonly sensitivity: {
    readonly value: string | null;
    readonly classification: FilesystemSensitivityClassification;
  };
  readonly verification: "present" | "absent";
  readonly staleAfter: string | null;
  readonly untrusted: true;
}

interface FilesystemQueryOptions {
  readonly maxManifestBytes?: number;
  readonly maxConceptBytes?: number;
  readonly maxYamlDepth?: number;
  readonly maxEntries?: number;
  readonly maxConcepts?: number;
  readonly maxTotalConceptBytes?: number;
  readonly maxDiagnostics?: number;
  readonly signal?: AbortSignal;
}

interface SearchVaultOptions extends FilesystemQueryOptions {
  readonly maxResults?: number;
  readonly maxExcerptBytes?: number;
  readonly maxTotalTextBytes?: number;
}

interface FilesystemSearchHit extends FilesystemConceptSignals {
  readonly source: FilesystemConceptSource;
  readonly title: string;
  readonly titleTruncated: boolean;
  readonly matchedField: "title" | "body";
  readonly excerpt: string;
  readonly excerptTruncated: boolean;
}

interface SearchVaultResult {
  readonly mode: "filesystem";
  readonly root: string;
  readonly results: readonly FilesystemSearchHit[];
  readonly matchedCount: number;
  readonly rejectedConcepts: number;
  readonly complete: boolean;
  readonly resultsTruncated: boolean;
  readonly outputTruncated: boolean;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly diagnosticsTruncated: boolean;
}

interface InspectConceptOptions extends FilesystemQueryOptions {
  readonly maxContentBytes?: number;
}

interface InspectConceptSuccess extends FilesystemConceptSignals {
  readonly ok: true;
  readonly mode: "filesystem";
  readonly root: string;
  readonly source: FilesystemConceptSource;
  readonly sourceText: string;
  readonly sourceByteLength: number;
  readonly returnedByteLength: number;
  readonly sourceTruncated: boolean;
  readonly handling: "ordinary" | "excluded";
  readonly rejectedConcepts: number;
  readonly complete: true;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly diagnosticsTruncated: false;
}

interface InspectConceptFailure {
  readonly ok: false;
  readonly mode: "filesystem";
  readonly root: string;
  readonly reason:
    | "invalid-selector"
    | "not-found"
    | "ambiguous"
    | "invalid-concept"
    | "incomplete";
  readonly rejectedConcepts: number;
  readonly complete: boolean;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly diagnosticsTruncated: boolean;
}

type InspectConceptResult = InspectConceptSuccess | InspectConceptFailure;
```

Search accepts a non-empty Unicode-scalar query of at most 4,096 UTF-8 bytes. It performs one case-sensitive literal substring match without trimming, tokenization, locale folding, Unicode normalization, fuzzy matching, semantic scoring, or YAML-source matching. The searchable fields, in precedence order, are decoded `title` and the Markdown body. A result records the first matching field and occurrence. Filter values and tags use exact decoded-string equality; supplied filters are ANDed, absent project/state/sensitivity never matches a supplied filter, and the query is still required when filters are present. Search covers only complete schema-valid Bookie concepts whose type is allowed by the manifest. Generic OKF Markdown remains valid vault content but is outside this first Bookie-profile retrieval API.

Each hit contains bounded `title` and `excerpt` strings with separate truncation flags, `FilesystemConceptSource`, and `FilesystemConceptSignals`. Results use deterministic canonical-path order rather than a relevance score. The result includes `matchedCount`, `resultsTruncated`, `outputTruncated`, `complete`, `diagnosticsTruncated`, `rejectedConcepts`, and static diagnostics. `matchedCount` counts non-excluded matches observed by the scan and is exact only when `complete` is true. Invalid Bookie candidates are omitted but remain observable through redacted diagnostics and `rejectedConcepts`; generic OKF concepts are neither hits nor rejections. Empty complete results remain distinguishable from incomplete or invalid scans.

Search defaults to at most 50 hits, 1,024 UTF-8 bytes for each title or excerpt, and 32,768 aggregate UTF-8 bytes across returned titles and excerpts. Per-hit truncation does not split a Unicode scalar; body excerpts retain the first exact match when it fits. The scan continues after filling the result budget so `matchedCount` and result truncation remain truthful. `resultsTruncated` reports omitted hits; `outputTruncated` reports any per-item or aggregate title/excerpt truncation.

Inspect resolves exactly one canonical bundle-absolute Bookie concept path or one exact canonical Bookie UID. Path lookup never falls back to UID, basename, prefix, case folding, or a nearest match; UID lookup fails on ambiguity. Success returns the shared source/signals, an exact UTF-8 source prefix, full and returned byte counts, `sourceTruncated`, `handling: "ordinary" | "excluded"`, and diagnostics. The hash always covers the complete source, never just the prefix. The default source-output limit is the 1 MiB concept limit and may be lowered. A malformed selector, missing concept, duplicate UID, invalid target concept, or incomplete snapshot returns an `ok: false` result with no source text.

A record assigned a class listed in `policy.sensitivity.excluded_classes` never appears in search hits, `matchedCount`, truncation decisions, or value-bearing diagnostics, even when a sensitivity filter names it. Missing and undeclared classes may participate in this local filesystem read and are labelled `missing` or `undeclared`; this grants no indexing, embedding, logging, checkpoint, or export eligibility and does not resolve OQ-007. Direct inspect may return an excluded record only through the exact path/UID selector and marks it `handling: "excluded"` plus `untrusted: true`; callers MUST NOT log, index, checkpoint, or export that result.

Both APIs use the manifest's anchored exclusions and Evidence-resource classification, reject symlinks, multiply linked files, unsafe roots, descriptor paths beneath Evidence roots, and filesystem identity changes, and recheck the complete tracked snapshot before returning content. They reuse the validation ceilings of 65,536 manifest bytes, 1 MiB per concept, depth 64, 100,000 entries, 50,000 concepts, 512 MiB aggregate concept bytes, and 1,000 diagnostics; callers may lower but not raise any ceiling. Reaching a filesystem/content bound or observing a race sets `complete: false`; inspect discards content, while search may return clearly incomplete safe hits. Cancellation rejects with `AbortError`. Invalid programmer option types or limits throw `TypeError`. Neither API reads Evidence resource bytes, uses Redis/Pi/network services, exits the process, commits, or pushes.

The BK-010 diagnostic additions are:

| Code                | Meaning                                                        |
| ------------------- | -------------------------------------------------------------- |
| `INSPECT-INPUT`     | The exact path or UID selector is lexically invalid.           |
| `INSPECT-NOT-FOUND` | No schema-valid Bookie concept matches the exact selector.     |
| `INSPECT-AMBIGUOUS` | More than one schema-valid concept has the selected exact UID. |

## Canonical JSONL export contract

BK-011 adds `exportCanonicalJsonl(root, request, options?)`. Per ADR-0006 and REQ-016, it exports one exact local Git commit rather than mutable filesystem bytes. `root` is an explicit filesystem path or file URL locating the vault inside a containing non-bare worktree. `sourceRef` uses the BK-009 canonical-ref/full-object-ID grammar, resolves once to a lowercase full SHA-1 or SHA-256 commit, and never appears unsanitized in diagnostics. Core reads only that commit's bounded object tree through the BK-009 sanitized local argument-vector Git boundary; it does not read staged or working-tree concept bytes, fetch, invoke hooks or filters, use replacement objects, commit, push, or access a network service.

```ts
interface CanonicalJsonlExportRequest {
  readonly sourceRef: string;
  readonly write: CanonicalJsonlSink;
}

type CanonicalJsonlSink = (
  completeLine: Uint8Array,
) => void | Promise<void>;

interface CanonicalJsonlExportOptions {
  readonly maxManifestBytes?: number;
  readonly maxConceptBytes?: number;
  readonly maxYamlDepth?: number;
  readonly maxEntries?: number;
  readonly maxConcepts?: number;
  readonly maxTotalConceptBytes?: number;
  readonly maxTotalResourceBytes?: number;
  readonly maxDiagnostics?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

interface CanonicalJsonlExportSuccess {
  readonly ok: true;
  readonly format: "bookie-canonical-jsonl";
  readonly schemaVersion: "1.0";
  readonly root: string;
  readonly sourceCommit: string;
  readonly recordCount: number;
  readonly byteLength: number;
  readonly outputHash: ConceptSourceHash;
  readonly complete: true;
  readonly diagnostics: readonly [];
  readonly diagnosticsTruncated: false;
}

interface CanonicalJsonlExportFailure {
  readonly ok: false;
  readonly format: "bookie-canonical-jsonl";
  readonly schemaVersion: "1.0";
  readonly root: string;
  readonly sourceCommit?: string;
  readonly reason:
    | "invalid-source"
    | "invalid-vault"
    | "sensitivity-policy"
    | "incomplete"
    | "output-error";
  readonly complete: boolean;
  readonly diagnostics: readonly VaultDiagnostic[];
  readonly diagnosticsTruncated: boolean;
  readonly possiblyWrittenRecords: number;
  readonly possiblyWrittenBytes: number;
}
```

The exact line schema is [`schemas/export/1.0/canonical-record.schema.json`](../../schemas/export/1.0/canonical-record.schema.json). Every record has `schema_version`, resolved `source_commit`, exact-blob `source_hash`, profile, UID, canonical bundle-absolute `.md` path, type, title, the complete decoded `frontmatter` mapping, and exact decoded `body_markdown`. Complete frontmatter retains lifecycle, workflow, typed relations, sources, Evidence metadata, external IDs, explicit empty values, and unknown extensions. Dates/timestamps retain their already schema-valid strings. YAML comments, quoting, and key presentation are not JSON data; the exact source hash keeps the original blob attributable.

Canonical serialization recursively sorts every object key using ECMAScript UTF-16 code-unit comparison, preserves array order, uses ordinary ECMAScript JSON scalar escaping/number spelling, emits no insignificant whitespace or BOM, and terminates every record with one LF. Records sort by exact stable UID. Duplicate UIDs invalidate the snapshot. Empty valid exports emit zero bytes. The returned `outputHash` is lowercase SHA-256 with the `sha256:` prefix over the exact concatenated JSONL bytes.

Before invoking `write`, core completely reads and validates the same immutable commit: manifest and OKF bundle metadata, concept envelopes/schemas and allowed types, canonical paths and unique UIDs, CommonMark local links, cross-file policy, Evidence resource modes/sizes/digests, sensitivity policy, all configured limits, every encoded line size, and aggregate output size. Manifest-excluded paths are ignored. Generic OKF remains valid but is not an export record. The source snapshot may contain up to the existing 100,000 entries, 50,000 concepts, 512 MiB aggregate concept bytes, 2 GiB streamed Evidence bytes, and 1,000 diagnostics; `maxOutputBytes` defaults to and cannot exceed 512 MiB. Caller options may lower but never raise defaults.

A record assigned a class in `policy.sensitivity.excluded_classes` is validated but omitted before sorting, counting, hashing, or output. A schema-valid Bookie record with missing or undeclared sensitivity returns `sensitivity-policy`, a static `EXPORT-SENSITIVITY` diagnostic whose file is `<unclassified>`, and zero sink calls. If an included record's decoded metadata or local Markdown links contain an omitted record's exact UID or path, export fails the same way rather than leaking or silently rewriting the included record. Export emits no logs.

Invalid programmer request/option types and above-default limits throw `TypeError`. Cancellation rejects with `AbortError`. Source, vault, sensitivity, and bound failures return before the sink is called and report zero possibly written bytes. Once emission starts, sink calls are sequential and each receives one complete line. A rejecting/throwing sink returns `output-error` with static `EXPORT-OUTPUT` and conservatively counts the attempted line in `possiblyWrittenRecords`/`possiblyWrittenBytes`; no raw sink error is exposed. Cancellation after emission starts can likewise leave a prefix. Callers must discard any prefix after non-success; BK-012's file command stages to an absent temporary and publishes only after success.

The BK-011 diagnostic additions are:

| Code                 | Meaning                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `EXPORT-SOURCE`      | The exact local source commit could not be resolved or read safely.        |
| `EXPORT-SENSITIVITY` | Export eligibility is unclassified or would expose an excluded identity.  |
| `EXPORT-OUTPUT`      | The caller-owned byte sink did not accept the complete deterministic data. |

## CLI contract

Initial commands:

```text
bookie init <path>
bookie validate [path] [--base <git-ref>] [--format text|json]
bookie create --type <type> --project <path> [--input <json-file>]
bookie amend <uid-or-path> --input <json-file>
bookie evidence add <file> --project <path> --supports <path...>
bookie search <query> [filters] [--format text|json]
bookie export jsonl --ref <git-ref> --output <file>
bookie inspect <uid-or-path> [--format yaml|json]
```

Commands that mutate require an explicit vault and report every changed path. Interactive prompting is deferred to the Pi extension. Before BK-012 exposes a mutating command, [OQ-009](../planning/open-questions.md#oq-009-pre-write-secret-detection-policy) must pin deterministic pre-write secret detection and redacted failure behavior; CLI diagnostics and logs must also omit excluded-sensitivity identifiers and content under REQ-026.

Exit codes:

- `0`: completed successfully;
- `1`: operation or validation failure;
- `2`: invalid invocation/configuration;
- `3`: conflict or immutable-policy violation.

## Acceptance criteria

- Core can round-trip valid fixtures byte-for-byte without dropping unknown frontmatter or changing untouched body content.
- Validation reports all independent errors in one run and uses documented rule codes.
- Every mutating API rejects absolute, relative, encoded, and symlink paths outside the vault.
- Concurrent writes detect source-hash conflicts rather than silently overwrite.
- Evidence capture verifies staged exact bytes, makes the resource durable before descriptor publication, never overwrites a raced target, and reports every canonical path that a failure may have published.
- Filesystem search reports degraded/local mode and respects project, type, lifecycle, workflow, and sensitivity filters.
- JSONL export resolves one exact local commit and is byte-for-byte deterministic with an exact output hash across repeated runs, regardless of worktree changes after that commit.
- Every schema-valid initial type, complete unknown decoded metadata, accepted Unicode/date/empty values, and exact Markdown body survives canonical JSONL 1.0 mapping.
- Invalid/incomplete snapshots, output bounds, and missing/undeclared sensitivity produce zero sink calls.
- A mixed-sensitivity export retains included records but omits records assigned a class in `policy.sensitivity.excluded_classes`; excluded UIDs, paths, and marker content appear in neither JSONL nor export diagnostics or logs.
- CLI stdout is machine-safe in JSON mode and diagnostics go to stderr.
- No core test requires Pi, Redis, Docker, or a network connection.

## Test strategy

- Unit tests for path resolution, normalization, diagnostics, identity, hashing, filters, canonical JSON serialization, exact-commit provenance, and sink accounting.
- Golden round-trip fixtures with comments, unknown fields, multiline YAML, Unicode, and Markdown links.
- Boundary tests for empty vaults, large concepts, duplicate IDs, broken links, malformed YAML, symlink escapes, and interrupted writes.
- Integration tests in temporary Git repositories for base-ref immutability.
- CLI process tests covering output, stderr, exit codes, cancellation, and no-partial-write behavior.
- Mixed-sensitivity JSONL fixtures assert positive inclusion, fail-closed missing/undeclared classes, and excluded UID, path, content, diagnostic, and log omission.
- Export tests cover all initial types, recursive key ordering, duplicate UIDs, malformed/unsafe commit trees, refs that move after resolution, worktree divergence, exact and one-over limits, cancellation, sink failure, packaged schema availability, and a 50,000-record scale probe.

## Dependencies

- [SPEC-001](001-canonical-ledger.md)
- [ADR-0004](../architecture/decisions/0004-typescript-monorepo.md)
- [ADR-0005](../architecture/decisions/0005-yaml-document-ast.md)
- [ADR-0006](../architecture/decisions/0006-exact-commit-streaming-export.md)
- [Security architecture](../architecture/security.md)

## Delivery notes

Implement thinly in this order: load one concept, validate one concept, validate a vault, safe mutation, evidence and Git-base policy, inspect/search, deterministic export. Add no provider or persistence abstraction until there is a second accepted caller behavior to isolate.
