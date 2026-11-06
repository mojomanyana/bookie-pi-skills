import { authorizeDisclosure, labelFixture } from "./disclosure-fixture.mjs";
import { pathToFileURL } from "node:url";
import * as core from "pi-bookie-core";
import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import registerBookie from "../dist/index.js";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "bookie-disclosure-")),
    vault = join(dir, "vault");
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    vault,
    { recursive: true },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  await labelFixture(vault);
  const tools = new Map(),
    commands = new Map(),
    handlers = new Map();
  registerBookie({
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (n, c) => commands.set(n, c),
    on: (n, f) => handlers.set(n, [...(handlers.get(n) || []), f]),
  });
  let endpoint = "https://api.example.invalid/v1",
    authHook = async () => {};
  const ctx = {
    cwd: dir,
    hasUI: true,
    isProjectTrusted: () => true,
    model: {
      provider: "fixture",
      id: "subject",
      api: "fixture-api",
      baseUrl: endpoint,
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => {
        await authHook();
        return { ok: true, apiKey: "secret-never-output", baseUrl: endpoint };
      },
    },
    sessionManager: { getSessionId: () => "session" },
    ui: { notify() {}, confirm: async () => true },
  };
  async function grant() {
    const inputs = [vault, "/projects/fixture/project.md"];
    await commands.get("bookie-context").handler("", {
      ...ctx,
      ui: {
        ...ctx.ui,
        input: async () => inputs.shift(),
        select: async (_, choices) =>
          choices.includes("Done") ? "Done" : choices[0],
      },
    });
  }
  const read = () =>
    tools
      .get("bookie_read")
      .execute(
        "read",
        { vault, selector: "path", value: "/projects/fixture/tasks/task.md" },
        undefined,
        undefined,
        ctx,
      );
  return {
    vault,
    ctx,
    tools,
    commands,
    handlers,
    grant,
    read,
    setEndpoint: (v) => (endpoint = v),
    setHook: (f) => (authHook = f),
  };
}
test("all tools fail closed before reading or mutating when model disclosure is absent", async (t) => {
  const f = await setup(t);
  for (const tool of f.tools.values())
    await assert.rejects(
      tool.execute(
        "blocked",
        {
          vault: f.vault,
          bundleId: "sha256:" + "a".repeat(64),
          registrationId: "sha256:" + "a".repeat(64),
          part: "final",
          requestPath: "secret-path",
          selector: "path",
          value: "secret-path",
          query: "secret-query",
          timing: "now",
          action: "create",
        },
        undefined,
        undefined,
        f.ctx,
      ),
      tool.name === "bookie_work"
        ? /Bookie work selection is unavailable or no longer authorized\./
        : /disclosure authority|Bookie consumer failed: denied/,
    );
  await f.grant();
  assert.match(JSON.stringify(await f.read()), /Fixture task/);
});
test("effective endpoint and model changes invalidate output and never expose credential material", async (t) => {
  const f = await setup(t);
  await f.grant();
  f.setEndpoint("https://other.invalid/v1");
  await assert.rejects(
    f.read(),
    (e) => /withheld/.test(e.message) && !e.message.includes("secret"),
  );
  await f.grant();
  f.ctx.model = { ...f.ctx.model, id: "different" };
  await assert.rejects(f.read(), /withheld/);
  f.setEndpoint("https://api.invalid/v1?token=private");
  await assert.rejects(f.grant(), /withheld/);
});
test("revocation after awaited provider resolution withholds body, details and errors", async (t) => {
  const f = await setup(t);
  await f.grant();
  let calls = 0;
  f.setHook(async () => {
    if (++calls === 2)
      await f.commands.get("bookie-context").handler("off", f.ctx);
  });
  await assert.rejects(f.read(), /withheld/);
});
test("search strips cross-project/global diagnostics and undeclared metadata; validation stays static", async (t) => {
  const f = await setup(t);
  await f.grant();
  const search = await f.tools
    .get("bookie_search")
    .execute(
      "search",
      { vault: f.vault, query: "Fixture" },
      undefined,
      undefined,
      f.ctx,
    );
  const value = JSON.parse(search.content[0].text).result;
  assert.equal(value.matchedCount, undefined);
  assert.equal(value.diagnostics, undefined);
  assert.ok(
    value.results.every(
      (x) =>
        x.project === "/projects/fixture/project.md" ||
        x.source.path === "/projects/fixture/project.md",
    ),
  );
  const validation = await f.tools
    .get("bookie_validate")
    .execute("validation", { vault: f.vault }, undefined, undefined, f.ctx);
  assert.equal(
    JSON.parse(validation.content[0].text).result.diagnostics,
    undefined,
  );
  await f.commands.get("bookie-context").handler("off", f.ctx);
  await assert.rejects(f.read(), /withheld/);
});

