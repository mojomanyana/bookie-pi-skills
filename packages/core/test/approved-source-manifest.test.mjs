import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { readApprovedSourceManifest } from "../dist/index.js";

const uid = "VLT-01ARZ3NDEKTSV4RRFFQ69G5FAY";
const approvedRef = "refs/heads/approved";
const unavailable = { ok: false, reason: "manifest-unavailable" };
const invalidRequest = {
  name: "TypeError",
  message: "Source manifest request is invalid.",
};
const source = await readFile(
  new URL("../../../examples/vault/bookie.yaml", import.meta.url),
);
const hash = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function git(root, args, input) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Manifest Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Manifest Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(
  t,
  { format = "sha1", scope = "", bytes = source, mode = "100644" } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "bookie-source-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["init", "-q", `--object-format=${format}`]);
  const vault = join(root, scope);
  await mkdir(vault, { recursive: true });
  const path = scope ? `${scope}/bookie.yaml` : "bookie.yaml";
  const blob = git(root, ["hash-object", "-w", "--stdin"], bytes);
  git(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `${mode},${blob},${path}`,
  ]);
  const tree = git(root, ["write-tree"]);
  const commit = git(root, ["commit-tree", tree], "manifest only\n");
  git(root, ["update-ref", approvedRef, commit]);
  return {
    root,
    vault,
    path,
    blob,
    commit,
    request: {
      sourceRef: commit,
      approvedRef,
      rollbackWindow: 0,
      vaultUid: uid,
    },
  };
}

test("source manifest uses approved exact bytes and portable vault scope in both Git object formats", async (t) => {
  for (const format of ["sha1", "sha256"]) {
    for (const scope of ["", "nested/space vault-😀"]) {
      const f = await fixture(t, { format, scope });
      await writeFile(join(f.vault, "bookie.yaml"), "PRIVATE_DIRTY_WORKTREE");
      const result = await readApprovedSourceManifest(
        pathToFileURL(f.vault),
        f.request,
      );
      assert.equal(result.ok, true);
      assert.deepEqual(result, {
        ok: true,
        sourceCommit: f.commit,
        approvedTip: f.commit,
        objectFormat: format,
        vaultScope: scope,
        manifest: {
          vaultUid: uid,
          profile: "1.0",
          hash: hash(source),
          sensitivityClasses: ["public", "internal", "restricted"],
        },
      });
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result.manifest));
      assert.ok(Object.isFrozen(result.manifest.sensitivityClasses));
      assert.equal(
        JSON.stringify(result).includes("PRIVATE_DIRTY_WORKTREE"),
        false,
      );
      // A manifest-only commit is deliberately not a valid complete vault.
      assert.equal("complete" in result, false);
      assert.equal("buildId" in result, false);
    }
  }
});

test("manifest checks reject malformed bytes, schema, identity, unsafe modes and the byte boundary", async (t) => {
  const exact = Buffer.concat([
    source,
    Buffer.from(`#${"x".repeat(65536 - source.length - 1)}`),
  ]);
  assert.equal(exact.length, 65536);
  const good = await fixture(t, { bytes: exact });
  assert.equal(
    (await readApprovedSourceManifest(good.vault, good.request)).manifest.hash,
    hash(exact),
  );
  for (const bytes of [
    Buffer.concat([exact, Buffer.from("x")]),
    Buffer.from([0xff]),
    Buffer.from("profile: '1.0'\nprofile: '1.0'\nPRIVATE_MARKER"),
    Buffer.from("[]"),
    Buffer.from("%YAML 1.1\n---\n{}"),
    Buffer.from("value: &a [*a]"),
    Buffer.from("x: ".repeat(66) + "1"),
    Buffer.from(
      source.toString().replace(uid, "VLT-01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
    ),
  ]) {
    const f = await fixture(t, { bytes });
    assert.deepEqual(
      await readApprovedSourceManifest(f.vault, f.request),
      unavailable,
    );
  }
  for (const mode of ["120000"]) {
    const f = await fixture(t, { mode });
    assert.deepEqual(
      await readApprovedSourceManifest(f.vault, f.request),
      unavailable,
    );
  }
  const f = await fixture(t);
  await rm(join(f.root, ".git/objects", f.blob.slice(0, 2), f.blob.slice(2)));
  assert.deepEqual(
    await readApprovedSourceManifest(f.vault, f.request),
    unavailable,
  );
});

test("approval precedes manifest reads, and missing manifests never become empty success", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await readApprovedSourceManifest(f.vault, {
      ...f.request,
      sourceRef: "HEAD",
    }),
    { ok: false, reason: "source-not-approved" },
  );
  git(f.root, ["update-ref", "-d", approvedRef]);
  git(f.root, ["update-ref", `refs/tags/${approvedRef}`, f.commit]);
  assert.deepEqual(await readApprovedSourceManifest(f.vault, f.request), {
    ok: false,
    reason: "source-not-approved",
  });
  const empty = git(f.root, ["mktree"], "");
  const commit = git(f.root, ["commit-tree", empty], "empty");
  git(f.root, ["update-ref", approvedRef, commit]);
  assert.deepEqual(
    await readApprovedSourceManifest(f.vault, {
      ...f.request,
      sourceRef: commit,
    }),
    unavailable,
  );
});

