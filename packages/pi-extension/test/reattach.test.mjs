import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateVault } from "pi-bookie-core";
import registerBookie from "../dist/index.js";
import {
  openManagedVault,
  reattachMovedProject,
  surveyMovedProjects,
} from "../dist/managed-vault.js";
import { modelContext } from "./disclosure-fixture.mjs";

const allow = async () => {};
const packageRoot = join(import.meta.dirname, "..");
function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}
async function repository(path) {
  await mkdir(path);
  git(path, "init", "-q");
  await writeFile(join(path, "README.md"), "fixture\n");
  git(path, "add", "README.md");
  git(path, "commit", "-q", "-m", "first");
  return git(path, "rev-parse", "HEAD");
}
// A copy followed by removal: new device/inode/creation time, as across volumes.
async function moveAcrossVolumes(from, to) {
  await cp(from, to, { recursive: true });
  await rm(from, { recursive: true, force: true });
}
async function setup(t) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "bookie-reattach-")),
  );
  t.after(() => rm(parent, { recursive: true, force: true }));
  const agent = join(parent, "agent");
  await mkdir(agent, { mode: 0o700 });
  return {
    parent,
    agent,
    store: join(agent, "bookie-project-memory"),
    open: (path) => openManagedVault(path, allow, agent),
    survey: (path) => surveyMovedProjects(path, agent),
  };
}
async function addNote(root, name = "note") {
  await writeFile(
    join(root, "projects/workspace/activities", name + ".md"),
    "saved\n",
  );
}
// Store contents with file identities, to prove that nothing changed.
async function snapshot(dir) {
  const rows = [];
  async function walk(path, prefix) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const full = join(path, entry.name);
      const st = await lstat(full, { bigint: true });
      rows.push(
        [prefix + entry.name, st.ino, st.nlink, st.size, st.mtimeNs].join(" "),
      );
      if (entry.isDirectory()) await walk(full, prefix + entry.name + "/");
    }
  }
  await walk(dir, "");
  return rows;
}
async function ledgerRecord(store, key) {
  const binding = JSON.parse(
    await readFile(join(store, key + ".json"), "utf8"),
  );
  return JSON.parse(
    await readFile(join(store, binding[1], "workspace.json"), "utf8"),
  );
}

test("opening managed memory records the folder and its Git commit beside the binding, outside the canonical vault", async (t) => {
  const { parent, store, open } = await setup(t);
  const project = join(parent, "project");
  const head = await repository(project);
  await mkdir(join(project, "docs"));
  const opened = await open(project);
  const keys = (await readdir(store)).filter((n) => n.endsWith(".json"));
  assert.equal(keys.length, 1);
  const record = await ledgerRecord(store, keys[0].slice(0, -5));
  assert.deepEqual(Object.keys(record), [
    "version",
    "key",
    "path",
    "directory",
    "git",
    "seen",
    "moves",
  ]);
  assert.equal(record.version, 1);
  assert.equal(record.key, keys[0].slice(0, -5));
  assert.equal(record.path, project);
  assert.match(record.directory, /^\d+:\d+:\d+$/u);
  assert.deepEqual(record.git, { head, prefix: "" });
  assert.deepEqual(record.moves, []);
  assert.equal((await readdir(opened.root)).includes("workspace.json"), false);
  assert.equal((await validateVault(opened.root)).valid, true);
  const subfolder = await open(join(project, "docs"));
  const nested = (await readdir(store)).filter(
    (n) => n.endsWith(".json") && n !== keys[0],
  );
  assert.deepEqual((await ledgerRecord(store, nested[0].slice(0, -5))).git, {
    head,
    prefix: "docs/",
  });
  assert.notEqual(subfolder.root, opened.root);
  const plain = join(parent, "plain");
  await mkdir(plain);
  await open(plain);
  const plainKey = (await readdir(store)).filter(
    (n) => n.endsWith(".json") && n !== keys[0] && n !== nested[0],
  )[0];
  assert.equal((await ledgerRecord(store, plainKey.slice(0, -5))).git, null);
});

