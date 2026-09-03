# SPEC-001: Canonical ledger profile

## Status

Verified

Verification evidence: BK-002 through [BK-009](../planning/evidence/BK-009.md) cover the profile schemas, fixtures, lossless loading, current-tree policy, Git-base immutability, retention, pinned identities, and exact Evidence resources.

Owner: unassigned  
Target release: 0.1  
Depends on: ADR-0001

## Goal

Define a versioned Bookie profile over OKF v0.2 that can represent the initial concept types, lifecycle rules, typed relations, evidence, and append-only policies without requiring any running Bookie software to read the corpus.

## Non-goals

- Implementing YAML parsing or choosing a YAML round-trip library.
- Implementing cross-file/runtime policy, filesystem containment, or realpath, symlink, and glob execution.
- Implementing CLI, Pi, service, Redis, or embedding behavior.
- Destination exports.
- Full transcript storage.
- Signed or compliance-grade records.

## Requirements

1. Create a machine-readable profile manifest format for `bookie.yaml` with profile version, vault identity, allowed concept types, evidence roots, exclusions, sensitivity policy, and attachment limits. The version 1.0 manifest contract is defined below.
2. Create JSON Schemas for common Bookie metadata and each initial type: Project, Task, Document, Research, Decision, Activity, Evidence, and Person.
3. Keep OKF `status` separate from `bookie.state` and validate both against their own enums.
4. Require stable prefixed ULIDs and define prefix/type mapping.
5. Define timestamps as UTC ISO 8601; retain `created_at` and `occurred_at` independently from `generated.at`.
6. Define the typed relation vocabulary, target path normalization, and required inverse relations.
7. Define activity/evidence immutability and decision supersession as policy rules that can be evaluated against a Git base tree.
8. Define evidence digest, media type, capture time, origin, resource path, and support-link rules.
9. Preserve unknown OKF frontmatter and body content.
10. Supply a conformant example vault with at least one record of every initial type and both valid and invalid test fixtures.
11. Document profile compatibility and migration rules.

## Version 1.0 `bookie.yaml` contract

The profile manifest is a YAML serialization of the JSON instance validated by the JSON Schema 2020-12 document at `schemas/profile/1.0/bookie-config.schema.json`. YAML decoding and round-trip behavior are not part of this increment; schema tests use decoded JSON fixtures. Profile 1.0 has this fixed shape:

```yaml
profile: "1.0"
vault:
  uid: VLT-01ARZ3NDEKTSV4RRFFQ69G5FAY
  title: Demo Bookie vault
allowed_concept_types:
  - Project
  - Task
policy:
  evidence_roots:
    - references/files
  exclude:
    - exports/**
  sensitivity:
    classes:
      - public
      - restricted
    excluded_classes:
      - restricted
  attachment_max_bytes: 26214400
```

All listed objects are fixed-shape and reject unknown keys recursively. This strictness applies only to `bookie.yaml`; it must never be applied to unknown OKF concept frontmatter, which remains accepted and preservable under ADR-0001 and requirement 9.

