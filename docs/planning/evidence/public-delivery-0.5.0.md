# Confirmable lexical recall delivery, 16 November 2026

BK-048 shipped as [pi-bookie 0.5.0](https://github.com/mojomanyana/bookie-pi-skills/releases/tag/v0.5.0), with exact automatic dependency pi-bookie-core 0.3.0. [PR #59](https://github.com/mojomanyana/bookie-pi-skills/pull/59) merged reviewed head `554d027a0c1fce7e0dda294e25a52eb02b982175` as `a8b42d38e79f9cc3eb2274dfbd19bbb000acfb6b`. Their trees match (`e750838ed585b70bb1ad8f6e10a22b28b3d42651`); tag `v0.5.0` points to that merge.

[Exact-head hosted CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/43849491864) passed the full check and pinned Pi 1.5.2 lifecycle. Full checks passed **1,295 tests**, with no failures or skips: repository 464, service 323, CLI 48, core 311 and Pi 149. [Merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/43850207856) also passed. The unchanged runtime implementation previously passed the same 1,295 tests locally; release metadata then passed formatting and 15 repository/package checks. Earlier failed attempts and their corrections remain in retained logs, not counted as passes.

Core was published once and its registry bytes verified before the extension was published once. Registry propagation was polled read-only. Both npm latest tags match the release. Registry and downloaded GitHub release archives match the qualified local archives byte-for-byte and by npm integrity.

| Package | SHA-256 | Installed files verified |
| --- | --- | ---: |
| pi-bookie 0.5.0 | `ce9ce208c76fe499174b939dcf883c389a1c4dfd97fea1846cfe0a01fc539aad` | 126 |
| pi-bookie-core 0.3.0 | `f90f6d059721aa47d4fadc09dc38a4028554673a45063da07c045e41e5cc9c38` | 176 |

A disposable installation requested only `pi-bookie@0.5.0` by public npm name; core 0.3.0 resolved automatically. Every installed file matched its registry archive. The installed core candidate API passed strict-zero/partial-candidate/exact-source checks, and the installed extension passed the native Pi 1.5.2 save/choice/fresh-session fixture with released Daddy 0.57.0: three fresh sessions, deferred/selected/typed choices, both dashboard views, zero attention requests, zero external fetches and completed cleanup. Active user installations were not changed.

These native journeys use a local scripted provider; no real model, judge or JEV call was made. Lexical suggestions do not establish semantic confidence, synonym understanding or general model recall quality. Candidate confirmation remains conversational and creates no automatic durable decision or authority. Private CLI/service dependency pins advanced coherently and remain unpublished. Shared retrieval and folder migration remain outside this delivery.

Scoped command logs, CI receipts, exact source identities and archive/install verification are retained by the coordinator under `ecosystem-flexible-recovery-20261116/release/bookie`.
