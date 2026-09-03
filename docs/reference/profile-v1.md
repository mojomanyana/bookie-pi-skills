# Bookie profile 1.0

Bookie profile 1.0 is a portable extension of [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md). UTF-8 Markdown concepts and referenced files remain readable without Bookie. This reference summarizes the normative [SPEC-001](../specs/001-canonical-ledger.md); the specification and schemas take precedence if prose differs.

## Vault layout

A vault is an OKF bundle and Git working tree:

```text
index.md                 OKF bundle metadata
bookie.yaml              Bookie profile manifest
projects/.../*.md        project-scoped concepts
people/.../*.md          Person concepts
research/.../*.md        optional vault-shared Research
references/files/...     captured Evidence resources
```

Required root `index.md` declares exact `okf_version: "0.2"` in YAML frontmatter. Reserved files such as `index.md` and `log.md` are not Bookie concepts. Every other concept is Markdown with YAML frontmatter and a human-readable body. Git `main` is accepted shared state; indexes and exports are derived.

## Vault manifest

`bookie.yaml` is consumed as exactly one complete strict YAML 1.2 mapping and validates against [`bookie-config.schema.json`](../../schemas/profile/1.0/bookie-config.schema.json). Document-start syntax is accepted; trailing documents or content outside the one document are rejected. Its objects are strict and reject unknown keys.

| Field | Contract |
|---|---|
| `profile` | Required exact string `"1.0"`. |
| `vault.uid` | Required `VLT-` prefixed canonical ULID. |
| `vault.title` | Required non-empty display title. |
| `allowed_concept_types` | Non-empty unique subset of the eight profile types; every Bookie concept type in the vault must be listed. |
| `policy.evidence_roots` | Literal relative POSIX roots; never glob expressions. |
| `policy.exclude` | Constrained relative POSIX glob patterns. |
| `policy.sensitivity.classes` | Declared lowercase kebab-case classes. |
| `policy.sensitivity.excluded_classes` | Classes excluded from indexing, checkpoints, logs, and exports. |
| `policy.attachment_max_bytes` | Required positive safe integer applied to captured resources. |