- `profile` is required and is exactly the string `"1.0"`. A different string is not implicitly compatible with this schema.
- `vault` is required and contains only required `uid` and `title`. `uid` is `VLT-` followed by a canonical uppercase Crockford Base32 ULID: 26 symbols, excluding `I`, `L`, `O`, and `U`, with a leading ULID symbol from `0` through `7` so values do not exceed 128 bits. `title` is a non-empty string.
- `allowed_concept_types` is the normative manifest allow-list for Bookie concepts. It is a required, non-empty, duplicate-free array whose members are exactly `Project`, `Task`, `Document`, `Research`, `Decision`, `Activity`, `Evidence`, or `Person`. Every concept carrying `bookie.profile` MUST use a listed type or fail `TYPE-ALLOWED`. Generic non-Bookie OKF concepts remain outside this profile allow-list, so it does not establish a centralized OKF type registry.
- `policy.evidence_roots` is a required, non-empty, duplicate-free array of lexical relative POSIX paths. Each path consists of non-empty slash-separated segments. Absolute paths, empty segments, `.` or `..` segments, backslashes, the metacharacters `*`, `?`, `[`, `]`, `{`, `}`, and `!`, colons (including Windows drive and URI-like forms), percent-encoded forms, C0 controls, DEL, C1 controls, and lone UTF-16 surrogates are rejected. Other characters with glob meaning in some runtimes, including extglob punctuation, are not excluded by this schema; runtimes MUST treat evidence roots as literal paths rather than glob expressions. Valid Unicode scalar path characters remain intentionally supported and require ECMAScript Unicode regex semantics. This is only a lexical schema boundary: filesystem containment, normalization against a vault root, and realpath/symlink handling remain runtime policy and are not claimed here. At runtime, a file strictly beneath a declared evidence root that is named by a schema-valid Evidence descriptor belongs to the Evidence resource namespace rather than the concept namespace, including a filename ending in `.md`. Unreferenced Markdown remains a concept candidate, and concept writers reject descriptor targets in evidence-root namespaces to keep classification deterministic.
- `policy.exclude` is a required duplicate-free array of constrained relative POSIX glob strings. Each slash-separated segment is either a literal made from ASCII letters, digits, `.`, `_`, and `-`, or exactly `*` or `**`. Absolute paths, empty segments, `.` or `..` segments, backslashes, and all other glob syntax are rejected. Matching and glob execution remain runtime policy.
- `policy.sensitivity.classes` is a required, non-empty, duplicate-free array of vault sensitivity class declarations. `policy.sensitivity.excluded_classes` is a required duplicate-free array of vault-global exclusions. Both arrays use lowercase kebab-case tokens of at most 63 characters; `unknown` and `unclassified` are reserved sentinels and cannot be declared. The schema validates each array independently and does not require every excluded class to appear in the declarations array; every listed exclusion still remains excluded under REQ-026. These fields classify and exclude vault data; they do not authorize any provider. Provider-specific approval remains unresolved under OQ-007.
- `policy.attachment_max_bytes` is a required integer from 1 through JavaScript's maximum safe integer, `9007199254740991`. The schema enforces integer and safe-range constraints on the decoded numeric value. The YAML parser/runtime must also reject numeric scalar text whose conversion would lose precision, even when the rounded decoded value would pass this schema. ADR-0005 selects that production strategy and SPEC-002 enforces precision before schema validation. The setting expresses a configured limit but establishes no product default; OQ-005 remains open.

### Version 1.0 concept frontmatter contract

The common schema at `schemas/bookie-common.schema.json` and the type schemas under `schemas/types/` validate decoded concept frontmatter while leaving unknown top-level, recognized-object, and `bookie` extension fields accepted. Acceptance demonstrates schema tolerance; lossless preservation remains a SPEC-002 writer obligation.

- Bookie concepts require non-empty `type` and `title`, explicit OKF lifecycle `status`, a `generated` event, and `bookie.profile` plus `bookie.uid`. Type schemas fix each initial `type` and require the fields listed in the accepted data model.
- OKF actor fields use `human:<id>`, `process:<id>`, or `<producer>/<version>`. `generated` and verification events require actor `by` and calendar-valid UTC `at` values.
- Every `sources` entry requires a non-empty `resource`, and source authors use the same actor contract. Every `usage_count` is framed by either the shared top-level or that source's own `usage_window`. Known source fields, bare-or-list `verified`, `stale_after`, and usage-window values retain their OKF v0.2 shapes. Calendar dates are validated independently; ordering a usage window is runtime policy rather than a schema claim.
- Research is either project-scoped with `bookie.project` or explicitly shared within its vault with `bookie.scope: shared`. Exactly one is required. Shared scope never crosses a vault and is not an authorization boundary.
- Evidence uses top-level OKF `resource`; `bookie.resource` is not the canonical placement. `bookie.mime_type` is a media type essence containing type and subtype registration names of 1 through 127 characters each; parameters and wildcards are rejected. Optional `bookie.origin` accepts absolute HTTP(S) URLs without embedded credentials. Concept-schema validators MUST assert the standard `uri` format rather than treating it as annotation-only; lexical guards additionally constrain scheme, host, port, credentials, controls, and percent escapes. Origin validation is syntactic and never authorizes a fetch.

These corrections remain within profile 1.0 because the concept schemas have not reached a release. Once profile 1.0 is released, changing required placement or Research scope semantics is breaking and follows the migration rule in the accepted data model.

### Profile 1.0 identity and relation contract

The common schema validates prefixed-ULID syntax. Each initial type schema additionally fixes this prefix mapping:

