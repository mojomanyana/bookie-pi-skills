import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  realpath,
  mkdir,
  mkdtemp,
  writeFile,
  link,
  open,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, join, relative, isAbsolute, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  initializeRecallState,
  readRecallState,
  RECALL_MARKER_FILE,
  RECALL_STATE_FILE,
} from "pi-bookie-core";
import {
  isAncestorOfHead,
  isGitCommit,
  readGitEvidence,
  type GitEvidence,
} from "./workspace-git.js";

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
const SEED_INDEX =
  '---\nokf_version: "0.2"\n---\n\n# Workspace memory\n\n[Project](projects/workspace/project.md)\n';
// The exact seed texts; re-attach compares against them to tell an untouched seed.
const seedManifest = (vaultUid: string) =>
  JSON.stringify({
    profile: "1.0",
    vault: { uid: vaultUid, title: "Workspace memory" },
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
  }) + "\n";
const seedProject = (projectUid: string, generated: string) =>
  "---\n" +
  JSON.stringify({
    type: "Project",
    title: "Workspace memory",
    status: "stable",
    generated: { by: "process:pi-bookie", at: generated },
    bookie: {
      profile: "1.0",
      uid: projectUid,
      state: "active",
      created_at: generated,
      sensitivity: "internal",
    },
  }) +
  "\n---\n\n# Workspace memory\n";
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
  await put(join(root, "bookie.yaml"), seedManifest(uid("VLT")));
  await put(join(root, "index.md"), SEED_INDEX);
  await put(join(root, project.slice(1)), seedProject(uid("PRJ"), generated));
  const result = await initializeRecallState(root, {
    assertAuthority: assertCurrent,
  });
  if (!result.ok || result.outcome !== "initialized") throw denied();
}

const keyFor = (cwd: string, cwdId: string) =>
  createHash("sha256")
    .update(JSON.stringify([1, cwd, cwdId]))
    .digest("hex");
async function locate(workspace: string, agentDirectory: string) {
  const cwd = await realpath(workspace),
    agent = await realpath(agentDirectory);
  if (below(cwd, agent) || below(agent, cwd)) throw denied();
  const cwdId = await directory(cwd),
    agentId = await directory(agent, "parent");
  return {
    cwd,
    cwdId,
    agent,
    agentId,
    key: keyFor(cwd, cwdId),
    store: join(agent, "bookie-project-memory"),
  };
}
// Private storage files are still read as untrusted: no links, bounded, stable.
async function readBounded(path: string, max: number) {
  const st = await lstat(path, { bigint: true });
  if (!st.isFile() || st.size > BigInt(max)) throw denied();
  const fd = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const current = await fd.stat({ bigint: true });
    if (current.dev !== st.dev || current.ino !== st.ino || !current.isFile())
      throw denied();
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fd.read(buf, 0, max + 1, 0);
    if (BigInt(bytesRead) !== st.size) throw denied();
    return { st, text: buf.toString("utf8", 0, bytesRead) };
  } finally {
    await fd.close();
  }
}
type Binding = Awaited<ReturnType<typeof readBinding>>;
// A mapping resolves only while it and the ledger's sealed binding are the same file.
async function readBinding(store: string, key: string) {
  const { st, text } = await readBounded(join(store, key + ".json"), 256);
  if (st.nlink !== 2n) throw denied();
  const record: unknown = JSON.parse(text);
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
    base,
    ledger: record[1],
    baseId,
    rootId,
    mapping: { dev: st.dev, ino: st.ino },
    id: [baseId, rootId, String(seal.dev), String(seal.ino)].join("/"),
  };
}

