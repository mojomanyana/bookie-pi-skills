import assert from "node:assert/strict";
import test from "node:test";
import { registerDashboardChoiceControls } from "../dist/dashboard-choice-controls.js";

test("controls bind a separate private host capability and dispose pending access", async () => {
  let registration;
  let closes = 0;
  let authorizations = 0,
    renewals = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pi = {
    events: {
      emit(name, value) {
        assert.equal(name, "pi-daddy:bookie-choice-controls:v1");
        registration = value;
        value.reply({ version: 1, ok: true, close: () => closes++ });
      },
    },
  };
  const close = registerDashboardChoiceControls(pi, {
    sessionId: "one",
    cwd: "/work",
    sourceGeneration: "source",
    async access() {
      authorizations++;
      await gate;
      throw Error("PRIVATE unavailable project path");
    },
    async refresh() {
      renewals++;
    },
  });
  assert.equal(registration.sourceGeneration, "source");
  assert.equal(authorizations, 0);
  await registration.renew();
  assert.equal(renewals, 1);
  assert.equal(
    await registration.answer(
      "id",
      "revision",
      { custom: "one", option: "two" },
      () => {},
    ),
    "refused",
  );
  assert.equal(authorizations, 0);
  const pending = registration.inspect("open-choice-one", () => {});
  close();
  release();
  assert.equal(await pending, undefined);
  await registration.renew();
  assert.equal(renewals, 1);
  close();
  assert.equal(closes, 1);
  assert.equal(
    await registration.inspect("open-choice-one", () => {}),
    undefined,
  );
  assert.equal(authorizations, 1);
});