| Type | UID prefix | Example |
|---|---|---|
| Project | `PRJ-` | `PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV` |
| Task | `TSK-` | `TSK-01ARZ3NDEKTSV4RRFFQ69G5FAW` |
| Document | `DOC-` | `DOC-01ARZ3NDEKTSV4RRFFQ69G5FAX` |
| Research | `RSC-` | `RSC-01ARZ3NDEKTSV4RRFFQ69G5FAY` |
| Decision | `DSN-` | `DSN-01ARZ3NDEKTSV4RRFFQ69G5FAZ` |
| Activity | `ACT-` | `ACT-01ARZ3NDEKTSV4RRFFQ69G5FB0` |
| Evidence | `EVD-` | `EVD-01ARZ3NDEKTSV4RRFFQ69G5FB1` |
| Person | `PER-` | `PER-01ARZ3NDEKTSV4RRFFQ69G5FB2` |

`bookie.project`, every `bookie.relations[*].target`, and every `bookie.supports[*]` value is a lexical bundle-absolute POSIX concept path: it has exactly one leading `/`, non-empty slash-separated segments, and a final `.md` suffix. Empty, `.` and `..` segments; backslashes; colons; percent signs; query or fragment markers; C0, DEL, or C1 controls; and lone UTF-16 surrogates are invalid. Unicode scalar values and spaces remain valid. Validators do not percent-decode, case-fold, Unicode-normalize, or apply host-OS path normalization; the decoded string must exactly match the tracked concept path.

Paths may change without changing a Bookie UID only while cross-file references can be updated consistently. A concept referenced by an Activity or Evidence already present in the Git base tree is path-pinned while that immutable record remains in the vault: the target cannot be renamed or deleted because its stored project, relation, or support path cannot be amended. This is a deliberate profile 1.0 portability constraint; aliases and UID-only fallback are not defined.

An Evidence top-level `resource` follows the same lexical rules but may use any non-empty final filename rather than `.md`. Files strictly beneath configured evidence roots that are named by schema-valid Evidence descriptors are interpreted as resource bytes, not Bookie or generic OKF concepts; unreferenced Markdown remains subject to concept validation. Runtime policy additionally applies configured-root containment and filesystem checks under `EVIDENCE-RESOURCE`.

A relation contains required `kind` and `target` strings and may contain `target_uid`. A cached `target_uid` never replaces path resolution and must equal the resolved concept UID. Unknown relation extension fields remain accepted and preservable. Exact duplicate relation objects fail schema validation; `RELATION-TARGET` also rejects duplicate `(kind, target)` pairs even if extension fields differ.

The profile does not otherwise restrict source/target type combinations. Project ownership and Evidence support have the specific target constraints named below. Supersession is limited to Decision-to-Decision replacement and same-type Activity or Evidence correction; Task, Project, Document, Research, and Person cannot use `supersedes` or `superseded_by`, and Activity/Evidence cannot store `superseded_by`.

| Relation kind | Required inverse | Profile 1.0 meaning |
|---|---|---|
| `part_of` | None | Source is a constituent of the target. |
| `relates_to` | `relates_to` | Symmetric general association. |
| `blocks` | `blocked_by` | Source blocks progress on the target. |
| `blocked_by` | `blocks` | Source is blocked by the target. |
| `depends_on` | None | Source requires the target. |
| `supports` | None | Source supports a claim or outcome in the target. Evidence support remains authoritative in `bookie.supports`; no mirrored relation is required. |
| `supersedes` | `superseded_by` | Source replaces the target. Decision reciprocity is required; immutable Activity/Evidence corrections use the exception below. |
| `superseded_by` | `supersedes` | Source was replaced by the target. |
| `owned_by` | None | Source is owned by the target. |

### Named cross-file policy rules

These codes are the stable profile 1.0 contract for future SPEC-002 diagnostics. BK-004 supplies declarative decoded fixtures; executable whole-vault and Git-base enforcement belongs to BK-007 and BK-009.

#### `TYPE-ALLOWED`

Every proposed concept carrying `bookie.profile` has a `type` listed in the vault manifest's `allowed_concept_types`. The allow-list constrains Bookie profile records, not generic OKF types.

#### `UID-UNIQUE`

Every Bookie UID occurs at most once in the proposed vault tree. Validation cannot prove global uniqueness outside the vault, but writers must generate ULIDs rather than reuse identifiers.

#### `PROJECT-TARGET`

