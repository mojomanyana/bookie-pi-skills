# ADR-0020: Current task scope and exact immediate-save locators

- Status: Accepted for the operator-authorized resume/read-back batch on 2026-11-16; delivered in pi-bookie 0.6.0 with unchanged exact core 0.3.0; see public-delivery evidence.
- Scope: BK-050, SPEC-003, REQ-011/014/024/025/027/034. Extends ADR-0013 and ADR-0016. BK-049/ADR-0019 belong to the independent frozen dashboard candidate and are not prerequisites.

## Decision

Always-injected managed-memory guidance must distinguish retrieved historical observations and earlier plans from current instructions and current operational prerequisites. Reconcile a past blocker with the latest trusted request and the requirements of the chosen authorized route. A stored blocker alone does not block independent authorized work. Actual current prerequisites, permissions, explicit stop conditions and still-applicable constraints remain binding. Source identity, a recent timestamp and an untrusted saved summary do not prove current applicability. Do not infer new work or bypass denied disclosure from this clarification.

An immediate successful `bookie_remember` result retains its existing status and adds `readBack: { selector: "path", value: <canonical note path> }` to model-facing content and details. This is the existing `bookie_read` input shape without a vault override. It names the exact saved target, including an already-saved idempotent result; it is not a revision pin, source hash, semantic verification or evidence that a requested read-back occurred. Use the existing guarded publication/current-authority checks and do not add a redundant post-write verification scan. The caller performs a separate current authorized read only when requested or otherwise needed, comparing the returned content with the intended note.

Pending final-reply deliveries retain their status-only result. Their eventual asynchronous save does not rewrite the earlier tool result or grant a confirmed locator early. Invalid, failed, withheld, cancelled and revoked operations return no success receipt. Existing context replay guards also apply to the locator; it does not restore permissions across sessions. Omit absolute private vault paths, content, new hashes and any verification claim from this receipt. Same-title notes keep independent content-derived identities and remain addressable.

## Compatibility and verification

This is an additive Pi extension receipt and guidance change. Keep core 0.3.0, all canonical records, save idempotency, exact/recent/candidate retrieval and pending-delivery behavior unchanged. No schema migration, automatic follow-up read, duplicate-blocker machinery, provider/model/JEV call or new research path is added. Rollback drops the locator and guidance while preserving notes.

Write tests before implementation for immediate save/read, same-title targets, idempotent retry, modified-target refusal, pending-final delivery, cancellation/denial, authority loss after publication, context replay suppression and fresh-session exact read. Verify the always-injected instruction boundary mechanically; no model behavior claim follows from string checks. Run focused and required existing suites plus a local scripted native fresh-session read-back fixture after approved regression scope. No delivery claim precedes release evidence.
