import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
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
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectConcept,
  readRecallState,
  registerProducerReference,
  updateRecallControl,
  validateVault,
} from "pi-bookie-core";
import registerBookie from "../dist/index.js";
import * as vault from "../dist/managed-vault.js";
import { modelContext } from "./disclosure-fixture.mjs";

const { openManagedVault, reattachMovedProject, surveyMovedProjects } = vault;
// Called through the namespace so this file still loads against builds without it.
const recoverReattach = (...args) => vault.recoverReattach(...args);

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
  // Distinct content, so repositories made in the same second have distinct histories.
  await writeFile(join(path, "README.md"), "fixture " + path + "\n");
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
const byPath = (rows) =>
  [...rows].sort((x, y) => (x.previous < y.previous ? -1 : 1));
// The vault a mapping resolves to under the lookup rule (two links, same file as the seal).
async function resolves(store, key) {
  try {
    const mapping = join(store, key + ".json");
    const [, ledger] = JSON.parse(await readFile(mapping, "utf8"));
    const st = await lstat(mapping),
      seal = await lstat(join(store, ledger, "binding"));
    return st.nlink === 2 && st.ino === seal.ino
      ? join(store, ledger, "vault")
      : undefined;
  } catch {
    return undefined;
  }
}
// Anything an unfinished re-attach can leave: lock, temporary links, pending
// seals and mappings that are not sealed bindings.
async function leftovers(store) {
  const found = [];
  for (const name of (await readdir(store)).sort()) {
    const path = join(store, name);
    if (name.startsWith("reattach")) found.push(name);
    else if (/^[0-9a-f]{64}\.json$/u.test(name)) {
      if ((await lstat(path)).nlink !== 2) found.push(name);
    } else if (name.startsWith("ledger-"))
      for (const entry of await readdir(path))
        if (entry === "binding.next" || entry.startsWith("reattach"))
          found.push(name + "/" + entry);
  }
  return found;
}
// Runs `then` once, right after the first file operation that `match` accepts
// (a 1-based step number or a predicate over the operation), while `run` runs.
const fsp = createRequire(import.meta.url)("node:fs/promises");
async function afterStep(match, then, run) {
  const names = ["writeFile", "link", "rename", "unlink"];
  const real = Object.fromEntries(names.map((name) => [name, fsp[name]]));
  let step = 0,
    done = false;
  for (const name of names)
    fsp[name] = async (...args) => {
      const result = await real[name](...args);
      step++;
      if (
        !done &&
        (typeof match === "number" ? step === match : match(name, args))
      ) {
        done = true;
        return then(result);
      }
      return result;
    };
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    Object.assign(fsp, real);
    syncBuiltinESMExports();
  }
}
// Simulates a crash: the matching file operation completes and nothing after it
// runs (no rollback, no lock release). Resolves true when the crash point was reached.
async function crashAfter(match, run) {
  let crash;
  const reached = new Promise((resolve) => (crash = resolve));
  return afterStep(
    match,
    () => {
      crash(true);
      return new Promise(() => {});
    },
    () => Promise.race([reached, run().then(() => false)]),
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

test("a later open where Git cannot answer keeps the recorded commit, so the memory stays tied to its history", async (t) => {
  const { parent, store, open, survey } = await setup(t);
  const project = join(parent, "client-repo");
  const head = await repository(project);
  await open(project);
  const [name] = (await readdir(store)).filter((n) => n.endsWith(".json"));
  const recorded = () => ledgerRecord(store, name.slice(0, -5));
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    await open(project);
  } finally {
    process.env.PATH = path;
  }
  assert.deepEqual((await recorded()).git, { head, prefix: "" });
  // A present Git can also refuse a repository. Use unsupported repository
  // metadata rather than chown, which ordinary CI users cannot perform.
  const configPath = join(project, ".git", "config");
  const originalConfig = await readFile(configPath);
  try {
    git(project, "config", "core.repositoryformatversion", "999");
    assert.throws(() => git(project, "rev-parse", "HEAD"));
    await open(project);
    assert.deepEqual((await recorded()).git, { head, prefix: "" });
  } finally {
    await writeFile(configPath, originalConfig);
  }
  // A successful probe still replaces it.
  await writeFile(join(project, "later.txt"), "later\n");
  git(project, "add", "later.txt");
  git(project, "commit", "-q", "-m", "later");
  await open(project);
  assert.deepEqual((await recorded()).git, {
    head: git(project, "rev-parse", "HEAD"),
    prefix: "",
  });
  await rm(project, { recursive: true });
  const unrelated = join(parent, "unrelated-repo");
  await repository(unrelated);
  const found = await survey(unrelated);
  assert.deepEqual(found.candidates, []);
  assert.deepEqual(found.excluded, [
    { previous: project, reason: "git-mismatch" },
  ]);
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
  assert.equal(candidate.earlier, "missing");
  assert.equal(candidate.root, original.root);
  assert.deepEqual(candidate.evidence, { git: true, folder: false });
  assert.equal(candidate.recordedGit.head, head);
});

test("an earlier folder that still exists is a copy or fork and is never offered; unrelated live projects are not listed", async (t) => {
  const { parent, open, survey } = await setup(t);
  const original = join(parent, "original"),
    copy = join(parent, "copy");
  await repository(original);
  await open(original);
  for (const name of ["client-alpha", "personal-diary"]) {
    await repository(join(parent, name));
    await open(join(parent, name));
  }
  await mkdir(join(parent, "plain"));
  await open(join(parent, "plain"));
  await cp(original, copy, { recursive: true });
  const found = await survey(copy);
  assert.deepEqual(found.candidates, []);
  assert.deepEqual(found.excluded, [
    { previous: original, reason: "still-exists" },
  ]);
  assert.equal(found.unrecorded, 0);
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

test("without Git, only the same renamed folder matches; a memory without Git or same-folder evidence is never offered", async (t) => {
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
  const unrelated = await survey(copied);
  assert.deepEqual(unrelated.candidates, []);
  assert.deepEqual(byPath(unrelated.excluded), [
    { previous: join(parent, "a"), reason: "no-evidence" },
    { previous: join(parent, "b"), reason: "no-evidence" },
  ]);
  // A deleted, unrelated non-Git project is not offered to a brand-new repository.
  const fresh = join(parent, "brand-new");
  await repository(fresh);
  assert.deepEqual((await survey(fresh)).candidates, []);
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
  const { parent, store, open, survey, agent } = await setup(t);
  const before = join(parent, "before"),
    after = join(parent, "after");
  await repository(before);
  const original = await open(before);
  await addNote(original.root);
  await moveAcrossVolumes(before, after);
  const first = await open(after);
  const shown = await survey(after);
  // A different automatic memory than the one shown: nothing moves.
  await rm(join(store, shown.key + ".json"));
  const automatic = await open(after);
  assert.notEqual(automatic.root, first.root);
  await assert.rejects(
    reattachMovedProject(shown, shown.candidates[0], allow, agent),
    /changed while you were confirming/u,
  );
  assert.equal((await open(after)).root, automatic.root);
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

test("the automatic memory counts as empty only while it is exactly the seed, with no recall controls or registrations", async (t) => {
  const { parent, open, survey } = await setup(t);
  const project = "/projects/workspace/project.md";
  async function revision(root) {
    const concept = await inspectConcept(root, { path: project });
    const state = await readRecallState(root);
    return {
      uid: concept.uid,
      project: {
        path: concept.source.path,
        sourceHash: concept.source.sourceHash,
      },
      expectedRevision: state.revision,
    };
  }
  const replace = (file, from, to) => async (root) => {
    const text = await readFile(join(root, file), "utf8");
    assert.equal(text.includes(from), true, file);
    await writeFile(join(root, file), text.replace(from, to));
  };
  const edits = {
    "a recall control": async (root) => {
      const { uid, ...request } = await revision(root);
      const result = await updateRecallControl(
        root,
        {
          ...request,
          control: {
            target: { kind: "concept", uid },
            disposition: "suppressed",
          },
        },
        { assertAuthority: allow },
      );
      assert.equal(result.ok, true);
    },
    "a producer registration": async (root) => {
      const { project: concept, expectedRevision } = await revision(root);
      const result = await registerProducerReference(
        root,
        {
          project: concept,
          record: {
            producer: "pi-daddy",
            producerInstance: "store-one",
            owner: { sessionId: "owner", cwd: root },
            operationId: "op-one",
            executionId: "exec-one",
            kind: "operation-result",
            reference: {
              locator: "/private/result.json",
              sha256: "a".repeat(64),
              byteLength: 128,
            },
          },
          sensitivity: "internal",
          expectedRevision,
        },
        {
          assertAuthority: allow,
          resolveReference: async (r) => ({
            sha256: r.reference.sha256,
            byteLength: r.reference.byteLength,
          }),
        },
      );
      assert.equal(result.ok, true);
    },
    "an edited index": replace("index.md", "# Workspace memory", "# Our plans"),
    "an edited manifest policy": replace(
      "bookie.yaml",
      '"excluded_classes":["private"]',
      '"excluded_classes":["private","internal"]',
    ),
    "an edited Project sensitivity": replace(
      project.slice(1),
      '"sensitivity":"internal"',
      '"sensitivity":"private"',
    ),
  };
  for (const [name, edit] of Object.entries(edits)) {
    const folder = join(parent, name.replaceAll(" ", "-"));
    await mkdir(folder);
    const { root } = await open(folder);
    assert.equal((await survey(folder)).current.state, "empty", name);
    await edit(root);
    assert.equal((await survey(folder)).current.state, "memory", name);
  }
});

test("a commit that fails after the automatic memory's link was replaced restores that link", async (t) => {
  const { parent, store, open, survey, agent } = await setup(t);
  const before = join(parent, "before"),
    after = join(parent, "after");
  await repository(before);
  const original = await open(before);
  await addNote(original.root);
  await moveAcrossVolumes(before, after);
  const automatic = await open(after);
  const found = await survey(after);
  const ledger = found.candidates[0].binding.base;
  await assert.rejects(
    reattachMovedProject(
      found,
      found.candidates[0],
      async () => {
        // Called just before this folder's link is replaced: make the commit rename fail.
        if (existsSync(join(ledger, "binding.next"))) {
          await rm(join(ledger, "binding"));
          await mkdir(join(ledger, "binding"));
        }
      },
      agent,
    ),
    { code: "EISDIR" },
  );
  assert.equal((await open(after)).root, automatic.root);
  assert.equal((await survey(after)).current.state, "empty");
  assert.equal(existsSync(join(ledger, "binding.next")), false);
  assert.deepEqual(
    (await readdir(store)).filter((name) => name.startsWith("reattach")),
    [],
  );
});

test("memory created for this folder while the automatic one was being replaced is never displaced", async (t) => {
  const { parent, open, survey, agent } = await setup(t);
  const before = join(parent, "before"),
    after = join(parent, "after");
  await repository(before);
  const original = await open(before);
  await moveAcrossVolumes(before, after);
  await open(after);
  const found = await survey(after);
  let created;
  // Right after the pending seal is linked to its temporary name, this folder's
  // link is replaced by one to a memory that holds a note.
  await assert.rejects(
    afterStep(
      (name, args) =>
        name === "link" && /reattach-[0-9a-f]+\.tmp$/u.test(args[1]),
      async () => {
        await rm(join(agent, "bookie-project-memory", found.key + ".json"));
        created = await open(after);
        await addNote(created.root);
      },
      () => reattachMovedProject(found, found.candidates[0], allow, agent),
    ),
    /changed while you were confirming/u,
  );
  assert.equal((await open(after)).root, created.root);
  assert.notEqual(created.root, original.root);
});

test("a location record is not replaced once the open's authority is revoked", async (t) => {
  const { parent, store, open, agent } = await setup(t);
  const project = join(parent, "project");
  await repository(project);
  await open(project);
  const [name] = (await readdir(store)).filter((n) => n.endsWith(".json"));
  const first = await ledgerRecord(store, name.slice(0, -5));
  let revoked = false;
  await assert.rejects(
    afterStep(
      (operation, args) =>
        operation === "writeFile" &&
        /\.workspace-[0-9a-f]+\.tmp$/u.test(args[0]),
      () => {
        revoked = true;
      },
      () =>
        openManagedVault(
          project,
          async () => {
            if (revoked) throw Error("revoked");
          },
          agent,
        ),
    ),
    /revoked/u,
  );
  assert.deepEqual(await ledgerRecord(store, name.slice(0, -5)), first);
});

test("a location record that does not describe its own binding is not used as evidence", async (t) => {
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
  // A live project whose record was edited to name a gone folder and another
  // repository's commit, keeping its own key.
  const secret = join(parent, "secret-client");
  await mkdir(secret);
  const live = await open(secret);
  await addNote(live.root);
  const other = join(parent, "other-repo");
  const head = await repository(other);
  const forged = join(live.root, "..", "workspace.json");
  const real = JSON.parse(await readFile(forged, "utf8"));
  for (const change of [
    { path: join(parent, "gone", "old-other-repo") },
    { directory: "1:2:3" },
  ]) {
    await writeFile(
      forged,
      JSON.stringify({ ...real, ...change, git: { head, prefix: "" } }) + "\n",
    );
    const offered = await survey(other);
    assert.deepEqual(offered.candidates, [], JSON.stringify(change));
    assert.equal(offered.unrecorded, 2);
  }
  assert.equal((await open(secret)).root, live.root);
});

test("a folder re-created at its recorded path (re-cloned or restored) can get its memory back with Git evidence", async (t) => {
  const { parent, open, survey, agent } = await setup(t);
  const project = join(parent, "project");
  await repository(project);
  const original = await open(project);
  await addNote(original.root);
  // Restored from a copy: same path, new folder identity, so Auto starts afresh.
  await moveAcrossVolumes(project, join(parent, "backup"));
  await moveAcrossVolumes(join(parent, "backup"), project);
  const fresh = await open(project);
  assert.notEqual(fresh.root, original.root);
  const found = await survey(project);
  assert.equal(found.current.state, "empty");
  assert.deepEqual(found.excluded, []);
  assert.equal(found.candidates.length, 1);
  const [candidate] = found.candidates;
  assert.equal(candidate.previous, project);
  assert.equal(candidate.earlier, "replaced");
  assert.deepEqual(candidate.evidence, { git: true, folder: false });
  await reattachMovedProject(found, candidate, allow, agent);
  assert.equal((await open(project)).root, original.root);
  // Without Git a restored folder has no evidence and is not offered.
  const plain = join(parent, "plain");
  await mkdir(plain);
  await addNote((await open(plain)).root);
  await moveAcrossVolumes(plain, join(parent, "plain-backup"));
  await moveAcrossVolumes(join(parent, "plain-backup"), plain);
  const restored = await survey(plain);
  assert.deepEqual(restored.candidates, []);
  assert.deepEqual(restored.excluded, [
    { previous: plain, reason: "no-evidence" },
  ]);
});

test("an earlier path that now leads to this folder under another name is offered as the same folder", async (t) => {
  const { parent, open, survey, agent } = await setup(t);
  const project = join(parent, "a", "project");
  await mkdir(join(parent, "a"));
  await mkdir(project);
  const original = await open(project);
  await addNote(original.root);
  // The parent moved and left a link, so the earlier path still reaches this
  // folder while its real path, and with it the lookup key, changed.
  await rename(join(parent, "a"), join(parent, "b"));
  await symlink("b", join(parent, "a"));
  const here = join(parent, "b", "project");
  const found = await survey(here);
  assert.deepEqual(found.excluded, []);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].previous, project);
  assert.equal(found.candidates[0].earlier, "aliased");
  assert.deepEqual(found.candidates[0].evidence, { git: false, folder: true });
  await reattachMovedProject(found, found.candidates[0], allow, agent);
  assert.equal((await open(here)).root, original.root);
  assert.equal((await open(project)).root, original.root);
});

test("an earlier folder whose path cannot be checked is not offered", async (t) => {
  const { parent, open, survey } = await setup(t);
  const holder = join(parent, "holder"),
    inside = join(holder, "project"),
    after = join(parent, "after");
  await mkdir(holder);
  await repository(inside);
  await open(inside);
  await cp(inside, after, { recursive: true });
  await rm(holder, { recursive: true });
  // The recorded path now runs through a symbolic-link loop: lstat fails with ELOOP.
  await symlink("holder", holder);
  await assert.rejects(lstat(inside), { code: "ELOOP" });
  const found = await survey(after);
  assert.deepEqual(found.candidates, []);
  assert.deepEqual(found.excluded, [
    { previous: inside, reason: "unknown-location" },
  ]);
});

test("a crash at any step of a re-attach leaves one resolving memory and is cleaned up by the next run", async (t) => {
  let steps = 0;
  for (const path of ["none", "empty"])
    for (let step = 1; ; step++) {
      const { parent, store, open, survey, agent } = await setup(t);
      const before = join(parent, "before"),
        after = join(parent, "after");
      await repository(before);
      const original = await open(before);
      await addNote(original.root);
      await moveAcrossVolumes(before, after);
      if (path === "empty") await open(after);
      const found = await survey(after);
      const earlierKey = found.candidates[0].key;
      const crashed = await crashAfter(step, () =>
        reattachMovedProject(found, found.candidates[0], allow, agent),
      );
      if (!crashed) break;
      steps++;
      const label = path + " step " + step;
      const lock = join(store, "reattach.lock");
      if (existsSync(lock)) {
        // The lock is never stolen; the message names it for the user to remove.
        await assert.rejects(
          recoverReattach(after, agent),
          (error) => error.message.includes(JSON.stringify(lock)),
          label,
        );
        await rm(lock);
      }
      // Exactly one folder resolves the memory: the earlier one until the commit.
      let reopened;
      try {
        reopened = (await open(after)).root;
      } catch (error) {
        assert.match(error.message, /could not verify/u, label);
      }
      assert.equal(
        (await resolves(store, earlierKey)) === original.root,
        reopened !== original.root,
        label,
      );
      await recoverReattach(after, agent);
      assert.deepEqual(await leftovers(store), [], label);
      const next = await survey(after);
      if (next.current.state !== "memory") {
        assert.equal(next.candidates[0]?.key, earlierKey, label);
        await reattachMovedProject(next, next.candidates[0], allow, agent);
      }
      assert.equal((await open(after)).root, original.root, label);
      assert.equal(await resolves(store, earlierKey), undefined, label);
      assert.deepEqual(await leftovers(store), [], label);
      assert.deepEqual(
        await readdir(join(original.root, "projects/workspace/activities")),
        ["note.md"],
        label,
      );
    }
  // Seven file operations without the automatic memory, eight with it.
  assert.equal(steps, 15);
});

test("after a crash between the commit and removing the earlier link, the folder moved back is recovered by the next run", async (t) => {
  const { parent, store, open, survey, agent } = await setup(t);
  const a = join(parent, "a"),
    b = join(parent, "b");
  await mkdir(a);
  const original = await open(a);
  await addNote(original.root);
  await rename(a, b);
  const found = await survey(b);
  assert.deepEqual(found.candidates[0].evidence, { git: false, folder: true });
  const committed = (name, args) =>
    name === "rename" && args[1].endsWith("/binding");
  assert.equal(
    await crashAfter(committed, () =>
      reattachMovedProject(found, found.candidates[0], allow, agent),
    ),
    true,
  );
  await rm(join(store, "reattach.lock"));
  assert.equal((await open(b)).root, original.root);
  await rename(b, a);
  // The earlier link still exists with one link, so lookup refuses at the old path.
  await assert.rejects(open(a), /could not verify/u);
  assert.equal(await recoverReattach(a, agent), 1);
  const back = await survey(a);
  assert.equal(back.current.state, "none");
  assert.equal(back.candidates.length, 1);
  assert.equal(back.candidates[0].previous, b);
  await reattachMovedProject(back, back.candidates[0], allow, agent);
  assert.equal((await open(a)).root, original.root);
  assert.deepEqual(await leftovers(store), []);
});

test("an earlier link is removed only when its ledger now resolves for another folder", async (t) => {
  const { parent, store, open, survey, agent } = await setup(t);
  const a = join(parent, "a"),
    b = join(parent, "b");
  await mkdir(a);
  const original = await open(a);
  await rename(a, b);
  const found = await survey(b);
  const earlier = join(store, found.candidates[0].key + ".json");
  const text = await readFile(earlier, "utf8");
  await reattachMovedProject(found, found.candidates[0], allow, agent);
  // An earlier link left behind, while the folder that now owns the ledger has lost its own link.
  await writeFile(earlier, text, { flag: "wx", mode: 0o600 });
  await rm(join(store, found.key + ".json"));
  await rename(b, a);
  assert.equal(await recoverReattach(a, agent), 0);
  assert.equal(await readFile(earlier, "utf8"), text);
  await assert.rejects(open(a), /could not verify/u);
  assert.equal((await lstat(original.root)).isDirectory(), true);
});

test("a pending seal is rolled back only together with the link that is the same file", async (t) => {
  const { parent, store, open, survey, agent } = await setup(t);
  const live = join(parent, "live");
  await mkdir(live);
  const kept = await open(live);
  await addNote(kept.root);
  const before = join(parent, "before"),
    after = join(parent, "after");
  await repository(before);
  const original = await open(before);
  await moveAcrossVolumes(before, after);
  const found = await survey(after);
  const liveKey = (await surveyMovedProjects(live, agent)).key;
  // A pending seal naming the live folder, linked from an unexpected place.
  const pending = join(original.root, "..", "binding.next");
  await writeFile(pending, JSON.stringify([liveKey, "ledger-XXXXXX"]), {
    flag: "wx",
    mode: 0o600,
  });
  await link(pending, join(store, "unexpected-link"));
  assert.equal(await recoverReattach(after, agent), 0);
  assert.equal((await open(live)).root, kept.root);
  await assert.rejects(
    reattachMovedProject(found, found.candidates[0], allow, agent),
    (error) =>
      error.message ===
      "Bookie found an unfinished re-attach file it could not clean up: " +
        JSON.stringify(pending) +
        ". Nothing was changed.",
  );
  assert.equal((await open(live)).root, kept.root);
});

test("a pending re-attach left in another folder is rolled back, not reported as a change", async (t) => {
  const { parent, store, open, survey, agent } = await setup(t);
  const before = join(parent, "before"),
    first = join(parent, "first"),
    second = join(parent, "second");
  await repository(before);
  const original = await open(before);
  await moveAcrossVolumes(before, first);
  await cp(first, second, { recursive: true });
  const attempt = await survey(first);
  // A crash after linking the pending seal as the first folder's mapping.
  assert.equal(
    await crashAfter(
      (name) => name === "link",
      () => reattachMovedProject(attempt, attempt.candidates[0], allow, agent),
    ),
    true,
  );
  await rm(join(store, "reattach.lock"));
  await assert.rejects(open(first), /could not verify/u);
  const found = await survey(second);
  assert.equal(found.candidates.length, 1);
  await reattachMovedProject(found, found.candidates[0], allow, agent);
  assert.equal((await open(second)).root, original.root);
  assert.deepEqual(await leftovers(store), []);
  assert.notEqual((await open(first)).root, original.root);
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
    isIdle: () => true,
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
            return typeof answers.confirm === "function"
              ? answers.confirm()
              : answers.confirm;
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
    "Earlier folder (not found: deleted, moved, or on a disconnected drive or unmounted volume, in which case this folder is a copy): " +
      JSON.stringify(before),
  );
  assert.equal(lines[1], "This folder: " + JSON.stringify(after));
  assert.match(
    lines[2],
    /^Git: the commit Bookie recorded there \([0-9a-f]{12}\) is in this folder's current history\. A clone or fork with the same history also matches\.$/u,
  );
  assert.match(
    lines[3],
    /^Saved notes: 2\. Open choices: 1\. Latest note: \d{4}-/u,
  );
  assert.match(lines[4], /^Last opened there: \d{4}-/u);
  assert.deepEqual(lines.slice(5), [
    "The empty memory Bookie created for this folder has no saved notes. It is set aside, not deleted.",
    "Afterwards the earlier folder no longer finds this memory. Re-attaching grants nothing new, but with Pi Daddy Auto on, the model in this folder can recall these notes right away, as in any project with Bookie memory.",
  ]);
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

test("a moved folder without Git or same-folder evidence is never offered; the command says why and changes nothing", async (t) => {
  const { parent, store } = await withAgent(t);
  const before = await rememberedProject(parent, "notes", false);
  const after = join(parent, "notes-moved");
  await moveAcrossVolumes(before, after);
  const next = host(after, "moved-session");
  await next.event("session_start");
  const untouched = await snapshot(store);
  const dialog = await next.reattach({ confirm: true });
  assert.deepEqual(dialog, { selects: [], confirms: [] });
  assert.equal(
    next.notices.at(-1),
    "No moved Bookie project matches this folder.\nNot offered: " +
      JSON.stringify(before) +
      " has no Git or same-folder evidence linking it to this folder.",
  );
  assert.deepEqual(await snapshot(store), untouched);
  assert.equal((await next.recent()).matchedCount, 0);
});

test("trust revoked or Pi busy after the confirmation changes nothing; a note saved meanwhile to the set-aside memory is reported", async (t) => {
  const { parent, store } = await withAgent(t);
  const before = await rememberedProject(parent, "before");
  const after = join(parent, "after");
  await moveAcrossVolumes(before, after);
  const next = host(after, "after-session");
  await next.event("session_start");
  const untouched = await snapshot(store);
  for (const [revoked, refusal] of [
    ["isProjectTrusted", /needs a folder Pi trusts/u],
    ["isIdle", /runs only while Pi is idle/u],
  ]) {
    let confirmed = false;
    const live = () => !confirmed;
    await assert.rejects(
      next.reattach({ confirm: () => (confirmed = true) }, { [revoked]: live }),
      refusal,
    );
    assert.equal(confirmed, true, revoked);
    assert.deepEqual(await snapshot(store), untouched, revoked);
  }
  // Another writer saves into the automatic memory after its last check and
  // before this folder's link moves: the save stays there and is reported.
  const automatic = await openManagedVault(after, allow);
  const late = join(automatic.root, "projects/workspace/activities/late.md");
  const pending = () =>
    readdirSync(store).some(
      (name) =>
        name.startsWith("ledger-") &&
        existsSync(join(store, name, "binding.next")),
    );
  await next.reattach(
    { confirm: true },
    {
      isProjectTrusted: () => {
        if (pending() && !existsSync(late)) writeFileSync(late, "late\n");
        return true;
      },
    },
  );
  assert.equal(
    next.notices.at(-1),
    "Bookie memory from " +
      JSON.stringify(before) +
      " is now attached to this folder.\nA note was saved to the set-aside empty memory during re-attach; it remains in " +
      JSON.stringify(join(automatic.root, "..")) +
      ".",
  );
  assert.equal(existsSync(late), true);
  assert.equal((await next.recent()).matchedCount, 2);
});

test("after an interrupted re-attach, the next /bookie-reattach cleans up first and offers the memory again", async (t) => {
  const { parent, store } = await withAgent(t);
  const before = await rememberedProject(parent, "before");
  const after = join(parent, "after");
  await moveAcrossVolumes(before, after);
  const next = host(after, "after-session");
  await next.event("session_start");
  // Pi stops right after this folder's link was moved to the pending seal.
  assert.equal(
    await crashAfter(
      (name, args) => name === "rename" && /[0-9a-f]{64}\.json$/u.test(args[1]),
      () => next.reattach({ confirm: true }),
    ),
    true,
  );
  await assert.rejects(next.reattach({ confirm: true }), (error) =>
    error.message.includes(join(store, "reattach.lock")),
  );
  await rm(join(store, "reattach.lock"));
  const dialog = await next.reattach({ confirm: true });
  assert.equal(dialog.confirms.length, 1);
  assert.equal(
    next.notices.includes(
      "Bookie cleaned up after an earlier re-attach that was interrupted.",
    ),
    true,
  );
  assert.equal(
    next.notices.at(-1),
    "Bookie memory from " +
      JSON.stringify(before) +
      " is now attached to this folder.",
  );
  assert.equal((await next.recent()).matchedCount, 2);
  assert.deepEqual(await leftovers(store), []);
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
  await assert.rejects(
    next.reattach(
      {
        confirm: true,
        select: (options) => {
          listed = true;
          return options[0];
        },
      },
      { isIdle: () => false },
    ),
    /runs only while Pi is idle/u,
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
