# Next-session handoff — 2026-10-08 UTC

## Development status

The behavior-preserving refactor in [BK-025](evidence/BK-025.md) is implemented and independently reviewed. A clean Node 24 install and full quality check passed all 822 cases. The cleanup removes 810 net source/test lines and repeated build work. No dependency major, public API, canonical format or feature scope changed.

Branch `bk-017-redis-projection` contains the retrieval build foundations and the shared-code/build refactor. The branch is based on `a91c82c18f7c4fcce6b4d818ed2b8c47f960bee6`. These changes are pending PR review and merge; BK-017 and BK-025 remain Ready until their delivery evidence is recorded. Use `git log main..HEAD` and `git status --short` for the current commit and checkout state.

Read [README](../../README.md), [AGENTS](../../AGENTS.md), the [backlog](backlog.md), [open questions](open-questions.md), [SPEC-004](../specs/004-retrieval-service.md) and its cited ADRs before feature work. [BK-017 evidence](evidence/BK-017.md) retains the earlier implementation history.

## Product status

Canonical loading/validation/mutation/evidence, exact-commit export, read/query CLI and approved Pi write/checkpoint workflows are available. BK-017's authenticated HTTP contract is merged. Its projection, ingestion, deployment guard, source preflight, runtime staging/inventory, recipe and output-descriptor primitives remain local, disconnected work. Passing offline tests does not complete shared retrieval.

The next feature remains BK-017. The new opt-in `npm run test:runtime --workspace @bookie/service` builds/qualifies one reproducible clean-install immutable local-image profile; see [current partial evidence](evidence/BK-017.md) for actual verification and limitations. It leaves trusted recipe/controller paths disconnected. The collective whole-baseline semantic review is complete and confirmed the descendant-mount alias repair. Its remaining strict projection-config and optional-dependency precedence findings now have test-first repairs and fresh image qualification; independent review of this repaired candidate is the next gate. The old runtime digest is historical, not the current packaged-byte identity (see partial evidence). After review, connect trusted authorized preflight and builder-side input/output comparison, implement the bounded authorized controller and fenced absent-output claim/attachment lifecycle, verify builder recipe and actual output, then implement Redis search, citations, activation/rollback and deployment/scale qualification. BK-018/BK-020 remain blocked; embedding/provider and destination work has not been activated.

Real Redis and hardened deployment suites were not rerun for the earlier behavior-preserving cleanup. Current runtime-image qualification verification is recorded separately in BK-017 evidence and does not qualify Redis, production Compose or scale. The previous handoff reported Docker Desktop WSL integration unavailable; check the live environment before attempting those suites. OQ-007 approval is still required before indexing real non-public data. Earlier dependency-advisory findings remain a separate triage item; this cleanup did not refresh dependencies or run an audit.

## Resume commands

```bash
git status --short --untracked-files=all
git rev-list --left-right --count main...HEAD
nvm use
npm run check
```

`npm run check` includes typechecking through one forced project-reference build and retains all package/Pi installation checks. The retrieval foundations and refactor are separate commits. The next delivery step is PR review; no merge, tag or publication is recorded for BK-025.