Every `bookie.project` path resolves in the proposed tree to a schema-valid Project concept. Project membership never crosses a vault. A project path stored by a Git-base Activity or Evidence is path-pinned and must continue resolving to the same UID.

#### `RELATION-TARGET`

Every relation target resolves in the proposed tree to a schema-valid Bookie concept. A present `target_uid` equals the resolved UID. Self-supersession, a repeated `(kind, target)` pair, a missing target, a target with a mismatched cached UID, and a supersession relation outside the allowed Decision/Activity/Evidence combinations fail this rule. A target path stored by a Git-base Activity or Evidence is path-pinned and must continue resolving to the same UID.

#### `RELATION-INVERSE`

`relates_to`, `blocks`/`blocked_by`, and Decision `supersedes`/`superseded_by` relations have the inverse shown in the vocabulary table. The target must contain exactly the corresponding `(inverse kind, source path)` pair and any cached UID must match. `supersedes` from a new Activity or Evidence correction is the only inverse exception because the merged predecessor cannot be amended; consumers discover that replacement from the incoming edge.

#### `DECISION-SUPERSESSION`

A Decision already present in the Git base tree is retained. A replacement is a distinct, schema-valid Decision in the same project with `status: stable`, `bookie.state: accepted`, and an outgoing `supersedes` relation. Each predecessor has `status: deprecated`, `bookie.state: superseded`, and exactly one reciprocal `superseded_by` relation to the replacement. Self-links, cycles, cross-project or wrong-type targets, missing reciprocal links, and multiple replacements for one predecessor fail. One accepted replacement may supersede multiple predecessors.

#### `ACTIVITY-IMMUTABLE`

Every Activity in the supplied Git base tree remains at the same path with the same UID and exact Markdown blob bytes. Edit, deletion, or rename fails. A correction is a new same-project Activity with a new UID and one outgoing `supersedes` relation to the unchanged predecessor.

#### `EVIDENCE-IMMUTABLE`

Every Evidence concept in the supplied Git base tree remains at the same path with the same UID, resource path, and exact Markdown blob bytes. Edit, deletion, or rename fails. A correction is a new same-project Evidence concept with a new UID and one outgoing `supersedes` relation to the unchanged predecessor.

#### `EVIDENCE-RESOURCE`

The Evidence `resource` path, after removing its leading `/`, is contained on a path-segment boundary beneath one configured literal `policy.evidence_roots` path. It resolves inside the real vault root to a tracked regular file with exactly one filesystem link, not a directory, symlink, hardlink alias, or submodule, and its byte size does not exceed `policy.attachment_max_bytes`. Missing files, traversal, root escapes, and changes or deletion of bytes referenced by Git-base Evidence fail.

#### `EVIDENCE-DIGEST`

SHA-256 is computed over the exact stored resource bytes without text decoding or newline normalization and equals lowercase `bookie.sha256`.

#### `EVIDENCE-SUPPORT`

Every `bookie.supports` path resolves in the proposed tree to a schema-valid Bookie concept. A support path stored by Git-base Evidence is path-pinned and must continue resolving to the same UID. At least one support is required by the Evidence schema; no mirrored `supports` relation is required.

### Profile compatibility and migration

Profile versions are exact `MAJOR.MINOR` schema identifiers. Additive optional changes create a minor schema; an older reader may expose a newer minor as generic read-only OKF but must not claim Bookie validation or mutate it without declared compatibility. Changed meaning, required fields, enum removals, or incompatible placement require a breaking major and explicit migration with dry-run, complete validation, backwards-compatibility fixtures, and Git rollback.

