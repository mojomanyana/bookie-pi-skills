import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { loadConcept } from "./concept-loader.js";
import { containsDetectedSecret } from "./vault-secret-detection.js";
import {
  historyText,
  taskObservation,
  fileBoundary,
  type FileBoundary,
  type TaskFileEntry,
  type TaskFileManifest,
  type TaskHistory,
  type TaskObservation,
  type TaskSelection,
} from "./task-history.js";
import { readTaskBlob, validTaskFilePath } from "./task-history-files.js";

type Observation = {
  eventId: string;
  recordedAt: string;
  ownerSequence?: number;
  event: TaskObservation;
};
type Checkpoint = {
  checkpointId: string;
  capturedAt: string;
  boundary: FileBoundary;
  manifest: TaskFileManifest;
};
type BlobEntry = { sha256: string; data: string };
interface TaskRecords {
  taskId: string;
  captureGaps: number;
  title: string;
  prerequisites: string[];
  observations: Observation[];
  checkpoints: Checkpoint[];
}
export interface TaskBundle extends TaskRecords {
  format: "pi-task-bundle";
  version: 1;
  bundleId: string;
  projectId: string;
  subtasks: (TaskRecords & { parentId: string })[];
  blobs: BlobEntry[];
  coverage: typeof coverage;
}
const coverage = {
  history:
    "selected task and descendants, observations, dependency identities and explicit working-file checkpoints",
  excluded:
    "external prerequisite contents, owner-private receipts, external services, canonical notes, choices and authorizations",
} as const;
export const maxTaskBundleBytes = 32 * 1024 * 1024;
const maxBlobBytes = 16 * 1024 * 1024;
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const digest = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const failure = (reason: string): never => {
  throw new Error(`Invalid task bundle: ${reason}.`);
};
function shape(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    return failure("unexpected fields");
  return value as Record<string, unknown>;
}
function id(value: unknown, pattern: RegExp): string {
  return typeof value === "string" && value.length <= 100 && pattern.test(value)
    ? value
    : failure("invalid identity");
}
function time(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return failure("invalid timestamp");
  return value;
}
function boundedList(value: unknown, maximum: number): unknown[] {
  return Array.isArray(value) && value.length <= maximum
    ? value
    : failure("list exceeds supported size");
}
function distinct(seen: Set<string>, value: string) {
  if (seen.has(value)) failure("duplicate identity");
  seen.add(value);
}
function entry(raw: unknown): TaskFileEntry {
  if (!raw || typeof raw !== "object") return failure("invalid file entry");
  const isFile = "status" in raw && raw.status === "file";
  const v = shape(
    raw,
    isFile ? ["path", "status", "mode", "size", "digest"] : ["path", "status"],
  );
  if (!validTaskFilePath(v.path))
    return failure("invalid or protected relative path");
  if (v.status === "missing" || v.status === "excluded")
    return { path: v.path, status: v.status };
  if (
    v.status !== "file" ||
    (v.mode !== "100644" && v.mode !== "100755") ||
    typeof v.size !== "number" ||
    !Number.isSafeInteger(v.size) ||
    v.size < 0 ||
    v.size > maxBlobBytes
  )
    return failure("invalid file metadata");
  return {
    path: v.path,
    status: "file",
    digest: id(v.digest, digest),
    mode: v.mode,
    size: v.size,
  };
}
function unpack(input: unknown): TaskBundle {
  const x = shape(input, [
    "format",
    "version",
    "bundleId",
    "projectId",
    "taskId",
    "title",
    "captureGaps",
    "prerequisites",
    "observations",
    "checkpoints",
    "subtasks",
    "blobs",
    "coverage",
  ]);
  if (
    x.format !== "pi-task-bundle" ||
    x.version !== 1 ||
    !historyText(x.title, 160)
  )
    return failure("unsupported header");
  const c = shape(x.coverage, ["history", "excluded"]);
  if (c.history !== coverage.history || c.excluded !== coverage.excluded)
    return failure("unknown coverage");
  const projectId = id(x.projectId, /^PRJ-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  const eventIds = new Set<string>(),
    checkpointIds = new Set<string>(),
    taskIds = new Set<string>();
  const wanted = new Map<string, number>();
  let entryCount = 0;
  function records(x: Record<string, unknown>): TaskRecords {
    const taskId = id(x.taskId, uuid);
    distinct(taskIds, taskId);
    if (!historyText(x.title, 160)) return failure("invalid task title");
    if (
      typeof x.captureGaps !== "number" ||
      !Number.isSafeInteger(x.captureGaps) ||
      x.captureGaps < 0
    )
      return failure("invalid checkpoint coverage");
    const prerequisites = boundedList(x.prerequisites, 1024).map((value) =>
      id(value, uuid),
    );
    if (
      new Set(prerequisites).size !== prerequisites.length ||
      prerequisites.includes(taskId)
    )
      return failure("invalid prerequisites");
    const observations = boundedList(x.observations, 10000).map((raw) => {
      const hasSequence =
        raw !== null &&
        typeof raw === "object" &&
        Object.hasOwn(raw, "ownerSequence");
      const row = shape(raw, [
        "eventId",
        "recordedAt",
        "event",
        ...(hasSequence ? ["ownerSequence"] : []),
      ]);
      const ownerSequence = row.ownerSequence;
      if (
        hasSequence &&
        (typeof ownerSequence !== "number" ||
          !Number.isSafeInteger(ownerSequence) ||
          ownerSequence < 1)
      )
        return failure("invalid owner sequence");
      const event = taskObservation(row.event);
      if (!event) return failure("invalid observation");
      const eventId = id(row.eventId, digest);
      if (eventIds.size >= 10000) return failure("too many observations");
      if (
        eventId !==
        sha(
          JSON.stringify([
            taskId,
            event.owner,
            event.operationId,
            event.kind,
            event.state,
          ]),
        )
      )
        return failure("observation identity mismatch");
      distinct(eventIds, eventId);
      return {
        eventId,
        recordedAt: time(row.recordedAt),
        event,
        ...(typeof ownerSequence === "number" ? { ownerSequence } : {}),
      };
    });
    const checkpoints = boundedList(x.checkpoints, 1024).map((raw) => {
      const row = shape(raw, [
        "checkpointId",
        "capturedAt",
        "boundary",
        "manifest",
      ]);
      const checkpointId = id(row.checkpointId, uuid);
      if (checkpointIds.size >= 1024) return failure("too many checkpoints");
      distinct(checkpointIds, checkpointId);
      const m = shape(row.manifest, ["version", "coverage", "entries"]);
      if (m.version !== 1 || m.coverage !== "explicit-working-files")
        return failure("unknown manifest format");
      const files = boundedList(m.entries, 1024);
      entryCount += files.length;
      if (entryCount > 10000) return failure("too many manifest entries");
      const paths = new Set<string>();
      const entries = files.map((rawFile) => {
        const f = entry(rawFile);
        distinct(paths, f.path);
        if (f.digest !== undefined && f.size !== undefined) {
          const previous = wanted.get(f.digest);
          if (previous !== undefined && previous !== f.size)
            return failure("inconsistent blob size");
          wanted.set(f.digest, f.size);
        }
        return f;
      });
      const manifest: TaskFileManifest = {
        version: 1,
        coverage: "explicit-working-files",
        entries,
      };
      return {
        checkpointId,
        capturedAt: time(row.capturedAt),
        boundary: fileBoundary(row.boundary),
        manifest,
      };
    });
    return {
      taskId,
      title: x.title,
      captureGaps: x.captureGaps,
      prerequisites,
      observations,
      checkpoints,
    };
  }
  const top = records(x);
  const subtasks = boundedList(x.subtasks, 127).map((raw) => {
    const child = shape(raw, [
      "taskId",
      "title",
      "captureGaps",
      "prerequisites",
      "observations",
      "checkpoints",
      "parentId",
    ]);
    return { ...records(child), parentId: id(child.parentId, uuid) };
  });
  const parents = new Map(subtasks.map((s) => [s.taskId, s.parentId]));
  for (const { taskId } of subtasks) {
    const seen = new Set<string>();
    let ancestor = taskId;
    while (ancestor !== top.taskId) {
      distinct(seen, ancestor);
      ancestor = parents.get(ancestor) ?? failure("subtask detached from root");
    }
  }
  const dependencies = new Map(
    [top, ...subtasks].map((t) => [t.taskId, t.prerequisites]),
  );
  const complete = new Set<string>(),
    visiting = new Set<string>();
  function visit(taskId: string) {
    if (complete.has(taskId)) return;
    if (visiting.has(taskId)) return failure("dependency cycle");
    visiting.add(taskId);
    for (const prerequisite of dependencies.get(taskId) ?? [])
      visit(prerequisite);
    visiting.delete(taskId);
    complete.add(taskId);
  }
  for (const taskId of taskIds) visit(taskId);
  let decodedBytes = 0;
  const blobs = boundedList(x.blobs, 10000)
    .map((raw) => {
      const b = shape(raw, ["sha256", "data"]);
      const sha256 = id(b.sha256, digest),
        size = wanted.get(sha256);
      if (
        size === undefined ||
        typeof b.data !== "string" ||
        b.data.length !== 4 * Math.ceil(size / 3)
      )
        return failure("unexpected, duplicate or incorrectly sized blob");
      decodedBytes += size;
      if (decodedBytes > maxBlobBytes)
        return failure("artifact limit exceeded");
      const bytes = Buffer.from(b.data, "base64");
      if (
        bytes.length !== size ||
        bytes.toString("base64") !== b.data ||
        sha(bytes) !== sha256
      )
        return failure("blob digest mismatch");
      // v1 only exports admitted text files. An imported archive is untrusted data.
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0") || containsDetectedSecret(text))
        return failure("withheld file content");
      wanted.delete(sha256);
      return { sha256, data: b.data };
    })
    .sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  if (wanted.size) return failure("required artifact missing");
  const body = {
    format: "pi-task-bundle" as const,
    version: 1 as const,
    projectId,
    ...top,
    subtasks,
    blobs,
    coverage,
  };
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) + 90 > maxTaskBundleBytes)
    return failure("bundle exceeds size limit");
  const bundleId = sha(serialized);
  if (id(x.bundleId, digest) !== bundleId)
    return failure("bundle digest mismatch");
  return { ...body, bundleId };
}

