# ADR-0012: Trusted capture authority and cooperating vault writers

- Status: Accepted for implementation by the operator's ecosystem foundation authorization on 2026-11-04.
- Scope: BK-030, local Bookie Pi and core mutation only.
- Refines REQ-011/015 and SPEC-003; supersedes ADR-0009 where explicit approval could be asserted by tool parameters and where checkpoint confirmation omitted the canonical vault. Trusted checkpoint UI now names the canonical vault/project/target and filtered-input digest; external request-file paths remain hidden and credential-shaped vault paths fail closed. ADR-0007 secret checks and ADR-0008 CLI deferral remain unchanged.

## Decision

Pi confirms a resolved vault and exact immutable input snapshot through trusted host UI. Model arguments never supply authority. A human-only session command grants/revokes routine structured Activity capture for one explicit vault and Project revision. Only vault-declared, non-excluded public/internal-labelled structured summaries/evidence references qualify; semantic personal-data detection is not claimed. Other writes need individual confirmation. Session changes, revocation and changed scope invalidate permission, including queued publication. Children receive no implicit permission.

Core serializes cooperating writers through an exclusive `.bookie-write.lock` file inside the canonical vault, with private owner metadata. Existing host and in-process queues remain. Revision comparison, policy validation and atomic target publication run under this lock. A stale source returns the existing conflict result without overwriting the winner; the caller owns retention of that result. Lock contention is bounded/abortable; owners release only their own lock file. Terminated owners leave a fail-closed lock. Recovery is explicitly manual: stop all writers, establish recorded ownership/death, preserve the record if needed, remove only the selected vault lock, then retry. Age alone never authorizes recovery. The lock is transient runtime state, never a canonical concept or commit instruction.

## Boundaries and alternatives

No dependency on shared service, Redis, provider policy or Daddy. No persistent blanket allow flag, model approval token or automatic stale takeover. A local lock does not constrain arbitrary filesystem editors and does not solve ADR-0008's adversarial publication portability issue. General shell/file tools and privileged extensions remain outside this Bookie-tool boundary.

## Verification and rollback

Test spoofing, denied/no-UI writes, exact snapshot/vault binding, scoped capture, revocation/session reset, two-process serialization with a stale loser, abort and interrupted-owner refusal. Run focused tests and root check. Rollback disables standing capture or mutating tools; it must not restore a model-selectable bypass. Existing canonical records require no migration.

## Deferred

Prepared-context bundles, destination disclosure, suppression/corrections and cross-session/child policy transport remain separately tracked foundations. Bookie service BK-017 and OQ-014 are unchanged.

## Selected work-map handoff links (BK-041)

The operator may additionally grant a narrow session permission in the trusted work-map selection dialog. It authorizes adding the exact coordinator-issued reference of a successful, retained final to the declared handoff or sole required output of an explicitly selected task. This permission ends with work selection. It covers only metadata and only the selected work-map Document. Projection and amendment recheck the source, revision, selected working root and current authority. The canonical mutation uses the existing cooperating-writer lock and expected Document revision. A same-slot replay preserves the existing reference. A different result requires review of the discrepancy. Changes to other concepts and independent output judgments keep their existing authority rules.
