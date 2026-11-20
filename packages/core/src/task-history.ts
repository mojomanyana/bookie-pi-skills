import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { safeText } from "./recall-scope.js";
import { containsDetectedSecret } from "./vault-secret-detection.js";

export const taskOwners = [
  "principal",
  "scout",
  "harness",
  "pi-daddy",
] as const;
export type TaskOwner = (typeof taskOwners)[number];
export interface TaskObservation {
  version: 1;
  owner: TaskOwner;
  operationId: string;
  kind: string;
  state: string;
  label: string;
  evidence?: { type: "operation" | "brief" | "evaluation"; id: string };
}
export interface TaskSelection {
  taskId: string;
  title: string;
  revision: number;
}
export interface TaskHistoryScope {
  /** Canonical managed vault in its private ledger directory. */
  vault: string;
  projectId: string;
  assertCurrent(): Promise<void>;
}
export type FileBoundary =
  | { stage: "manual" }
  | {
      stage: "before" | "after";
      tool: "write" | "edit" | "apply_patch" | "delegate" | "bash";
      callId: string;
    };
export function fileBoundary(raw: unknown): FileBoundary {
  if (!raw || typeof raw !== "object" || !("stage" in raw)) throw invalid();
  if (raw.stage === "manual" && Object.keys(raw).length === 1)
    return { stage: "manual" };
  if (
    (raw.stage === "before" || raw.stage === "after") &&
    Object.keys(raw).length === 3 &&
    "tool" in raw &&
    (raw.tool === "write" ||
      raw.tool === "edit" ||
      raw.tool === "apply_patch" ||
      raw.tool === "delegate" ||
      raw.tool === "bash") &&
    "callId" in raw &&
    typeof raw.callId === "string" &&
    /^[0-9a-f]{64}$/u.test(raw.callId)
  )
    return { stage: raw.stage, tool: raw.tool, callId: raw.callId };
  throw invalid();
}
export interface ObservedCheckpoint {
  checkpointId: string;
  state: "captured" | "published";
  capturedAt: string;
  coverage: string;
  files: number;
  missing: number;
  excluded: number;
}
export interface TaskHistoryView extends TaskSelection {
  observations: number;
  captureGaps: number;
  lastObservation?: {
    owner: TaskOwner;
    state: string;
    label: string;
    recordedAt: string;
  };
  lastCheckpoint?: ObservedCheckpoint;
}
const invalid = () =>
  Error("Task history is unavailable, invalid or no longer selected.");
const conflict = () =>
  Error("This task event identity already has different content.");
const hash = (input: string) =>
  createHash("sha256").update(input).digest("hex");
const validId = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(s);
export const historyText = (s: unknown, max: number): s is string =>
  safeText(s, max) && s.trim() === s && !/\p{Cf}/u.test(s);
export function taskObservation(raw: unknown): TaskObservation | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const x = raw as Record<string, unknown>;
  let evidence: TaskObservation["evidence"];
  if (Object.hasOwn(x, "evidence")) {
    const ref = x.evidence as Record<string, unknown> | null;
    if (
      !ref ||
      typeof ref !== "object" ||
      Object.keys(ref).length !== 2 ||
      (ref.type !== "operation" &&
        ref.type !== "brief" &&
        ref.type !== "evaluation") ||
      !historyText(ref.id, 128) ||
      !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(ref.id)
    )
      return;
    evidence = {
      type: ref.type as NonNullable<TaskObservation["evidence"]>["type"],
      id: ref.id,
    };
  }
  if (
    Object.keys(x).length !== (evidence ? 7 : 6) ||
    x.version !== 1 ||
    !taskOwners.includes(x.owner as TaskOwner) ||
    !historyText(x.operationId, 256) ||
    !historyText(x.kind, 64) ||
    !historyText(x.state, 64) ||
    !historyText(x.label, 240)
  )
    return;
  return {
    version: 1,
    owner: x.owner as TaskOwner,
    operationId: x.operationId,
    kind: x.kind,
    state: x.state,
    label: x.label,
    ...(evidence ? { evidence } : {}),
  };
}
const schema = `
CREATE TABLE IF NOT EXISTS binding (singleton INTEGER PRIMARY KEY CHECK(singleton=1), project TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS active (singleton INTEGER PRIMARY KEY CHECK(singleton=1), task TEXT NOT NULL REFERENCES tasks(id), revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS capture_policy (task TEXT PRIMARY KEY REFERENCES tasks(id), auto INTEGER NOT NULL, protect INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS capture_gaps (task TEXT PRIMARY KEY REFERENCES tasks(id), count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS operation_origins (task TEXT NOT NULL REFERENCES tasks(id), owner TEXT NOT NULL, operation TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(task,owner,operation,kind));
CREATE TABLE IF NOT EXISTS note_links (task TEXT NOT NULL REFERENCES tasks(id), path TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(task,path,digest));
CREATE TABLE IF NOT EXISTS task_children (child TEXT PRIMARY KEY REFERENCES tasks(id), parent TEXT NOT NULL REFERENCES tasks(id));
CREATE INDEX IF NOT EXISTS task_children_parent ON task_children(parent);
CREATE TABLE IF NOT EXISTS task_dependencies (task TEXT NOT NULL REFERENCES tasks(id), prerequisite TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(task,prerequisite));
CREATE TABLE IF NOT EXISTS tracking (task TEXT PRIMARY KEY REFERENCES tasks(id), paths TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS replay_sources (id TEXT PRIMARY KEY REFERENCES observations(id), source_seq INTEGER NOT NULL, indexed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS replay_cursors (task TEXT NOT NULL REFERENCES tasks(id), owner TEXT NOT NULL, cursor INTEGER NOT NULL, PRIMARY KEY(task,owner));
CREATE TABLE IF NOT EXISTS observations (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, task TEXT NOT NULL REFERENCES tasks(id), instant TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS observations_task ON observations(task,seq);
CREATE TABLE IF NOT EXISTS checkpoints (seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, task TEXT NOT NULL REFERENCES tasks(id), instant TEXT NOT NULL, manifest TEXT NOT NULL, boundary TEXT NOT NULL, object TEXT);
CREATE INDEX IF NOT EXISTS checkpoints_task ON checkpoints(task,seq);
CREATE TABLE IF NOT EXISTS staging (checkpoint TEXT NOT NULL REFERENCES checkpoints(id), digest TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(checkpoint,digest));
CREATE TABLE IF NOT EXISTS imported_bundles (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS imported_facts (project TEXT NOT NULL, task TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(project,task,id));
`;
type HistoryDatabase = import("node:sqlite").DatabaseSync;