test("a repository moved to another volume is offered with matching Git evidence and both paths", async (t) => {
  const { parent, open, survey } = await setup(t);
  const before = join(parent, "before"),
    after = join(parent, "after");
  const head = await repository(before);
  const original = await open(before);
  await moveAcrossVolumes(before, after);
  await writeFile(join(after, "later.txt"), "later\n");
  git(after, "add", "later.txt");
  git(after, "commit", "-q", "-m", "later");
  const found = await survey(after);
  assert.equal(found.workspace, after);
  assert.equal(found.current.state, "none");
  assert.deepEqual(found.excluded, []);
  assert.equal(found.unrecorded, 0);
  assert.equal(found.candidates.length, 1);
  const [candidate] = found.candidates;
  assert.equal(candidate.previous, before);
  assert.equal(candidate.root, original.root);
  assert.deepEqual(candidate.evidence, { git: true, folder: false });
  assert.equal(candidate.recordedGit.head, head);
});

test("an earlier folder that still exists is a copy or fork and is never offered", async (t) => {
  const { parent, open, survey } = await setup(t);
  const original = join(parent, "original"),
    copy = join(parent, "copy");
  await repository(original);
  await open(original);
  await cp(original, copy, { recursive: true });
  const found = await survey(copy);
  assert.deepEqual(found.candidates, []);
  assert.deepEqual(found.excluded, [
    { previous: original, reason: "still-exists" },
  ]);
});

test("Git history that contradicts the recorded commit excludes the earlier project", async (t) => {
  for (const variant of ["unrelated history", "no repository", "subfolder"]) {
    const { parent, open, survey } = await setup(t);
    const before = join(parent, variant + " before"),
      after = join(parent, variant + " after");
    await repository(before);
    await open(before);
    await moveAcrossVolumes(before, after);
    let target = after;
    if (variant === "unrelated history") {
      git(after, "checkout", "-q", "--orphan", "other");
      git(after, "commit", "-q", "-m", "unrelated");
    } else if (variant === "no repository")
      await rm(join(after, ".git"), { recursive: true });
    else {
      // The same commit seen from a different place in the repository.
      target = join(after, "nested");
      await mkdir(target);
    }
    const found = await survey(target);
    assert.deepEqual(found.candidates, [], variant);
    assert.deepEqual(
      found.excluded,
      [{ previous: before, reason: "git-mismatch" }],
      variant,
    );
  }
});

test("without Git, a renamed folder matches as the same folder and a copied one stays unverified", async (t) => {
  const { parent, open, survey } = await setup(t);
  const renamed = join(parent, "renamed"),
    copied = join(parent, "copied");
  await mkdir(join(parent, "a"));
  await open(join(parent, "a"));
  await rename(join(parent, "a"), renamed);
  const same = await survey(renamed);
  assert.equal(same.candidates.length, 1);
  assert.equal(same.candidates[0].previous, join(parent, "a"));
  assert.deepEqual(same.candidates[0].evidence, { git: false, folder: true });
  assert.equal(same.candidates[0].recordedGit, null);
  await mkdir(join(parent, "b"));
  await open(join(parent, "b"));
  await moveAcrossVolumes(join(parent, "b"), copied);
  const unverified = await survey(copied);
  // The renamed folder's memory is still offered here too: Bookie shows it as unverified.
  const fromB = unverified.candidates.filter(
    (c) => c.previous === join(parent, "b"),
  );
  assert.equal(fromB.length, 1);
  assert.deepEqual(fromB[0].evidence, { git: false, folder: false });
});