// Location evidence sits beside the sealed binding, outside the canonical vault.
// It is the only place Bookie keeps a readable folder path and Git commit, and is
// used solely by the human re-attach command; lookup still uses the exact binding.
const RECORD = "workspace.json";
// An enrollment witness lives outside the managed ledger. A missing or
// replaced database must never turn a controlled task into standalone work.
async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (hasCode(e, "ENOENT")) return false;
    throw e;
  }
}
async function enrollmentEvidence(workspace: string, agentDirectory: string) {
  const location = await locate(workspace, agentDirectory);
  const folder = join(location.agent, "bookie-task-enrollments"),
    marker = join(folder, location.key + ".json");
  let saved: string | undefined;
  if (await pathExists(folder)) {
    await directory(folder, "private");
    if (await pathExists(marker)) {
      const { text, st } = await readBounded(marker, 512);
      if (
        st.nlink !== 1n ||
        (typeof process.getuid === "function" &&
          (st.uid !== BigInt(process.getuid()) || (st.mode & 0o077n) !== 0n))
      )
        throw denied();
      saved = text;
    }
  }
  const empty = () => {
    if (saved !== undefined) throw denied();
    return { folder, marker, saved: undefined, expected: undefined };
  };
  if (!(await pathExists(location.store))) return empty();
  await directory(location.store, "private");
  if (!(await pathExists(join(location.store, location.key + ".json"))))
    return empty();
  const binding = await readBinding(location.store, location.key);
  const database = join(binding.base, "task-history-v1.sqlite");
  if (!(await pathExists(database))) return empty();
  const st = await lstat(database, { bigint: true });
  if (
    !st.isFile() ||
    st.nlink !== 1n ||
    st.ino <= 0n ||
    st.birthtimeNs <= 0n ||
    (typeof process.getuid === "function" &&
      (st.uid !== BigInt(process.getuid()) || (st.mode & 0o077n) !== 0n))
  )
    throw denied();
  const expected = JSON.stringify([
    1,
    location.key,
    binding.baseId,
    String(st.dev),
    String(st.ino),
    String(st.birthtimeNs),
  ]);
  if (saved !== undefined && saved !== expected) throw denied();
  return { folder, marker, saved, expected };
}
export async function taskEnrollment(
  workspace: string,
  agentDirectory = getAgentDir(),
): Promise<"absent" | "existing" | "attached" | "unavailable"> {
  try {
    const state = await enrollmentEvidence(workspace, agentDirectory);
    return state.saved ? "attached" : state.expected ? "existing" : "absent";
  } catch {
    return "unavailable";
  }
}
export async function attestTaskEnrollment(
  workspace: string,
  guard: () => Promise<void>,
  agentDirectory = getAgentDir(),
) {
  await guard();
  const state = await enrollmentEvidence(workspace, agentDirectory);
  if (!state.expected) throw denied();
  if (state.saved === state.expected) return;
  try {
    await mkdir(state.folder, { mode: 0o700 });
  } catch (e) {
    if (!hasCode(e, "EEXIST")) throw e;
  }
  await directory(state.folder, "private");
  const temp = join(state.folder, "pending-" + randomBytes(12).toString("hex"));
  await put(temp, state.expected);
  try {
    await guard();
    try {
      await link(temp, state.marker);
    } catch (e) {
      if (!hasCode(e, "EEXIST")) throw e;
    }
  } finally {
    await unlink(temp);
  }
  const again = await enrollmentEvidence(workspace, agentDirectory);
  if (again.saved !== state.expected) throw denied();
  await guard();
}
export interface WorkspaceMove {
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly evidence: "git" | "folder" | "git+folder";
}
interface WorkspaceRecord {
  readonly version: 1;
  readonly key: string;
  readonly path: string;
  readonly directory: string;
  readonly git: GitEvidence | null;
  readonly seen: string;
  readonly moves: readonly WorkspaceMove[];
}
const MAX_MOVES = 16;
const textPath = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 4096 &&
  isAbsolute(v) &&
  !/[\p{Cc}]/u.test(v);
const instant = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 32 &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const own = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const shape = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length &&
  keys.every((key) => Object.hasOwn(v, key));
