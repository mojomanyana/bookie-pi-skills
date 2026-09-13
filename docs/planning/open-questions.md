# Open questions

Open questions are not permission to guess. Resolve them by the listed deadline, record the decision in the appropriate ADR/specification, then mark the entry resolved without deleting its history.

## OQ-001: Project license

- **State:** Open; not blocking private development.
- **Question:** Which license applies to the Bookie code and Pi package, considering Redis client dependencies and intended distribution?
- **Current direction:** Evaluate Apache-2.0 and AGPL-3.0 implications before public release; do not add a license by assumption.
- **Decision deadline:** Before first public package or external contribution.
- **Owner:** Repository owner.

## OQ-002: YAML round-trip implementation

- **State:** Resolved 2026-08-18 by [ADR-0005](../architecture/decisions/0005-yaml-document-ast.md).
- **Question:** Which maintained TypeScript YAML library and update strategy best preserve comments, ordering, unknown fields, multiline scalars, and untouched body bytes?
- **Decision:** Use `yaml` v2 Document AST in core while retaining the original validated UTF-8 source. No-op serialization returns original bytes; future mutation edits the AST and reuses untouched body bytes. Parser types remain private to core.
- **Evidence:** [`test/yaml-roundtrip-decision.test.mjs`](../../test/yaml-roundtrip-decision.test.mjs) reproduces the corpus and synthetic-edit checks. The profile corpus parsed successfully and the edit retained comments, key order, quoting, unknown nodes, and block-scalar styles. Direct AST stringification was byte-identical for 0 of 16 corpus frontmatter documents because flow whitespace/layout was normalized, which makes retained raw source mandatory rather than optional.
- **Revisit trigger:** A golden mutation loses protected source structure, byte-stable untouched frontmatter within a changed concept becomes required, the v2 line becomes unmaintained, or bounded parser performance fails.
- **Owner:** Core implementer.

## OQ-003: Initial service authentication

- **State:** Open; blocks service protocol acceptance.
- **Question:** Should the first small-team deployment use per-user opaque tokens, reverse-proxy identity headers, or OIDC directly?
- **Current direction:** Prefer short-lived identity from a private reverse proxy if an existing identity provider is available; otherwise hashed scoped tokens.
- **Decision deadline:** Before BK-016.
- **Owner:** Service architect and deployment owner.

## OQ-004: HTTP service framework

- **State:** Open; blocks service runtime scaffolding.
- **Question:** Use Node's native HTTP stack, Fastify, or another maintained minimal framework?
- **Current direction:** Compare cancellation, schema integration, security history, observability, and dependency cost; do not choose on benchmark throughput alone.
- **Decision deadline:** Before BK-016.
- **Owner:** Service implementer.

## OQ-005: Attachment policy defaults

- **State:** Open; does not block schema shape.
- **Question:** What default direct-Git limit, Git LFS range, and external-reference threshold fit actual evidence files?
- **Current direction:** Make limits configurable and fail closed; gather one month of representative file sizes before fixing defaults.
- **Decision deadline:** Before evidence capture is released.
- **Owner:** Product owner.

## OQ-006: Default embedding deployment

- **State:** Open; provider-neutral contract is already decided.
- **Question:** Which provider/model should the first shared deployment configure by default?
- **Current direction:** Choose at deployment among Voyage AI, OpenAI-compatible, and Ollama; evaluate on the Bookie query set rather than generic benchmarks.
- **Decision deadline:** Before BK-019 provider smoke testing.
- **Owner:** Deployment owner.

## OQ-007: Indexable sensitivity classes

- **State:** Partially resolved for canonical export on 2026-09-03; provider approval remains open and blocks production indexing of non-public data.
- **Question:** Which classes may be sent to each cloud provider or local model, and who approves changes?
- **Export decision:** BK-011 exports only records with a sensitivity class declared by the source commit's manifest and not listed in `excluded_classes`. Any otherwise exportable Bookie record with missing or undeclared sensitivity fails the complete export before output with a static redacted diagnostic. Excluded records are omitted; an included record that would expose an excluded UID or path also fails rather than being silently rewritten.
- **Current provider direction:** BK-010 local filesystem reads label missing or undeclared classes and omit vault-global exclusions without treating either as provider approval. At indexing/provider boundaries, unknown classes fail closed; local models may receive a broader approved set but are not automatically trusted.
- **Decision deadline:** Export behavior is resolved before BK-011; provider approval remains due before the first real vault is indexed.
- **Owner:** Data owner/security reviewer.

