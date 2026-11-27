import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerBookie from "../dist/index.js";
import { reconcileProposalAgainstMatches } from "../dist/memory-proposals.js";

async function setupBookieProposalHarness(t, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), "bookie-proposals-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const tools = new Map();
  const handlers = new Map();
  const events = new Map();
  let daddyAutoEnabled = opts.daddyAutoEnabled ?? false;
  let bookieOwnerActive = opts.bookieOwnerActive ?? true;
  let confirmCalls = 0;
  let confirmAnswer = opts.confirmAnswer ?? false;

  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand() {},
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    events: {
      on: (name, fn) => events.set(name, [...(events.get(name) ?? []), fn]),
      emit(name, payload) {
        if (
          name === "pi-daddy:request-project-memory-owner-v1" &&
          bookieOwnerActive
        ) {
          payload.reply?.({
            version: 1,
            sessionId: "proposal-session",
            cwd: workspace,
            isCurrent: () => bookieOwnerActive,
            isAutoEnabled: () => daddyAutoEnabled,
          });
          return;
        }
        for (const fn of events.get(name) ?? []) fn(payload);
      },
    },
  };
  registerBookie(pi);

  const endpoint = "https://provider.example.invalid/v1";
  const ctx = {
    cwd: workspace,
    mode: "tui",
    hasUI: opts.hasUI ?? true,
    isProjectTrusted: () => true,
    model: {
      provider: "fixture",
      id: "subject",
      api: "fixture-api",
      baseUrl: endpoint,
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "fixture-secret",
        baseUrl: endpoint,
      }),
    },
    sessionManager: {
      getSessionId: () => "proposal-session",
      getBranch: () => [],
    },
    ui: {
      notify() {},
      confirm:
        opts.noConfirmFn === true
          ? undefined
          : async () => {
              confirmCalls++;
              return confirmAnswer;
            },
    },
  };

  for (const h of handlers.get("session_start") ?? []) await h({}, ctx);
  const propose = (params) =>
    tools
      .get("bookie_propose_memory")
      .execute("call-1", params, undefined, undefined, ctx);

  async function countSavedNotes() {
    let count = 0;
    async function walk(dir) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.startsWith("note-") && entry.name.endsWith(".md"))
          count++;
      }
    }
    await walk(agentDir);
    return count;
  }

  return {
    propose,
    countSavedNotes,
    setAuto: (v) => {
      daddyAutoEnabled = v;
    },
    setOwnerActive: (v) => {
      bookieOwnerActive = v;
    },
    setConfirmAnswer: (v) => {
      confirmAnswer = v;
    },
    confirmCalls: () => confirmCalls,
  };
}

test("reconcileProposalAgainstMatches identifies duplicates, conflicts, and novel notes", () => {
  const existing = [
    {
      path: "/projects/demo/activities/note-1.md",
      uid: "ACT-01",
      title: "Use SQLite WAL mode",
      excerpt:
        "All Bookie indexes must use SQLite WAL mode for concurrent reads.",
    },
  ];

  const dup = reconcileProposalAgainstMatches(
    {
      title: "use sqlite wal mode",
      summary:
        "All Bookie indexes must use SQLite WAL mode for concurrent reads",
    },
    existing,
  );
  assert.equal(dup.status, "duplicate");
  assert.equal(dup.existingPath, "/projects/demo/activities/note-1.md");

  const conflict = reconcileProposalAgainstMatches(
    {
      title: "Use SQLite WAL mode",
      summary: "Disable WAL mode and use DELETE journal instead.",
    },
    existing,
  );
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.existingUid, "ACT-01");

  const novel = reconcileProposalAgainstMatches(
    {
      title: "Retry policy for read-only roles",
      summary: "Replay-safe specialists retry once automatically.",
    },
    existing,
  );
  assert.equal(novel.status, "novel");
});

