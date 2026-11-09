# Compact continuity with existing Bookie checkpoints

This recipe uses the existing Activity request format and an explicit host-side metadata helper; it adds no schema, store or model-facing tool. Use only an already selected canonical vault and Project. Saving and model disclosure require their existing independent trusted choices.

Create one bounded JSON request file inside the authorized working scope for `bookie_checkpoint`. Its top-level fields are `path`, `frontmatter` and `fragments`. The path is vault-relative, for example `projects/demo/activities/continuation-01.md`, with a safe existing parent. Supply complete Activity metadata: `type: Activity`, title, lifecycle status, generated actor/UTC time, and `bookie` profile, Activity UID, canonical `/projects/.../project.md` reference, occurred_at and declared sensitivity. Use the packaged helper below rather than inventing an actor string, UUID or timestamp. A Bookie Activity UID is `ACT-` plus a 26-character ULID, not a UUID. Valid actor forms are `human:<id>`, `process:<id>`, or `<producer>/<version>`; an automated Pi checkpoint must not claim a human author.

## Host-owned metadata

The trusted Pi controller can import this helper from the installed package:

```js
import { createCheckpointMetadata } from "pi-bookie/dist/checkpoint-metadata.js";

const metadata = createCheckpointMetadata({
  sessionId: ctx.sessionManager.getSessionId(),
});
const request = {
  path: activityPath, // Already authorized vault-relative target; safe parent exists.
  frontmatter: {
    type: "Activity",
    title,
    status: "stable",
    generated: metadata.generated,
    bookie: {
      profile: "1.0",
      uid: metadata.uid,
      project: projectPath, // Exact selected /projects/.../project.md reference.
      occurred_at: metadata.occurred_at,
      sensitivity, // Actual declared class; never inferred from prose.
    },
  },
  fragments, // The factual, classified sections below.
};
```

`ctx` is the actual trusted Pi extension/controller context, not model-authored JSON. The helper generates a process actor from that real session ID, a UTC timestamp and a cryptographically random Activity ULID. It does not discover or select a vault/Project, classify content, save a file, or grant authority. If the host cannot supply the actual session identity, keep a local checkpoint rather than fabricate one. Callers outside Pi can continue using the existing complete explicit metadata contract.

Construct metadata once and persist the complete request with exclusive-create semantics inside the authorized working scope. Reuse those exact bytes after interruption; never regenerate a target/UID to retry an unknown save. A known pre-write `input` rejection means no checkpoint was written and the request can be corrected within existing authority. A possible-mutation warning requires inspecting the exact target first. The helper's `now` and ten-byte `entropy` options exist for deterministic host tests; normal use leaves both omitted.

## Factual sections

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
