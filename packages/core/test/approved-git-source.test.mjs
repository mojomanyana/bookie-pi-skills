import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveApprovedGitCommit } from "../dist/index.js";

const approvedRef = "refs/heads/approved";
const denied = { ok: false, reason: "source-not-approved" };
function git(root, args, input) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Approval Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Approval Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function graph(t, format = "sha1") {
  const root = await mkdtemp(join(tmpdir(), "bookie-approved-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["init", "-q", `--object-format=${format}`]);
  const tree = git(root, ["mktree"], "");
  const commit = (parents, message) =>
    git(
      root,
      ["commit-tree", tree, ...parents.flatMap((oid) => ["-p", oid])],
      message,
    );
  const base = commit([], "base");
  const first = commit([base], "first");
  const side = commit([base], "side");
  const tip = commit([first, side], "merge");
  git(root, ["update-ref", approvedRef, tip]);
  return { root, base, first, side, tip, tree, commit };
}
const resolve = (source, oid, rollbackWindow = 0, extra = {}) =>
  resolveApprovedGitCommit(source.root, {
    sourceRef: oid,
    approvedRef,
    rollbackWindow,
    ...extra,
  });

test("approval accepts only full exact tip or bounded first-parent commits in both object formats", async (t) => {
  for (const format of ["sha1", "sha256"]) {
    const g = await graph(t, format);
    for (const [oid, distance] of [
      [g.tip, 0],
      [g.first, 1],
      [g.base, 2],
    ]) {
      assert.deepEqual(await resolve(g, oid, distance), {
        ok: true,
        sourceCommit: oid,
        approvedTip: g.tip,
      });
      if (distance > 0)
        assert.deepEqual(await resolve(g, oid, distance - 1), denied);
    }
    assert.deepEqual(await resolve(g, g.side, 1024), denied);
    assert.deepEqual(await resolve(g, g.tree, 1024), denied);
    for (const oid of [
      "HEAD",
      g.tip.slice(0, 12),
      g.tip.toUpperCase(),
      `${g.tip}\n`,
      "0".repeat(g.tip.length),
      `${g.tip}^`,
    ]) {
      assert.deepEqual(await resolve(g, oid, 2), denied);
    }
  }
});

test("approval resolves a local full ref once; annotated tags work and malformed/missing/non-commit refs fail", async (t) => {
  const g = await graph(t);
  git(g.root, [
    "-c",
    "user.name=Approval Test",
    "-c",
    "user.email=test@example.invalid",
    "tag",
    "-a",
    "approved",
    "-m",
    "approved",
    g.tip,
  ]);
  assert.equal(
    (await resolve(g, g.tip, 0, { approvedRef: "refs/tags/approved" })).ok,
    true,
  );
  git(g.root, ["update-ref", "refs/tags/tree", g.tree]);
  for (const ref of ["refs/tags/tree", "refs/heads/missing"]) {
    assert.deepEqual(await resolve(g, g.tip, 0, { approvedRef: ref }), denied);
  }
  for (const ref of [
    "HEAD",
    "approved",
    "--help",
    "refs/heads/approved~1",
    "refs/heads/a\n",
    "refs/replace/a",
  ]) {
    await assert.rejects(() => resolve(g, g.tip, 0, { approvedRef: ref }), {
      name: "TypeError",
      message: "Git approval request is invalid.",
    });
  }
  for (const window of [-1, 1025, 1.5, Infinity, "2"]) {
    await assert.rejects(
      () => resolve(g, g.tip, window),
      /Git approval request is invalid/u,
    );
  }
  await assert.rejects(
    () => resolve(g, g.tip, 0, { callerApproved: true }),
    /Git approval request is invalid/u,
  );
});

test("a missing literal approved ref cannot resolve through Git name guessing", async (t) => {
  const g = await graph(t);
  git(g.root, ["update-ref", "-d", approvedRef]);
  git(g.root, ["update-ref", `refs/tags/${approvedRef}`, g.tip]);
  // rev-parse guesses this differently named tag; deployment did not approve it.
  assert.equal(git(g.root, ["rev-parse", `${approvedRef}^{commit}`]), g.tip);
  assert.deepEqual(await resolve(g, g.tip), denied);
});

test("approval pins the ref before traversal and a later call reevaluates the moved tip", async (t) => {
  const g = await graph(t);
  const cp = createRequire(import.meta.url)("node:child_process");
  const original = cp.spawn;
  let resolutions = 0;
  const mock = t.mock.method(cp, "spawn", function (command, args, options) {
    const child = original(command, args, options);
    if (args.includes("show-ref") && args.includes(approvedRef)) {
      resolutions++;
      child.once("close", () =>
        git(g.root, ["update-ref", approvedRef, g.side]),
      );
    }
    return child;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await resolve(g, g.first, 1), {
      ok: true,
      sourceCommit: g.first,
      approvedTip: g.tip,
    });
    assert.equal(resolutions, 1);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await resolve(g, g.first, 1), denied);
});

test("raw first parents ignore replacement/graft/shallow graph rewrites; missing required objects fail closed", async (t) => {
  const g = await graph(t);
  const forged = g.commit([g.side], "forged lineage");
  git(g.root, ["replace", g.tip, forged]);
  await mkdir(join(g.root, ".git/info"), { recursive: true });
  await writeFile(join(g.root, ".git/info/grafts"), `${g.tip} ${g.side}\n`);
  await writeFile(join(g.root, ".git/shallow"), `${g.tip}\n`);
  assert.deepEqual(await resolve(g, g.side, 1), denied);
  assert.equal((await resolve(g, g.first, 1)).ok, true);
  // Raw object proof must read and hash the requested ancestor, not just see its ID in a parent header.
  await rm(join(g.root, ".git/objects", g.first.slice(0, 2), g.first.slice(2)));
  assert.deepEqual(await resolve(g, g.first, 1), denied);
  assert.equal((await resolve(g, g.tip)).ok, true);
});

test("approval sanitizes inherited Git selectors and cancellation reasons", async (t) => {
  const g = await graph(t);
  const foreign = await graph(t);
  const keys = {
    GIT_DIR: join(foreign.root, ".git"),
    GIT_WORK_TREE: foreign.root,
    GIT_OBJECT_DIRECTORY: join(foreign.root, ".git/objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(foreign.root, ".git/objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/PRIVATE_MARKER",
  };
  const saved = new Map(
    Object.keys(keys).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, keys);
  try {
    assert.equal((await resolve(g, g.first, 1)).ok, true);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const controller = new AbortController();
  controller.abort("PRIVATE_MARKER");
  await assert.rejects(
    () => resolve(g, g.tip, 0, { signal: controller.signal }),
    (error) =>
      error.name === "AbortError" && !error.message.includes("PRIVATE_MARKER"),
  );
  const active = new AbortController();
  const pending = resolve(g, g.base, 2, { signal: active.signal });
  active.abort("PRIVATE_MARKER");
  await assert.rejects(() => pending, { name: "AbortError" });
  assert.deepEqual(
    await resolveApprovedGitCommit("/PRIVATE_MARKER/missing", {
      sourceRef: g.tip,
      approvedRef,
      rollbackWindow: 0,
    }),
    denied,
  );
});

test("approval rejects oversized and hash-corrupt commit objects without exposing object bytes", async (t) => {
  const g = await graph(t);
  const huge = g.commit([], "PRIVATE_MARKER".repeat(100_000));
  git(g.root, ["update-ref", approvedRef, huge]);
  assert.deepEqual(await resolve(g, huge), denied);
  // Git cat-file itself does not verify object identity on every read.
  git(g.root, ["update-ref", approvedRef, g.tip]);
  const { deflateSync } = await import("node:zlib");
  const bytes = Buffer.from(
    `tree ${g.tree}\nparent ${g.side}\nauthor Test <a@b> 0 +0000\ncommitter Test <a@b> 0 +0000\n\nPRIVATE_MARKER\n`,
  );
  await rm(join(g.root, ".git/objects", g.tip.slice(0, 2), g.tip.slice(2)));
  await writeFile(
    join(g.root, ".git/objects", g.tip.slice(0, 2), g.tip.slice(2)),
    deflateSync(
      Buffer.concat([Buffer.from(`commit ${bytes.length}\0`), bytes]),
    ),
  );
  assert.deepEqual(await resolve(g, g.side, 1), denied);
  assert.deepEqual(await resolve(g, g.tip), denied);
});