function storeObservation(
  db: DatabaseSync,
  taskId: string,
  event: TaskObservation,
  continued = false,
  recordedAt = new Date().toISOString(),
) {
  const payload = JSON.stringify(event);
  const identity = [
    taskId,
    event.owner,
    event.operationId,
    event.kind,
  ] as const;
  const eventId = hash(JSON.stringify([...identity, event.state]));
  if (continued) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM operation_origins WHERE task=? AND owner=? AND operation=? AND kind=?",
        )
        .get(...identity)
    )
      throw invalid();
  } else
    db.prepare("INSERT OR IGNORE INTO operation_origins VALUES(?,?,?,?)").run(
      ...identity,
    );
  const prior = db
    .prepare("SELECT payload FROM observations WHERE id=?")
    .get(eventId);
  if (prior && prior.payload !== payload) throw conflict();
  if (!prior)
    db.prepare(
      "INSERT INTO observations(id,task,instant,payload) VALUES(?,?,?,?)",
    ).run(eventId, taskId, recordedAt, payload);
  return { eventId };
}
function prerequisites(db: HistoryDatabase, taskId: string) {
  return db
    .prepare(
      "SELECT p.id AS taskId,p.title FROM task_dependencies d JOIN tasks p ON p.id=d.prerequisite WHERE d.task=? ORDER BY p.id",
    )
    .all(taskId)
    .map(taskTitle);
}
function taskTitle(row: Record<string, unknown>) {
  if (!validId(row.taskId) || !historyText(row.title, 160)) throw invalid();
  return { taskId: row.taskId, title: row.title };
}
function readTaskRecords(db: HistoryDatabase, taskId: string, title: string) {
  const events = db
    .prepare(
      "SELECT o.id,o.instant,o.payload,r.source_seq FROM observations o LEFT JOIN replay_sources r ON o.id=r.id WHERE o.task=? ORDER BY o.instant,o.seq LIMIT 10001",
    )
    .all(taskId);
  const captures = db
    .prepare(
      "SELECT id,instant,manifest,boundary,object FROM checkpoints WHERE task=? ORDER BY seq LIMIT 1025",
    )
    .all(taskId);
  if (
    events.length > 10000 ||
    captures.length > 1024 ||
    captures.some((c) => c.object === null)
  )
    throw Error(
      "Task export exceeds its limit or checkpoint publication is pending.",
    );
  return {
    taskId,
    title,
    captureGaps: Number(
      db.prepare("SELECT count FROM capture_gaps WHERE task=?").get(taskId)
        ?.count ?? 0,
    ),
    prerequisites: prerequisites(db, taskId).map((row) => row.taskId),
    observations: events.map((row) => {
      const event = taskObservation(JSON.parse(String(row.payload)));
      if (!event) throw invalid();
      return {
        eventId: String(row.id),
        recordedAt: String(row.instant),
        event,
        ...(row.source_seq === null
          ? {}
          : { ownerSequence: Number(row.source_seq) }),
      };
    }),
    checkpoints: captures.map((c) => ({
      checkpointId: String(c.id),
      capturedAt: String(c.instant),
      boundary: fileBoundary(JSON.parse(String(c.boundary))),
      manifest: JSON.parse(String(c.manifest)) as TaskFileManifest,
      object: String(c.object),
    })),
  };
}

