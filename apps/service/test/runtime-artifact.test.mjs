import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  chmod,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hashRuntimeArtifact,
  verifyRuntimeArtifact,
} from "../dist/runtime-artifact.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bookie-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "apps/service/dist",
    "packages/core/dist",
    "node_modules/module",
  ])
    await mkdir(join(root, path), { recursive: true });
  for (const [name, contents] of [
    ["apps/service/dist/server.js", "export default 1;"],
    ["packages/core/dist/index.js", "export default 2;"],
    ["node_modules/module/index.js", "export default 3;"],
    ["package-lock.json", '{"lockfileVersion":3}'],
    ["package.json", "{}"],
    ["apps/service/package.json", "{}"],
    ["packages/core/package.json", "{}"],
  ])
    await writeFile(join(root, name), contents);
  for (const name of schemaFiles) {
    const path = join(root, "packages/core/dist/schemas", name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ name }));
    if (
      ["bookie-common.schema.json", "service/v1/protocol.schema.json"].includes(
        name,
      )
    ) {
      const servicePath = join(root, "schemas", name);
      await mkdir(join(servicePath, ".."), { recursive: true });
      await writeFile(servicePath, JSON.stringify({ name }));
    }
  }
  return root;
}
const bad = { name: "TypeError", message: "Runtime artifact is invalid." };
const schemaFiles = [
  "bookie-common.schema.json",
  "service/v1/protocol.schema.json",
  "profile/1.0/bookie-config.schema.json",
  "export/1.0/canonical-record.schema.json",
  ...[
    "activity",
    "decision",
    "document",
    "evidence",
    "person",
    "project",
    "research",
    "task",
  ].map((type) => `types/${type}.schema.json`),
];

test("artifact inventory is byte-deterministic across relocation, and code, dependencies, lock and Node profile affect it", async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const first = await hashRuntimeArtifact(a);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await hashRuntimeArtifact(b), first);
  for (const file of [
    "apps/service/dist/server.js",
    "packages/core/dist/index.js",
    "node_modules/module/index.js",
    "package-lock.json",
    "apps/service/package.json",
    "packages/core/package.json",
  ]) {
    const old = await readFile(join(a, file));
    await writeFile(join(a, file), Buffer.concat([old, Buffer.from("!")]));
    assert.notEqual(await hashRuntimeArtifact(a), first, file);
    await writeFile(join(a, file), old);
  }
  await assert.rejects(
    hashRuntimeArtifact(a, { nodeProfile: "v24.19.1" }),
    bad,
  );
  assert.equal(await hashRuntimeArtifact(a), first);
  await mkdir(join(a, "node_modules/empty"));
  const withEmptyDirectory = await hashRuntimeArtifact(a);
  assert.notEqual(withEmptyDirectory, first);
  await mkdir(join(a, "node_modules/empty/nested"));
  assert.notEqual(await hashRuntimeArtifact(a), withEmptyDirectory);
  const withNestedDirectory = await hashRuntimeArtifact(a);
  await chmod(join(a, "node_modules/empty/nested"), 0o700);
  assert.notEqual(await hashRuntimeArtifact(a), withNestedDirectory);
  await chmod(join(a, "node_modules/empty/nested"), 0o755);
  const beforeMode = await hashRuntimeArtifact(a);
  await chmod(join(a, "node_modules/module/index.js"), 0o755);
  assert.notEqual(await hashRuntimeArtifact(a), beforeMode);
});

test("service and core schemas must be present and paired service/core bytes must agree", async (t) => {
  const root = await fixture(t);
  const first = await hashRuntimeArtifact(root);
  const rootSchema = join(root, "schemas/service/v1/protocol.schema.json");
  await writeFile(rootSchema, '{"changed":true}');
  await assert.rejects(hashRuntimeArtifact(root), bad);
  await writeFile(
    rootSchema,
    JSON.stringify({ name: "service/v1/protocol.schema.json" }),
  );
  assert.equal(await hashRuntimeArtifact(root), first);
  await rm(rootSchema);
  await assert.rejects(hashRuntimeArtifact(root), bad);
  await writeFile(
    rootSchema,
    JSON.stringify({ name: "service/v1/protocol.schema.json" }),
  );
  await rm(join(root, "packages/core/dist/schemas/types/evidence.schema.json"));
  await assert.rejects(hashRuntimeArtifact(root), bad);
  await writeFile(
    join(root, "packages/core/dist/schemas/types/evidence.schema.json"),
    JSON.stringify({ name: "types/evidence.schema.json" }),
  );
  for (const path of [
    "packages/core/dist/schemas/bookie-common.schema.json",
    "packages/core/dist/schemas/profile/1.0/bookie-config.schema.json",
  ]) {
    const original = await readFile(join(root, path));
    await rm(join(root, path));
    await assert.rejects(hashRuntimeArtifact(root), bad, path);
    await writeFile(join(root, path), original);
  }
  await writeFile(
    join(root, "schemas/bookie-common.schema.json"),
    '{"changed":true}',
  );
  await assert.rejects(hashRuntimeArtifact(root), bad);
  await writeFile(
    join(root, "schemas/bookie-common.schema.json"),
    JSON.stringify({ name: "bookie-common.schema.json" }),
  );
  await rm(
    join(
      root,
      "packages/core/dist/schemas/export/1.0/canonical-record.schema.json",
    ),
  );
  assert.match(await hashRuntimeArtifact(root), /^sha256:[0-9a-f]{64}$/);
});

test("verification rejects a changed dependency or a forged/malformed expected digest", async (t) => {
  const root = await fixture(t);
  const expected = await hashRuntimeArtifact(root);
  assert.equal(await verifyRuntimeArtifact(root, expected), expected);
  await assert.rejects(
    verifyRuntimeArtifact(root, `sha256:${"a".repeat(64)}`),
    bad,
  );
  await assert.rejects(verifyRuntimeArtifact(root, "sha256:fake"), bad);
  await writeFile(join(root, "node_modules/module/index.js"), "changed");
  await assert.rejects(verifyRuntimeArtifact(root, expected), bad);
});

test("missing runtime parts, symlinks, and bounded inventory failures reject without a digest", async (t) => {
  const root = await fixture(t);
  await rm(join(root, "node_modules/module/index.js"));
  await symlink("/etc/passwd", join(root, "node_modules/module/index.js"));
  await assert.rejects(hashRuntimeArtifact(root), bad);
  await rm(join(root, "node_modules/module/index.js"));
  await writeFile(join(root, "node_modules/module/index.js"), "ok");
  await assert.rejects(hashRuntimeArtifact(root, { maxBytes: 1 }), bad);
  await assert.rejects(hashRuntimeArtifact(root, { maxFiles: 1 }), bad);
  await rm(join(root, "packages/core/dist/index.js"));
  await assert.rejects(hashRuntimeArtifact(root), bad);
  await assert.rejects(hashRuntimeArtifact("relative"), bad);
});