test("revoked disclosure after a successful mutation preserves local outcome and warns against blind retry", async (t) => {
  const f = await setup(t);
  await f.grant();
  const request = {
    path: "people/disclosure-success.md",
    frontmatter: {
      type: "Person",
      title: "PROTECTED MUTATION TITLE",
      status: "draft",
      generated: { by: "human:test", at: "2026-11-04T12:00:00Z" },
      bookie: {
        profile: "1.0",
        uid: "PER-00000000000000000000000301",
        created_at: "2026-11-04T12:00:00Z",
        sensitivity: "public",
      },
    },
    bodyText: "PROTECTED MUTATION BODY",
  };
  const requestPath = join(f.vault, "../mutation.json");
  await writeFile(requestPath, JSON.stringify(request));
  let calls = 0;
  f.setHook(async () => {
    if (++calls === 2)
      await f.commands.get("bookie-context").handler("off", f.ctx);
  });
  await assert.rejects(
    f.tools
      .get("bookie_write")
      .execute(
        "write",
        { vault: f.vault, requestPath, action: "create" },
        undefined,
        undefined,
        f.ctx,
      ),
    (e) =>
      /may have changed/.test(e.message) && !e.message.includes("PROTECTED"),
  );
  assert.match(
    await readFile(join(f.vault, request.path), "utf8"),
    /PROTECTED MUTATION BODY/,
  );
});
test("capture off leaves independent disclosure valid; lifecycle reset does not", async (t) => {
  const f = await setup(t);
  await f.grant();
  await f.commands.get("bookie-capture").handler("off", f.ctx);
  assert.match(JSON.stringify(await f.read()), /Fixture task/);
  for (const handler of f.handlers.get("session_start") ?? [])
    await handler({ reason: "fork" }, f.ctx);
  await assert.rejects(f.read(), /withheld/);
});

test("mutation feedback remains withheld after disclosure revocation", async (t) => {
  const f = await setup(t);
  await f.grant();
  const requestPath = join(f.vault, "../invalid-path.json");
  await writeFile(
    requestPath,
    JSON.stringify({
      path: "/PRIVATE-PATH.md",
      frontmatter: {},
      bodyText: "PRIVATE BODY",
    }),
  );
  let calls = 0;
  f.setHook(async () => {
    if (++calls === 2)
      await f.commands.get("bookie-context").handler("off", f.ctx);
  });
  await assert.rejects(
    f.tools
      .get("bookie_write")
      .execute(
        "invalid",
        { vault: f.vault, action: "create", requestPath },
        undefined,
        undefined,
        f.ctx,
      ),
    (error) => {
      assert.match(error.message, /local state may have changed/u);
      assert.doesNotMatch(
        error.message,
        /PRIVATE|request\.path|vault-relative/u,
      );
      return true;
    },
  );
});

