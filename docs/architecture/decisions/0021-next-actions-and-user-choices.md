# ADR-0021: Keep next actions separate from user choices

- Status: Accepted for the owner-authorized ecosystem clarity batch on 2026-11-16; implementation and verification are tracked in BK-051.
- Scope: SPEC-003, REQ-011/012/024/025/026/034. Extends ADR-0016 and ADR-0020 without changing authority or canonical schemas.

## Decision

`bookie_remember` accepts an optional bounded `nextAction` string for the next known work step. Store it in the existing Activity **Next action** section. It neither creates an open-choice tag nor becomes a dashboard decision. It is untrusted remembered context, not permission to execute the step or a claim that prerequisites are satisfied.

Reserve `openChoice` for a concrete unresolved decision the user still owns. Already-authorized build, research, review or verification belongs in `nextAction`, not a question asking whether to proceed. A genuinely unresolved scope, budget or product decision can remain a choice. Current conversation authorization and actual prerequisites govern continuation; a saved note cannot supply missing authorization.

Bookie does not classify or delete question text heuristically, infer that an old question was answered, or manufacture a user answer. A caller that explicitly supplies a mistaken `openChoice` can still create one. Tool descriptions and always-injected continuity guidance make the distinction at the authoring boundary. Local tests establish storage and presentation mechanics, not guaranteed model compliance.

`nextAction` has at most 240 characters, excludes control characters and detected secrets, and is included in the content identity only when present. Existing calls without it retain their identities and retry behavior. Pending resource deliveries preserve it when the final reply supplies a different explicit open choice. Same-title notes and prior records remain untouched.

Authoring guidance exposes title/summary/line limits. A rejected input that never reached publication can be corrected directly. A save with uncertain or withheld confirmation still requires inspection before retry; guidance must not turn that distinct case into permission to duplicate a write.

## Compatibility and verification

This is an additive extension contract. Core remains exactly 0.3.0; there is no migration or new service/model/JEV dependency. Older extension readers can read the existing canonical Next action section. Verify next-action-only save/read/fresh-session recall without choice rows, genuine choices alongside next actions, answering only the selected choice, pending final delivery, invalid-field/secret bounds and existing authority/idempotency behavior. No publication is implied by implementation or local checks.
