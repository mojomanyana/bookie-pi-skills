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
- **Evidence:** The original selection experiment parsed all 16 profile-corpus documents and retained comments, ordering, unknown nodes and scalar styles in an edit. Direct AST stringification was byte-identical for 0 of 16, motivating raw-source retention. Ongoing regression checks now exercise the production [loader](../../packages/core/test/concept-loader.test.mjs) and [mutation](../../packages/core/test/concept-mutation.test.mjs), including literal/folded values; BK-025 retired the duplicated dependency experiment.
- **Revisit trigger:** A golden mutation loses protected source structure, byte-stable untouched frontmatter within a changed concept becomes required, the v2 line becomes unmaintained, or bounded parser performance fails.
- **Owner:** Core implementer.

## OQ-003: Initial service authentication

- **State:** Resolved 2026-09-15 by [ADR-0010](../architecture/decisions/0010-service-protocol-auth-and-projection.md) with deployment-owner approval.
- **Question:** Should the first small-team deployment use per-user opaque tokens, reverse-proxy identity headers, or OIDC directly?
- **Decision:** Use standalone random opaque bearer tokens with digest-only verifier entries, expiration/revocation, constant-time comparison, separate admin credentials, and server-side per-vault scopes. Default Compose is loopback-only; remote access requires TLS ingress. A future verified reverse-proxy identity adapter may map to the same grants.
- **Revisit trigger:** An identity-aware ingress already exists, more than 15 users require centralized lifecycle, or policy requires MFA or proof of possession.
- **Owner:** Service architect and deployment owner.

## OQ-004: HTTP service framework

- **State:** Resolved 2026-09-15 by [ADR-0010](../architecture/decisions/0010-service-protocol-auth-and-projection.md) with repository-owner approval.
- **Question:** Use Node's native HTTP stack, Fastify, or another maintained minimal framework?
- **Decision:** Use the maintained Fastify major compatible with Node 24 for strict route schemas and lifecycle hooks. Bookie still owns composed cancellation, static redacted errors, safe explicit logs, dependency deadlines, and schema/plugin compatibility tests.
- **Revisit trigger:** Maintained Node 24 support, required cancellation hooks, or strict schema/error behavior regresses.
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

## OQ-012: Checkpoint preparation and sensitivity boundary

- **State:** Resolved 2026-09-14 by [ADR-0009](../architecture/decisions/0009-structured-checkpoint-preparation.md) with product-owner approval.
- **Question:** How can Pi preview and capture a mixed-sensitivity checkpoint when compaction events lack canonical Activity metadata and free-form transcript classification would expose or misclassify excluded content?
- **Decision:** Callers supply complete Activity metadata and structured sensitivity-labelled fragments. Core validates labels against the manifest, removes excluded fragments, rejects detected secrets, and renders the deterministic preview/write body. The extension may retain only prepared state for a pre-compaction approval and never derives checkpoints from raw transcripts or ordinary agent completion.
- **Revisit trigger:** A measured workflow requires transcript-derived summarization, deterministic metadata generation, or durable pending drafts across sessions.
- **Owner:** Product owner and security reviewer.

## OQ-013: Durable rebuild admission and projection identity

- **State:** Resolved 2026-09-16 by [ADR-0011](../architecture/decisions/0011-bounded-rebuild-admission.md) with explicit owner approval. Proposed and accepted on the same date; implementation and scale verification remain pending.
- **Question:** How should bounded rebuild submission create its durable idempotent controller before lengthy ingestion, when the current SPEC-004 projection ID includes the completed canonical JSONL output hash and `RedisCandidateStore.claim()` requires final concept/chunk counts?
- **Evidence:** ADR-0010 separates durable rebuild submission from the asynchronous six-hour builder and requires duplicate convergence. The local projection API derives its ID after complete export/validation/projection; the current candidate primitive claims a fully specified projection. Neither primitive by itself defines pre-admission concurrency, interruption, or a prompt durable job receipt.
- **Options considered:** Derive build identity from immutable commit/manifest/configuration/implementation inputs and retain output hashes/counts as later fenced verification evidence; or explicitly specify bounded, admission-controlled preparation before accepting a durable job, with initial-scale latency and cancellation evidence. A separate provisional job/build identity would require a deliberate protocol/state-machine design, not invented placeholder hashes or counts.
- **Decision:** Definitive input-derived IDs bound to exact commit, repository-relative vault scope, manifest, policy, and versioned runtime artifact; output hashes/counts attached once after full validation under the live fence. Keep approved tips and configuration epochs outside immutable identity. Preserve v1 fields/states under the approved assumption that no external consumer relies on experimental output-derived IDs. Ten-second admission, one bounded preflight plus one full builder, and no unbounded queue are accepted limits, not measured results. ADR-0011 records alternatives, unknown Redis outcomes, migration/rollback, and remaining scale gates.
- **Constraint:** Migrate the local output-derived recipe and final-count claim under ADR-0011/SPEC-004 with test evidence before controller exposure. Retain output hashes as mandatory verification evidence; never use placeholder manifests or unbounded synchronous ingestion. Approval does not change existing code or stored IDs.
- **Revisit trigger:** External reliance on the experimental ID algorithm is discovered, initial-scale admission/retrieval limits fail, or a real consumer requires public output-content addressing. Reopen the decision rather than weakening its guarantees.
- **Decision deadline:** Before BK-017 controller submission or HTTP rebuild wiring.
- **Owner:** Service architect and repository owner.
