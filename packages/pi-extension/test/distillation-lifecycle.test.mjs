import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  distillSessionCheckpoint,
  registerAutoDistill,
} from "../dist/auto-distill.js";

const decision =
  "Keep archived workshop reports for seven days after the event.";
const checkpointText = JSON.stringify({
  title: "Report retention",
  summary: decision,
});

async function fixture(t, content = [{ type: "text", text: decision }]) {
  const vault = await mkdtemp(join(tmpdir(), "bookie-distill-"));
  const previous = new Map(
    ["PI_CODING_AGENT_DIR", "PI_ECO_MODEL_FAST"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(vault, { recursive: true, force: true });
  });
  delete process.env.PI_ECO_MODEL_FAST;
  process.env.PI_CODING_AGENT_DIR = vault;
  const work = { id: "work" };
  const cheap = { id: "cheap" };
  const calls = [];
  const result = {
    stopReason: "stop",
    content: [{ type: "text", text: checkpointText }],
  };
  const ctx = {
    model: work,
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "OK." }],
          },
        },
      ],
    },
    modelRegistry: {
      find: (provider, id) =>
        provider === "demo" && id === "catalog/cheap" ? cheap : undefined,
      streamSimple(model, request) {
        calls.push({ model, prompt: request.messages[0].content[0].text });
        return { result: async () => result };
      },
    },
  };
  return { ctx, vault, calls, work, cheap, result };
}

for (const [label, content] of Object.entries({
  string: decision,
  blocks: [
    { type: "text", text: decision },
    { type: "image", data: "non-text fixture" },
  ],
})) {
  test(`distillation retains the user's decision from ${label} content`, async (t) => {
    const { ctx, vault, calls, work } = await fixture(t, content);
    const result = await distillSessionCheckpoint(ctx, vault);
    assert.equal(result.saved, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, work);
    assert.ok(calls[0].prompt.includes(`USER: ${decision}`));
    assert.ok(!calls[0].prompt.includes("non-text fixture"));
    assert.ok((await readFile(result.path, "utf8")).includes(decision));
  });
}

test("simultaneous checkpoints with the same title keep both activity files", async (t) => {
  const { ctx, vault } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01") });
  const saved = await Promise.all([
    distillSessionCheckpoint(ctx, vault),
    distillSessionCheckpoint(ctx, vault),
  ]);
  assert.ok(saved.every((entry) => entry.saved));
  assert.notEqual(saved[0].path, saved[1].path);
  const notes = await Promise.all(
    saved.map((entry) => readFile(entry.path, "utf8")),
  );
  assert.notEqual(notes[0], notes[1]);
});

for (const stopReason of ["aborted", "error", "length"]) {
  test(`distillation rejects valid-looking JSON after a provider ${stopReason}`, async (t) => {
    const { ctx, vault, result } = await fixture(t);
    result.stopReason = stopReason;
    const skipped = await distillSessionCheckpoint(ctx, vault);
    assert.deepEqual(skipped, {
      saved: false,
      reason: {
        aborted: "cancelled",
        error: "model-error",
        length: "incomplete-distillation",
      }[stopReason],
    });
    assert.deepEqual(await readdir(vault), []);
  });
}

test("an unavailable fast tier skips the checkpoint without calling the work model", async (t) => {
  const { ctx, vault, calls } = await fixture(t);
  await writeFile(
    join(vault, "ecosystem.json"),
    JSON.stringify({ models: { fast: "demo/unknown" } }),
  );
  assert.deepEqual(await distillSessionCheckpoint(ctx, vault), {
    saved: false,
    reason: "fast-model-unavailable",
  });
  assert.equal(calls.length, 0);
});

test("a configured fast tier resolves nested model IDs and overrides the configuration file", async (t) => {
  const { ctx, vault, calls, cheap } = await fixture(t);
  await writeFile(
    join(vault, "ecosystem.json"),
    JSON.stringify({ models: { fast: "demo/unknown" } }),
  );
  process.env.PI_ECO_MODEL_FAST = "demo/catalog/cheap";
  assert.equal((await distillSessionCheckpoint(ctx, vault)).saved, true);
  assert.equal(calls[0].model, cheap);
});

