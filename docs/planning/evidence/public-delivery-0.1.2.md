# Checkpoint recovery delivery, 9 November 2026

BK-040 shipped in [pi-bookie 0.1.2](https://github.com/mojomanyana/bookie-pi-skills/releases/tag/v0.1.2). [PR #45](https://github.com/mojomanyana/bookie-pi-skills/pull/45)
merged `0df400e998c456052d9688c4b06d5ef6325a7da3` as `e84aed09ba3f9080cf51d2a3745946da62cf88a2`. The reviewed source and merge share tree
`3b62169433af3f3f694d7772efab2bb9804ad3df`. The [pull-request check](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/42621643752) and [merged-main check](https://github.com/mojomanyana/bookie-pi-skills/actions/runs/42622260187) both passed.

The required local check passed all 1,254 tests with zero skips. An earlier parallel
check stalled in the private service's Redis fixture; that fixture passed all 20
tests in isolation. The successful full check ran with two CPUs.

One live Pi 1.5.0 trial saved a checkpoint in a selected project, stopped the parent,
resumed the same Pi session in a fresh process, and recalled the exact Activity
after selecting current access. Its governed child finished and the controller
recorded valid completion directly. The connected dashboard showed the task
move from running to settled. That observation covers this trial's workflow.

A fresh installation by public npm name verified all 50 Pi package files and all
175 files in its unchanged `pi-bookie-core@0.1.0` dependency. Actual Pi 1.5.0
loaded the installed extension and continuity skill twice. The public Pi archive
matched the live-tested archive byte-for-byte (SHA-256 `c1cda1324c3ea675bfa5473636cedb72838ce49254a0a4cb6ea55008285149af`).
Core stayed at its existing public archive. The earlier unsuccessful checkpoint
trial remains historical. BK-017 and the held work-view experiment retain their
own acceptance criteria.