test("re-attaching moves the binding atomically: normal lookup finds it, the old folder does not, and a re-run has nothing to move", async (t) => {
  const { parent, store, open, survey, agent } = await setup(t);
  const before = join(parent, "before"),
    after = join(parent, "after");
  await repository(before);
  const original = await open(before);
  await addNote(original.root);
  await moveAcrossVolumes(before, after);
  const found = await survey(after);
  const [candidate] = found.candidates;
  const oldMapping = join(store, candidate.key + ".json");
  const outcome = await reattachMovedProject(found, candidate, allow, agent);
  assert.deepEqual(outcome, {
    root: original.root,
    found: true,
    cleaned: true,
    recorded: true,
  });
  assert.equal((await open(after)).root, original.root);
  await assert.rejects(lstat(oldMapping), { code: "ENOENT" });
  await assert.rejects(original.assertCurrent);
  const record = await ledgerRecord(store, found.key);
  assert.equal(record.key, found.key);
  assert.equal(record.path, after);
  assert.equal(record.moves.length, 1);
  assert.deepEqual(
    { ...record.moves[0], at: undefined },
    { from: before, to: after, at: undefined, evidence: "git" },
  );
  const rerun = await survey(after);
  assert.equal(rerun.current.state, "memory");
  assert.deepEqual(rerun.candidates, []);
  // A new folder at the old path starts fresh instead of inheriting the memory.
  await repository(before);
  assert.notEqual((await open(before)).root, original.root);
  assert.equal(
    (await readdir(join(store, original.root.split("/").at(-2)))).includes(
      "binding.next",
    ),
    false,
  );
  assert.deepEqual(
    (await readdir(store)).filter((n) => n.includes("reattach")),
    [],
  );
});

test("the empty memory automatically created in the new folder is set aside, not deleted; saved content blocks re-attach", async (t) => {
  const { parent, open, survey, agent } = await setup(t);
  const before = join(parent, "before"),
    after = join(parent, "after");
  await repository(before);
  const original = await open(before);
  await addNote(original.root);
  await moveAcrossVolumes(before, after);
  const automatic = await open(after);
  const found = await survey(after);
  assert.equal(found.current.state, "empty");
  const outcome = await reattachMovedProject(
    found,
    found.candidates[0],
    allow,
    agent,
  );
  assert.equal(outcome.setAside, join(automatic.root, ".."));
  assert.equal(outcome.setAsideChanged, false);
  assert.deepEqual((await lstat(automatic.root)).isDirectory(), true);
  assert.equal((await open(after)).root, original.root);
  await assert.rejects(automatic.assertCurrent);

  const edited = join(parent, "edited");
  await mkdir(edited);
  const editedRoot = (await open(edited)).root;
  assert.equal((await survey(edited)).current.state, "empty");
  const projectFile = join(editedRoot, "projects/workspace/project.md");
  await writeFile(
    projectFile,
    (await readFile(projectFile, "utf8")).replace(
      '"title":"Workspace memory"',
      '"title":"Renamed by the user"',
    ),
  );
  assert.equal((await survey(edited)).current.state, "memory");

  const other = join(parent, "other"),
    moved = join(parent, "moved");
  await repository(other);
  await addNote((await open(other)).root);
  await moveAcrossVolumes(other, moved);
  await addNote((await open(moved)).root, "new-folder-note");
  const refused = await survey(moved);
  assert.equal(refused.current.state, "memory");
  assert.deepEqual(refused.candidates, []);
});

test("a location record that names a different binding is not used as evidence", async (t) => {
  const { parent, store, open, survey } = await setup(t);
  const before = join(parent, "before"),
    after = join(parent, "after");
  await repository(before);
  const original = await open(before);
  await moveAcrossVolumes(before, after);
  const recordPath = join(original.root, "..", "workspace.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(
    recordPath,
    JSON.stringify({ ...record, key: "0".repeat(64) }) + "\n",
  );
  const found = await survey(after);
  assert.deepEqual(found.candidates, []);
  assert.equal(found.unrecorded, 1);
  assert.equal((await readdir(store)).length, 2);
});

