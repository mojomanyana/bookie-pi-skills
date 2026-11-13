# Managed project recall delivery, 13 November 2026

BK-047 shipped as [pi-bookie 0.4.0](https://github.com/mojomanyana/bookie-pi-skills/releases/tag/v0.4.0) with the exact automatic dependency pi-bookie-core 0.2.0. [PR #56](https://github.com/mojomanyana/bookie-pi-skills/pull/56) merged reviewed head `3deb0f48685bd934283af828a0e76683580f694e` as `801dae289677ff50f5798ecc64138db3cb31a7de`. Their trees match (`d4ee404723873a6382ed1ae914f8a2eb0b6b3eec`); tag `v0.4.0` points to that merge.

[Hosted CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/43517532704) passed both the required check and pinned Pi 1.5.2 lifecycle. The required check passed 1,290 tests, with zero failures or skips. The independently reviewed implementation's prior local check passed the same 1,290 tests; release metadata then passed formatting and 15 repository/package checks. Existing earlier failures and corrections remain in the private retained command logs, not counted as passes.

Core was published first and its registry bytes verified before publishing Bookie. Each package was submitted exactly once; registry propagation delays were polled read-only. Both npm `latest` tags matched the released versions.

| Package | SHA-256 | Installed files verified |
| --- | --- | ---: |
| pi-bookie 0.4.0 | `cea00218c493162c672baf1d0186d204da5ebfb501b9bbc53055661c2bce3f2a` | 126 |
| pi-bookie-core 0.2.0 | `b3a85a02ad7eed67709066f825a425cafd1ab0afd6276a1435be745cb2769089` | 175 |

A fresh installation requested only `pi-bookie@0.4.0` by public npm name; core 0.2.0 resolved automatically. Every installed file matched the tested public archive, and downloaded registry archives matched local archives byte-for-byte and by npm integrity. The installed extension passed the real Pi 1.5.2 save/choice/fresh-session fixture with released Daddy 0.56.3: three fresh sessions, deferred/selected/typed choices, both dashboard views, zero attention requests, zero external fetches and completed cleanup. The source candidate also passed the same lifecycle with the concurrent Daddy daily-use candidate.

These native journeys use a local scripted provider. No real model, judge or JEV calls were made; these results do not establish semantic recall, large-vault performance or general model quality. The private CLI/service dependency pins advanced coherently but those packages remain unpublished. Shared retrieval and folder migration remain deferred.

Scoped command logs, source identities, CI receipts and archive/install verification are retained by the coordinator under `ecosystem-daily-use-20261113/release/bookie`.
