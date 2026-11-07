# Public continuity delivery — 2026-11-07

BK-038 is delivered in `pi-bookie` **0.1.1** under MIT. The automatic exact
dependency remains `pi-bookie-core: 0.1.0`; core was not republished.

- [PR #43](https://github.com/mojomanyana/bookie-pi-skills/pull/43) merged the approved
  `ea48125d079b8cc54169d7a185059ccb4d2e0a71` candidate as
  `8271c037164cbc2d5666bc2a1183b83247616eca`. Both trees are exactly
  `844a0eed5fc31d1dcf8a488c6b459da8ae26d90d`.
- [Exact-head CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/42361695214)
  and [merged-main CI](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/42361962585)
  succeeded. The required local check had 1,248 passes, zero failures and zero skips.
- [Immutable release v0.1.1](https://github.com/mojomanyana/bookie-pi-skills/releases/tag/v0.1.1)
  targets that merge. The npm registry's `pi-bookie@0.1.1` archive was downloaded
  and matched the independently reviewed, paired-install-qualified archive byte for byte.
- Pi archive SHA-256:
  `1e24a323f698a8002e0ea562bf9a6b407c711560adce245650f9d6356699c8c7`.
  Core 0.1.0 remains the previously published archive, SHA-256
  `90eb68b70e2b4669deaeb969e1b94ad2868eb66218289e5264f0d56c9857fe89`.

Independent release review approved the assembled metadata/instruction candidate.
Actual Pi 1.5.0 resource loading passed separately and in the grouped ecosystem
installation, including repeated resource discovery. The optional continuity
skill and recipe add no runtime hook, permission, automatic authority restoration
or canonical-format change. These checks do not establish general live model
quality, human usability, shared retrieval completion or production qualification.

This dated record supersedes preparation-only delivery status in BK-038 and
ADR-0015's maintenance snapshot without changing historical evidence. The release
tag and published package bytes are unchanged by this documentation closeout.
BK-017 and its service/scale gates remain partial; this release does not advance them.
