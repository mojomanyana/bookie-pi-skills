import assert from "node:assert/strict";
import test from "node:test";
import * as drivers from "./helpers/trusted-builder-driver.mjs";
import { controllerStorageDriver } from "./helpers/controller-storage-driver.mjs";
import { trustedBuilderStages } from "../scripts/qualification-labels.mjs";

const fixture = { config: {}, commit: "a".repeat(40) };
const invalid = {
  name: "TypeError",
  message: "Trusted builder fixture mode is invalid.",
};

// These are enduring rejection behaviors, not a timing or test-count quota.
const adversarialCases = [
  "token-rotation",
  "forged-recipes",
  "cross-builder-recipe",
  "invalid-preflight-request",
  "changed-configuration",
  "path-drift",
  "input-recipe",
  "input-policy",
  "input-approval",
  "input-runtime",
  "output-status",
  "output-canonical",
  "output-concept",
  "output-order",
  "output-descriptor",
  "preflight-configuration-race",
  "build-configuration-race",
  "epoch-reauthorization",
  "preflight-deadline",
  "pre-dispatch-abort",
  "dispatched-abort",
  "operational-timeout",
];
const stages = (source) =>
  [...source.matchAll(/^stage\('([^']+)'\);$/gmu)].map((match) => match[1]);

test("fixture modes reject unknown selections and legacy boolean combinations", () => {
  for (const options of [
    { mode: "unknown" },
    null,
    [],
    { mode: undefined },
    { mode: true },
    { mode: "adversarial" },
    { adversarial: true },
    { mode: "positive", drift: true },
    { failure: "arbitrary" },
  ])
    assert.throws(
      () => drivers.trustedBuilderDriver(fixture, options),
      invalid,
    );
});

test("private controller/storage modes reject arbitrary selectors and emit only static allowlisted stages", () => {
  for (const mode of [null, true, {}, "arbitrary", "positive ", "complete"])
    assert.throws(() => controllerStorageDriver(fixture, mode), {
      name: "TypeError",
      message: "Controller storage fixture mode is invalid.",
    });
  for (const mode of ["positive", "tamper"]) {
    const source = controllerStorageDriver(fixture, mode);
    const labels = [
      ...source.matchAll(/QUALIFICATION trusted-builder stage=([a-z-]+)/gu),
    ].map((m) => m[1]);
    assert.ok(
      labels.length > 0 &&
        labels.every((s) => trustedBuilderStages.includes(s)),
    );
  }
});

test("independent named groups select every adversarial behavior exactly once", () => {
  const groups = drivers.trustedBuilderGroups;
  assert.ok(groups && Object.isFrozen(groups));
  const selected = [];
  for (const [mode, cases] of Object.entries(groups)) {
    assert.ok(Object.isFrozen(cases));
    const source = drivers.trustedBuilderDriver(fixture, { mode });
    assert.deepEqual(stages(source), [
      "startup",
      "authorized-preflight",
      ...cases,
    ]);
    selected.push(...cases);
  }
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(selected.sort(), [...adversarialCases].sort());
});

test("default positive and explicit rejection/drift modes stay distinct from negative groups", () => {
  assert.equal(
    drivers.trustedBuilderDriver(fixture),
    drivers.trustedBuilderDriver(fixture, { mode: "positive" }),
  );
  assert.deepEqual(stages(drivers.trustedBuilderDriver(fixture)), [
    "startup",
    "authorized-preflight",
    "positive-build-first",
    "positive-build-second",
    "legacy-projection",
    "canonical-export",
    "controller-composition",
  ]);
  for (const mode of ["drift", "secret-policy", "invalid-vault"])
    assert.deepEqual(stages(drivers.trustedBuilderDriver(fixture, { mode })), [
      "startup",
      "authorized-preflight",
      mode,
    ]);
});
