# Canonical data model

## Model layers

1. **OKF v0.2 envelope** supplies concepts, Markdown bodies, links, provenance, trust, freshness, lifecycle, and optional attested computations.
2. **Bookie profile** supplies stable identity, workflow state, typed relations, project ownership, audit fields, external mappings, and evidence digests.
3. **Git** supplies content history, authorship, review, branching, and the accepted-main boundary.

Bookie must remain valid to a generic OKF consumer. Custom metadata lives under one `bookie` mapping and unknown fields are preserved.

## Identity

- OKF concept ID: bundle-relative path without `.md`.
- Bookie UID: immutable ULID with a profile-assigned type prefix: `PRJ`, `TSK`, `DOC`, `RSC`, `DSN`, `ACT`, `EVD`, or `PER` for the initial types.
- Path changes do not change the UID; however, targets referenced from merged immutable records are path-pinned until a future profile defines portable aliases or UID fallback. The exact mapping and constraint are normative in [SPEC-001](../specs/001-canonical-ledger.md#profile-10-identity-and-relation-contract).
- Links use standard Markdown paths; Bookie relation targets use bundle-absolute Markdown file paths including `.md` and may additionally cache a target UID after validation.
- External IDs are namespaced by destination and never replace the Bookie UID.

## Common concept envelope

```yaml
---
type: Task
title: Add deterministic export
description: Produce versioned JSONL from canonical records.
tags: [export]
status: stable
generated:
  by: "human:alice"
  at: 2026-06-27T10:30:00Z
sources:
  - id: accepted-design
    resource: /projects/demo/decisions/export-model.md
    title: Accepted export model
bookie:
  profile: "1.0"
  uid: TSK-01ARZ3NDEKTSV4RRFFQ69G5FAV
  project: /projects/demo/project.md
  state: in_progress
  created_at: 2026-06-27T10:30:00Z
  relations:
    - kind: blocks
      target: /projects/demo/tasks/import.md
  external_ids: {}
---
```

The body contains human-readable context, outcome, and type-specific sections. Machines must not require a heading that a type's schema does not declare.

## OKF and Bookie field separation

| Concern | Field |
|---|---|
| Concept kind | `type` |
| Display name | `title` |
| OKF lifecycle | `status`: draft, stable, deprecated |
| Current content producer | `generated` |
| Source provenance | `sources` |
| Independent confirmation | `verified` |
| Freshness deadline | `stale_after` |
| Underlying asset | `resource` |
| Stable identity | `bookie.uid` |
| Project membership | `bookie.project` |
| Explicit vault-shared Research scope | `bookie.scope: shared` |
| Task workflow | `bookie.state` |
| Domain relationships | `bookie.relations` |
| Creation/occurrence time | `bookie.created_at`, `bookie.occurred_at` |
| Destination identity | `bookie.external_ids` |

`generated.at` tracks the current content's last meaningful change. It does not replace immutable creation or occurrence timestamps.

## Initial concept types

| Type | Required Bookie fields | Mutation policy |
|---|---|---|
| Project | `uid`, `created_at`, `state` | Mutable |
| Task | `uid`, `project`, `created_at`, `state` | Mutable |
| Document | `uid`, `project`, `created_at` | Mutable |
| Research | `uid`, exactly one of `project` or `scope: shared`, `created_at` | Mutable |
| Decision | `uid`, `project`, `created_at`, `state` | Superseded, not erased |
| Activity | `uid`, `project`, `occurred_at` | Append-only after merge |
| Evidence | `uid`, `project`, `captured_at`, `sha256`, `mime_type`, `supports` | Immutable after merge |
| Person | `uid`, `created_at` | Mutable |

Project-scoped Research records carry `bookie.project`. Research shared across projects in the same vault instead carries `bookie.scope: shared`; the two fields are mutually exclusive. Shared scope is retrieval metadata, not a confidentiality boundary, and never crosses a vault.

## Typed relations

Initial relation kinds are deliberately small: `part_of`, `relates_to`, `blocks`, `blocked_by`, `depends_on`, `supports`, `supersedes`, `superseded_by`, and `owned_by`.

Relations require a kind and bundle-absolute Markdown target; an optional cached target UID must match the resolved concept. `relates_to` is symmetric, `blocks`/`blocked_by` are inverses, and Decision `supersedes`/`superseded_by` are inverses. New Activity and Evidence corrections use an incoming `supersedes` edge without modifying the immutable predecessor. Other kinds have no required inverse. The exact lexical path contract and named cross-file diagnostics are normative in [SPEC-001](../specs/001-canonical-ledger.md#profile-10-identity-and-relation-contract). New relation kinds require a profile revision, not an arbitrary writer convention.

## Lifecycle rules

- Task workflow states: `proposed`, `ready`, `in_progress`, `blocked`, `done`, `cancelled`.
- Decision states: `proposed`, `accepted`, `rejected`, `superseded`.
- Project states: `active`, `paused`, `completed`, `archived`.
- OKF `deprecated` marks a concept no longer current; it does not mean a completed task.
- A superseded decision changes to OKF `deprecated`, records `bookie.state: superseded`, and links the successor.

## Activity checkpoints

A checkpoint is one Activity concept per event, not a growing journal file. It records:

- outcome and why it matters;
- changed canonical or code artifacts;
- decisions and evidence created or referenced;
- validation/test evidence;
- unresolved work and suggested next action;
- Pi session identifier as a source descriptor when available.

The checkpoint contains a curated operational record, not a raw transcript.

## Evidence

The Evidence concept describes immutable bytes at the top-level OKF `resource`. A file beneath a configured evidence root that is named by a schema-valid Evidence descriptor is treated as resource bytes rather than a concept even when its filename ends in `.md`; unreferenced Markdown remains a concept candidate. Required digest input is the exact stored byte sequence. SHA-256 is lowercase hexadecimal. `mime_type` stores only the media type essence (`type/subtype`), without parameters or wildcards. When known, `bookie.origin` is an absolute HTTP(S) URL without embedded credentials; schema validity never authorizes dereferencing it. Creator, capture method, and source timestamp are recorded when known. `supports` points to concepts whose claims the resource substantiates.

For an external resource that cannot be captured, create a Research or Document source reference instead of claiming immutable evidence.

## Audit policy

- Git is the accepted change log.
- SPEC-002 CI validation must compare immutable concepts against the target branch and reject edits, deletion, or rename; Evidence resource bytes must also be retained and digest-verified.
- An Activity or Evidence correction creates a new same-project concept with `supersedes`; the original bytes remain unchanged and consumers follow the incoming replacement relation.
- `log.md` is a human-readable derived chronology and cannot substitute for Git or Activity records.
- Signed commits and WORM storage are outside the initial practical-audit target.

## Profile evolution

`bookie.profile` uses a major/minor string. Additive optional fields increment minor. Changed meaning, required fields, or enum removals increment major and require a migration command plus backwards-compatibility tests. Major migrations never rewrite merged Activity/Evidence merely to update the profile marker: a target profile must explicitly recognize their historical schema as legacy immutable data, or the migration refuses. New corrections use the target profile.