test("a throwing provider returns a useful failure without writing a checkpoint", async (t) => {
  const { ctx, vault } = await fixture(t);
  ctx.modelRegistry.streamSimple = () => ({
    result: async () => {
      throw new Error("synthetic provider failure");
    },
  });
  assert.deepEqual(await distillSessionCheckpoint(ctx, vault), {
    saved: false,
    reason: "model-error",
  });
  assert.deepEqual(await readdir(vault), []);
});

test("a cancelled request skips the model before dispatch", async (t) => {
  const { ctx, vault, calls } = await fixture(t);
  const skipped = await distillSessionCheckpoint(
    ctx,
    vault,
    AbortSignal.abort(),
  );
  assert.deepEqual(skipped, { saved: false, reason: "cancelled" });
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(vault), []);
});

test("modelFallbacks.fast falls back from unavailable primary to available fallback or explicit session sentinel", async (t) => {
  const { ctx, vault, calls, cheap, work } = await fixture(t);
  await writeFile(
    join(vault, "ecosystem.json"),
    JSON.stringify({
      models: { fast: "demo/unavailable" },
      modelFallbacks: { fast: ["demo/catalog/cheap", "session"] },
    }),
  );
  assert.equal((await distillSessionCheckpoint(ctx, vault)).saved, true);
  assert.equal(calls[0].model, cheap);

  await writeFile(
    join(vault, "ecosystem.json"),
    JSON.stringify({
      models: { fast: "demo/unavailable" },
      modelFallbacks: { fast: ["session"] },
    }),
  );
  assert.equal((await distillSessionCheckpoint(ctx, vault)).saved, true);
  assert.equal(calls[1].model, work);
});

test("invalid ecosystem.json fails closed without calling any model", async (t) => {
  const { ctx, vault, calls } = await fixture(t);
  for (const raw of [
    "{invalid json",
    JSON.stringify({ models: [] }),
    JSON.stringify({ bookie: { autoDistill: "false" } }),
  ]) {
    await writeFile(join(vault, "ecosystem.json"), raw);
    assert.deepEqual(await distillSessionCheckpoint(ctx, vault), {
      saved: false,
      reason: "invalid-ecosystem-config",
    });
  }
  assert.equal(calls.length, 0);
  // Also verify the session_before_compact hook itself fails closed on invalid nested fields.
  const hooks = new Map();
  const fakePi = {
    on(name, fn) {
      hooks.set(name, fn);
    },
    registerCommand() {},
  };
  let managedCalls = 0;
  registerAutoDistill(
    fakePi,
    {
      get: async () => {
        managedCalls++;
        return { vault: { root: vault } };
      },
    },
    { canManage: () => true },
    { canManage: () => true },
  );
  const compact = hooks.get("session_before_compact");
  for (const raw of [
    JSON.stringify({ models: [] }),
    JSON.stringify({ bookie: { autoDistill: "false" } }),
  ]) {
    await writeFile(join(vault, "ecosystem.json"), raw);
    await compact({ signal: undefined }, ctx);
  }
  assert.equal(managedCalls, 0);
  assert.equal(calls.length, 0);
});

test("skips a catalogued primary whose provider lacks auth and proceeds to the next working fallback", async (t) => {
  const { ctx, vault, calls, cheap } = await fixture(t);
  const unauthedPrimary = { provider: "demo", id: "catalog/unauthed" };
  ctx.modelRegistry.find = (provider, id) => {
    if (provider === "demo" && id === "catalog/unauthed")
      return unauthedPrimary;
    if (provider === "demo" && id === "catalog/cheap") return cheap;
    return undefined;
  };
  ctx.modelRegistry.hasConfiguredAuth = (model) => model === cheap;

  await writeFile(
    join(vault, "ecosystem.json"),
    JSON.stringify({
      models: { fast: "demo/catalog/unauthed" },
      modelFallbacks: { fast: ["demo/catalog/cheap", "session"] },
    }),
  );
  assert.equal((await distillSessionCheckpoint(ctx, vault)).saved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, cheap);

  // Also works with comma-separated PI_ECO_MODEL_FAST
  process.env.PI_ECO_MODEL_FAST = "demo/catalog/unauthed, demo/catalog/cheap";
  assert.equal((await distillSessionCheckpoint(ctx, vault)).saved, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, cheap);
});
