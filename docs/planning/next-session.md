# Next-session handoff — 2026-10-07 UTC

This is a **snapshot, not delivery evidence**. Begin with [README](../../README.md), the [documentation map](../INDEX.md), [requirements](../product/requirements.md), [vision](../product/vision.md), [backlog](backlog.md), [open questions](open-questions.md), and the active [SPEC-004](../specs/004-retrieval-service.md) plus its accepted ADRs. For test history and the pre-handoff working-tree inventory, see [BK-017 partial evidence](evidence/BK-017.md).

## Product in one minute

Bookie is a local-first, Git-native operational knowledge ledger for people and coding agents. OKF-compatible Markdown and evidence files in Git hold projects, tasks, decisions, research, documents, people, and approved activity checkpoints. Core validates and queries them; Pi supplies explicit read/write/checkpoint workflows; the CLI supplies read/query automation. A future authenticated service will rebuild disposable Redis indexes from approved Git commits for cited team search, then add provider-neutral semantic retrieval. Agents do not silently capture conversations, auto-commit, or make Redis authoritative. Destination adapters remain demand-driven, not a prerequisite for the ledger. See [vision](../product/vision.md), [architecture](../architecture/overview.md), and [roadmap](roadmap.md).

## Where we are

- **Merged and usable locally:** canonical profile and validation, conflict-aware core writes and evidence capture, filesystem search/inspect, deterministic exact-commit JSONL export, read/query-only CLI, and Pi read/search/validate/explicit-write/approved-checkpoint tools (BK-001–BK-015). BK-016's service design and BK-017's authenticated Fastify HTTP contract are merged. CLI filesystem-writing commands remain deliberately deferred by ADR-0008. See [backlog](backlog.md) and [README](../../README.md).
- **Locally implemented but not delivered:** BK-017 projection, approved-history ingestion, read-only deployment guard, isolated source preflight, Redis candidate-store primitives, offline runtime staging/inventory, recipe assembly and output hash/descriptor evidence. These are disconnected slices; they do **not** constitute an integrated controller or live shared retrieval. See [BK-017 evidence](evidence/BK-017.md) and [service README](../../apps/service/README.md).
- **Status/scale of progress:** 18 of 24 backlog rows are marked `Done` (75% **by item count**, not by effort or acceptance criteria). A previous informal estimate of roughly 50–60% of the broader vision is subjective, not a delivery metric. BK-017 is `Ready`/partial; BK-018 and BK-020 are blocked on it; BK-019 requires BK-018 and an embedding-provider choice; BK-021/022 export adapters are deferred until real migration demand. Release 0.2 shared retrieval is not complete.

## What remains on the current BK-017 path

1. Review the accumulated local changes and choose whether to commit/PR a coherent slice or keep working on the dirty branch. Do not equate passing local tests with merged delivery.
2. Qualify a **clean-install, reproducible, immutable** runtime artifact/image. Authenticate the isolated preflight receipt and bind it to deployment-owned policy and the measured artifact before the controller uses the v2 input recipe; the current assembly helper is not an attestation or an admission path.
3. Implement the ADR-0011 bounded, authorized rebuild controller and fenced Redis **absent-output claim**, then builder-side claimed-recipe/canonical-output verification, one-time validated attachment, stored-output verification, evaluation, complete state and compare-and-set activation. Preserve unknown-outcome quarantine, cancellation, stale-owner fencing and prior serving generations.
4. Implement Redis lexical Search, citations, bounded filtering/ranking, reader leases and the remaining HTTP routes; qualify the hardened one-host deployment and initial-scale latency/security behavior. Only then assess BK-017 against [SPEC-004 acceptance](../specs/004-retrieval-service.md#acceptance-criteria). Do not start blocked BK-018/BK-020.
5. Restore Docker Desktop's WSL integration before rerunning `npm run test:redis --workspace @bookie/service` and deployment/integration checks. Obtain the OQ-007 data-owner decision before indexing any real non-public data. No Redis success, image qualification, or production behavior is claimed by the offline unit tests.

## Checkout and verification at closeout

- Branch `bk-017-redis-projection` at `a91c82c18f7c4fcce6b4d818ed2b8c47f960bee6` (same as local `main` and `origin/main` when checked); `main...HEAD` divergence `0 0`, no upstream. **62 pre-handoff uncommitted paths** are listed in [BK-017 evidence](evidence/BK-017.md#continuation-measured-offline-v2-input-assembly--2026-09-29). This handoff adds one untracked path, so **63 paths** remain uncommitted; `docs/INDEX.md` was already modified. Nothing in the local BK-017 slices was committed, pushed, or merged in this closeout. Always re-run `git status --short --untracked-files=all` for the live inventory; do not treat historical evidence lists as current. These local changes are **not saved to the remote**; a fresh clone will not have them or this handoff.
- After `pi update --extensions`, the first quality run stopped at a missing local Prettier installation. `npm ci` restored dependencies from the current lockfile; the subsequent Node `v24.19.0` **`npm run check` exited 0 with 830 passed / 0 failed / 0 skipped**, including formatting, lint and typechecking. The final run log is `/tmp/bookie-next-session-closeout-check.log` (local temporary file, not portable). No product behavior changed in this closeout. The installed Node 24 command reports npm `11.5.2` versus the [documented toolchain](toolchain.md)'s `11.9.0` baseline.
- The clean install reported **5 npm advisories (2 high, 3 moderate)**. A separate `npm audit` identifies high-severity transitive `brace-expansion` (fix available) and `undici` (reported fix requires a major update of `@earendil-works/pi-coding-agent`). No audit fix or dependency change was applied; treat these as a new security triage item rather than assuming BK-023's earlier audit evidence is still current.
- At closeout `docker info` exits 1: Docker Desktop reports WSL integration is disabled. This is an environment limitation, not a passing Redis integration check. One worktree remains (this checkout). Five local `principal/run-*` scratch branches all pointed to the same commit already merged into `main` and were deleted; historical feature branches and all remote refs were left alone. No repository-local scratch directories were found.

## First commands next session

```bash
git status --short --untracked-files=all
git rev-list --left-right --count main...HEAD
# Under the Node 24 toolchain, rerun after any environment/tooling update:
npm run check
# Once Docker works in this WSL distro:
npm run test:redis --workspace @bookie/service
```

Read [SPEC-004](../specs/004-retrieval-service.md) and [ADR-0011](../architecture/decisions/0011-bounded-rebuild-admission.md) before integrating recipe, controller or Redis primitives. Resolve a newly discovered contradiction in the normative documents first. The next accepted backlog item remains **BK-017**, not its blocked dependents. No spec, requirement or ADR drift is claimed by this handoff.
