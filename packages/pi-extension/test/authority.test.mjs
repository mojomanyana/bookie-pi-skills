import {
  modelContext,
  authorizeDisclosure,
  labelFixture,
} from "./disclosure-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withRootMutationQueue } from "../../core/dist/concept-mutation-filesystem.js";
import registerBookie from "../dist/index.js";

function extension() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  registerBookie({
    registerTool: (t) => tools.set(t.name, t),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
  });
  return { tools, commands, handlers };
}

test("model arguments cannot assert write or checkpoint approval", async () => {
  const { tools } = extension();
  for (const name of ["bookie_write", "bookie_checkpoint"]) {
    const tool = tools.get(name);
    assert.equal(tool.parameters.properties.approval, undefined);
    await assert.rejects(
      tool.execute(
        "spoof",
        {
          vault: "/unread",
          requestPath: "/unread",
          action: "create",
          timing: "now",
          approval: "explicit",
        },
        undefined,
        undefined,
        { cwd: "/", hasUI: false },
      ),
      /approval|authority/iu,
    );
  }
});

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "bookie-authority-"));
  const vault = join(dir, "vault");
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    vault,
    { recursive: true },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  await labelFixture(vault);
  const ext = extension();
  const ctx = modelContext({
    cwd: dir,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: { notify() {}, confirm: async () => true },
  });
  const request = {
    path: "projects/fixture/activities/routine.md",
    frontmatter: {
      type: "Activity",
      title: "Routine summary",
      status: "stable",
      generated: { by: "human:test", at: "2026-11-04T12:00:00Z" },
      bookie: {
        profile: "1.0",
        uid: "ACT-00000000000000000000000199",
        project: "/projects/fixture/project.md",
        occurred_at: "2026-11-04T12:00:00Z",
        sensitivity: "public",
      },
    },
    fragments: [
      "outcome",
      "changed-artifacts",
      "decisions",
      "evidence",
      "validation",
      "unresolved-work",
      "next-action",
    ].map((section) => ({ section, sensitivity: "public", text: "None." })),
  };
  const requestPath = join(dir, "request.json");
  await writeFile(requestPath, JSON.stringify(request));
  const args = { vault, requestPath, timing: "now" };
  async function enable() {
    const inputs = [vault, "/projects/fixture/project.md"];
    await ext.commands.get("bookie-capture").handler("", {
      ...ctx,
      ui: {
        ...ctx.ui,
        input: async () => inputs.shift(),
        select: async () => "Structured summaries",
      },
    });
  }
  await authorizeDisclosure(ext.commands, vault, ctx);
  const execute = () =>
    ext.tools
      .get("bookie_checkpoint")
      .execute("capture", args, undefined, undefined, { ...ctx, hasUI: false });
  return { dir, vault, ext, ctx, request, requestPath, args, enable, execute };
}

test("human-selected project permission permits routine checkpoints and no wider vault", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.execute(), /trusted approval|disclosure authority/);
  await f.enable();
  const otherVault = join(f.dir, "other-vault");
  await cp(f.vault, otherVault, { recursive: true });
  f.args.vault = otherVault;
  await assert.rejects(f.execute(), /trusted approval|disclosure authority/);
  f.args.vault = f.vault;
  const result = await f.execute();
  assert.match(JSON.stringify(result), /created/);
  assert.match(
    await readFile(join(f.vault, f.request.path), "utf8"),
    /Routine summary/,
  );
});

test("revocation rejects a concurrently prepared capture", async (t) => {
  const f = await setup(t);
  await f.enable();
  let enter;
  let release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const held = withRootMutationQueue(f.vault, undefined, async () => {
    enter();
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  await entered;
  const task = f.execute();
  const rejected = assert.rejects(
    task,
    /failed|revoked|expired|trusted approval/,
  );
  await f.ext.commands.get("bookie-capture").handler("off", f.ctx);
  release();
  await held;
  await rejected;
  await assert.rejects(readFile(join(f.vault, f.request.path)), {
    code: "ENOENT",
  });
});

test("project revision changes and session replacement invalidate standing permission", async (t) => {
  const f = await setup(t);
  await f.enable();
  const project = join(f.vault, "projects/fixture/project.md");
  await writeFile(
    project,
    (await readFile(project, "utf8")) + "\nChanged scope\n",
  );
  await assert.rejects(
    f.execute(),
    /project revision changed|disclosure authority/,
  );
  await f.enable();
  for (const handler of f.ext.handlers.get("session_start"))
    await handler({ reason: "fork" }, f.ctx);
  await assert.rejects(f.execute(), /trusted approval|disclosure authority/);
  await assert.rejects(readFile(join(f.vault, f.request.path)), {
    code: "ENOENT",
  });
});

test("routine internal capture stays local while other and excluded classes are not auto-approved", async (t) => {
  const f = await setup(t);
  const manifest = join(f.vault, "bookie.yaml");
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8")).replace(
      "      - public\n",
      "      - public\n      - internal\n      - confidential\n",
    ),
  );
  await authorizeDisclosure(f.ext.commands, f.vault, f.ctx);
  await f.enable();
  f.request.frontmatter.bookie.sensitivity = "confidential";
  for (const fragment of f.request.fragments)
    fragment.sensitivity = "confidential";
  await writeFile(f.requestPath, JSON.stringify(f.request));
  await assert.rejects(f.execute(), /trusted approval|disclosure authority/);
  f.request.frontmatter.bookie.sensitivity = "internal";
  for (const fragment of f.request.fragments) fragment.sensitivity = "internal";
  await writeFile(f.requestPath, JSON.stringify(f.request));
  assert.match(JSON.stringify(await f.execute()), /created/);
  assert.match(
    await readFile(join(f.vault, f.request.path), "utf8"),
    /sensitivity: internal/,
  );
});

test("excluding the selected project invalidates standing capture without changing its bytes", async (t) => {
  const f = await setup(t);
  await f.enable();
  const manifest = join(f.vault, "bookie.yaml");
  await writeFile(
    manifest,
    (await readFile(manifest, "utf8"))
      .replace("      - public\n", "      - public\n      - internal\n")
      .replace("excluded_classes: []", "excluded_classes: [public]"),
  );
  f.request.frontmatter.bookie.sensitivity = "internal";
  for (const fragment of f.request.fragments) fragment.sensitivity = "internal";
  await writeFile(f.requestPath, JSON.stringify(f.request));
  await assert.rejects(
    f.execute(),
    /project revision changed|disclosure authority/,
  );
  await assert.rejects(readFile(join(f.vault, f.request.path)), {
    code: "ENOENT",
  });
});

test("all documented new-session reasons and shutdown revoke the session setting", async (t) => {
  const f = await setup(t);
  for (const reason of ["new", "resume", "fork", "reload"]) {
    await f.enable();
    for (const handler of f.ext.handlers.get("session_start"))
      await handler({ reason }, f.ctx);
    await assert.rejects(f.execute(), /trusted approval|disclosure authority/);
  }
  await f.enable();
  for (const handler of f.ext.handlers.get("session_shutdown"))
    await handler({}, f.ctx);
  await assert.rejects(f.execute(), /trusted approval|disclosure authority/);
});
