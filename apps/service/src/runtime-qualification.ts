import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  open,
  readdir,
  realpath,
  statfs,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ownDataFields } from "./closed-data.js";
import { assertReadonlyMountProfile } from "./readonly-checkout.js";
import { verifyRuntimeArtifact } from "./runtime-artifact.js";

const baseImage =
  "node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b";
const run = promisify(execFile);
function invalid(): never {
  throw new TypeError("Runtime qualification failed.");
}

/** Pure test seam only: supplied metadata never substitutes for live qualification. */
export function assertRuntimeProfile(
  mounts: string,
  status: string,
  uid: number,
  paths: readonly string[],
  profile: unknown,
  observed: Readonly<{
    node: string;
    git: string;
    gitHash: string;
    platform: string;
  }>,
): void {
  try {
    const [version, base, platform, node, git, gitHash, npm, build] =
      ownDataFields(profile, [
        "version",
        "baseImage",
        "platform",
        "node",
        "git",
        "gitHash",
        "npm",
        "build",
      ]);
    if (
      version !== 1 ||
      base !== baseImage ||
      platform !== "linux/amd64" ||
      node !== "v24.19.0" ||
      git !== "git version 2.39.5" ||
      npm !== "11.9.0" ||
      build !== "bookie-clean-workspaces-1" ||
      typeof gitHash !== "string" ||
      !/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(gitHash) ||
      observed.node !== node ||
      observed.git !== git ||
      observed.gitHash !== gitHash ||
      observed.platform !== platform
    )
      invalid();
    assertReadonlyMountProfile(mounts, status, uid, paths);
  } catch {
    invalid();
  }
}

async function readBounded(
  path: string,
  maximum: number,
  kernel = false,
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      (!kernel && (before.nlink !== 1n || before.size > BigInt(maximum)))
    )
      invalid();
    const bytes = Buffer.alloc(maximum + 1);
    let total = 0;
    while (total <= maximum) {
      const { bytesRead } = await handle.read(
        bytes,
        total,
        bytes.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maximum) invalid();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (!kernel &&
        (before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs))
    )
      invalid();
    return bytes.subarray(0, total);
  } finally {
    await handle.close();
  }
}
async function directories(path: string): Promise<void> {
  if ((await realpath(path)) !== path) invalid();
  let current = path;
  while (true) {
    if (!(await lstat(current)).isDirectory()) invalid();
    if (current === "/") break;
    current = dirname(current);
  }
}
async function ordinaryTree(root: string): Promise<void> {
  let entries = 0;
  async function walk(path: string, depth: number): Promise<void> {
    if (++entries > 100000 || depth > 64) invalid();
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const name of await readdir(path))
        await walk(join(path, name), depth + 1);
    } else if (!info.isFile() || info.nlink !== 1) invalid();
  }
  await directories(root);
  await walk(root, 0);
}

async function selectedGitDirectories(): Promise<readonly string[]> {
  const value = process.env.PATH;
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096) invalid();
  const directories: string[] = [];
  const search = value.split(":");
  if (search.length > 64) invalid();
  for (const path of search) {
    if (!path.startsWith("/") || posix.normalize(path) !== path) invalid();
    const directory = await realpath(path);
    if (directory !== path) invalid();
    directories.push(directory);
    const candidate = join(directory, "git");
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isFile() && (info.mode & 0o111) === 0) continue;
    if (!info.isFile() || candidate !== "/usr/bin/git") invalid();
    await access(candidate, constants.X_OK);
    return directories;
  }
  invalid();
}

/** Private, outside HTTP admission. Trusted host/mount administrator is required.
 * Root comes from this loaded module, never requests or a caller's mount receipt.
 * Read-only namespace checks precede reliance on the inventory (REV-003).
 */
export async function qualifyRuntime(
  expected: string,
): Promise<`sha256:${string}`> {
  try {
    if (
      arguments.length !== 1 ||
      typeof expected !== "string" ||
      !/^sha256:[a-f0-9]{64}(?![\s\S])/u.test(expected) ||
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      process.geteuid === undefined
    )
      invalid();
    const root = fileURLToPath(new URL("../../../", import.meta.url)).replace(
      /\/$/u,
      "",
    );
    const gitPath = "/usr/bin/git";
    const paths = [root, process.execPath, gitPath];
    for (const path of ["/proc/self/mountinfo", "/proc/self/status"])
      if ((await statfs(path)).type !== 0x9fa0) invalid();
    const mounts = await readBounded("/proc/self/mountinfo", 1048576, true);
    const status = await readBounded("/proc/self/status", 65536, true);
    // Fail closed before reading/executing runtime files in an unsupported namespace.
    assertReadonlyMountProfile(
      mounts.toString("utf8"),
      status.toString("utf8"),
      process.geteuid(),
      paths,
    );
    // Ingestion invokes Git through PATH. Protect the complete search prefix so
    // a writable directory or alternate executable cannot preempt the baked Git.
    const gitDirectories = await selectedGitDirectories();
    assertReadonlyMountProfile(
      mounts.toString("utf8"),
      status.toString("utf8"),
      process.geteuid(),
      [...paths, ...gitDirectories],
    );
    for (const directory of gitDirectories) await directories(directory);
    for (const path of [process.execPath, gitPath]) {
      if (
        (await realpath(path)) !== path ||
        !(await lstat(path)).isFile() ||
        (await lstat(path)).nlink !== 1
      )
        invalid();
      await directories(dirname(path));
    }
    await ordinaryTree(root);
    const profile: unknown = JSON.parse(
      (await readBounded(join(root, "runtime-profile.json"), 4096)).toString(
        "utf8",
      ),
    );
    const { stdout } = await run(gitPath, ["--version"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeout: 2000,
      maxBuffer: 4096,
    });
    assertRuntimeProfile(
      mounts.toString("utf8"),
      status.toString("utf8"),
      process.geteuid(),
      paths,
      profile,
      {
        node: process.version,
        git: stdout.trim(),
        gitHash: `sha256:${createHash("sha256")
          .update(await readBounded(gitPath, 32 * 1024 * 1024))
          .digest("hex")}`,
        platform: "linux/amd64",
      },
    );
    const measured = await verifyRuntimeArtifact(root, expected);
    if (
      !(await readBounded("/proc/self/mountinfo", 1048576, true)).equals(mounts)
    )
      invalid();
    assertReadonlyMountProfile(
      mounts.toString("utf8"),
      (await readBounded("/proc/self/status", 65536, true)).toString("utf8"),
      process.geteuid(),
      paths,
    );
    return measured;
  } catch {
    invalid();
  }
}