A major migration never rewrites merged Activity or Evidence merely to change `bookie.profile`. The target profile must explicitly recognize each retained historical schema for legacy immutable records; those records retain exact bytes and validate against their declared schema, while new corrections use the target profile. If the target cannot recognize all retained immutable profiles, migration fails. The complete operational contract is documented in the [profile 1.0 reference](../reference/profile-v1.md#compatibility-and-migration).

The current `schemas/bookie-common.schema.json` and `schemas/types/*.schema.json` files are the frozen concept schema set for profile 1.0. Before accepting another profile generation, an ADR and migration increment must copy that set into a version-addressed registry, keep these canonical 1.0 URIs resolvable, and make runtime selection explicit by each record's declared profile. A later profile must not edit the only retained copy of an historical schema.

### Deferred runtime policy

**`SENSITIVITY-EXCLUSION`** refines REQ-026: a record assigned a class listed in `policy.sensitivity.excluded_classes` MUST NOT be indexed, checkpointed, logged, or exported. This schema declares the exclusions but does not enforce operation behavior. Export enforcement belongs to SPEC-002/BK-011, checkpoint enforcement to SPEC-003/BK-015, and indexing enforcement to SPEC-004/BK-017; any logging implementation must apply the same requirement when introduced. This increment does not define runtime behavior for missing, reserved, or undeclared record classes and does not settle provider authorization; OQ-007 remains open.

## Interfaces and artifacts

Expected artifacts are delivered sequentially at these repository-relative paths:

```text
schemas/profile/1.0/bookie-config.schema.json
fixtures/profile/1.0/bookie-config/valid/*.json
fixtures/profile/1.0/bookie-config/invalid/*.json
schemas/bookie-common.schema.json
schemas/types/*.schema.json
fixtures/concepts/1.0/valid/*.json
fixtures/concepts/1.0/invalid/*.json
fixtures/policy/1.0/{valid,invalid}/cases.json
fixtures/policy/1.0/resources/*
fixtures/valid-vault/
fixtures/invalid-vaults/<case>/
docs/reference/profile-v1.md
```

The schema is a contract, not the complete policy engine. `SENSITIVITY-EXCLUSION` above is a named deferred runtime rule; target existence, inverse relations, Git-base immutability, and resource digests are documented as additional named validation rules for SPEC-002.

## Acceptance criteria

- A generic OKF v0.2 consumer can parse every valid fixture.
- Every non-reserved Markdown concept in the valid fixture has a non-empty `type`.
- Each initial type has a documented valid example and at least one invalid fixture.
- Schema validation rejects missing UID, malformed UID, invalid lifecycle, every type-specific workflow state, every missing required field, and a mismatched type schema.
- Project-scoped and explicitly shared Research fixtures pass; missing, invalid, or conflicting Research scope fails.
- Evidence requires top-level `resource`; Bookie-only resource placement, malformed media types, and invalid or credential-bearing origin URLs fail.
- Known OKF provenance, actor, trust, freshness, and date shapes reject malformed values while unknown extensions remain accepted.
- Named cross-file rules cover broken relations, inverse mismatch, missing evidence resource, digest mismatch, immutable edit/deletion, and invalid decision supersession.
- Unknown custom frontmatter is accepted and declared preservable.
- The example profile contains no secrets or environment-specific credentials.
- Profile compatibility rules explain additive minor and breaking major changes.

## Test strategy

- Direct Ajv 8 JSON Schema 2020-12 strict-mode meta-validation and positive/negative decoded JSON fixtures.
- Table-driven required-field, wrong-type, UID, actor, enum, timestamp, Research-scope, media-type, origin, and relation examples.
- Exact invalid-fixture diagnostics include keyword, instance path, and missing property where applicable.
- OKF envelope checks for every Markdown fixture.
- Mutation fixtures comparing a base and proposed tree for each immutable-policy boundary.
- Digest fixtures containing valid bytes, changed bytes, missing files, and path escapes.

## Dependencies

- [Data model](../architecture/data-model.md)
- [ADR-0001](../architecture/decisions/0001-okf-git-canonical-store.md)
- Official [OKF v0.2 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

## Delivery notes

BK-002 delivers the profile manifest schema and decoded configuration fixtures. BK-003 delivers the common metadata and initial concept schemas with decoded fixtures, including explicit Research scope, top-level Evidence resource placement, and recognized OKF metadata shapes. BK-004 delivers exact type-prefix mapping, relation/path schema constraints, stable cross-file rule codes, and materializable decoded base/proposed policy fixtures. BK-005 delivers the complete profile reference, migration/compatibility contract, human-readable example vault, and full valid/invalid Markdown vault fixtures. The fixture test oracle schema-validates records and isolates expected rule boundaries. BK-006 in SPEC-002 consumes the format through production lossless loading, BK-007 enforces schemas plus current-tree links, relations, resources, and digests, and BK-009 verifies Git-base immutability, retained Decisions, pinned identities, and exact base resource retention.

Implement schema and fixtures before the policy engine. The YAML round-trip choice belongs to SPEC-002 and is recorded by ADR-0005 with executable preservation evidence; it is not a SPEC-001 schema constraint.
