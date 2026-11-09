import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  realpath,
  mkdir,
  mkdtemp,
  writeFile,
  link,
  open,
  rm,
} from "node:fs/promises";
import { basename, join, relative, isAbsolute, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { initializeRecallState, readRecallState } from "pi-bookie-core";

const project = "/projects/workspace/project.md";
const denied = () =>
  Error(
    "Bookie could not verify this folder's private memory. Existing records were not replaced.",
  );
const hasCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;
const below = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
};
const uid = (prefix: string) =>
  prefix + "-0" + randomBytes(13).toString("hex").slice(0, 25).toUpperCase();
async function directory(path: string, privateMode?: "parent" | "private") {
  const st = await lstat(path, { bigint: true });
  if (
    !st.isDirectory() ||
    st.ino <= 0n ||
    st.birthtimeNs <= 0n ||
    (privateMode &&
      typeof process.getuid === "function" &&
      (st.uid !== BigInt(process.getuid()) ||
        (st.mode & (privateMode === "private" ? 0o077n : 0o022n)) !== 0n))
  )
    throw denied();
  return [st.dev, st.ino, st.birthtimeNs].join(":");
}
async function put(path: string, value: string) {
  return writeFile(path, value, { flag: "wx", mode: 0o600 });
}
async function seed(root: string, assertCurrent: () => Promise<void>) {
  const generated = new Date().toISOString();
  await mkdir(root, { mode: 0o700 });
  for (const dir of [
    "projects/workspace/activities",
    "projects/workspace/decisions",
    "references/files",
  ]) {
    await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
  }
  const manifest = {
    profile: "1.0",
    vault: { uid: uid("VLT"), title: "Workspace memory" },
    allowed_concept_types: [
      "Project",
      "Task",
      "Document",
      "Research",
      "Decision",
      "Activity",
      "Evidence",
      "Person",
    ],
    policy: {
      evidence_roots: ["references/files"],
      exclude: ["exports/**"],
      sensitivity: {
        classes: ["internal", "private"],
        excluded_classes: ["private"],
      },
      attachment_max_bytes: 1048576,
    },
  };
  const record = {
    type: "Project",
    title: "Workspace memory",
    status: "stable",
    generated: { by: "process:pi-bookie", at: generated },
    bookie: {
      profile: "1.0",
      uid: uid("PRJ"),
      state: "active",
      created_at: generated,
      sensitivity: "internal",
    },
  };
  await put(join(root, "bookie.yaml"), JSON.stringify(manifest) + "\n");
  await put(
    join(root, "index.md"),
    '---\nokf_version: "0.2"\n---\n\n# Workspace memory\n\n[Project](projects/workspace/project.md)\n',
  );
  await put(
    join(root, project.slice(1)),
    "---\n" + JSON.stringify(record) + "\n---\n\n# Workspace memory\n",
  );
  const result = await initializeRecallState(root, {
    assertAuthority: assertCurrent,
  });
  if (!result.ok || result.outcome !== "initialized") throw denied();
}

// Only Pi's private storage is searched, by exact workspace identity. A fully seeded
// directory becomes reachable through an exclusive hard link; overlapping starts
// cannot replace a published ledger, and a partial seed is never selected.
export async function openManagedVault(
  workspace: string,
  assertCurrent: () => Promise<void>,
  agentDirectory = getAgentDir(),
) {
  await assertCurrent();
  const cwd = await realpath(workspace),
    agent = await realpath(agentDirectory);
  if (below(cwd, agent) || below(agent, cwd)) throw denied();
  const cwdId = await directory(cwd),
    agentId = await directory(agent, "parent");
  const key = createHash("sha256")
    .update(JSON.stringify([1, cwd, cwdId]))
    .digest("hex");
  const store = join(agent, "bookie-project-memory");
  await assertCurrent();
  try {
    await mkdir(store, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const storeId = await directory(store, "private"),
    mapping = join(store, key + ".json");
  async function checkStore() {
    await assertCurrent();
    if (
      (await realpath(workspace)) !== cwd ||
      (await directory(cwd)) !== cwdId ||
      (await realpath(agentDirectory)) !== agent ||
      (await directory(agent, "parent")) !== agentId ||
      (await directory(store, "private")) !== storeId
    )
      throw denied();
  }
  async function selection() {
    const st = await lstat(mapping, { bigint: true });
    if (!st.isFile() || st.size > 256n || st.nlink !== 2n) throw denied();
    const fd = await open(
      mapping,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const current = await fd.stat({ bigint: true });
      if (current.dev !== st.dev || current.ino !== st.ino || !current.isFile())
        throw denied();
      const buf = Buffer.alloc(257);
      const { bytesRead } = await fd.read(buf, 0, 257, 0);
      if (BigInt(bytesRead) !== st.size) throw denied();
      const record: unknown = JSON.parse(buf.toString("utf8", 0, bytesRead));
      if (
        !Array.isArray(record) ||
        record.length !== 4 ||
        record[0] !== key ||
        typeof record[1] !== "string" ||
        !/^ledger-[A-Za-z0-9]{6}$/u.test(record[1])
      )
        throw denied();
      const base = join(store, record[1]);
      const baseId = await directory(base, "private");
      const seal = await lstat(join(base, "binding"), { bigint: true });
      if (!seal.isFile() || seal.dev !== st.dev || seal.ino !== st.ino)
        throw denied();
      const root = join(base, "vault");
      const rootId = await directory(root, "private");
      if (record[2] !== baseId || record[3] !== rootId) throw denied();
      return {
        root,
        id: [baseId, rootId, String(seal.dev), String(seal.ino)].join("/"),
      };
    } finally {
      await fd.close();
    }
  }
  let exists = true;
  try {
    await lstat(mapping);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    exists = false;
  }
  if (!exists) {
    await checkStore();
    const base = await mkdtemp(join(store, "ledger-"));
    let published = false;
    try {
      await seed(join(base, "vault"), checkStore);
      await put(
        join(base, "binding"),
        JSON.stringify([
          key,
          basename(base),
          await directory(base, "private"),
          await directory(join(base, "vault"), "private"),
        ]),
      );
      await checkStore();
      try {
        await link(join(base, "binding"), mapping);
        published = true;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    } finally {
      if (!published && (await directory(store, "private")) === storeId)
        await rm(base, { recursive: true, force: true });
    }
  }
  const selected = await selection();
  async function check() {
    await checkStore();
    const now = await selection();
    if (now.id !== selected.id || now.root !== selected.root) throw denied();
  }
  if (!(await readRecallState(selected.root)).ok) throw denied();
  await check();
  return { root: selected.root, project, assertCurrent: check };
}
