import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, statfs } from "node:fs/promises";
import { posix } from "node:path";
import { beneath } from "./deployment-config.js";

export class DeploymentRejected extends Error {
  constructor() {
    super("DEPLOYMENT_REJECTED");
    this.name = "DeploymentRejected";
  }
}
function reject(): never {
  throw new DeploymentRejected();
}
interface Mount {
  readonly point: string;
  readonly root: string;
  readonly device: string;
  readonly readonly: boolean;
}
function decodePath(value: string): string {
  const escapes: Record<string, string> = {
    "040": " ",
    "011": "\t",
    "012": "\n",
    "134": "\\",
  };
  const result = value.replace(
    /\\([\s\S]{0,3})/gu,
    (_match, code: string) => escapes[code] ?? reject(),
  );
  if (
    !result.startsWith("/") ||
    posix.normalize(result) !== result ||
    result.includes("\0")
  )
    reject();
  return result;
}
function mountTable(text: string): readonly Mount[] {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > 1048576 ||
    !text.endsWith("\n") ||
    text.includes("\0")
  )
    reject();
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > 8192) reject();
  const points = new Set<string>();
  const ids = new Set<string>();
  return lines.map((line) => {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (
      fields.some((field) => field === "") ||
      separator < 6 ||
      fields.length !== separator + 4 ||
      !/^[1-9][0-9]*$/u.test(fields[0] ?? "") ||
      !/^[0-9]+$/u.test(fields[1] ?? "") ||
      !/^[0-9]+:[0-9]+$/u.test(fields[2] ?? "")
    )
      reject();
    const id = fields[0]!;
    const point = decodePath(fields[4]!);
    if (ids.has(id) || points.has(point)) reject();
    ids.add(id);
    points.add(point);
    const options = fields[5]!.split(",");
    if (
      options.filter((value) => value === "ro" || value === "rw").length !== 1
    )
      reject();
    return {
      point,
      root: decodePath(fields[3]!),
      device: fields[2]!,
      readonly: options.includes("ro"),
    };
  });
}
/** Pure parser/checker for tests; it is NOT a runtime mount receipt or authorization. */
export function assertReadonlyMountProfile(
  text: string,
  status: string,
  uid: number,
  paths: readonly string[],
): void {
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    typeof status !== "string" ||
    Buffer.byteLength(status) > 65536
  )
    reject();
  const field = (name: string): string => {
    const rows = status
      .split("\n")
      .filter((line) => line.startsWith(`${name}:`));
    if (rows.length !== 1) reject();
    return rows[0]!.slice(name.length + 1).trim();
  };
  const uids = field("Uid").split(/\s+/u);
  if (
    field("NoNewPrivs") !== "1" ||
    uids.length !== 4 ||
    uids.some((value) => value !== String(uid))
  )
    reject();
  for (const name of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"])
    if (!/^0{1,32}$/u.test(field(name))) reject();
  const mounts = mountTable(text);
  const containing = (path: string): Mount => {
    const found = mounts
      .filter((mount) => beneath(path, mount.point))
      .sort((a, b) => b.point.length - a.point.length)[0];
    if (found === undefined) reject();
    return found;
  };
  if (!containing("/").readonly || paths.length === 0) reject();
  for (const path of paths) {
    if (!path.startsWith("/") || posix.normalize(path) !== path) reject();
    // Non-mount ancestors must not be renameable through a writable parent tree.
    let ancestor = path;
    while (true) {
      if (!containing(ancestor).readonly) reject();
      if (ancestor === "/") break;
      ancestor = posix.dirname(ancestor);
    }
    const selected = containing(path);
    const filesystemPath = posix.join(
      selected.root,
      posix.relative(selected.point, path),
    );
    for (const mount of mounts) {
      if (
        !mount.readonly &&
        (beneath(mount.point, path) ||
          (mount.device === selected.device &&
            (beneath(mount.root, filesystemPath) ||
              beneath(filesystemPath, mount.root))))
      )
        reject();
    }
  }
}
async function boundedFile(
  path: string,
  maximum: number,
  kernel = false,
): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      (!kernel && (before.nlink !== 1n || before.size > BigInt(maximum)))
    )
      reject();
    const bytes = Buffer.alloc(maximum + 1);
    let total = 0;
    while (total <= maximum) {
      const { bytesRead } = await file.read(
        bytes,
        total,
        bytes.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maximum) reject();
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (!kernel &&
        (before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs))
    )
      reject();
    return bytes.subarray(0, total);
  } finally {
    await file.close();
  }
}
async function directoryIdentity(path: string): Promise<string> {
  if ((await realpath(path)) !== path) reject();
  let current = "/";
  const identities: string[] = [];
  for (const part of path.slice(1).split("/")) {
    current = posix.join(current, part);
    const stat = await lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject();
    identities.push(`${stat.dev}:${stat.ino}`);
  }
  return identities.join("/");
}
async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  reject();
}
async function metadataTree(root: string): Promise<void> {
  let entries = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 64) reject();
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (++entries > 100000) reject();
      const child = posix.join(path, entry.name);
      const stat = await lstat(child);
      if (stat.isDirectory()) await walk(child, depth + 1);
      else if (!stat.isFile() || stat.nlink !== 1) reject();
    }
  };
  await walk(root, 0);
  for (const name of [
    "commondir",
    "worktrees",
    "config.worktree",
    "objects/info/alternates",
    "objects/info/http-alternates",
  ])
    await absent(posix.join(root, name));
}
async function configKeys(bytes: Buffer): Promise<void> {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    LC_ALL: "C",
  });
  await new Promise<void>((resolve, fail) => {
    const child = spawn(
      "git",
      [
        "config",
        "--no-includes",
        "--null",
        "--name-only",
        "--file",
        "-",
        "--list",
      ],
      { cwd: "/", env, stdio: ["pipe", "pipe", "ignore"] },
    );
    let output = Buffer.alloc(0);
    let invalid = false;
    const error = (): void => {
      invalid = true;
      child.kill("SIGKILL");
    };
    child.on("error", error);
    child.stdin.on("error", error);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 65536) {
        error();
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    child.once("close", (code) => {
      if (invalid || code !== 0 || (output.length > 0 && output.at(-1) !== 0)) {
        fail(new DeploymentRejected());
        return;
      }
      const keys =
        output.length === 0
          ? []
          : output.toString("utf8").slice(0, -1).split("\0");
      const allowed =
        /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|extensions\.objectformat|user\.(?:name|email)|remote\..+\.(?:url|fetch)|branch\..+\.(?:remote|merge))(?![\s\S])/u;
      if (keys.length > 256 || keys.some((key) => !allowed.test(key)))
        fail(new DeploymentRejected());
      else resolve();
    });
    child.stdin.end(bytes);
  });
}
/** Runs only inside the deadline-bounded ingestion process. Host/mount admin is trusted. */
export async function inspectReadonlyCheckout(
  root: string,
  repositoryRoot: string,
): Promise<string> {
  try {
    if (
      process.platform !== "linux" ||
      process.geteuid === undefined ||
      !beneath(root, repositoryRoot)
    )
      reject();
    for (const path of ["/proc/self/mountinfo", "/proc/self/status"])
      if ((await statfs(path)).type !== 0x9fa0) reject();
    const mounts = await boundedFile("/proc/self/mountinfo", 1048576, true);
    const status = await boundedFile("/proc/self/status", 65536, true);
    const gitRoot = posix.join(repositoryRoot, ".git");
    assertReadonlyMountProfile(
      mounts.toString("utf8"),
      status.toString("utf8"),
      process.geteuid(),
      [repositoryRoot, root, gitRoot],
    );
    const identities = await Promise.all([
      directoryIdentity(repositoryRoot),
      directoryIdentity(root),
      directoryIdentity(gitRoot),
    ]);
    let nested = root;
    while (nested !== repositoryRoot) {
      await absent(posix.join(nested, ".git"));
      nested = posix.dirname(nested);
    }
    await metadataTree(gitRoot);
    const config = await boundedFile(posix.join(gitRoot, "config"), 65536);
    await configKeys(config);
    if (
      !(await boundedFile("/proc/self/mountinfo", 1048576, true)).equals(mounts)
    )
      reject();
    return createHash("sha256")
      .update(JSON.stringify(identities))
      .update(mounts)
      .update(config)
      .digest("hex");
  } catch {
    reject();
  }
}