test("Bookie enabled with Daddy Auto OFF still requires confirmation for a coordinator-verified proposal", async (t) => {
  const h = await setupBookieProposalHarness(t, {
    bookieOwnerActive: true,
    daddyAutoEnabled: false,
    confirmAnswer: false,
  });
  const declined = await h.propose({
    title: "API retry backoff decision",
    summary: "Use exponential backoff capped at 30s.",
    kind: "decision",
    verified: true,
  });
  assert.equal(declined.details.status, "declined");
  assert.equal(declined.details.daddyAutoEnabled, false);
  assert.equal(
    h.confirmCalls(),
    1,
    "operator confirmation must be requested when Daddy Auto is off",
  );
  assert.equal(
    await h.countSavedNotes(),
    0,
    "declined proposal must not write durable storage",
  );

  // Confirming interactively persists the verified note.
  h.setConfirmAnswer(true);
  const confirmed = await h.propose({
    title: "API retry backoff decision",
    summary: "Use exponential backoff capped at 30s.",
    kind: "decision",
    verified: true,
  });
  assert.equal(confirmed.details.status, "saved");
  assert.equal(h.confirmCalls(), 2);
  assert.equal(await h.countSavedNotes(), 1);
});

test("Daddy Auto ON with coordinator-verified finding saves automatically without prompting", async (t) => {
  const h = await setupBookieProposalHarness(t, {
    bookieOwnerActive: true,
    daddyAutoEnabled: true,
  });
  const saved = await h.propose({
    title: "Verified build failure root cause",
    summary: "Missing lockfile refresh caused typebox resolution failure.",
    kind: "finding",
    verified: true,
    evidence: "npm run build",
  });
  assert.equal(saved.details.status, "saved");
  assert.equal(
    h.confirmCalls(),
    0,
    "Daddy Auto ON with coordinator-verified finding saves automatically",
  );
  assert.equal(await h.countSavedNotes(), 1);
});

test("specialist uncorroborated verified flag never writes durable storage even when Daddy Auto is ON", async (t) => {
  const h = await setupBookieProposalHarness(t, {
    bookieOwnerActive: true,
    daddyAutoEnabled: true,
  });
  // Case A: specialist role without coordinator acceptance
  const proposed = await h.propose({
    title: "Specialist finding about cache",
    summary: "Cache invalidation skips stale keys on reload.",
    kind: "finding",
    verified: true,
    specialist: "investigate",
  });
  assert.equal(proposed.details.status, "proposed");
  assert.equal(proposed.details.accepted, false);
  assert.equal(proposed.details.needsCoordinatorAcceptance, true);
  assert.equal(proposed.details.uncorroboratedSpecialistFlag, true);
  assert.equal(h.confirmCalls(), 0);
  assert.equal(await h.countSavedNotes(), 0);

  // Case B: proxied specialist attempting to spoof coordinatorAccepted=true (source pinned to specialist)
  const spoofed = await h.propose({
    title: "Specialist finding about cache",
    summary: "Cache invalidation skips stale keys on reload.",
    kind: "finding",
    verified: true,
    specialist: "investigate",
    source: "specialist",
    coordinatorAccepted: true,
  });
  assert.equal(spoofed.details.status, "proposed");
  assert.equal(spoofed.details.accepted, false);
  assert.equal(await h.countSavedNotes(), 0);

  // Case C: coordinator reviews and explicitly accepts it with Daddy Auto ON -> persists cleanly
  const accepted = await h.propose({
    title: "Specialist finding about cache",
    summary: "Cache invalidation skips stale keys on reload.",
    kind: "finding",
    verified: true,
    specialist: "investigate",
    source: "coordinator",
    coordinatorAccepted: true,
  });
  assert.equal(accepted.details.status, "saved");
  assert.equal(await h.countSavedNotes(), 1);
});

test("absent disclosure authority fails closed before reading or writing", async (t) => {
  const h = await setupBookieProposalHarness(t, {
    bookieOwnerActive: false,
    daddyAutoEnabled: true,
  });
  await assert.rejects(
    h.propose({
      title: "Should fail closed",
      summary: "No disclosure authority exists in this session.",
      kind: "finding",
      verified: true,
    }),
    /disclosure authority/,
  );
  assert.equal(await h.countSavedNotes(), 0);
});
