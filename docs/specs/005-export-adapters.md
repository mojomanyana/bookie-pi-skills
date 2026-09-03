# SPEC-005: Canonical and destination exports

## Status

In progress — canonical JSONL 1.0 is accepted for BK-011; destination planning and adapters remain deferred until real migration demand

Owner: unassigned  
Target release: 0.1 for canonical JSONL; 0.3 for destination adapters
Depends on: SPEC-002, ADR-0006

## Goal

Export Bookie concepts through one deterministic, versioned JSONL intermediate model and then map that model to Jira, Asana, and Trello with dry-run, loss reporting, stable identity, and idempotent execution.

## Non-goals

- Perfect behavioral emulation of destination tools.
- Bidirectional continuous synchronization in the initial release.
- Making an export artifact canonical.
- Writing external IDs before destination success and user approval.
- Hiding unsupported-field loss.

## Requirements

1. Define a canonical JSONL 1.0 envelope with the resolved source commit, exact concept source hash, Bookie UID/path/type/title, complete decoded frontmatter, and exact decoded Markdown body.
2. Read and completely validate one exact local Git commit; never label staged or working-tree bytes with that commit.
3. Sort records by stable UID and serialize every object recursively with deterministic key ordering, preserving array order and schema-valid scalar values.
4. Omit records assigned a manifest-excluded sensitivity class. Fail the complete export before output when any otherwise exportable record has missing or undeclared sensitivity, or would expose an excluded record's UID or path.
5. Apply deterministic local high-confidence secret detection by default before output; permit only an explicit, auditable `allow-unchecked` low-level opt-out that never weakens sensitivity policy.
6. Bound source traversal, concepts, aggregate concept/resource bytes, diagnostics, encoded output, and cancellation; invalid or incomplete snapshots produce zero JSONL bytes.
7. Separate pure mapping/planning from network execution.
8. Produce a dry-run plan containing create/update/skip/conflict actions and field-loss warnings.
9. Use Bookie UID plus recorded external ID to make reruns idempotent.
10. Never infer destructive deletes by default.
11. Write external IDs back through the canonical mutation path only after confirmed success and explicit approval.
12. Preserve an execution receipt linking destination results, canonical source commit, mapper version, and plan hash.
13. Implement Jira CSV/API, Asana CSV, and Trello API/JSON as separate adapters only after fixture mappings are approved.
14. Bound and hash attachments; disclose destination size/type limitations.

## Canonical JSONL 1.0 contract

The JSON Schema 2020-12 document at [`schemas/export/1.0/canonical-record.schema.json`](../../schemas/export/1.0/canonical-record.schema.json) is the normative record shape. Each line is one JSON object followed by LF; there is no BOM, header, blank line, or alternate newline. Empty valid exports contain zero bytes.

```json
{
  "schema_version": "1.0",
  "source_commit": "<full-lowercase-git-object-id>",
  "source_hash": "sha256:<exact-concept-blob-digest>",
  "profile": "1.0",
  "uid": "TSK-...",
  "path": "/projects/demo/tasks/example.md",
  "type": "Task",
  "title": "Example",
  "frontmatter": {},
  "body_markdown": "..."
}
```

`path` is the canonical bundle-absolute Markdown path including `.md`; the extensionless OKF concept ID is derivable and is not a second identity field. `frontmatter` contains the complete schema-valid decoded mapping, including lifecycle, workflow, typed relations, sources, Evidence metadata, external IDs, and unknown extensions. Top-level identity fields are deterministic copies produced by core and must equal their frontmatter source. `body_markdown` is the exact decoded text after the frontmatter closing delimiter. `source_hash` covers the complete original concept blob bytes, not the normalized JSON fields.

Canonical serialization recursively orders object property names by ECMAScript UTF-16 code-unit comparison, preserves array order, distinguishes absent properties from explicit `null`/empty values, uses ECMAScript JSON string/number encoding without insignificant whitespace, and preserves accepted date/timestamp strings rather than reparsing them. Records sort by exact UID. Duplicate UIDs invalidate the snapshot rather than supplying a tie-breaker.