test("request snapshots, malformed configuration and cancellation keep static contracts", async (t) => {
  const f = await fixture(t);
  const request = { ...f.request };
  const root = pathToFileURL(f.vault);
  const pending = readApprovedSourceManifest(root, request);
  request.sourceRef = "HEAD";
  request.vaultUid = "PRIVATE_MARKER";
  root.pathname = "/PRIVATE_MARKER";
  assert.equal((await pending).ok, true);
  const cwd = process.cwd();
  try {
    process.chdir(f.vault);
    const relativeCall = readApprovedSourceManifest(".", f.request);
    process.chdir(cwd);
    assert.equal((await relativeCall).ok, true);
  } finally {
    process.chdir(cwd);
  }
  for (const patch of [
    { unknown: true },
    { vaultUid: "bad" },
    { approvedRef: "HEAD" },
    { rollbackWindow: 1025 },
    { sourceRef: 123 },
    { signal: {} },
  ]) {
    await assert.rejects(
      () => readApprovedSourceManifest(f.vault, { ...f.request, ...patch }),
      invalidRequest,
    );
  }
  for (const immediate of [true, false]) {
    const controller = new AbortController();
    if (immediate) controller.abort("PRIVATE_MARKER");
    const call = readApprovedSourceManifest(f.vault, {
      ...f.request,
      signal: controller.signal,
    });
    if (!immediate) controller.abort("PRIVATE_MARKER");
    await assert.rejects(
      () => call,
      (error) =>
        error.name === "AbortError" &&
        !error.message.includes("PRIVATE_MARKER"),
    );
  }
});

test("Git inspection is targeted and never reads corpus blobs or mutates the repository", async (t) => {
  const f = await fixture(t, { scope: "nested" });
  const cp = createRequire(import.meta.url)("node:child_process");
  const original = cp.spawn;
  const calls = [];
  const mock = t.mock.method(cp, "spawn", function (command, args, options) {
    calls.push([...args]);
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(
      (await readApprovedSourceManifest(f.vault, f.request)).ok,
      true,
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(calls.filter((args) => args.includes("show-ref")).length, 1);
  const trees = calls.filter((args) => args.includes("ls-tree"));
  assert.equal(trees.length, 1);
  assert.ok(trees[0].at(-1).endsWith("nested/bookie.yaml"));
  assert.equal(trees[0].includes("-r"), false);
  const blobs = calls.filter(
    (args) => args.includes("cat-file") && args.includes("blob"),
  );
  assert.deepEqual(
    blobs.map((args) => args.at(-1)),
    [f.blob],
  );
  assert.equal(
    calls.some((args) => args.includes("--batch")),
    false,
  );
  assert.equal(
    calls.some((args) =>
      ["fetch", "checkout", "update-index", "commit", "push"].includes(
        args[args.indexOf("-C") + 2],
      ),
    ),
    false,
  );
});

test("manifest blob corruption is rejected even when Git can decode its bytes", async (t) => {
  const f = await fixture(t);
  const { deflateSync } = await import("node:zlib");
  const bytes = Buffer.from(source.toString().replace("Demo", "Test"));
  assert.notDeepEqual(bytes, source);
  const path = join(
    f.root,
    ".git/objects",
    f.blob.slice(0, 2),
    f.blob.slice(2),
  );
  await rm(path);
  await writeFile(
    path,
    deflateSync(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])),
  );
  assert.deepEqual(
    await readApprovedSourceManifest(f.vault, f.request),
    unavailable,
  );
});

test("approved ancestors retain their own manifest and equivalent clones retain distinct sibling scopes", async (t) => {
  const f = await fixture(t, { scope: "one" });
  await mkdir(join(f.root, "two"));
  git(f.root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `100644,${f.blob},two/bookie.yaml`,
  ]);
  const tree = git(f.root, ["write-tree"]);
  const tip = git(f.root, ["commit-tree", tree, "-p", f.commit], "siblings");
  git(f.root, ["update-ref", approvedRef, tip]);
  const ancestor = await readApprovedSourceManifest(f.vault, {
    ...f.request,
    rollbackWindow: 1,
  });
  assert.equal(ancestor.ok, true);
  assert.equal(ancestor.sourceCommit, f.commit);
  assert.equal(ancestor.approvedTip, tip);
  const first = await readApprovedSourceManifest(f.vault, {
    ...f.request,
    sourceRef: tip,
  });
  const second = await readApprovedSourceManifest(join(f.root, "two"), {
    ...f.request,
    sourceRef: tip,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.manifest.hash, second.manifest.hash);
  assert.equal(first.sourceCommit, second.sourceCommit);
  assert.notEqual(first.vaultScope, second.vaultScope);
  const cloneParent = await mkdtemp(join(tmpdir(), "bookie-manifest-clone-"));
  t.after(() => rm(cloneParent, { recursive: true, force: true }));
  await cp(f.root, join(cloneParent, "clone"), { recursive: true });
  assert.deepEqual(
    await readApprovedSourceManifest(join(cloneParent, "clone/one"), {
      ...f.request,
      sourceRef: tip,
    }),
    first,
  );
});

test("public manifest declarations expose no Git, filesystem or parser internals", async () => {
  const declaration = await readFile(
    new URL("../dist/approved-source-manifest.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(declaration, /readApprovedSourceManifest/u);
  assert.doesNotMatch(
    declaration,
    /vault-git|node:fs|yaml|ajv|SchemaValidator|GitEntry/u,
  );
});