test("an interrupted re-attach fails closed, keeps the earlier binding and is rolled back by the next run", async (t) => {
  const { parent, store, open, survey, agent } = await setup(t);
  const before = join(parent, "before"),
    after = join(parent, "after");
  await repository(before);
  const original = await open(before);
  await moveAcrossVolumes(before, after);
  const found = await survey(after);
  const [candidate] = found.candidates;
  // State left by a crash after linking the pending seal and before the commit rename.
  const ledger = join(original.root, "..");
  const binding = JSON.parse(
    await readFile(join(store, candidate.key + ".json"), "utf8"),
  );
  await writeFile(
    join(ledger, "binding.next"),
    JSON.stringify([found.key, ...binding.slice(1)]),
    { flag: "wx", mode: 0o600 },
  );
  await link(join(ledger, "binding.next"), join(store, found.key + ".json"));
  await assert.rejects(open(after), /could not verify/u);
  await original.assertCurrent().catch(() => {});
  const interrupted = await survey(after);
  assert.equal(interrupted.current.state, "interrupted");
  assert.equal(interrupted.candidates.length, 1);
  await reattachMovedProject(
    interrupted,
    interrupted.candidates[0],
    allow,
    agent,
  );
  assert.equal((await open(after)).root, original.root);
});

test("a held re-attach lock, a changed candidate or revoked trust changes nothing", async (t) => {
  const { parent, store, open, survey, agent } = await setup(t);
  const before = join(parent, "before"),
    after = join(parent, "after");
  await repository(before);
  await open(before);
  await moveAcrossVolumes(before, after);
  const found = await survey(after);
  const unchanged = await snapshot(store);
  await writeFile(join(store, "reattach.lock"), "held\n");
  await assert.rejects(
    reattachMovedProject(found, found.candidates[0], allow, agent),
    /did not finish/u,
  );
  await rm(join(store, "reattach.lock"));
  assert.deepEqual(await snapshot(store), unchanged);
  await assert.rejects(
    reattachMovedProject(
      found,
      found.candidates[0],
      async () => {
        throw Error("untrusted");
      },
      agent,
    ),
    /untrusted/u,
  );
  assert.deepEqual(await snapshot(store), unchanged);
  await mkdir(before);
  await assert.rejects(
    reattachMovedProject(found, found.candidates[0], allow, agent),
    /changed while you were confirming/u,
  );
  assert.deepEqual(await snapshot(store), unchanged);
});

const owner = "pi-daddy:request-project-memory-owner-v1";
function host(cwd, sessionId) {
  const events = new EventEmitter(),
    tools = new Map(),
    commands = new Map(),
    hooks = new Map();
  const notices = [];
  const ctx = modelContext({
    cwd,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
    ui: { notify: (message) => notices.push(message) },
  });
  const lease = { version: 1, cwd, sessionId, isCurrent: () => true };
  events.on(owner, (q) => {
    if (q.sessionId === sessionId && q.cwd === cwd) q.reply(lease);
  });
  registerBookie({
    events,
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, h) => hooks.set(name, [...(hooks.get(name) || []), h]),
  });
  return {
    ctx,
    tools,
    commands,
    hooks,
    notices,
    async event(name, payload = {}) {
      const results = [];
      for (const h of hooks.get(name) || [])
        results.push(await h(payload, ctx));
      return results;
    },
    async call(name, args) {
      return (
        await tools.get(name).execute("id", args, undefined, undefined, ctx)
      ).content[0].text;
    },
    async recent() {
      return JSON.parse(
        await this.call("bookie_search", { mode: "recent", type: "Activity" }),
      ).result;
    },
    // A human answering the terminal dialogs.
    async reattach(answers, overrides = {}) {
      const dialog = { selects: [], confirms: [] };
      await commands.get("bookie-reattach").handler("", {
        ...ctx,
        ...overrides,
        ui: {
          notify: (message) => notices.push(message),
          async select(title, options) {
            dialog.selects.push({ title, options });
            return answers.select ? answers.select(options) : options[0];
          },
          async confirm(title, message) {
            dialog.confirms.push({ title, message });
            return answers.confirm;
          },
        },
      });
      return dialog;
    },
  };
}
async function withAgent(t) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "bookie-reattach-command-")),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agent = join(parent, "agent");
  await mkdir(agent, { mode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(parent, { recursive: true, force: true });
  });
  return { parent, store: join(agent, "bookie-project-memory") };
}
async function rememberedProject(parent, name, makeRepository = true) {
  const folder = join(parent, name);
  if (makeRepository) await repository(folder);
  else await mkdir(folder);
  const first = host(folder, name + "-first");
  await first.event("session_start");
  await first.call("bookie_remember", {
    title: "Venue decision",
    summary: "The workshop uses the library hall.",
  });
  await first.call("bookie_remember", {
    title: "Catering question",
    summary: "Catering is still undecided.",
    openChoice: "Which caterer should we book?",
  });
  await first.event("session_shutdown");
  return folder;
}

