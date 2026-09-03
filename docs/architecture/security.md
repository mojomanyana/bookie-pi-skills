# Security architecture

## Assets

- Canonical concepts and evidence resources.
- Git history and review metadata.
- Provider, service, and repository credentials.
- Sensitive project metadata.
- Retrieval indexes and query telemetry.
- Agent context assembled from retrieved records.

## Trust boundaries

```text
untrusted concept text
        |
local user/Pi --- local vault --- Git remote
        |                           |
        | authenticated request     | approved read-only checkout
        v                           v
Bookie service -----------------> Redis private network
        |
        v
external or local embedding provider
```

Git permissions authorize canonical writes. The Bookie service authorizes retrieval. Redis filters are not authorization. Separate vaults are the confidentiality boundary.

## Principal threats and controls

### Prompt injection through records

**Threat:** a retrieved concept instructs an agent to ignore policy, expose secrets, or call tools.

**Controls:** label all retrieved text as untrusted data; delimit it from system instructions; include source and trust state; cap automatic context; never derive authorization or tool policy from corpus text; add adversarial retrieval fixtures.

### Path traversal and arbitrary file access

**Threat:** crafted tool input or concept resource escapes the configured vault.

**Controls:** resolve canonical absolute paths; reject paths outside the real vault root; account for symlinks and hardlinks; use allowlisted reference roots; queue the resolved target path; test encoded, relative, absolute, symlink, and multiply-linked escapes. Read-only vault validation requires no-follow opens, rejects files with multiple links, snapshots every ancestor's device, inode, link count, mode, size, and high-resolution change/modify times around enumeration or reading, rejects encoded Markdown path separators, and rechecks deduplicated identities and real paths at completion. A platform without no-follow support fails closed. Mutation APIs still require their own queued read-modify-write window. Because portable Node lacks directory-relative `openat`/`renameat2`, OS permissions or sandboxing must prevent an uncoordinated hostile process from renaming validated ancestors between pathname syscalls; detected late races fail observably and report any canonical path that may have published.

### Concurrent lost updates

**Threat:** parallel Pi tools overwrite one another.

**Controls:** use Pi's file mutation queue for the complete read-modify-write window; validate the source hash before replacement; write to a same-filesystem temporary file and rename atomically; surface conflicts.

### Credential disclosure

**Threat:** secrets enter records, checkpoints, logs, images, or exports.

**Controls:** environment/secret-manager credentials; excluded path and sensitivity policies; pre-write and pre-index secret scanning; metadata-only query logs; hierarchical redaction of excluded concept, OKF source-resource, project, relation, support, Evidence-resource, and local-link paths; static error messages; no credential fields in canonical schemas.

### Cross-vault leakage

**Threat:** a caller queries another client or project boundary.

**Controls:** one service identity is granted explicit vaults; resolve vault scope from authentication rather than caller-supplied filters; use separate indexes/keys and checkout roots; include adversarial isolation tests; prefer separate service deployments for strong client isolation.

### Stale or poisoned indexes

**Threat:** Redis serves content not present in approved Git or from an incomplete build.

**Controls:** index only read-only approved commits; namespace generations; verify source hashes; mark completion after validation; serve one atomic active pointer; return source commit with every result.

### Malicious files and oversized input

**Threat:** parsers consume hostile documents or exhaust resources.

**Controls:** initial ingestion is Markdown plus explicitly allowed evidence types; size, chunk, depth, and timeout limits; no execution of attachments; sandbox future extractors; disclose skipped content. Evidence validation streams exact bytes through SHA-256 from one no-follow file handle and rechecks high-resolution identity metadata rather than buffering attachments. Evidence capture likewise streams into a flushed same-directory temporary, reopens it for exact digest verification, publishes the resource before its descriptor with no-replace semantics, and reports any durable orphan rather than deleting through a racy check-then-unlink rollback. CommonMark analysis rejects excessive AST container depth and sends suspicious container input to a cancellable five-second worker. The synchronous core YAML loader enforces byte/depth bounds and a hostile-input regression budget; bulk CLI/service YAML ingestion must add a cancellable worker or process deadline rather than pretending a synchronous parser can be interrupted in place.

Git-base validation reads only local commit objects through bounded, argument-vector Git plumbing. It sanitizes inherited Git repository/index/object/config selectors, disables hooks, replacement objects, and lazy object fetching, never applies worktree filters to base blobs, and never includes Git stderr or object content in diagnostics. Required files are checked against stage-zero ordinary entries at both ends of the comparison while policy still evaluates exact working-tree bytes.

### Unauthorized service or Redis access

**Threat:** exposed endpoints allow corpus extraction or mutation.

**Controls:** private Docker network; Redis ACL and no public port; authenticated service API; TLS at the private ingress/reverse proxy; least-privilege read-only canonical mount; rate limits and audit metadata.

## Sensitivity policy

The profile supports deployment-specific classes such as `public`, `internal`, and `confidential`. A deployment declares which classes may be indexed by each embedding provider; a class without provider approval fails closed at that provider boundary. Classes listed in `policy.sensitivity.excluded_classes` are excluded from indexing, checkpointing, logging, and export under REQ-026. Runtime behavior for a missing, reserved, or undeclared record class remains unresolved under OQ-007. Secrets are never a supported class.

Project membership and `bookie.scope: shared` are retrieval metadata, not confidentiality boundaries. Shared Research remains confined to its vault; cross-vault access still requires the explicit authorization design in REQ-024.

## Practical audit guarantees

The initial release provides Git attribution, pull-request review, source provenance, content hashes, CI validation, and backups. It does not provide WORM retention, signed non-repudiation, legal hold, or independent timestamp authority.

## Required security tests

- vault path and symlink escape rejection;
- immutable record modification/deletion rejection;
- digest mismatch rejection;
- cross-vault authorization isolation;
- prompt-injection content remains inert and labelled;
- credentials do not appear in logs or tool results;
- service/embedding outage is observable;
- output and ingestion limits hold at boundaries.

## Deployment checklist

- Bind Redis only to the private network.
- Configure per-user or workload service credentials.
- Mount canonical checkout read-only in the service.
- Select and document approved embedding data classes.
- Configure backups for Git and evidence resources.
- Validate exclusions before first indexing.
- Record active Git commit and embedding generation.
- Test filesystem-only degraded retrieval.