The manifest classifies data but does not grant provider authorization. Local filesystem query may label missing or undeclared classes without granting index, embedding, logging, checkpoint, or export eligibility; provider and later-operation behavior remains governed by [OQ-007](../planning/open-questions.md#oq-007-indexable-sensitivity-classes).

## Common concept metadata

Every Bookie concept requires:

```yaml
---
type: Task
title: Example task
status: draft
generated:
  by: "human:alice"
  at: 2026-06-27T10:30:00Z
bookie:
  profile: "1.0"
  uid: TSK-01ARZ3NDEKTSV4RRFFQ69G5FAV
---
```

| Concern | Field |
|---|---|
| Concept kind | top-level `type` |
| Display name | top-level `title` |
| OKF lifecycle | top-level `status`: `draft`, `stable`, or `deprecated` |
| Current producer | top-level `generated.by` and UTC `generated.at` |
| Stable identity | `bookie.uid` |
| Profile version | `bookie.profile` |
| Workflow state | `bookie.state`, only where the type defines one |
| Project ownership | `bookie.project` |
| Sensitivity | `bookie.sensitivity` |
| Domain links | `bookie.relations` |
| Destination IDs | `bookie.external_ids` |

OKF lifecycle and Bookie workflow are independent. `generated.at` records the current content generation; it does not replace `bookie.created_at`, `bookie.occurred_at`, or `bookie.captured_at`.

Known OKF provenance, verification, freshness, usage, actor, and resource shapes are schema-validated. Unknown top-level, known-object, relation, and `bookie` extension fields remain accepted and must be preserved by writers. Untouched Markdown body bytes must also be preserved.

## Initial concept types

| Type | UID prefix | Required type-specific Bookie fields | Mutation policy |
|---|---|---|---|
| Project | `PRJ-` | `created_at`, `state` | Mutable |
| Task | `TSK-` | `project`, `created_at`, `state` | Mutable |
| Document | `DOC-` | `project`, `created_at` | Mutable |
| Research | `RSC-` | `created_at` and exactly one of `project` or `scope: shared` | Mutable |
| Decision | `DSN-` | `project`, `created_at`, `state` | Retained and superseded, not erased |
| Activity | `ACT-` | `project`, `occurred_at` | Append-only after merge |
| Evidence | `EVD-` | `project`, `captured_at`, `sha256`, `mime_type`, `supports` | Immutable after merge |
| Person | `PER-` | `created_at` | Mutable |

Workflow enums:

- Project: `active`, `paused`, `completed`, `archived`.
- Task: `proposed`, `ready`, `in_progress`, `blocked`, `done`, `cancelled`.
- Decision: `proposed`, `accepted`, `rejected`, `superseded`.

Project-scoped Research uses `bookie.project`. Vault-shared Research uses `bookie.scope: shared`; this is retrieval metadata, not authorization, and never crosses a vault.

## Paths and resources

The OKF concept ID is the bundle-relative Markdown path without `.md`; `bookie.uid` remains stable when a mutable concept moves.

`bookie.project`, relation targets, and Evidence support targets use bundle-absolute POSIX Markdown paths such as `/projects/demo/project.md`. They require one leading slash, non-empty segments, and `.md`; they reject traversal, empty segments, backslashes, colons, percent encoding, query/fragment syntax, controls, and lone surrogates. Unicode scalar values and spaces are valid. Matching is exact: no percent decoding, case folding, Unicode normalization, or host-OS normalization.

A target referenced from merged immutable Activity or Evidence is path-pinned while that record remains: it cannot move or be replaced by another UID because the source bytes cannot be amended. Profile 1.0 defines no aliases or UID-only fallback.

Evidence uses top-level OKF `resource`, for example `/references/files/source.txt`. The path must be beneath a configured evidence root and resolve inside the real vault to a singly linked tracked regular file—not a directory, symlink, hardlink alias, or submodule. Files strictly beneath an evidence root that are named by schema-valid Evidence descriptors are resource bytes rather than concepts even when a filename ends in `.md`; unreferenced Markdown remains subject to concept validation, and Bookie concept writers reject descriptor paths in those namespaces. Exact resource bytes must fit `attachment_max_bytes`; SHA-256 uses those bytes without decoding or newline normalization.

## Relations

Each relation requires `kind` and `target`; optional `target_uid` caches the resolved UID but never replaces path resolution.

| Kind | Required inverse |
|---|---|
| `part_of` | None |
| `relates_to` | `relates_to` |
| `blocks` | `blocked_by` |
| `blocked_by` | `blocks` |
| `depends_on` | None |
| `supports` | None |
| `supersedes` | `superseded_by` for Decisions; no stored inverse for immutable corrections |
| `superseded_by` | `supersedes` and Decision-only |
| `owned_by` | None |

Supersession is limited to Decision-to-Decision replacement and same-type Activity or Evidence correction. A Decision predecessor becomes `status: deprecated` and `bookie.state: superseded`; its accepted stable replacement and reciprocal relations remain in the vault. A new Activity or Evidence correction has one incoming-to-old `supersedes` edge while the predecessor remains byte-identical.

Evidence claim support is authoritative in `bookie.supports`; a mirrored relation is not required.

## Cross-file validation

Profile 1.0 defines these stable rule codes:

| Rule | Detects |
|---|---|
| `TYPE-ALLOWED` | A Bookie concept type is absent from `allowed_concept_types`. |
| `UID-UNIQUE` | Duplicate Bookie UIDs in the proposed vault. |
| `PROJECT-TARGET` | Missing, wrong-type, cross-vault, or path-replaced project target. |
| `RELATION-TARGET` | Missing target, cached UID mismatch, duplicate logical relation, invalid supersession, or pinned-target replacement. |
| `RELATION-INVERSE` | Missing, wrong, or duplicate required inverse. |
| `DECISION-SUPERSESSION` | Deletion, lifecycle, project, type, cycle, or replacement-cardinality violations. |
| `ACTIVITY-IMMUTABLE` | Edit, deletion, or rename against the Git base tree. |
| `EVIDENCE-IMMUTABLE` | Evidence descriptor edit, deletion, or rename against the Git base tree. |
| `EVIDENCE-RESOURCE` | Missing, escaping, oversized, non-regular, symlinked, multiply linked, changed, or deleted resource. |
| `EVIDENCE-DIGEST` | Exact resource bytes do not match `bookie.sha256`. |
| `EVIDENCE-SUPPORT` | Missing or path-replaced supported concept. |

`SENSITIVITY-EXCLUSION` is a deferred operation rule: excluded records and their identifiers/content must not reach indexes, checkpoints, logs, exports, embeddings, plans, receipts, or destination requests.

Schema validation is necessary but does not replace cross-file, filesystem, or Git-base validation.

## Activity checkpoints

A checkpoint is one Activity concept per approved event, not a growing journal or transcript. It records outcome, changed artifacts, decisions/evidence, test evidence, unresolved work, and source session identity when available. Once merged it is append-only. Bookie never creates checkpoints, commits, or pushes without explicit user approval.

## Compatibility and migration

Profile versions use `MAJOR.MINOR` and are exact schema identifiers.

- An implementation writes only a version it explicitly supports and validates the manifest and every concept against that exact schema.
- Within the same major version, a newer implementation may read an older minor using the older schema. Additive optional fields require a new minor schema and preservation tests.
- An older implementation encountering a newer minor may expose generic OKF read-only content, but it must not claim Bookie validation or mutate the vault unless compatibility is explicitly declared.
- Changed meaning, new required fields, enum removals, or incompatible placement require a breaking major version.
- A breaking major upgrade requires an explicit migration command and backwards-compatibility fixtures; opening a vault never migrates it implicitly.
- Merged Activity and Evidence are never rewritten merely to change `bookie.profile`. A target major profile must explicitly declare which historical schemas it accepts for legacy immutable records. Those records retain their original profile and exact bytes and validate against that historical schema; new corrections use the target profile. If the target cannot recognize every retained immutable profile, migration must refuse.

The unversioned common/type schema files are frozen as the profile 1.0 set. Before another profile generation is accepted, an ADR-backed migration increment must retain a version-addressed copy, preserve the existing 1.0 schema URIs, and define runtime selection by each record's declared profile; a future profile cannot overwrite the only historical copy.

A migration must:

1. name source and target profile versions, validate the source version, and reject mixed versions except legacy immutable versions explicitly recognized by the target profile;
2. offer a dry-run listing every changed path and loss warning;
3. preserve stable UIDs, unknown fields, body content, provenance, and exact immutable history while migrating only mutable records;
4. validate each retained immutable record against its declared historical schema and the complete proposed tree against target compatibility rules;
5. write mutable changes through normal conflict-safe canonical mutation paths without commit or push;
6. record migration evidence and leave Git rollback available.

Git rollback restores the pre-migration tree. Derived indexes and exports are rebuilt from the selected canonical commit. Profile 1.0 has no predecessor migration because it is the first accepted Bookie profile and recognizes no legacy immutable profile set.

## Authoring checklist

- Start from a schema-valid type example.
- Keep `status` separate from `bookie.state`.
- Generate the correct prefixed ULID once; never derive identity from a path.
- Use UTC ISO 8601 timestamps and standard Markdown links.
- Keep bundle paths canonical and verify targets/inverses.
- Preserve unknown frontmatter and untouched body bytes.
- Hash Evidence exact bytes and keep resources under an allowed root.
- Correct merged Activity/Evidence with a new linked record; supersede Decisions instead of erasing them.
- Run complete schema, cross-file, resource, digest, and Git-base validation before merge.
- Never place secrets in canonical records. Records assigned an excluded sensitivity class may remain canonical, but their identifiers and content must not reach diagnostics, logs, indexes, checkpoints, embeddings, or exports.
