// Node/test qualification labels only. Never derive a label from fixture data,
// command arguments, dependency errors or runtime/source identity.
export const trustedBuilderGroups = Object.freeze({
  authority: Object.freeze([
    "token-rotation",
    "forged-recipes",
    "cross-builder-recipe",
    "invalid-preflight-request",
    "changed-configuration",
    "path-drift",
  ]),
  "worker-input": Object.freeze([
    "input-recipe",
    "input-policy",
    "input-approval",
    "input-runtime",
  ]),
  "output-shape": Object.freeze(["output-status", "output-canonical"]),
  "output-streams": Object.freeze(["output-concept", "output-order"]),
  "output-descriptor": Object.freeze(["output-descriptor"]),
  "configuration-message": Object.freeze([
    "preflight-configuration-race",
    "build-configuration-race",
  ]),
  "cancellation-deadline": Object.freeze([
    "epoch-reauthorization",
    "preflight-deadline",
    "pre-dispatch-abort",
    "dispatched-abort",
    "operational-timeout",
  ]),
});

export const trustedBuilderStages = Object.freeze([
  "startup",
  "authorized-preflight",
  "positive-build-first",
  "positive-build-second",
  "legacy-projection",
  "canonical-export",
  "controller-composition",
  "drift",
  "secret-policy",
  "invalid-vault",
  ...Object.values(trustedBuilderGroups).flat(),
]);