function parseRecord(value: unknown): WorkspaceRecord | undefined {
  if (
    !own(value) ||
    !shape(value, [
      "version",
      "key",
      "path",
      "directory",
      "git",
      "seen",
      "moves",
    ]) ||
    value.version !== 1 ||
    typeof value.key !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.key) ||
    !textPath(value.path) ||
    typeof value.directory !== "string" ||
    !/^\d{1,40}:\d{1,40}:\d{1,40}$/u.test(value.directory) ||
    !instant(value.seen) ||
    !Array.isArray(value.moves) ||
    value.moves.length > MAX_MOVES
  )
    return;
  const git = value.git;
  if (
    git !== null &&
    (!own(git) ||
      !shape(git, ["head", "prefix"]) ||
      !isGitCommit(git.head) ||
      typeof git.prefix !== "string" ||
      git.prefix.length > 4096 ||
      /[\p{Cc}]/u.test(git.prefix))
  )
    return;
  for (const move of value.moves as unknown[])
    if (
      !own(move) ||
      !shape(move, ["from", "to", "at", "evidence"]) ||
      !textPath(move.from) ||
      !textPath(move.to) ||
      !instant(move.at) ||
      !["git", "folder", "git+folder"].includes(move.evidence as string)
    )
      return;
  return value as unknown as WorkspaceRecord;
}
// A record describes a binding only if that binding's key is the hash of the
// record's own path and folder identity; anything else is stale or forged.
const boundTo = (record: WorkspaceRecord | undefined, key: string) =>
  record?.key === key && keyFor(record.path, record.directory) === key
    ? record
    : undefined;
async function readRecord(base: string) {
  try {
    const { st, text } = await readBounded(join(base, RECORD), 65_536);
    return st.nlink === 1n ? parseRecord(JSON.parse(text)) : undefined;
  } catch {
    return;
  }
}
async function writeRecord(
  base: string,
  record: WorkspaceRecord,
  assertCurrent: () => Promise<void>,
  prefix = ".workspace-",
) {
  const temporary = join(
    base,
    prefix + randomBytes(8).toString("hex") + ".tmp",
  );
  await put(temporary, JSON.stringify(record) + "\n");
  try {
    await assertCurrent();
    await rename(temporary, join(base, RECORD));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
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
  const { cwd, cwdId, agent, agentId, key, store } = await locate(
    workspace,
    agentDirectory,
  );
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
  const selection = () => readBinding(store, key);
  let exists = true;
  try {
    await lstat(mapping);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    exists = false;
  }
  if (!exists) {
    if ((await taskEnrollment(workspace, agentDirectory)) !== "absent")
      throw denied();
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
  try {
    const previous = await readRecord(selected.base);
    await writeRecord(
      selected.base,
      {
        version: 1,
        key,
        path: cwd,
        directory: cwdId,
        // Only a successful probe replaces a recorded commit: a missing, slow or
        // refusing Git says nothing about this folder's history.
        git:
          (await readGitEvidence(cwd)) ?? boundTo(previous, key)?.git ?? null,
        seen: new Date().toISOString(),
        moves: previous?.moves ?? [],
      },
      check,
    );
  } catch {
    // Location evidence only helps a later human re-attach; lookup never depends on it.
  }
  await check();
  return { root: selected.root, project, assertCurrent: check };
}

const SEED_ENTRIES = new Map([
  ["bookie.yaml", "file"],
  ["index.md", "file"],
  [RECALL_STATE_FILE, "file"],
  [RECALL_MARKER_FILE, "file"],
  ["projects", "dir"],
  ["projects/workspace", "dir"],
  ["projects/workspace/project.md", "file"],
  ["projects/workspace/activities", "dir"],
  ["projects/workspace/decisions", "dir"],
  ["references", "dir"],
  ["references/files", "dir"],
]);
const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
// True only for the exact automatic seed: no notes, decisions, evidence,
// controls, registrations, manifest or project edits, or any other entry.
// Anything unreadable counts as content, so callers refuse.
async function untouchedSeed(root: string) {
  try {
    return await seedOnly(root);
  } catch {
    return false;
  }
}
async function seedOnly(root: string) {
  const found = new Map<string, string>();
  async function walk(dir: string, prefix: string): Promise<boolean> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (found.size >= SEED_ENTRIES.size) return false;
      const kind = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "";
      found.set(name, kind);
      if (SEED_ENTRIES.get(name) !== kind) return false;
      if (kind === "dir" && !(await walk(join(dir, entry.name), name + "/")))
        return false;
    }
    return true;
  }
  if (!(await walk(root, "")) || found.size !== SEED_ENTRIES.size) return false;
  if ((await readBounded(join(root, "index.md"), 4096)).text !== SEED_INDEX)
    return false;
  const manifest = (await readBounded(join(root, "bookie.yaml"), 4096)).text;
  const parsed = json(manifest);
  if (
    !own(parsed) ||
    !own(parsed.vault) ||
    typeof parsed.vault.uid !== "string" ||
    manifest !== seedManifest(parsed.vault.uid)
  )
    return false;
  const text = (
    await readBounded(join(root, "projects/workspace/project.md"), 4096)
  ).text;
  const front = /^---\n(\{[^\n]*\})\n---\n/u.exec(text);
  const record = front ? json(front[1]!) : undefined;
  if (
    !own(record) ||
    !own(record.bookie) ||
    !own(record.generated) ||
    typeof record.bookie.uid !== "string" ||
    typeof record.generated.at !== "string" ||
    text !== seedProject(record.bookie.uid, record.generated.at)
  )
    return false;
  const state = await readRecallState(root);
  return (
    state.ok &&
    state.state.controls.length === 0 &&
    state.state.registrations.length === 0
  );
}