test("after a move, starting a session never re-attaches; the command shows the earlier project and re-attaches only after yes", async (t) => {
  const { parent, store } = await withAgent(t);
  const before = await rememberedProject(parent, "before");
  const after = join(parent, "after");
  await moveAcrossVolumes(before, after);
  const next = host(after, "after-session");
  await next.event("session_start");
  // Automatic memory starts empty in the new folder; the earlier notes stay where they were.
  assert.equal((await next.recent()).matchedCount, 0);
  const untouched = await snapshot(store);

  const cancelled = await next.reattach({ confirm: false });
  assert.equal(cancelled.selects.length, 1);
  const [option] = cancelled.selects[0].options;
  assert.equal(
    option.startsWith(
      "1. " +
        JSON.stringify(before) +
        " -> " +
        JSON.stringify(after) +
        " | Git history matches | 2 notes, 1 open choices | last opened ",
    ),
    true,
    option,
  );
  const [confirmation] = cancelled.confirms;
  assert.equal(confirmation.title, "Re-attach Bookie project memory?");
  const lines = confirmation.message.split("\n");
  assert.equal(
    lines[0],
    "Earlier folder (no longer exists): " + JSON.stringify(before),
  );
  assert.equal(lines[1], "This folder: " + JSON.stringify(after));
  assert.match(
    lines[2],
    /^Git: the commit Bookie recorded there \([0-9a-f]{12}\) is in this folder's current history\.$/u,
  );
  assert.match(
    lines[3],
    /^Saved notes: 2\. Open choices: 1\. Latest note: \d{4}-/u,
  );
  assert.equal(
    lines.includes(
      "The empty memory Bookie created for this folder has no saved notes. It is set aside, not deleted.",
    ),
    true,
  );
  assert.equal(
    next.notices.at(-1),
    "Bookie re-attach cancelled. Nothing was changed.",
  );
  assert.deepEqual(await snapshot(store), untouched);
  assert.equal((await next.recent()).matchedCount, 0);

  await next.reattach({ select: () => undefined, confirm: true });
  assert.deepEqual(await snapshot(store), untouched);

  await next.reattach({ confirm: true });
  assert.equal(
    next.notices.at(-1),
    "Bookie memory from " +
      JSON.stringify(before) +
      " is now attached to this folder.",
  );
  const recalled = await next.recent();
  assert.equal(recalled.matchedCount, 2);
  assert.deepEqual(recalled.results.map((hit) => hit.title).sort(), [
    "Catering question",
    "Venue decision",
  ]);
  await assert.rejects(
    next.reattach({ confirm: true }),
    /already has Bookie project memory/u,
  );
  // A fresh session in the new folder uses the ordinary lookup.
  const fresh = host(after, "after-fresh");
  await fresh.event("session_start");
  assert.equal((await fresh.recent()).matchedCount, 2);
});