/** Export only the selected task and its referenced file bytes. No repository paths,
 * Git ancestors, runtime credentials or restore instructions enter the archive. */
export async function exportTaskBundle(
  store: TaskHistory,
  selection: TaskSelection,
): Promise<TaskBundle> {
  const source = await store.bundle(selection);
  const result = await materializeBundle(store, source);
  const current = await store.selected();
  if (
    current?.taskId !== selection.taskId ||
    current.revision !== selection.revision
  )
    throw Error("Task selection changed during export.");
  return result;
}
async function materializeBundle(
  store: TaskHistory,
  source: Awaited<ReturnType<TaskHistory["bundle"]>>,
): Promise<TaskBundle> {
  const blobs = new Map<string, string>();
  let total = 0;
  async function materialize(
    task: typeof source | (typeof source.subtasks)[number],
  ): Promise<TaskRecords> {
    const checkpoints: Checkpoint[] = [];
    for (const snapshot of task.checkpoints) {
      const entries = snapshot.manifest.entries.map(entry);
      for (const file of entries) {
        if (file.status !== "file" || !file.digest || blobs.has(file.digest))
          continue;
        total += file.size!;
        if (total > maxBlobBytes) return failure("artifact limit exceeded");
        const bytes = await readTaskBlob(store, snapshot.object, file.digest);
        blobs.set(
          file.digest,
          Buffer.from(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          ).toString("base64"),
        );
      }
      checkpoints.push({
        checkpointId: snapshot.checkpointId,
        capturedAt: snapshot.capturedAt,
        boundary: snapshot.boundary,
        manifest: { version: 1, coverage: "explicit-working-files", entries },
      });
    }
    return {
      taskId: task.taskId,
      title: task.title,
      captureGaps: task.captureGaps,
      prerequisites: task.prerequisites,
      observations: task.observations,
      checkpoints,
    };
  }
  const top = await materialize(source);
  const subtasks = [];
  for (const child of source.subtasks)
    subtasks.push({ ...(await materialize(child)), parentId: child.parentId });
  const body = {
    format: "pi-task-bundle" as const,
    version: 1 as const,
    projectId: source.projectId,
    ...top,
    subtasks,
    blobs: [...blobs.keys()]
      .sort()
      .map((sha256) => ({ sha256, data: blobs.get(sha256)! })),
    coverage,
  };
  return unpack({ ...body, bundleId: sha(JSON.stringify(body)) });
}