Only schema-valid Bookie profile concepts are records; generic OKF remains portable input but is outside this export model. The source commit's manifest exclusions are not traversed. Records assigned a class in `policy.sensitivity.excluded_classes` are validated but omitted. A schema-valid Bookie record with missing or undeclared sensitivity fails the entire export with a static redacted diagnostic and zero sink calls. If any canonical field of an included record contains an omitted record's exact UID or path, including through a resolved relative local link, export likewise fails rather than silently editing the record.

Secret detection defaults to `secretPolicy: "reject-detected"` and examines every included canonical string field for the fixed high-confidence signatures in SPEC-002 before any sink call. Detection failure is static and redacted. The only opt-out is the exact programmatic value `"allow-unchecked"`; every result echoes the selected policy. It skips secret signatures only, is never selected from the environment, and is not exposed by BK-011 through CLI or Pi.

Per [ADR-0006](../architecture/decisions/0006-exact-commit-streaming-export.md), core resolves one accepted local ref once and reads only blobs reachable from that immutable commit. It never fetches or mixes index/worktree bytes into the artifact. All records are collected, validated, filtered, canonicalized, and sized before the caller's byte sink is invoked. Sink calls are sequential complete lines. A sink failure returns a static output failure and conservatively reports possibly written records/bytes; cancellation rejects with `AbortError`. Either can leave a caller-owned prefix after emission starts, so file callers stage and discard on failure before atomic publication.

## Acceptance criteria

- Two exports of the same resolved commit and limits are byte-for-byte identical, have the same SHA-256 receipt, and remain unchanged by worktree edits or ref movement after resolution.
- Every initial concept type has an export fixture whose line validates against canonical record schema 1.0.
- Complete decoded unknown fields, Unicode, explicit empty values, accepted date/timestamp strings, arrays, and exact Markdown body text survive canonicalization.
- Invalid/incomplete commits, output bounds, unclassified records, and default-detected credentials invoke the sink zero times; an explicit unchecked export succeeds and reports its policy; sink failure and cancellation disclose or document discard of a possible prefix.
- Dry-run performs no network or canonical write.
- Mapping reports every dropped, approximated, or unsupported field.
- Replaying a successful plan produces updates/skips rather than duplicate destination objects.
- A partial destination failure records successful operations, leaves failed operations retryable, and does not write uncertain IDs.
- External-ID write-back requires explicit approval and passes normal canonical validation.
- Destination credentials never appear in plans, receipts, logs, or canonical records.
- Records assigned an excluded class contribute no identifiers or content to JSONL, plans, receipts, destination requests, diagnostics, or adapter logs; an included control record still exports. Missing/undeclared sensitivity fails canonical JSONL closed before output.
- Attachment limits and unsupported relation types are visible before execution.

## Test strategy

- Golden JSONL fixtures, schema validation, deterministic byte/hash comparisons, recursive-key ordering, and 50,000-record scale coverage.
- Exact-commit tests cover refs and full SHA-1/SHA-256 IDs, nested vaults, moving refs, worktree divergence, malformed trees, local-only operation, bounds, cancellation, and sink failure.
- Mixed-sensitivity tests assert included control output plus excluded and unclassified identifier/content omission from bytes, diagnostics, and intercepted logs.
- Secret-policy tests cover every fixed signature family, structured and body assignments, placeholders, static redaction, invalid policies, default rejection, and explicit unchecked output.
- Pure adapter mapping tests using representative destination fixtures.
- Fake HTTP servers for retries, rate limits, pagination, partial failure, and idempotency.
- Receipt/plan hash tests and approval/write-back tests.
- Credential-redaction and attachment-boundary tests.
- Mixed-sensitivity export tests capture JSONL, plans, receipts, fake destination requests, diagnostics, and logs for positive inclusion and excluded-data omission.
- Optional sandbox smoke tests guarded by explicit environment configuration.

## Dependencies

- [SPEC-002](002-core-and-cli.md)
- [ADR-0006](../architecture/decisions/0006-exact-commit-streaming-export.md)
- [Canonical data model](../architecture/data-model.md)
- Destination API decisions, credentials, and representative real records.

## Delivery notes

BK-011 delivers only canonical JSONL 1.0 and its core sink API for release 0.1. BK-021 later delivers destination-independent planning and receipts; BK-022 remains deferred until OQ-008 selects an adapter from actual demand. Preserve unsupported decoded metadata in canonical JSONL rather than forcing it into lossy destination fields.
