import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("the public Pi archive includes readable release notes for its version", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "bookie-pi-changelog-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  // Root check has already built the workspaces. Avoid nesting another build here.
  const packed = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--workspace",
        "pi-bookie",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        output,
      ],
      { cwd: root, encoding: "utf8", timeout: 60_000 },
    ),
  );
  assert.equal(packed.length, 1);
  assert.ok(packed[0].files.some(({ path }) => path === "CHANGELOG.md"));
  const archive = join(output, packed[0].filename);
  const entry = (name) =>
    execFileSync("tar", ["-xOf", archive, "package/" + name], {
      encoding: "utf8",
    });
  const manifest = JSON.parse(entry("package.json"));
  assert.equal(manifest.name, "pi-bookie");
  assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
  const changelog = entry("CHANGELOG.md");
  assert.equal(
    changelog,
    await readFile(join(root, "packages/pi-extension/CHANGELOG.md"), "utf8"),
  );
  assert.ok(
    changelog.includes("## [" + manifest.version + "]"),
    "Pi selects entries by the installed package version",
  );
  assert.match(
    changelog,
    /## \[0\.3\.0\]/u,
    "Previous shipped behavior remains identifiable",
  );
});