export type CurrentMemory =
  | { readonly state: "none" }
  | { readonly state: "empty"; readonly binding: Binding }
  | { readonly state: "memory" }
  | { readonly state: "unverified" };
async function currentMemory(
  store: string,
  key: string,
): Promise<CurrentMemory> {
  try {
    await lstat(join(store, key + ".json"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { state: "none" };
    throw error;
  }
  let binding: Binding;
  try {
    binding = await readBinding(store, key);
  } catch {
    // Includes a mapping on the pending binding of a re-attach still running elsewhere.
    return { state: "unverified" };
  }
  return (await untouchedSeed(binding.root))
    ? { state: "empty", binding }
    : { state: "memory" };
}

export interface MovedProject {
  readonly key: string;
  readonly previous: string;
  /**
   * Why the earlier folder counts as gone from its recorded path: nothing is
   * there, a different folder is there now, or the path now leads to this
   * folder under another name (a case-only rename, or a link left by a move).
   */
  readonly earlier: "missing" | "replaced" | "aliased";
  readonly root: string;
  readonly evidence: { readonly git: boolean; readonly folder: boolean };
  readonly recordedGit: GitEvidence | null;
  readonly lastOpened: string;
  readonly binding: Binding;
  readonly record: WorkspaceRecord;
  assertCurrent(): Promise<void>;
}
export interface ExcludedProject {
  readonly previous: string;
  readonly reason:
    "still-exists" | "unknown-location" | "git-mismatch" | "no-evidence";
}
export interface MovedProjectSurvey {
  readonly workspace: string;
  readonly key: string;
  readonly directory: string;
  readonly git: GitEvidence | null;
  readonly current: CurrentMemory;
  readonly candidates: readonly MovedProject[];
  readonly excluded: readonly ExcludedProject[];
  readonly unrecorded: number;
  readonly limited: boolean;
}
const MAX_SURVEYED = 1000;
const sameFile = (
  a: { dev: bigint; ino: bigint },
  b: { dev: bigint; ino: bigint },
) => a.dev === b.dev && a.ino === b.ino;

/**
 * Human re-attach only: earlier project memories whose recorded folder is gone
 * and that Git history or the same folder identity links to this folder.
 * Read-only. Memories unrelated to this folder are not listed unless their
 * folder is gone.
 */
export async function surveyMovedProjects(
  workspace: string,
  agentDirectory = getAgentDir(),
): Promise<MovedProjectSurvey> {
  const at = await locate(workspace, agentDirectory);
  const candidates: MovedProject[] = [],
    excluded: ExcludedProject[] = [];
  let unrecorded = 0,
    limited = false,
    git: GitEvidence | null = null,
    storeId: string;
  const survey = (current: CurrentMemory): MovedProjectSurvey => ({
    workspace: at.cwd,
    key: at.key,
    directory: at.cwdId,
    git,
    current,
    candidates,
    excluded,
    unrecorded,
    limited,
  });
  try {
    storeId = await directory(at.store, "private");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return survey({ state: "none" });
    throw error;
  }
  const current = await currentMemory(at.store, at.key);
  if (current.state === "memory" || current.state === "unverified")
    return survey(current);
  git = await readGitEvidence(at.cwd);
  const names = (await readdir(at.store))
    .filter(
      (name) => /^[0-9a-f]{64}\.json$/u.test(name) && name !== at.key + ".json",
    )
    .sort();
  if (names.length > MAX_SURVEYED) {
    limited = true;
    names.length = MAX_SURVEYED;
  }
  for (const name of names) {
    const key = name.slice(0, -5);
    let binding: Binding;
    try {
      binding = await readBinding(at.store, key);
    } catch {
      continue;
    }
    const record = boundTo(await readRecord(binding.base), key);
    if (!record) {
      unrecorded++;
      continue;
    }
    const previous = record.path;
    // The earlier folder is gone when nothing is at its path, when a different
    // folder is there now (re-created, re-cloned or restored, possibly this one),
    // or when that path now leads to this folder, whose real path differs.
    let earlier: MovedProject["earlier"] | "present" | "unknown";
    try {
      const st = await lstat(previous, { bigint: true });
      const there = [st.dev, st.ino, st.birthtimeNs].join(":");
      earlier =
        there !== record.directory
          ? "replaced"
          : there === at.cwdId
            ? "aliased"
            : "present";
    } catch (error) {
      earlier =
        hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")
          ? "missing"
          : "unknown";
    }
    const folder = record.directory === at.cwdId;
    const history =
      record.git !== null &&
      git !== null &&
      git.prefix === record.git.prefix &&
      (await isAncestorOfHead(at.cwd, record.git.head));
    if (earlier === "present" || earlier === "unknown") {
      // Only a related folder is worth a reason; unrelated live projects are not listed.
      if (history || folder)
        excluded.push({
          previous,
          reason: earlier === "present" ? "still-exists" : "unknown-location",
        });
      continue;
    }
    if (record.git && !history) {
      excluded.push({ previous, reason: "git-mismatch" });
      continue;
    }
    if (!history && !folder) {
      excluded.push({ previous, reason: "no-evidence" });
      continue;
    }
    candidates.push({
      key,
      previous,
      earlier,
      root: binding.root,
      evidence: { git: history, folder },
      recordedGit: record.git,
      lastOpened: record.seen,
      binding,
      record,
      async assertCurrent() {
        if ((await readBinding(at.store, key)).id !== binding.id)
          throw denied();
      },
    });
  }
  if ((await directory(at.store, "private")) !== storeId) throw denied();
  return survey(current);
}

const changed = () =>
  Error(
    "Bookie project memory changed while you were confirming. Nothing was re-attached; run /bookie-reattach again.",
  );
async function unlinkSame(
  path: string,
  identity: { dev: bigint; ino: bigint },
) {
  const st = await lstat(path, { bigint: true });
  if (!st.isFile() || !sameFile(st, identity)) throw changed();
  await unlink(path);
}

// Only re-attach creates these, and only while it holds the store lock.
const TEMPORARY = /^reattach-[0-9a-f]{16}\.tmp$/u;
const LEDGER = /^ledger-[A-Za-z0-9]{6}$/u;
const MAPPING = /^[0-9a-f]{64}\.json$/u;
async function withStoreLock<T>(store: string, run: () => Promise<T>) {
  await directory(store, "private");
  const lock = join(store, "reattach.lock");
  let handle;
  try {
    handle = await open(
      lock,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (hasCode(error, "EEXIST"))
      throw Error(
        "Another Bookie re-attach is running or did not finish. If no Pi session is re-attaching, remove " +
          JSON.stringify(lock) +
          " and run /bookie-reattach again. Nothing was changed.",
        { cause: error },
      );
    throw error;
  }
  const owned = await handle.stat({ bigint: true });
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n",
    );
  } finally {
    await handle.close();
  }
  try {
    return await run();
  } finally {
    // A lock left behind only blocks the next re-attach, which explains how to recover.
    await lstat(lock, { bigint: true })
      .then(
        (st) => (sameFile(st, owned) ? unlink(lock) : undefined),
        () => undefined,
      )
      .catch(() => undefined);
  }
}

/**
 * Under the store lock: undo what an interrupted re-attach can leave, so a crash
 * at any step is recovered by the next run. Before the commit rename the earlier
 * mapping still resolves, so dropping the pending files restores it; after the
 * commit only the earlier mapping, which can no longer resolve, is left. A state
 * that does not match one of these exactly is left in place and fails closed.
 * Returns the number of files removed.
 */
async function sweep(store: string) {
  let removed = 0;
  const KEY = /^[0-9a-f]{64}$/u;
  const first = (text: string) => {
    const record = json(text);
    return Array.isArray(record) ? (record as unknown[]) : [];
  };
  async function drop(path: string, only?: (st: BigIntStats) => boolean) {
    try {
      const st = await lstat(path, { bigint: true });
      if (st.isFile() && (only?.(st) ?? true)) {
        await unlinkSame(path, st);
        removed++;
        return true;
      }
    } catch {
      /* Left in place; later steps fail closed on it. */
    }
    return false;
  }
  // A pending binding that some folder's mapping points at: that mapping fails
  // closed until both are gone; nothing was committed.
  async function uncommitted(pending: string) {
    try {
      const { st, text } = await readBounded(pending, 256);
      const key = first(text)[0];
      if (st.nlink !== 2n || typeof key !== "string" || !KEY.test(key)) return;
      if (await drop(join(store, key + ".json"), (m) => sameFile(m, st)))
        await drop(pending, (p) => p.nlink === 1n);
    } catch {
      /* Left in place. */
    }
  }
  // An earlier mapping a committed re-attach did not remove: one link, and its
  // ledger's seal now resolves for a different folder.
  async function superseded(name: string) {
    const key = name.slice(0, -5),
      mapping = join(store, name);
    try {
      const { st, text } = await readBounded(mapping, 256);
      const [named, ledger] = first(text);
      if (
        st.nlink !== 1n ||
        named !== key ||
        typeof ledger !== "string" ||
        !LEDGER.test(ledger)
      )
        return;
      const owner = first(
        (await readBounded(join(store, ledger, "binding"), 256)).text,
      )[0];
      if (typeof owner !== "string" || owner === key || !KEY.test(owner))
        return;
      if ((await readBinding(store, owner)).ledger === ledger)
        await drop(mapping, (now) => sameFile(now, st) && now.nlink === 1n);
    } catch {
      /* Left in place. */
    }
  }
  const names = await readdir(store);
  for (const name of names)
    if (TEMPORARY.test(name)) await drop(join(store, name));
  for (const name of names) {
    if (!LEDGER.test(name)) continue;
    const base = join(store, name);
    const entries = await readdir(base).catch(() => [] as string[]);
    for (const entry of entries)
      if (TEMPORARY.test(entry))
        await drop(join(base, entry), (st) => st.nlink === 1n);
    if (!entries.includes("binding.next")) continue;
    const pending = join(base, "binding.next");
    if (!(await drop(pending, (st) => st.nlink === 1n)))
      await uncommitted(pending);
  }
  for (const name of names) if (MAPPING.test(name)) await superseded(name);
  return removed;
}

/**
 * Human re-attach only: under the store lock, clean up after an earlier
 * re-attach that did not finish. Moves nothing; returns the files removed.
 */
export async function recoverReattach(
  workspace: string,
  agentDirectory = getAgentDir(),
) {
  const { store } = await locate(workspace, agentDirectory);
  try {
    await lstat(store);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return 0;
    throw error;
  }
  return withStoreLock(store, () => sweep(store));
}

/**
 * Move one surveyed project's binding to the surveyed folder after the human
 * confirmed it. Uses the creation primitives (exclusive files, hard-link seal,
 * atomic rename). The ledger's binding rename is the single commit point; before
 * it the earlier mapping still resolves and this folder's mapping cannot.
 */
export async function reattachMovedProject(
  surveyed: MovedProjectSurvey,
  chosen: MovedProject,
  assertCurrent: () => Promise<void>,
  agentDirectory = getAgentDir(),
) {
  const at = await locate(surveyed.workspace, agentDirectory);
  if (at.cwd !== surveyed.workspace || at.key !== surveyed.key) throw changed();
  return withStoreLock(at.store, async () => {
    // Leftovers of an interrupted attempt must not block this one. Then everything
    // shown before confirmation must still hold under the store lock.
    await sweep(at.store);
    const again = await surveyMovedProjects(surveyed.workspace, agentDirectory);
    const now = again.candidates.find((c) => c.key === chosen.key);
    const before = surveyed.current,
      current = again.current;
    if (
      again.key !== surveyed.key ||
      !now ||
      now.binding.id !== chosen.binding.id ||
      now.previous !== chosen.previous ||
      now.earlier !== chosen.earlier ||
      now.evidence.git !== chosen.evidence.git ||
      now.evidence.folder !== chosen.evidence.folder ||
      current.state !== before.state ||
      (current.state === "empty" &&
        before.state === "empty" &&
        current.binding.id !== before.binding.id)
    )
      throw changed();
    await assertCurrent();
    const mapping = join(at.store, at.key + ".json");
    const binding = now.binding;
    const pending = join(binding.base, "binding.next");
    // The sweep removed every pending binding it could account for.
    await lstat(pending).then(
      () => {
        throw Error(
          "Bookie found an unfinished re-attach file it could not clean up: " +
            JSON.stringify(pending) +
            ". Nothing was changed.",
        );
      },
      (error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      },
    );
    await put(
      pending,
      JSON.stringify([at.key, binding.ledger, binding.baseId, binding.rootId]),
    );
    const next = await lstat(pending, { bigint: true });
    let linked = false;
    try {
      if (current.state === "empty") {
        const temporary = join(
          at.store,
          "reattach-" + randomBytes(8).toString("hex") + ".tmp",
        );
        await link(pending, temporary);
        try {
          // Only re-attach replaces a mapping, and it holds the store lock.
          const still = await lstat(mapping, { bigint: true });
          if (
            !sameFile(still, current.binding.mapping) ||
            !(await untouchedSeed(current.binding.root))
          )
            throw changed();
          await assertCurrent();
          await rename(temporary, mapping);
          linked = true;
        } finally {
          if (!linked) await rm(temporary, { force: true });
        }
      } else {
        await assertCurrent();
        // Exclusive: if a first open created memory meanwhile, it wins and nothing moves.
        await link(pending, mapping).catch((error: unknown) => {
          throw hasCode(error, "EEXIST") ? changed() : error;
        });
        linked = true;
      }
      await rename(pending, join(binding.base, "binding"));
    } catch (error) {
      // Not committed: restore this folder's previous mapping and drop the pending seal.
      try {
        if (linked) {
          await unlinkSame(mapping, next);
          if (current.state === "empty")
            await link(join(current.binding.base, "binding"), mapping);
        }
        await rm(pending, { force: true });
      } catch {
        /* Whatever is left is removed by the next run's sweep. */
      }
      throw error;
    }
    // Committed: the earlier mapping no longer matches the seal. Remove it.
    let cleaned = true;
    try {
      await unlinkSame(join(at.store, now.key + ".json"), binding.mapping);
    } catch {
      cleaned = false;
    }
    const evidence: WorkspaceMove["evidence"] = now.evidence.git
      ? now.evidence.folder
        ? "git+folder"
        : "git"
      : "folder";
    let recorded = true;
    try {
      await writeRecord(
        binding.base,
        {
          version: 1,
          key: at.key,
          path: at.cwd,
          directory: at.cwdId,
          git: again.git,
          seen: now.record.seen,
          moves: [
            ...now.record.moves,
            {
              from: now.previous,
              to: at.cwd,
              at: new Date().toISOString(),
              evidence,
            },
          ].slice(-MAX_MOVES),
        },
        async () => {},
        "reattach-",
      );
    } catch {
      recorded = false;
    }
    const found = await readBinding(at.store, at.key).then(
      (after) => after.root === binding.root,
      () => false,
    );
    return {
      root: binding.root,
      found,
      cleaned,
      recorded,
      ...(current.state === "empty"
        ? {
            setAside: current.binding.base,
            // Sampled once: a save that lands in the set-aside memory later is not reported here.
            setAsideChanged: !(await untouchedSeed(current.binding.root)),
          }
        : {}),
    };
  });
}