// Load the actual compiled authority with just its core import redirected. Real
// scope/state parsing stays in core; the seam emulates an old core or a revocation
// exactly while its final asynchronous state observation is pending.
async function authorityFixture(t) {
  const f = await setup(t);
  const dir = await mkdtemp(join(tmpdir(), "bookie-authority-import-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shim = join(dir, "core.mjs"),
    factory = join(dir, "authority.mjs");
  const coreUrl = JSON.stringify(import.meta.resolve("pi-bookie-core"));
  await writeFile(
    shim,
    `import * as core from ${coreUrl}; export * from ${coreUrl};
    let hook; export const setHook=(value)=>{hook=value;};
    export async function readRecallState(...args){const result=await core.readRecallState(...args);return hook?hook(result):result;}`,
  );
  const source = await readFile(
    new URL("../dist/disclosure-authority.js", import.meta.url),
    "utf8",
  );
  assert.equal(source.split('from "pi-bookie-core"').length, 2);
  await writeFile(
    factory,
    source.replace(
      'from "pi-bookie-core"',
      `from ${JSON.stringify(pathToFileURL(shim).href)}`,
    ),
  );
  const { createDisclosureAuthority } = await import(
    pathToFileURL(factory).href
  );
  const { setHook } = await import(pathToFileURL(shim).href);
  const commands = new Map();
  const authority = createDisclosureAuthority(
    { registerCommand: (n, c) => commands.set(n, c), on() {} },
    async (root) => ({ root, assertCurrent: async () => {} }),
  );
  await authorizeDisclosure(commands, f.vault, f.ctx);
  return { ...f, authority, commands, setReadHook: setHook };
}

test("canonical authority survives metadata while default registry authority remains exact", async (t) => {
  const f = await authorityFixture(t);
  const canonical = await f.authority.capture(f.vault, f.ctx, "canonical");
  const registry = await f.authority.capture(f.vault, f.ctx);
  const state = await core.readRecallState(f.vault);
  const record = {
    producer: "fixture",
    producerInstance: "one",
    owner: { sessionId: "one", cwd: f.vault },
    operationId: "one",
    executionId: "one",
    kind: "operation-result",
    reference: {
      locator: "fixture://one",
      sha256: "a".repeat(64),
      byteLength: 1,
    },
  };
  const added = await core.registerProducerReference(
    f.vault,
    {
      project: canonical.scope.project,
      record,
      sensitivity: "public",
      expectedRevision: state.revision,
    },
    {
      assertAuthority: async () => {},
      resolveReference: async () => record.reference,
    },
  );
  assert.equal(added.ok, true);
  await canonical.assertCurrent();
  await assert.rejects(registry.assertCurrent, /withheld/);
  await assert.rejects(
    f.authority.capture(f.vault, f.ctx, "unknown"),
    /withheld/,
  );
  await f.commands.get("bookie-context").handler("off", f.ctx);
  await authorizeDisclosure(f.commands, f.vault, f.ctx);
  await assert.rejects(canonical.assertCurrent, /withheld/);
  const fresh = await f.authority.capture(f.vault, f.ctx, "canonical");
  assert.notEqual(
    fresh.binding.policyRevision,
    canonical.binding.policyRevision,
  );
  await fresh.assertCurrent();
});

test("canonical authority fails closed for absent or malformed derived identity from an older core", async (t) => {
  const f = await authorityFixture(t);
  const current = await f.authority.capture(f.vault, f.ctx, "canonical");
  for (const value of [undefined, "not-a-hash"]) {
    f.setReadHook((result) => ({ ...result, controlsRevision: value }));
    await assert.rejects(
      f.authority.capture(f.vault, f.ctx, "canonical"),
      /withheld/,
    );
    await assert.rejects(current.assertCurrent, /withheld/);
    const strict = await f.authority.capture(f.vault, f.ctx);
    await strict.assertCurrent();
  }
});

test("capture and currentness refuse grant revocation during the final recall read", async (t) => {
  for (const phase of ["capture", "assertCurrent"]) {
    await t.test(phase, async (t) => {
      const f = await authorityFixture(t);
      const ticket = await f.authority.capture(f.vault, f.ctx, "canonical");
      f.setReadHook(async (result) => {
        await f.commands.get("bookie-context").handler("off", f.ctx);
        return result;
      });
      await assert.rejects(
        phase === "capture"
          ? f.authority.capture(f.vault, f.ctx, "canonical")
          : ticket.assertCurrent(),
        /withheld/,
      );
    });
  }
});
