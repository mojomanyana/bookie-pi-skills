# Compact continuity with existing Bookie checkpoints

This recipe uses the existing Activity request format; it adds no new schema, store or tool. Use only an already selected canonical vault and Project. Saving and model disclosure require their existing independent trusted choices.

Create one bounded JSON request file inside the authorized working scope for `bookie_checkpoint`. Its top-level fields are `path`, `frontmatter` and `fragments`. The path is vault-relative, for example `projects/demo/activities/continuation-01.md`, with a safe existing parent. Supply complete Activity metadata: `type: Activity`, title, lifecycle status, generated actor/UTC time, and `bookie` profile, Activity UID, canonical `/projects/.../project.md` reference, occurred_at and declared sensitivity. Use a new real identity and timestamp, not this example's labels.

All seven required sections must be present, with “None” or “Not yet observed” where accurate. Every fragment has exactly `section`, `sensitivity` and `text`:

| Existing section | Compact task content |
| --- | --- |
| `outcome` | Requested outcome, current result, explicit non-goals. |
| `changed-artifacts` | Changed paths and exact owner references; “None” if unchanged. |
| `decisions` | Scoped decisions and original user source references, including replacements/revocations. |
| `evidence` | Exact result/report/research references; no duplicated transcript body. |
| `validation` | Applicable checks and accepted alternatives, their scope, missing verification. |
| `unresolved-work` | Open questions and remaining work; distinguish a blocker from a limitation. |
| `next-action` | Current phase and the next useful authorized action. |
| `source-session` (optional) | Actual available session identity and source locators. |

Labels must be declared by the vault. Routine standing capture covers only permitted public/internal summaries for the exact selected Project revision; it does not make unknown or personal data safe. Do not relabel a fragment to make it pass. Core preparation still filters excluded fragments and rejects detected secrets. The 24,000-byte checkpoint preview bound is a maximum, not a target.

Call `bookie_checkpoint` with `vault`, `requestPath` and `timing: now` for immediate capture through existing confirmation/standing permission. Use `before-compaction` only for an explicitly desired staged checkpoint; it still asks at compaction. There is no background or every-turn save.

The guarded result intentionally returns a static status, not canonical hashes. After confirmed success, a targeted `bookie_read` of the known Activity path provides the current source hash under current disclosure permission. Then `bookie_context_prepare` can pin that exact path/hash; retain the returned handle and references instead of the whole text. A later read must be complete and current before relying on it.

If the outcome is uncertain, inspect the exact known target with current authority before trying again. Do not treat a withheld result as no write, create a duplicate checkpoint, or repair missing control state. Reload restores neither capture nor disclosure grants. A compact local/session note remains the fallback; new permission is needed only for a genuinely needed operation outside current authority.
