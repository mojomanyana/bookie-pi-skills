import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join, resolve } from "node:path";
import { containsDetectedSecret } from "./vault-secret-detection.js";
import {
  hashBytes,
  historyText,
  type CapturedTaskFiles,
  type TaskFileEntry,
  type TaskHistory,
} from "./task-history.js";

const maxFileBytes = 1024 * 1024;
const maxBytes = 4 * maxFileBytes;
const maxFiles = 32;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const object = /^[0-9a-f]{40}(?:[a-f0-9]{24})?$/u;
const digest = /^[0-9a-f]{64}$/u;
const protection =
  /^(?:\.git|\.pi|\.principal|\.ssh|\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12))$/iu;
export function validTaskFilePath(value: unknown): value is string {
  return (
    historyText(value, 512) &&
    !value.includes("\\") &&
    !value.includes(":") &&
    value
      .split("/")
      .every((p) => p !== "" && p !== "." && p !== ".." && !protection.test(p))
  );
}
const disappeared = (e: unknown) =>
  e instanceof Error && "code" in e && e.code === "ENOENT";
export function validTaskFileSet(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxFiles &&
    value.every(validTaskFilePath) &&
    new Set(value).size === value.length
  );
}
export async function captureTaskFiles(
  workspace: string,
  selected: string[],
  guard: () => Promise<void>,
): Promise<CapturedTaskFiles> {
  if (!validTaskFileSet(selected) || !selected.length)
    throw Error("Select up to 32 eligible relative file paths.");
  const root = await realpath(workspace);
  const blobs = new Map<string, Buffer>();
  const entries: TaskFileEntry[] = [];
  const signatures = new Map<string, string>();
  const stable = async (path: string) => {
    const current = await lstat(path, { bigint: true });
    return [
      current.dev,
      current.ino,
      current.mode,
      current.size,
      current.mtimeNs,
      current.ctimeNs,
    ].join(":");
  };
  let total = 0;
  for (const name of [...selected].sort()) {
    await guard();
    const path = resolve(root, ...name.split("/"));
    try {
      if ((await realpath(path)) !== path) {
        entries.push({ path: name, status: "excluded" });
        continue;
      }
      const stat = await lstat(path, { bigint: true });
      const before = await stable(path);
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.size > BigInt(maxFileBytes)
      ) {
        entries.push({ path: name, status: "excluded" });
        continue;
      }
      if (total + Number(stat.size) > maxBytes)
        throw Error("The selected file set exceeds the checkpoint size limit.");
      const handle = await open(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      let bytes: Buffer;
      try {
        const opened = await handle.stat({ bigint: true });
        if (
          !opened.isFile() ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino
        )
          throw Error("A tracked file changed during capture.");
        const buffer = Buffer.alloc(Number(stat.size) + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await handle.read(
            buffer,
            offset,
            buffer.length - offset,
            offset,
          );
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        if (
          offset !== Number(stat.size) ||
          (await stable(path)) !== before ||
          (await realpath(path)) !== path
        )
          throw Error("A tracked file changed during capture.");
        bytes = buffer.subarray(0, offset);
      } finally {
        await handle.close();
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        entries.push({ path: name, status: "excluded" });
        continue;
      }
      if (text.includes("\u0000") || containsDetectedSecret(text)) {
        entries.push({ path: name, status: "excluded" });
        continue;
      }
      const sha = hashBytes(bytes);
      total += bytes.length;
      signatures.set(path, before);
      blobs.set(sha, bytes);
      entries.push({
        path: name,
        status: "file",
        digest: sha,
        mode: stat.mode & 0o111n ? "100755" : "100644",
        size: bytes.length,
      });
    } catch (e) {
      if (!disappeared(e)) throw e;
      // A dangling link is an excluded object, not proof of a missing file.
      try {
        if ((await lstat(path)).isSymbolicLink()) {
          entries.push({ path: name, status: "excluded" });
          continue;
        }
      } catch (err) {
        if (!disappeared(err)) throw err;
      }
      // A missing final path with a symbolic-link ancestor cannot establish deletion.
      let parent = dirname(path);
      while (parent !== root) {
        try {
          const directory = await lstat(parent);
          if (!directory.isDirectory() || (await realpath(parent)) !== parent)
            throw Error("A tracked path has an unsupported ancestor.", {
              cause: e,
            });
          break;
        } catch (err) {
          if (!disappeared(err)) throw err;
        }
        parent = dirname(parent);
      }
      entries.push({ path: name, status: "missing" });
      signatures.set(path, "missing");
    }
  }
  for (const [path, identity] of signatures) {
    let observed;
    try {
      observed = await stable(path);
    } catch (e) {
      if (!disappeared(e)) throw e;
      observed = "missing";
    }
    if (observed !== identity)
      throw Error("Files changed during checkpoint capture.");
  }
  await guard();
  return {
    manifest: { version: 1, coverage: "explicit-working-files", entries },
    blobs,
  };
}

async function git(
  store: TaskHistory,
  args: string[],
  input?: Uint8Array,
  limit = 65536,
): Promise<Buffer> {
  await store.assertCurrent();
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_TERMINAL_PROMPT: "0",
  });
  return new Promise<Buffer>((ok, fail) => {
    const child = execFile(
      "git",
      [
        "--no-pager",
        "-c",
        "core.hooksPath=" + devNull,
        "-c",
        "gc.auto=0",
        ...args,
      ],
      {
        cwd: store.base,
        env,
        timeout: 20000,
        maxBuffer: limit,
        encoding: "buffer",
        windowsHide: true,
      },
      (err, stdout) => {
        if (err) fail(Error("Private task history Git operation failed."));
        else ok(stdout);
      },
    );
    child.stdin?.on("error", () => {
      /* The process callback reports failed writes. */
    });
    child.stdin?.end(input);
  });
}
async function privateRepo(store: TaskHistory, create: boolean) {
  await store.assertCurrent();
  const dir = join(store.base, "task-history.git");
  if (create) {
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    }
  }
  const st = await lstat(dir);
  if (
    !st.isDirectory() ||
    (await realpath(dir)) !== dir ||
    (typeof process.getuid === "function" &&
      (st.uid !== process.getuid() || (st.mode & 0o077) !== 0))
  )
    throw Error(
      "Private task history has an unexpected location or access mode.",
    );
  const args = ["--git-dir=" + dir];
  if (create) {
    try {
      await lstat(join(dir, "HEAD"));
    } catch (e) {
      if (!disappeared(e)) throw e;
      await git(store, [...args, "init", "--bare", "--quiet", "--template="]);
    }
  }
  for (const name of ["alternates", "http-alternates"]) {
    try {
      await lstat(join(dir, "objects", "info", name));
      throw Error("Private history has external object dependencies.");
    } catch (e) {
      if (!disappeared(e)) throw e;
    }
  }
  return args;
}
/** Reads only the retained bytes referenced by the selected manifest. */
export async function readTaskBlob(
  store: TaskHistory,
  tree: string,
  sha: string,
): Promise<Uint8Array> {
  if (!object.test(tree) || !digest.test(sha))
    throw Error("Invalid task artifact reference.");
  const args = await privateRepo(store, false);
  const value = await git(
    store,
    [...args, "cat-file", "blob", tree + ":" + sha],
    undefined,
    maxFileBytes + 1,
  );
  await store.assertCurrent();
  if (hashBytes(value) !== sha)
    throw Error("Retained task artifact digest differs.");
  return value;
}
async function publishNextCheckpoint(store: TaskHistory): Promise<boolean> {
  const row = await store.pending();
  if (!row) return false;
  if (!uuid.test(row.id) || !uuid.test(row.taskId))
    throw Error("Invalid task history request.");
  const args = await privateRepo(store, true);
  const lines: string[] = [];
  const writeBlob = async (name: string, data: Uint8Array) => {
    const id = (
      await git(
        store,
        [...args, "hash-object", "--no-filters", "-w", "--stdin"],
        data,
      )
    )
      .toString()
      .trim();
    if (!object.test(id)) throw Error("Invalid private Git blob receipt.");
    lines.push("100644 blob " + id + "\t" + name + "\n");
  };
  for (const blob of row.blobs) await writeBlob(blob.digest, blob.bytes);
  await writeBlob("manifest.json", Buffer.from(row.manifest));
  const tree = (
    await git(store, [...args, "mktree"], Buffer.from(lines.sort().join("")))
  )
    .toString()
    .trim();
  if (!object.test(tree)) throw Error("Invalid private Git tree receipt.");
  await store.assertCurrent();
  const ref = "refs/bookie/tasks/" + row.taskId + "/checkpoints/" + row.id;
  try {
    await git(store, [
      ...args,
      "update-ref",
      ref,
      tree,
      "0".repeat(tree.length),
    ]);
  } catch (e) {
    if (
      (await git(store, [...args, "rev-parse", "--verify", ref]))
        .toString()
        .trim() !== tree
    )
      throw e;
  }
  await store.published(row.id, tree);
  return true;
}

const jobs = new Map<
  string,
  { wake: number; store: TaskHistory; done: Promise<void> }
>();
/** No persistent worker grant. Durable pending bytes resume with fresh current access. */
export function publishTaskFiles(store: TaskHistory): Promise<void> {
  const current = jobs.get(store.base);
  if (current) {
    current.wake++;
    current.store = store;
    return current.done;
  }
  const worker = { wake: 0, store, done: Promise.resolve() };
  worker.done = (async () => {
    try {
      for (;;) {
        const wake = worker.wake;
        const source = worker.store;
        try {
          if (await publishNextCheckpoint(source)) continue;
        } catch (error) {
          // A fresh session may have renewed the worker while the old grant expired.
          // Start the pending read again under that session's own authority.
          if (worker.store === source) throw error;
        }
        if (wake === worker.wake) return;
      }
    } finally {
      if (jobs.get(store.base) === worker) jobs.delete(store.base);
    }
  })();
  jobs.set(store.base, worker);
  return worker.done;
}