function bundleFacts(bundle: TaskBundle) {
  return [bundle, ...bundle.subtasks].flatMap((t) => [
    ...t.observations.map((o) => ({
      taskId: t.taskId,
      id: o.eventId,
      digest: sha(JSON.stringify(o)),
    })),
    ...t.checkpoints.map((c) => ({
      taskId: t.taskId,
      id: c.checkpointId,
      digest: sha(JSON.stringify(c)),
    })),
  ]);
}
export async function importTaskBundle(store: TaskHistory, input: unknown) {
  await store.assertCurrent();
  const bundle = unpack(input);
  const facts = bundleFacts(bundle);
  const duplicate = await store.retainImport(
    bundle.projectId,
    bundle.taskId,
    bundle.bundleId,
    JSON.stringify(bundle),
    facts,
  );
  return { bundleId: bundle.bundleId, taskId: bundle.taskId, duplicate };
}

export async function readImportedTaskBundle(
  store: TaskHistory,
  bundleId: string,
): Promise<TaskBundle> {
  id(bundleId, digest);
  const serialized = await store.readImport(bundleId);
  if (!serialized || Buffer.byteLength(serialized) > maxTaskBundleBytes)
    throw Error("Imported bundle unavailable.");
  const bundle = unpack(JSON.parse(serialized));
  if (bundle.bundleId !== bundleId)
    return failure("stored bundle identity mismatch");
  return bundle;
}