function collectTree(
  db: HistoryDatabase,
  current: { taskId: string; title: string },
  projectId: string,
) {
  const descendants = db
    .prepare(
      `WITH RECURSIVE included(id) AS
          (SELECT ? UNION SELECT c.child FROM task_children c JOIN included i ON c.parent=i.id LIMIT 129)
          SELECT t.id AS taskId,t.title,c.parent FROM included i JOIN tasks t ON t.id=i.id
          JOIN task_children c ON c.child=i.id WHERE i.id<>? ORDER BY t.rowid`,
    )
    .all(current.taskId, current.taskId);
  if (descendants.length >= 128)
    throw Error("Task export exceeds the supported subtask count.");
  const top = readTaskRecords(db, current.taskId, current.title);
  let events = top.observations.length,
    captures = top.checkpoints.length;
  const subtasks = descendants.map((row) => {
    const child = taskTitle(row);
    if (!validId(row.parent)) throw invalid();
    const records = readTaskRecords(db, child.taskId, child.title);
    events += records.observations.length;
    captures += records.checkpoints.length;
    if (events > 10000 || captures > 1024)
      throw Error("Task export exceeds the supported record count.");
    return { ...records, parentId: row.parent };
  });
  return {
    version: 1 as const,
    projectId,
    ...top,
    subtasks,
  };
}

function selectedRow(db: DatabaseSync): TaskSelection | undefined {
  const row = db
    .prepare(
      "SELECT t.id AS taskId,t.title,a.revision FROM active a JOIN tasks t ON t.id=a.task WHERE a.singleton=1",
    )
    .get();
  if (!row) return;
  if (
    !validId(row.taskId) ||
    !historyText(row.title, 160) ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision)
  )
    throw invalid();
  return { taskId: row.taskId, title: row.title, revision: row.revision };
}
function requireSelection(db: DatabaseSync, wanted: TaskSelection) {
  const actual = selectedRow(db);
  if (
    !actual ||
    actual.taskId !== wanted.taskId ||
    actual.revision !== wanted.revision
  )
    throw invalid();
  return actual;
}
async function assertPrivate(path: string, kind: "dir" | "file") {
  const st = await lstat(path);
  if (
    (kind === "dir" ? !st.isDirectory() : !st.isFile() || st.nlink !== 1) ||
    (typeof process.getuid === "function" &&
      (st.uid !== process.getuid() || (st.mode & 0o077) !== 0))
  )
    throw invalid();
}
const absent = (err: unknown) =>
  err instanceof Error && "code" in err && err.code === "ENOENT";
