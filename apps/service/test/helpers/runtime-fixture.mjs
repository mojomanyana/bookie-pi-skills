import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function fileWriter(root) {
  return async (name, contents) => {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  };
}

export async function writeRuntimeSchemas(write) {
  for (const name of [
    "bookie-common.schema.json",
    "profile/1.0/bookie-config.schema.json",
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
    "service/v1/protocol.schema.json",
  ]) {
    await write(`packages/core/dist/schemas/${name}`, JSON.stringify({ name }));
    if (
      ["bookie-common.schema.json", "service/v1/protocol.schema.json"].includes(
        name,
      )
    ) {
      await write(`schemas/${name}`, JSON.stringify({ name }));
    }
  }
}

export async function runtimeFixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = fileWriter(root);
  for (const [name, contents] of [
    ["package.json", "{}"],
    ["package-lock.json", "{}"],
    ["apps/service/package.json", "{}"],
    ["apps/service/dist/server.js", "export default 1;"],
    ["packages/core/package.json", "{}"],
    ["packages/core/dist/index.js", "export default 2;"],
    ["node_modules/module/index.js", "export default 3;"],
  ])
    await file(name, contents);
  await writeRuntimeSchemas(file);
  return { root, file };
}