test("an unverified candidate is flagged and attaches only after an explicit yes", async (t) => {
  const { parent, store } = await withAgent(t);
  const before = await rememberedProject(parent, "notes", false);
  const after = join(parent, "notes-moved");
  await moveAcrossVolumes(before, after);
  const next = host(after, "moved-session");
  await next.event("session_start");
  const untouched = await snapshot(store);
  for (const answer of [undefined, "yes", 1]) {
    const dialog = await next.reattach({ confirm: answer });
    assert.match(dialog.selects[0].options[0], / \| UNVERIFIED \| /u);
    assert.equal(
      dialog.confirms[0].title,
      "Re-attach UNVERIFIED Bookie project memory?",
    );
    assert.equal(
      dialog.confirms[0].message.split("\n")[2],
      "UNVERIFIED: Bookie recorded no Git commit for the earlier folder and this is a different folder. Continue only if you know it is the same project.",
    );
    assert.deepEqual(await snapshot(store), untouched);
  }
  await next.reattach({ confirm: true });
  assert.equal((await next.recent()).matchedCount, 2);
});

test("the command refuses without the interactive terminal, without trust, or when this folder already has saved memory", async (t) => {
  const { parent, store } = await withAgent(t);
  const before = await rememberedProject(parent, "before");
  const after = join(parent, "after");
  await moveAcrossVolumes(before, after);
  const next = host(after, "after-session");
  await next.event("session_start");
  const untouched = await snapshot(store);
  for (const overrides of [
    { mode: "print", hasUI: false },
    { mode: "json", hasUI: false },
    { mode: "rpc", hasUI: true },
    { mode: "tui", hasUI: false },
  ]) {
    let dialog;
    await assert.rejects(
      (async () => {
        dialog = await next.reattach({ confirm: true }, overrides);
      })(),
      /needs the interactive Pi terminal/u,
    );
    assert.equal(dialog, undefined);
  }
  let listed = false;
  await assert.rejects(
    next.reattach(
      {
        confirm: true,
        select: (options) => {
          listed = true;
          return options[0];
        },
      },
      { isProjectTrusted: () => false },
    ),
    /needs a folder Pi trusts/u,
  );
  assert.equal(listed, false);
  assert.equal(
    next.notices.some((notice) => notice.includes(before)),
    false,
  );
  assert.deepEqual(await snapshot(store), untouched);
  await next.call("bookie_remember", {
    title: "New folder note",
    summary: "Saved after the move.",
  });
  const withMemory = await snapshot(store);
  await assert.rejects(
    next.reattach({ confirm: true }),
    /already has Bookie project memory with saved content/u,
  );
  assert.deepEqual(await snapshot(store), withMemory);
  assert.equal((await next.recent()).matchedCount, 1);
});

test("re-attach is never offered to the model: it is no tool and appears in no injected guidance", async (t) => {
  const { parent } = await withAgent(t);
  const folder = await rememberedProject(parent, "project");
  const session = host(folder, "guidance-session");
  await session.event("session_start");
  assert.equal(session.commands.has("bookie-reattach"), true);
  const exposed = JSON.stringify(
    [...session.tools.values()].map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
    })),
  );
  assert.equal(/re-?attach/iu.test(exposed), false);
  const [prompt] = (
    await session.event("before_agent_start", { systemPrompt: "base" })
  ).filter(Boolean);
  assert.match(prompt.systemPrompt, /Bookie project memory is ready/u);
  assert.equal(/re-?attach/iu.test(prompt.systemPrompt), false);
  const context = await session.event("context", {
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  });
  assert.equal(/re-?attach/iu.test(JSON.stringify(context)), false);
  for (const name of await readdir(join(packageRoot, "skills"), {
    recursive: true,
  })) {
    if (!name.endsWith(".md")) continue;
    const text = await readFile(join(packageRoot, "skills", name), "utf8");
    assert.equal(/re-?attach/iu.test(text), false, name);
  }
});