export type ArchiveScope = "task" | "project";
export type ArchiveNoteLink = {
  taskId: string;
  path: string;
  sourceHash: string;
};
export type ArchiveMemoryRecord = {
  path: string;
  sourceHash: string;
  sourceText: string;
  tasks: string[];
};
export interface ArchiveMemory {
  records: ArchiveMemoryRecord[];
  limited: boolean;
}
export interface HistoryArchive {
  format: "pi-bookie-history-archive";
  version: 1;
  scope: ArchiveScope;
  archiveId: string;
  projectId: string;
  selectedTaskId: string;
  bundles: TaskBundle[];
  memory: ArchiveMemory;
}
export function archiveMemoryPath(path: unknown): path is string {
  return (
    historyText(path, 512) &&
    path.startsWith("/projects/workspace/") &&
    path.endsWith(".md") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    path
      .split("/")
      .slice(1)
      .every((p) => p.length > 0 && p.trim() === p && !p.startsWith("."))
  );
}
function archiveBody(input: unknown) {
  const raw = shape(input, [
    "format",
    "version",
    "scope",
    "projectId",
    "selectedTaskId",
    "bundles",
    "memory",
  ]);
  if (
    raw.format !== "pi-bookie-history-archive" ||
    raw.version !== 1 ||
    (raw.scope !== "task" && raw.scope !== "project")
  )
    return failure("unknown archive format");
  const projectId = id(raw.projectId, /^PRJ-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  const selectedTaskId = id(raw.selectedTaskId, uuid);
  const tasks = new Set<string>(),
    bundles: TaskBundle[] = [];
  let observations = 0,
    checkpoints = 0;
  for (const data of boundedList(raw.bundles, 128)) {
    const bundle = unpack(data);
    if (bundle.projectId !== projectId)
      return failure("mixed project histories");
    for (const t of [bundle, ...bundle.subtasks]) {
      distinct(tasks, t.taskId);
      observations += t.observations.length;
      checkpoints += t.checkpoints.length;
      if (tasks.size > 128 || observations > 10000 || checkpoints > 1024)
        return failure("archive history exceeds limits");
    }
    bundles.push(bundle);
  }
  if (
    !tasks.has(selectedTaskId) ||
    (raw.scope === "task" &&
      (bundles.length !== 1 || bundles[0]?.taskId !== selectedTaskId))
  )
    return failure("invalid archive scope");
  const links = new Map<string, string[]>();
  for (const b of bundles)
    for (const t of [b, ...b.subtasks]) links.set(t.taskId, t.prerequisites);
  const completed = new Set<string>(),
    visiting = new Set<string>();
  function checkDependencies(t: string) {
    if (completed.has(t)) return;
    if (visiting.has(t)) return failure("archive dependency cycle");
    visiting.add(t);
    for (const next of links.get(t) ?? []) {
      if (raw.scope === "project" && !tasks.has(next))
        return failure("project prerequisite missing");
      if (tasks.has(next)) checkDependencies(next);
    }
    visiting.delete(t);
    completed.add(t);
  }
  for (const t of tasks) checkDependencies(t);
  const memory = shape(raw.memory, ["records", "limited"]);
  if (typeof memory.limited !== "boolean")
    return failure("unknown memory coverage");
  const seen = new Set<string>();
  let bytes = 0;
  const records: ArchiveMemoryRecord[] = [];
  for (const row of boundedList(memory.records, 1024)) {
    const note = shape(row, ["path", "sourceHash", "sourceText", "tasks"]);
    if (
      !archiveMemoryPath(note.path) ||
      typeof note.sourceText !== "string" ||
      typeof note.sourceHash !== "string"
    )
      return failure("invalid note revision");
    const source = Buffer.from(note.sourceText);
    bytes += source.length;
    if (
      source.length > 32768 ||
      bytes > 8 * 1024 * 1024 ||
      note.sourceHash !== "sha256:" + sha(source) ||
      // eslint-disable-next-line no-control-regex -- Archived notes exclude non-printing controls except tabs and line breaks.
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(
        note.sourceText,
      ) ||
      containsDetectedSecret(note.sourceText)
    )
      return failure("withheld or mismatched note");
    distinct(seen, note.path);
    const loaded = loadConcept(source, { file: note.path, maxBytes: 32768 });
    const meta = loaded.ok ? loaded.concept.frontmatter.bookie : undefined;
    if (
      !meta ||
      typeof meta !== "object" ||
      Array.isArray(meta) ||
      !("sensitivity" in meta) ||
      (meta.sensitivity !== "public" && meta.sensitivity !== "internal") ||
      (!(
        note.path === "/projects/workspace/project.md" &&
        "uid" in meta &&
        meta.uid === projectId
      ) &&
        (!("project" in meta) ||
          meta.project !== "/projects/workspace/project.md"))
    )
      return failure("invalid note scope");
    const members = boundedList(note.tasks, 128).map((t) => id(t, uuid));
    if (
      members.some((t) => !tasks.has(t)) ||
      new Set(members).size !== members.length ||
      (raw.scope === "task" && !members.length)
    )
      return failure("note outside archive scope");
    records.push({
      path: note.path,
      sourceHash: note.sourceHash,
      sourceText: note.sourceText,
      tasks: members,
    });
  }
  const body = {
    format: "pi-bookie-history-archive" as const,
    version: 1 as const,
    scope: raw.scope as ArchiveScope,
    projectId,
    selectedTaskId,
    bundles,
    memory: { records, limited: memory.limited },
  };
  if (Buffer.byteLength(JSON.stringify(body)) + 90 > maxTaskBundleBytes)
    return failure("archive exceeds size limit");
  return body;
}
function historicalArchive(input: unknown): HistoryArchive {
  const checked = shape(input, [
    "format",
    "version",
    "scope",
    "projectId",
    "selectedTaskId",
    "bundles",
    "memory",
    "archiveId",
  ]);
  const { archiveId, ...raw } = checked;
  const body = archiveBody(raw);
  if (id(archiveId, digest) !== sha(JSON.stringify(body)))
    return failure("archive digest mismatch");
  return { ...body, archiveId: archiveId as string };
}

/** The runtime supplies a fresh operator-approved, scoped canonical memory reader.
 * A project archive never changes active selection to visit another task. */
export async function exportHistoryArchive(
  store: TaskHistory,
  selection: TaskSelection,
  scope: ArchiveScope,
  readMemory: (links: ArchiveNoteLink[]) => Promise<ArchiveMemory>,
): Promise<HistoryArchive> {
  const plan = await store.archivePlan(selection, scope);
  const bundles: TaskBundle[] = [];
  let size = 0;
  for (const tree of plan.trees) {
    const bundle = await materializeBundle(store, tree);
    size += Buffer.byteLength(JSON.stringify(bundle));
    if (size > maxTaskBundleBytes) return failure("archive exceeds size limit");
    bundles.push(bundle);
  }
  const memory = await readMemory(plan.links);
  const body = archiveBody({
    format: "pi-bookie-history-archive",
    version: 1,
    scope,
    projectId: plan.projectId,
    selectedTaskId: plan.selectedTaskId,
    bundles,
    memory,
  });
  const current = await store.selected();
  if (
    current?.taskId !== selection.taskId ||
    current.revision !== selection.revision
  )
    throw Error("Task selection changed during export.");
  return { ...body, archiveId: sha(JSON.stringify(body)) };
}
export async function importHistoryArchive(store: TaskHistory, input: unknown) {
  await store.assertCurrent();
  const archive = historicalArchive(input);
  const duplicate = await store.retainImport(
    archive.projectId,
    archive.selectedTaskId,
    archive.archiveId,
    JSON.stringify(archive),
    archive.bundles.flatMap(bundleFacts),
  );
  return {
    bundleId: archive.archiveId,
    taskId: archive.selectedTaskId,
    duplicate,
  };
}
export async function readImportedHistoryArchive(
  store: TaskHistory,
  archiveId: string,
) {
  id(archiveId, digest);
  const stored = await store.readImport(archiveId);
  if (!stored || Buffer.byteLength(stored) > maxTaskBundleBytes)
    throw Error("Historical archive unavailable.");
  const result = historicalArchive(JSON.parse(stored));
  if (result.archiveId !== archiveId)
    return failure("stored archive identity mismatch");
  return result;
}