async function privateFile(path: string, create: boolean) {
  try {
    await assertPrivate(path, "file");
    return true;
  } catch (err) {
    if (!absent(err)) throw err;
  }
  if (!create) return false;
  try {
    await (await open(path, "wx", 0o600)).close();
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST"))
      throw err;
  }
  await assertPrivate(path, "file");
  return true;
}
export async function openTaskHistory(scope: TaskHistoryScope) {
  if (!/^PRJ-[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(scope.projectId))
    throw invalid();
  await scope.assertCurrent();
  const base = dirname(scope.vault);
  if (basename(scope.vault) !== "vault" || (await realpath(base)) !== base)
    throw invalid();
  await assertPrivate(base, "dir");
  const path = join(base, "task-history-v1.sqlite");
  async function use<T>(
    write: boolean,
    action: (db: DatabaseSync) => T,
  ): Promise<T | undefined> {
    await scope.assertCurrent();
    await assertPrivate(base, "dir");
    if (!(await privateFile(path, write))) return;
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try {
        await assertPrivate(path + suffix, "file");
      } catch (e) {
        if (!absent(e)) throw e;
      }
    }
    const { DatabaseSync } = await import("node:sqlite");
    await scope.assertCurrent();
    const db = new DatabaseSync(path, { readOnly: !write });
    try {
      db.exec(
        "PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=500; PRAGMA foreign_keys=ON;",
      );
      db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      if (write) {
        db.exec(schema);
        db.prepare("INSERT OR IGNORE INTO binding VALUES(1,?,1)").run(
          scope.projectId,
        );
      }
      const bound = db
        .prepare("SELECT project,version FROM binding WHERE singleton=1")
        .get();
      if (bound?.project !== scope.projectId || bound.version !== 1)
        throw invalid();
      const value = action(db);
      db.exec("COMMIT");
      return value;
    } finally {
      db.close();
    }
  }
  async function select(id: string, title?: string): Promise<TaskSelection> {
    if (!validId(id) || (title !== undefined && !historyText(title, 160)))
      throw invalid();
    return (await use(true, (db) => {
      if (title !== undefined)
        db.prepare("INSERT INTO tasks VALUES(?,?)").run(id, title);
      if (!db.prepare("SELECT 1 FROM tasks WHERE id=?").get(id))
        throw invalid();
      const previous = selectedRow(db);
      if (previous?.taskId !== id)
        db.prepare(
          "INSERT INTO active VALUES(1,?,1) ON CONFLICT(singleton) DO UPDATE SET task=excluded.task,revision=revision+1",
        ).run(id);
      return selectedRow(db)!;
    }))!;
  }
  return {
    selected: async () => (await use(false, selectedRow)) ?? undefined,
    async ensureSelected(): Promise<TaskSelection> {
      return (await use(true, (db) => {
        const existing = selectedRow(db);
        if (existing) return existing;
        const id = randomUUID();
        db.prepare("INSERT INTO tasks VALUES(?,?)").run(id, "Workspace task");
        db.prepare("INSERT INTO active VALUES(1,?,1)").run(id);
        return selectedRow(db)!;
      }))!;
    },
    list: async (limit = 100) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101)
        throw invalid();
      return (
        (await use(false, (db) =>
          db
            .prepare("SELECT id,title FROM tasks ORDER BY rowid DESC LIMIT ?")
            .all(limit)
            .map((row) => {
              if (!validId(row.id) || !historyText(row.title, 160))
                throw invalid();
              return { taskId: row.id, title: row.title };
            }),
        )) ?? []
      );
    },
    async rename(task: TaskSelection, title: string) {
      if (!historyText(title, 160)) throw invalid();
      return (await use(true, (db) => {
        requireSelection(db, task);
        db.prepare("UPDATE tasks SET title=? WHERE id=?").run(
          title,
          task.taskId,
        );
        return selectedRow(db)!;
      }))!;
    },
    selectNew: (title: string) => select(randomUUID(), title),
    selectExisting: (id: string) => select(id),
    async append(task: TaskSelection, raw: unknown, continued = false) {
      const event = taskObservation(raw);
      if (!event) throw invalid();
      return (await use(true, (db) => {
        if (!continued) requireSelection(db, task);
        return storeObservation(db, task.taskId, event, continued);
      }))!;
    },
    async replayCursor(task: TaskSelection, owner: TaskOwner) {
      if (owner !== "pi-daddy") throw invalid();
      return (
        (await use(false, (db) => {
          requireSelection(db, task);
          if (
            !db
              .prepare(
                "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='replay_cursors'",
              )
              .get()
          )
            return 0;
          return Number(
            db
              .prepare(
                "SELECT cursor FROM replay_cursors WHERE task=? AND owner=?",
              )
              .get(task.taskId, owner)?.cursor ?? 0,
          );
        })) ?? 0
      );
    },
    async applyReplay(
      task: TaskSelection,
      owner: TaskOwner,
      after: number,
      next: number,
      raw: unknown[],
      provenance: { sequence: number; recordedAt: string }[],
    ) {
      if (
        owner !== "pi-daddy" ||
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(next) ||
        next <= after ||
        next - after > 32 ||
        !Array.isArray(raw) ||
        !Array.isArray(provenance) ||
        provenance.length !== raw.length ||
        raw.length > next - after
      )
        throw invalid();
      let lastSequence = after;
      for (const source of provenance) {
        if (
          !source ||
          !Number.isSafeInteger(source.sequence) ||
          source.sequence <= lastSequence ||
          source.sequence > next ||
          typeof source.recordedAt !== "string" ||
          !Number.isFinite(Date.parse(source.recordedAt)) ||
          new Date(source.recordedAt).toISOString() !== source.recordedAt
        )
          throw invalid();
        lastSequence = source.sequence;
      }
      const events = raw.map((value) => {
        const event = taskObservation(value);
        if (!event || event.owner !== owner) throw invalid();
        return event;
      });
      await use(true, (db) => {
        requireSelection(db, task);
        const previous = Number(
          db
            .prepare(
              "SELECT cursor FROM replay_cursors WHERE task=? AND owner=?",
            )
            .get(task.taskId, owner)?.cursor ?? 0,
        );
        if (previous >= next) {
          // A concurrent reader may already have applied this page.
          for (const [index, event] of events.entries()) {
            const source = provenance[index];
            if (!source) throw invalid();
            const id = hash(
              JSON.stringify([
                task.taskId,
                event.owner,
                event.operationId,
                event.kind,
                event.state,
              ]),
            );
            const saved = db
              .prepare(
                "SELECT o.payload,o.instant,r.source_seq FROM observations o JOIN replay_sources r ON o.id=r.id WHERE o.id=?",
              )
              .get(id);
            if (
              !saved ||
              saved.payload !== JSON.stringify(event) ||
              saved.instant !== source.recordedAt ||
              saved.source_seq !== source.sequence
            )
              throw conflict();
          }
          return;
        }
        if (previous !== after) throw conflict();
        const indexedAt = new Date().toISOString();
        for (const [index, event] of events.entries()) {
          const source = provenance[index];
          if (!source) throw invalid();
          const { eventId } = storeObservation(
            db,
            task.taskId,
            event,
            false,
            source.recordedAt,
          );
          db.prepare("INSERT INTO replay_sources VALUES(?,?,?)").run(
            eventId,
            source.sequence,
            indexedAt,
          );
        }
        db.prepare(
          "INSERT INTO replay_cursors VALUES(?,?,?) ON CONFLICT(task,owner) DO UPDATE SET cursor=excluded.cursor",
        ).run(task.taskId, owner, next);
      });
    },
    async capturePolicy(task: TaskSelection) {
      return (await use(false, (db) => {
        requireSelection(db, task);
        const row = db
          .prepare("SELECT auto,protect FROM capture_policy WHERE task=?")
          .get(task.taskId);
        const files = db
          .prepare("SELECT paths FROM tracking WHERE task=?")
          .get(task.taskId);
        return {
          auto: row?.auto === 1,
          protect: row?.protect === 1,
          paths: files ? (JSON.parse(String(files.paths)) as string[]) : [],
        };
      }))!;
    },
    async setCapturePolicy(
      task: TaskSelection,
      autosave: boolean,
      protect: boolean,
    ) {
      if (typeof autosave !== "boolean" || typeof protect !== "boolean")
        throw invalid();
      await use(true, (db) => {
        requireSelection(db, task);
        db.prepare(
          "INSERT INTO capture_policy VALUES(?,?,?) ON CONFLICT(task) DO UPDATE SET auto=excluded.auto,protect=excluded.protect",
        ).run(task.taskId, +autosave, +protect);
        db.prepare("UPDATE active SET revision=revision+1 WHERE task=?").run(
          task.taskId,
        );
      });
    },
    async captureGap(task: TaskSelection, prior?: string) {
      await use(true, (db) => {
        if (prior === undefined) requireSelection(db, task);
        else if (
          !validId(prior) ||
          !db
            .prepare("SELECT 1 FROM checkpoints WHERE id=? AND task=?")
            .get(prior, task.taskId)
        )
          throw invalid();
        db.prepare(
          "INSERT INTO capture_gaps VALUES(?,1) ON CONFLICT(task) DO UPDATE SET count=count+1",
        ).run(task.taskId);
      });
    },
    async recent(task: TaskSelection, limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        throw invalid();
      return (await use(false, (db) => {
        requireSelection(db, task);
        return db
          .prepare(
            "SELECT o.id,o.instant,o.payload,r.indexed_at,r.source_seq FROM observations o LEFT JOIN replay_sources r ON o.id=r.id WHERE o.task=? ORDER BY o.instant DESC,o.seq DESC LIMIT ?",
          )
          .all(task.taskId, limit)
          .map((row) => {
            const event = taskObservation(JSON.parse(String(row.payload)));
            if (!event || !historyText(row.instant, 32)) throw invalid();
            return {
              eventId: String(row.id),
              recordedAt: row.instant,
              event,
              ...(row.source_seq === null
                ? {}
                : {
                    ownerSequence: Number(row.source_seq),
                    indexedAt: String(row.indexed_at),
                  }),
            };
          });
      }))!;
    },
    async project(task: TaskSelection): Promise<TaskHistoryView> {
      return (await use(false, (db) => {
        const selected = requireSelection(db, task);
        const count = Number(
          db
            .prepare("SELECT count(*) AS count FROM observations WHERE task=?")
            .get(task.taskId)!.count,
        );
        const latest = db
          .prepare(
            "SELECT instant,payload FROM observations WHERE task=? ORDER BY instant DESC,seq DESC LIMIT 1",
          )
          .get(task.taskId);
        const checkpoint = db
          .prepare(
            "SELECT id,instant,manifest,object FROM checkpoints WHERE task=? ORDER BY seq DESC LIMIT 1",
          )
          .get(task.taskId);
        const gap = db
          .prepare("SELECT count FROM capture_gaps WHERE task=?")
          .get(task.taskId);
        const view: TaskHistoryView = {
          ...selected,
          observations: count,
          captureGaps: Number(gap?.count ?? 0),
        };
        if (checkpoint) {
          const manifest: TaskFileManifest = JSON.parse(
            String(checkpoint.manifest),
          );
          view.lastCheckpoint = {
            checkpointId: String(checkpoint.id),
            capturedAt: String(checkpoint.instant),
            state: checkpoint.object ? "published" : "captured",
            coverage: manifest.coverage,
            files: manifest.entries.filter((e) => e.status === "file").length,
            missing: manifest.entries.filter((e) => e.status === "missing")
              .length,
            excluded: manifest.entries.filter((e) => e.status === "excluded")
              .length,
          };
        }
        if (latest) {
          const observed = taskObservation(JSON.parse(String(latest.payload)));
          if (!observed) throw invalid();
          view.lastObservation = {
            owner: observed.owner,
            state: observed.state,
            label: observed.label,
            recordedAt: String(latest.instant),
          };
        }
        return view;
      }))!;
    },
    // The checkpoint worker can publish an already-retained capture after a task switch.
    // Admission to capture new bytes always checks the current selection.
    async linkNote(task: TaskSelection, path: string, digest: string) {
      if (
        !/^\/projects\/workspace\/activities\/note-[a-f0-9]{32}\.md$/u.test(
          path,
        ) ||
        !/^sha256:[a-f0-9]{64}$/u.test(digest)
      )
        throw invalid();
      await use(true, (db) => {
        requireSelection(db, task);
        db.prepare(
          "INSERT OR IGNORE INTO note_links(task,path,digest) VALUES(?,?,?)",
        ).run(task.taskId, path, digest);
      });
    },
    async noteLinks(task: TaskSelection) {
      return (await use(false, (db) => {
        requireSelection(db, task);
        return db
          .prepare(
            "SELECT path,digest FROM note_links WHERE task=? ORDER BY rowid DESC LIMIT 51",
          )
          .all(task.taskId)
          .map((row) => ({
            path: String(row.path),
            sourceHash: String(row.digest),
          }));
      }))!;
    },
    async tracked(task: TaskSelection) {
      return (await use(false, (db) => {
        requireSelection(db, task);
        const row = db
          .prepare("SELECT paths FROM tracking WHERE task=?")
          .get(task.taskId);
        return row ? (JSON.parse(String(row.paths)) as string[]) : [];
      }))!;
    },
    async setTracked(task: TaskSelection, paths: string[]) {
      const { validTaskFileSet } = await import("./task-history-files.js");
      if (!validTaskFileSet(paths)) throw invalid();
      await use(true, (db) => {
        requireSelection(db, task);
        const canonical = JSON.stringify([...paths].sort());
        const prior = db
          .prepare("SELECT paths FROM tracking WHERE task=?")
          .get(task.taskId);
        if ((prior?.paths ?? "[]") === canonical) return;
        db.prepare(
          "INSERT INTO tracking(task,paths) VALUES(?,?) ON CONFLICT(task) DO UPDATE SET paths=excluded.paths",
        ).run(task.taskId, canonical);
        db.prepare("UPDATE active SET revision=revision+1 WHERE task=?").run(
          task.taskId,
        );
      });
    },
    async capture(
      task: TaskSelection,
      snapshot: CapturedTaskFiles,
      boundary: FileBoundary = { stage: "manual" },
    ) {
      const { validTaskFileSet } = await import("./task-history-files.js");
      if (
        Object.keys(snapshot.manifest).length !== 3 ||
        snapshot.manifest.entries.length > 32 ||
        snapshot.blobs.size > 32
      )
        throw invalid();
      // Capture the submitted values before yielding to the authorization check.
      const manifest = structuredClone(snapshot.manifest);
      const edge = JSON.stringify(fileBoundary(boundary));
      const retained = new Map<string, Buffer>();
      const expected = new Set<string>();
      let total = 0;
      if (
        manifest.version !== 1 ||
        manifest.coverage !== "explicit-working-files" ||
        !validTaskFileSet(manifest.entries.map((e) => e.path)) ||
        !manifest.entries.length
      )
        throw invalid();
      for (const e of manifest.entries) {
        if (e.status === "missing" || e.status === "excluded") {
          if (Object.keys(e).length !== 2) throw invalid();
          continue;
        }
        if (
          e.status !== "file" ||
          typeof e.digest !== "string" ||
          !["100644", "100755"].includes(e.mode ?? "") ||
          Object.keys(e).length !== 5
        )
          throw invalid();
        const source = snapshot.blobs.get(e.digest);
        const bytes = source && Buffer.from(source);
        if (
          !bytes ||
          hashBytes(bytes) !== e.digest ||
          bytes.length !== e.size ||
          bytes.length > 1024 * 1024
        )
          throw invalid();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes("\u0000") || containsDetectedSecret(text))
          throw invalid();
        total += bytes.length;
        expected.add(e.digest);
        retained.set(e.digest, bytes);
      }
      if (total > 4 * 1024 * 1024 || expected.size !== snapshot.blobs.size)
        throw invalid();

      return (await use(true, (db) => {
        requireSelection(db, task);
        const id = randomUUID();
        const text = JSON.stringify(manifest);
        if (boundary.stage !== "manual") {
          const prior = db
            .prepare(
              "SELECT id,manifest FROM checkpoints WHERE task=? AND boundary=? LIMIT 1",
            )
            .get(task.taskId, edge);
          if (prior && prior.manifest !== text) throw conflict();
          if (prior) return String(prior.id);
        }
        db.prepare(
          "INSERT INTO checkpoints(id,task,instant,manifest,boundary) VALUES(?,?,?,?,?)",
        ).run(id, task.taskId, new Date().toISOString(), text, edge);
        const insert = db.prepare(
          "INSERT INTO staging(checkpoint,digest,bytes) VALUES(?,?,?)",
        );
        for (const [digest, bytes] of retained) insert.run(id, digest, bytes);
        return id;
      }))!;
    },
    assertCurrent: scope.assertCurrent,
    async pending() {
      return use(false, (db) => {
        const row = db
          .prepare(
            "SELECT id,task,manifest FROM checkpoints WHERE object IS NULL ORDER BY seq LIMIT 1",
          )
          .get();
        if (!row) return;
        if (!validId(row.id) || !validId(row.task)) throw invalid();
        const blobs = db
          .prepare("SELECT digest,bytes FROM staging WHERE checkpoint=?")
          .all(row.id);
        return {
          id: row.id,
          taskId: row.task,
          manifest: String(row.manifest),
          blobs: blobs.map((b): { digest: string; bytes: Uint8Array } => {
            if (
              typeof b.digest !== "string" ||
              !(b.bytes instanceof Uint8Array) ||
              hashBytes(b.bytes) !== b.digest
            )
              throw invalid();
            return { digest: b.digest, bytes: b.bytes };
          }),
        };
      });
    },
    async published(id: string, object: string) {
      if (!validId(id) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(object))
        throw invalid();
      await use(true, (db) => {
        const receipt = db
          .prepare("SELECT object FROM checkpoints WHERE id=?")
          .get(id);
        if (!receipt || (receipt.object !== null && receipt.object !== object))
          throw invalid();
        db.prepare("UPDATE checkpoints SET object=? WHERE id=?").run(
          object,
          id,
        );
        db.prepare("DELETE FROM staging WHERE checkpoint=?").run(id);
      });
    },
    async createChild(parent: TaskSelection, title: string) {
      if (!historyText(title, 160)) throw invalid();
      return (await use(true, (db) => {
        requireSelection(db, parent);
        const child = randomUUID();
        db.prepare("INSERT INTO tasks(id,title) VALUES(?,?)").run(child, title);
        db.prepare("INSERT INTO task_children(child,parent) VALUES(?,?)").run(
          child,
          parent.taskId,
        );
        db.prepare(
          "UPDATE active SET task=?,revision=revision+1 WHERE singleton=1",
        ).run(child);
        return selectedRow(db)!;
      }))!;
    },
    async addDependency(task: TaskSelection, prerequisiteId: string) {
      if (!validId(prerequisiteId)) throw invalid();
      await use(true, (db) => {
        requireSelection(db, task);
        if (!db.prepare("SELECT 1 FROM tasks WHERE id=?").get(prerequisiteId))
          throw Error(
            "The prerequisite task is outside the current project or unavailable.",
          );
        const cycle = db
          .prepare(
            `WITH RECURSIVE upstream(id) AS
          (SELECT ? UNION SELECT d.prerequisite FROM task_dependencies d JOIN upstream u ON d.task=u.id)
          SELECT 1 FROM upstream WHERE id=? LIMIT 1`,
          )
          .get(prerequisiteId, task.taskId);
        if (cycle)
          throw Error(
            "That prerequisite would create a task dependency cycle.",
          );
        db.prepare(
          "INSERT OR IGNORE INTO task_dependencies(task,prerequisite) VALUES(?,?)",
        ).run(task.taskId, prerequisiteId);
      });
    },
    async budgetRoot(task: TaskSelection) {
      return (await use(false, (db) => {
        requireSelection(db, task);
        const roots = db
          .prepare(
            `WITH RECURSIVE lineage(id) AS (SELECT ? UNION SELECT c.parent FROM task_children c JOIN lineage l ON c.child=l.id)
          SELECT t.id FROM lineage l JOIN tasks t ON t.id=l.id LEFT JOIN task_children c ON c.child=t.id WHERE c.child IS NULL LIMIT 2`,
          )
          .all(task.taskId);
        const id = roots[0]?.id;
        if (roots.length !== 1 || !validId(id)) throw invalid();
        return id;
      }))!;
    },
    async relationships(task: TaskSelection) {
      return (await use(false, (db) => {
        requireSelection(db, task);
        const parent = db
          .prepare(
            "SELECT p.id AS taskId,p.title FROM task_children c JOIN tasks p ON p.id=c.parent WHERE c.child=?",
          )
          .get(task.taskId);
        const children = db
          .prepare(
            "SELECT t.id AS taskId,t.title FROM task_children c JOIN tasks t ON t.id=c.child WHERE c.parent=? ORDER BY t.rowid",
          )
          .all(task.taskId)
          .map(taskTitle);
        return {
          ...(parent ? { parent: taskTitle(parent) } : {}),
          children,
          prerequisites: prerequisites(db, task.taskId),
        };
      }))!;
    },
    async bundle(task: TaskSelection) {
      return (await use(false, (db) => {
        const current = requireSelection(db, task);
        return collectTree(db, current, scope.projectId);
      }))!;
    },
    async archivePlan(task: TaskSelection, scopeKind: "task" | "project") {
      return (await use(false, (db) => {
        const current = requireSelection(db, task);
        if (scopeKind !== "task" && scopeKind !== "project") throw invalid();
        const roots =
          scopeKind === "task"
            ? [current]
            : db
                .prepare(
                  "SELECT t.id AS taskId,t.title FROM tasks t LEFT JOIN task_children c ON c.child=t.id WHERE c.child IS NULL ORDER BY t.id LIMIT 129",
                )
                .all()
                .map(taskTitle);
        if (roots.length > 128)
          throw Error("Project archive exceeds its task limit.");
        const trees: ReturnType<typeof collectTree>[] = [];
        const links: { taskId: string; path: string; sourceHash: string }[] =
          [];
        let total = 0,
          observations = 0,
          captures = 0;
        for (const root of roots) {
          const tree = collectTree(db, root, scope.projectId);
          for (const member of [tree, ...tree.subtasks]) {
            total++;
            observations += member.observations.length;
            captures += member.checkpoints.length;
            if (total > 128 || observations > 10000 || captures > 1024)
              throw Error("Project archive exceeds its history limits.");
            const rows = db
              .prepare(
                "SELECT path,digest FROM note_links WHERE task=? ORDER BY path,digest LIMIT 1025",
              )
              .all(member.taskId);
            for (const row of rows) {
              if (links.length >= 1024)
                throw Error(
                  "Project archive exceeds its memory reference limit.",
                );
              links.push({
                taskId: member.taskId,
                path: String(row.path),
                sourceHash: String(row.digest),
              });
            }
          }
          trees.push(tree);
        }
        return {
          projectId: scope.projectId,
          selectedTaskId: current.taskId,
          trees,
          links,
        };
      }))!;
    },
    // Archives have their own immutable namespace. Importing never selects a
    // task, mutates a live note, grants access or dispatches the recorded work.
    async retainImport(
      project: string,
      task: string,
      id: string,
      payload: string,
      facts: { taskId: string; id: string; digest: string }[],
    ) {
      if (
        !/^PRJ-[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(project) ||
        !validId(task) ||
        !/^[0-9a-f]{64}$/u.test(id) ||
        Buffer.byteLength(payload) > 32 * 1024 * 1024 ||
        facts.length > 11024
      )
        throw invalid();
      return (await use(true, (db) => {
        const prior = db
          .prepare("SELECT payload FROM imported_bundles WHERE id=?")
          .get(id);
        if (prior) {
          if (prior.payload !== payload) throw conflict();
          return true;
        }
        const lookup = db.prepare(
          "SELECT digest FROM imported_facts WHERE project=? AND task=? AND id=?",
        );
        const insert = db.prepare(
          "INSERT INTO imported_facts(project,task,id,digest) VALUES(?,?,?,?)",
        );
        for (const fact of facts) {
          if (!validId(fact.taskId)) throw invalid();
          const old = lookup.get(project, fact.taskId, fact.id);
          if (old && old.digest !== fact.digest) throw conflict();
          if (!old) insert.run(project, fact.taskId, fact.id, fact.digest);
        }
        db.prepare("INSERT INTO imported_bundles(id,payload) VALUES(?,?)").run(
          id,
          payload,
        );
        return false;
      }))!;
    },
    async readImport(id: string) {
      if (!/^[0-9a-f]{64}$/u.test(id)) throw invalid();
      return use(false, (db) => {
        const row = db
          .prepare("SELECT payload FROM imported_bundles WHERE id=?")
          .get(id);
        return typeof row?.payload === "string" ? row.payload : undefined;
      });
    },
    base,
  };
}
export type TaskHistory = Awaited<ReturnType<typeof openTaskHistory>>;
export interface TaskFileEntry {
  path: string;
  status: "file" | "missing" | "excluded";
  digest?: string;
  mode?: string;
  size?: number;
}
export interface TaskFileManifest {
  version: 1;
  coverage: "explicit-working-files";
  entries: TaskFileEntry[];
}
export interface CapturedTaskFiles {
  manifest: TaskFileManifest;
  blobs: Map<string, Uint8Array>;
}
export function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