## OQ-008: First destination adapter

- **State:** Deferred until real migration demand.
- **Question:** Jira, Asana, or Trello first?
- **Current direction:** Select from an actual target workspace and representative records after JSONL is stable.
- **Decision deadline:** Before BK-022.
- **Owner:** Product owner.

## OQ-009: Pre-write secret detection policy

- **State:** Resolved 2026-09-04 by [ADR-0007](../architecture/decisions/0007-fail-closed-write-secret-policy.md); export policy was resolved earlier for BK-011 on 2026-09-03.
- **Question:** Which deterministic local detectors, approval/override rules, and stable redacted diagnostic should guard complete create/amend candidates and captured Evidence resources before publication?
- **Export decision:** Canonical export uses fixed deterministic high-confidence signatures by default, returns only static `EXPORT-SECRET` at `<redacted>` on a match, and permits the low-level exact option `secretPolicy: "allow-unchecked"`. The selected policy is reported, no environment variable can opt out, and sensitivity exclusions remain mandatory. BK-011 does not expose the opt-out through CLI or Pi.
- **Write decision:** Supported write surfaces use policy-bearing core operations that scan the complete resulting concept and, for Evidence, the complete bounded staged resource before publication. ADR-0008 subsequently removed all release 0.1 CLI write surfaces without weakening this policy. Detection returns only static `WRITE-SECRET` at `<redacted>` and publishes nothing. No user-facing flag, environment variable, configuration value, prompt, or fallback may bypass detection. BK-008/BK-009 remain explicitly low-level policy-neutral primitives and may not be called directly by CLI or Pi.
- **Revisit trigger:** Measured false positives materially block normal use and an authenticated, attributable, append-only approval design has been accepted.
- **Owner:** Product owner and security reviewer.

## OQ-010: CLI authoring inputs and generated metadata

- **State:** Resolved 2026-09-04 in SPEC-002 with product-owner approval.
- **Question:** Should release 0.1 create and Evidence commands require callers to provide canonical target/resource paths, UIDs, timestamps, actors, sensitivity, media type, title, and body in a complete JSON request, or should the CLI generate any of them from flags and local defaults?
- **Decision:** Keep any future non-interactive authoring surface deterministic and thin. Init, create, amend, and Evidence capture require complete caller-supplied JSON requests and generate no path, identity, timestamp, actor, sensitivity, attachment, or Evidence metadata. ADR-0008 subsequently deferred those CLI commands; the input contract remains available for a future accepted surface.
- **Revisit trigger:** A measured automation use case cannot reasonably produce the core request, or an accepted Pi workflow needs a shared deterministic generator.
- **Owner:** Product owner.

## OQ-011: Portable vault initialization publication

- **State:** Resolved 2026-09-04 by product-owner approval of ADR-0007's rollback.
- **Question:** How shall release 0.1 publish a newly initialized vault when portable Node exposes neither atomic no-replace directory rename nor directory-relative no-follow mutation primitives that prevent a concurrently swapped destination from redirecting descendant writes?
- **Decision:** Defer every filesystem-writing CLI command. Release 0.1 CLI exposes validate, search, and inspect only. Canonical JSONL remains available through the core stream API, but file-targeted CLI export is deferred because its path-based temporary publication has the same substitution race. Existing policy-bearing core create, amend, and Evidence APIs remain reusable but are not CLI-reachable. No plain `rename()`, cooperating lock, logical marker, or narrowed same-principal race assumption substitutes for the accepted guarantees.
- **Revisit trigger:** A small audited native helper has an accepted platform/filesystem support matrix and adversarial tests for atomic no-replace publication plus directory-relative no-follow writes, or Node exposes equivalent portable primitives.
- **Owner:** Product owner and security reviewer.
