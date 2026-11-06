import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as core from "../dist/index.js";

const projectPath = "/projects/fixture/project.md";
const taskPath = "/projects/fixture/tasks/task.md";
const taskUid = "TSK-00000000000000000000000002";
const binding = {
  policyRevision: "synthetic-policy-v1",
  destination: {
    provider: "synthetic",
    model: "fixture",
    endpoint: "https://example.invalid",
  },
};
const authority = { assertAuthority: async () => {} };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bookie-recall-"));
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    root,
    { recursive: true },
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const entry of await readdir(root, { recursive: true })) {
    if (!entry.endsWith(".md") || entry === "index.md") continue;
    const path = join(root, entry);
    const source = await readFile(path, "utf8");
    const end = source.indexOf("\n---\n", 4);
    const fm = JSON.parse(source.slice(4, end));
    fm.bookie.sensitivity = "public";
    await writeFile(path, "---\n" + JSON.stringify(fm) + source.slice(end));
  }
  const manifestPath = join(root, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8"))
      .replace(
        "      - public\n",
        "      - public\n      - internal\n      - restricted\n",
      )
      .replace("excluded_classes: []", "excluded_classes: [restricted]"),
  );
  const project = {
    path: projectPath,
    sourceHash: core.computeConceptSourceHash(
      await readFile(join(root, projectPath)),
    ),
  };
  return { root, project };
}
function request(project) {
  return {
    project,
    selectors: [{ path: taskPath }],
    maxContentBytes: 2000,
    maxTotalBytes: 4000,
  };
}
function record() {
  return {
    producer: "fixture-daddy",
    producerInstance: "synthetic-store-one",
    owner: { sessionId: "session-one", cwd: "/synthetic/project" },
    operationId: "operation-one",
    executionId: "execution-one",
    kind: "operation-result",
    reference: {
      locator: "fixture://result/one",
      sha256: "a".repeat(64),
      byteLength: 32,
    },
  };
}
const resolver = {
  ...authority,
  resolveReference: async (record) => ({
    sha256: record.reference.sha256,
    byteLength: record.reference.byteLength,
  }),
};

test("exact context is reusable only with matching current source, destination and control state", async (t) => {
  const { root, project } = await fixture(t);
  assert.equal(
    (await core.prepareContext(root, request(project), { binding })).reason,
    "not-configured",
  );
  assert.equal(
    (await core.initializeRecallState(root, authority)).outcome,
    "initialized",
  );
  const prepared = await core.prepareContext(root, request(project), {
    binding,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.bundle.source.commit, null);
  assert.equal(prepared.bundle.inputs[0].uid, taskUid);
  assert.match(prepared.bundle.inputs[0].text, /Fixture task/);
  assert.equal(
    (await core.revalidateContext(root, prepared.bundle, { binding })).ok,
    true,
  );
  assert.equal(
    (
      await core.revalidateContext(root, prepared.bundle, {
        binding: { ...binding, policyRevision: "other" },
      })
    ).reason,
    "stale",
  );
  assert.equal(
    (
      await core.revalidateContext(root, prepared.bundle, {
        binding: {
          ...binding,
          destination: { ...binding.destination, model: "other" },
        },
      })
    ).reason,
    "stale",
  );
  await writeFile(
    join(root, taskPath),
    (await readFile(join(root, taskPath), "utf8")) + "\nNew information\n",
  );
  const changed = await core.revalidateContext(root, prepared.bundle, {
    binding,
  });
  assert.equal(changed.ok, false);
  assert.equal("bundle" in changed, false);
  const rebuilt = await core.prepareContext(root, request(project), {
    binding,
  });
  assert.equal(rebuilt.ok, true);
  assert.match(rebuilt.bundle.inputs[0].text, /New information/);
});

test("suppression blocks rebuilt context and deleted or unsupported state never resets it", async (t) => {
  const { root, project } = await fixture(t);
  await core.initializeRecallState(root, authority);
  const prepared = await core.prepareContext(root, request(project), {
    binding,
  });
  assert.equal(prepared.ok, true);
  const state = await core.readRecallState(root);
  assert.equal(state.ok, true);
  const update = await core.updateRecallControl(
    root,
    {
      project,
      expectedRevision: state.revision,
      control: {
        target: { kind: "concept", uid: taskUid },
        disposition: "suppressed",
      },
    },
    authority,
  );
  assert.equal(update.ok, true);
  assert.equal(
    (await core.revalidateContext(root, prepared.bundle, { binding })).ok,
    false,
  );
  assert.equal(
    (await core.prepareContext(root, request(project), { binding })).reason,
    "suppressed",
  );
  const path = join(root, "bookie-recall.json");
  const bytes = await readFile(path);
  await rm(path);
  assert.equal((await core.readRecallState(root)).reason, "invalid-state");
  assert.equal(
    (await core.initializeRecallState(root, authority)).reason,
    "invalid-state",
  );
  assert.equal(
    (await core.prepareContext(root, request(project), { binding })).reason,
    "invalid-state",
  );
  await writeFile(path, bytes);
  assert.equal(
    (await core.prepareContext(root, request(project), { binding })).reason,
    "suppressed",
  );
  const unsupported = JSON.parse(bytes);
  unsupported.schemaVersion = 99;
  await writeFile(path, JSON.stringify(unsupported));
  assert.equal(
    (await core.initializeRecallState(root, authority)).reason,
    "invalid-state",
  );
  assert.equal(
    (await core.prepareContext(root, request(project), { binding })).reason,
    "invalid-state",
  );
});

test("producer retries retain one metadata receipt, reject changed bytes and cannot reimport suppression", async (t) => {
  const { root, project } = await fixture(t);
  const initial = await core.initializeRecallState(root, authority);
  assert.equal(initial.ok, true);
  const input = {
    project,
    expectedRevision: initial.revision,
    record: record(),
    sensitivity: "public",
  };
  const created = await core.registerProducerReference(root, input, resolver);
  assert.equal(created.outcome, "registered");
  const reused = await core.registerProducerReference(root, input, resolver);
  assert.equal(reused.outcome, "reused");
  assert.equal(reused.registrationId, created.registrationId);
  assert.equal(
    (await core.readRecallState(root)).state.registrations.length,
    1,
  );
  const reordered = {
    ...input,
    record: {
      reference: {
        byteLength: 32,
        sha256: "a".repeat(64),
        locator: "fixture://result/one",
      },
      kind: input.record.kind,
      executionId: input.record.executionId,
      operationId: input.record.operationId,
      owner: {
        cwd: input.record.owner.cwd,
        sessionId: input.record.owner.sessionId,
      },
      producerInstance: input.record.producerInstance,
      producer: input.record.producer,
    },
  };
  assert.equal(
    (await core.registerProducerReference(root, reordered, resolver)).outcome,
    "reused",
  );
  assert.equal(
    (
      await core.registerProducerReference(
        root,
        { ...input, sensitivity: "internal" },
        resolver,
      )
    ).reason,
    "conflict",
  );
  const changed = {
    ...input,
    record: {
      ...input.record,
      reference: { ...input.record.reference, sha256: "b".repeat(64) },
    },
  };
  assert.equal(
    (await core.registerProducerReference(root, changed, resolver)).reason,
    "conflict",
  );
  const blocked = await core.updateRecallControl(
    root,
    {
      project,
      expectedRevision: created.revision,
      control: {
        target: { kind: "producer", registrationId: created.registrationId },
        disposition: "suppressed",
      },
    },
    authority,
  );
  assert.equal(blocked.ok, true);
  assert.equal(
    (await core.registerProducerReference(root, input, resolver)).reason,
    "suppressed",
  );
  assert.equal(
    (await core.readRecallState(root)).state.registrations.length,
    1,
  );
});

test("control mutation rechecks authority under the lock and stale revisions cannot overwrite", async (t) => {
  const { root, project } = await fixture(t);
  const state = await core.initializeRecallState(root, authority);
  assert.equal(state.ok, true);
  let checks = 0;
  let lockObserved = false;
  const waiting = core.updateRecallControl(
    root,
    {
      project,
      expectedRevision: state.revision,
      control: {
        target: { kind: "concept", uid: taskUid },
        disposition: "suppressed",
      },
    },
    {
      assertAuthority: async () => {
        checks++;
        if (checks === 2) {
          lockObserved =
            (await readFile(join(root, ".bookie-write.lock"))).length > 0;
          throw Error("revoked-secret");
        }
      },
    },
  );
  assert.equal((await waiting).reason, "authority");
  assert.equal(lockObserved, true);
  assert.equal((await core.readRecallState(root)).revision, state.revision);
  const args = {
    project,
    expectedRevision: state.revision,
    control: {
      target: { kind: "concept", uid: taskUid },
      disposition: "suppressed",
    },
  };
  assert.equal(
    (await core.updateRecallControl(root, args, authority)).ok,
    true,
  );
  assert.equal(
    (await core.updateRecallControl(root, args, authority)).reason,
    "conflict",
  );
});

test("an explicit correction preserves predecessor bytes and rejects old bundle reuse", async (t) => {
  const { root, project } = await fixture(t);
  const before = await readFile(join(root, taskPath));
  const state = await core.initializeRecallState(root, authority);
  assert.equal(state.ok, true);
  const prepared = await core.prepareContext(root, request(project), {
    binding,
  });
  assert.equal(prepared.ok, true);
  const replacementPath = "/projects/fixture/research/Δ-findings.md";
  await writeFile(
    join(root, replacementPath),
    (await readFile(join(root, replacementPath), "utf8")) +
      "\nReplaces [the prior task](" +
      taskPath +
      ") (" +
      taskUid +
      ").\n",
  );
  const replacement = await core.inspectConcept(root, {
    path: replacementPath,
  });
  assert.equal(replacement.ok, true);
  const updated = await core.updateRecallControl(
    root,
    {
      project,
      expectedRevision: state.revision,
      control: {
        target: { kind: "concept", uid: taskUid },
        disposition: "superseded",
        replacement: {
          path: replacementPath,
          uid: replacement.uid,
          sourceHash: replacement.source.sourceHash,
        },
      },
    },
    authority,
  );
  assert.equal(updated.ok, true);
  assert.equal(
    (await core.revalidateContext(root, prepared.bundle, { binding })).ok,
    false,
  );
  assert.deepEqual(await readFile(join(root, taskPath)), before);
  const replacementContext = await core.prepareContext(
    root,
    { project, selectors: [{ path: replacementPath }] },
    { binding },
  );
  assert.equal(replacementContext.ok, true);
  assert.match(
    replacementContext.bundle.inputs[0].text,
    /Replaces \[the prior task\]/,
  );
});

test("committed context uses pinned source bytes while current controls still govern reuse", async (t) => {
  const { root, project } = await fixture(t);
  const git = (args) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Bookie Recall Tests",
        "-c",
        "user.email=bookie@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "-C",
        root,
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "synthetic source"]);
  const commit = git(["rev-parse", "HEAD"]);
  const original = await readFile(join(root, taskPath));
  await core.initializeRecallState(root, authority);
  await writeFile(join(root, taskPath), original + "\nWorking only\n");
  const historical = await core.prepareContext(
    root,
    { ...request(project), source: { mode: "committed", commit } },
    { binding },
  );
  assert.equal(historical.ok, true);
  assert.equal(historical.bundle.source.commit, commit);
  assert.equal(
    historical.bundle.inputs[0].sourceHash,
    core.computeConceptSourceHash(original),
  );
  assert.doesNotMatch(historical.bundle.inputs[0].text, /Working only/);
  const state = await core.readRecallState(root);
  await core.updateRecallControl(
    root,
    {
      project,
      expectedRevision: state.revision,
      control: {
        target: { kind: "concept", uid: taskUid },
        disposition: "suppressed",
      },
    },
    authority,
  );
  assert.equal(
    (await core.revalidateContext(root, historical.bundle, { binding })).ok,
    false,
  );
});

test("Project amendments preserve stable suppression and producer reimport refusal", async (t) => {
  const { root, project } = await fixture(t);
  const state = await core.initializeRecallState(root, authority);
  const registered = await core.registerProducerReference(
    root,
    {
      project,
      record: record(),
      sensitivity: "public",
      expectedRevision: state.revision,
    },
    resolver,
  );
  assert.equal(registered.ok, true);
  const hidden = await core.updateRecallControl(
    root,
    {
      project,
      expectedRevision: registered.revision,
      control: {
        target: { kind: "producer", registrationId: registered.registrationId },
        disposition: "suppressed",
      },
    },
    authority,
  );
  assert.equal(hidden.ok, true);
  const hiddenTask = await core.updateRecallControl(
    root,
    {
      project,
      expectedRevision: hidden.revision,
      control: {
        target: { kind: "concept", uid: taskUid },
        disposition: "suppressed",
      },
    },
    authority,
  );
  assert.equal(hiddenTask.ok, true);
  await writeFile(
    join(root, projectPath),
    (await readFile(join(root, projectPath), "utf8")) +
      "\nAmended project intent\n",
  );
  const amended = {
    path: projectPath,
    sourceHash: core.computeConceptSourceHash(
      await readFile(join(root, projectPath)),
    ),
  };
  assert.equal(
    (await core.prepareContext(root, request(amended), { binding })).ok,
    false,
  );
  assert.equal(
    (
      await core.registerProducerReference(
        root,
        {
          project: amended,
          record: record(),
          sensitivity: "public",
          expectedRevision: hiddenTask.revision,
        },
        resolver,
      )
    ).reason,
    "suppressed",
  );
});

test("committed content obeys current sensitivity changes and exclusions", async (t) => {
  const { root, project } = await fixture(t);
  const git = (args) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Bookie Recall Tests",
        "-c",
        "user.email=bookie@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "-C",
        root,
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "synthetic source"]);
  const commit = git(["rev-parse", "HEAD"]);
  await core.initializeRecallState(root, authority);
  const args = { ...request(project), source: { mode: "committed", commit } };
  const original = await core.prepareContext(root, args, { binding });
  assert.equal(original.ok, true);
  const path = join(root, taskPath);
  const bytes = await readFile(path, "utf8");
  await writeFile(
    path,
    bytes.replace('"sensitivity":"public"', '"sensitivity":"internal"'),
  );
  assert.equal(
    (await core.prepareContext(root, args, { binding })).reason,
    "policy",
  );
  assert.equal(
    (await core.revalidateContext(root, original.bundle, { binding })).ok,
    false,
  );
  await writeFile(
    path,
    bytes.replace('"sensitivity":"public"', '"sensitivity":"restricted"'),
  );
  assert.equal((await core.prepareContext(root, args, { binding })).ok, false);
});

test("producer resolution cannot mutate captured arguments or bypass a changed Project", async (t) => {
  const { root, project } = await fixture(t);
  const state = await core.initializeRecallState(root, authority);
  const input = {
    project,
    record: record(),
    sensitivity: "public",
    expectedRevision: state.revision,
  };
  const badResolution = await core.registerProducerReference(root, input, {
    ...authority,
    resolveReference: async (resolved) => {
      resolved.reference.sha256 = "b".repeat(64);
      return { sha256: resolved.reference.sha256, byteLength: 32 };
    },
  });
  assert.equal(badResolution.reason, "source-changed");
  assert.equal((await core.readRecallState(root)).revision, state.revision);
  const changedScope = await core.registerProducerReference(root, input, {
    ...authority,
    resolveReference: async (resolved) => {
      await writeFile(
        join(root, projectPath),
        (await readFile(join(root, projectPath), "utf8")) +
          "\nChanged while resolving\n",
      );
      return { sha256: resolved.reference.sha256, byteLength: 32 };
    },
  });
  assert.equal(changedScope.reason, "stale");
  assert.equal((await core.readRecallState(root)).revision, state.revision);
});

test("metadata-only producer registration preserves exact canonical context", async (t) => {
  const { root, project } = await fixture(t);
  const initialized = await core.initializeRecallState(root, authority);
  assert.equal(initialized.ok, true);
  const prepared = await core.prepareContext(root, request(project), {
    binding,
  });
  assert.equal(prepared.ok, true);
  const before = await core.readRecallState(root);
  assert.equal(before.ok, true);
  const registered = await core.registerProducerReference(
    root,
    {
      project,
      expectedRevision: before.revision,
      record: record(),
      sensitivity: "public",
    },
    resolver,
  );
  assert.equal(registered.outcome, "registered");
  const after = await core.readRecallState(root);
  assert.equal(after.ok, true);
  assert.notEqual(after.revision, before.revision);
  assert.match(before.controlsRevision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(after.controlsRevision, before.controlsRevision);
  assert.deepEqual(after.state.controls, before.state.controls);
  assert.equal(
    after.state.registrations.length,
    before.state.registrations.length + 1,
  );
  const current = await core.revalidateContext(root, prepared.bundle, {
    binding,
  });
  assert.equal(current.ok, true);
  assert.deepEqual(current.bundle.inputs, prepared.bundle.inputs);
});

test("canonical control identity retains ordered no-op history and whole-store refusal", async (t) => {
  const { root, project } = await fixture(t);
  await core.initializeRecallState(root, authority);
  const original = await core.readRecallState(root);
  assert.match(original.controlsRevision, /^sha256:[a-f0-9]{64}$/);
  const other = await core.inspectConcept(root, {
    path: "/projects/fixture/documents/document.md",
  });
  assert.equal(other.ok, true);
  const control = {
    target: { kind: "concept", uid: other.uid },
    disposition: "suppressed",
  };
  const first = await core.updateRecallControl(
    root,
    { project, expectedRevision: original.revision, control },
    authority,
  );
  assert.equal(first.ok, true);
  const one = await core.readRecallState(root);
  assert.notEqual(one.controlsRevision, original.controlsRevision);
  const prepared = await core.prepareContext(root, request(project), {
    binding,
  });
  assert.equal(prepared.ok, true);
  const repeated = await core.updateRecallControl(
    root,
    { project, expectedRevision: one.revision, control },
    authority,
  );
  assert.equal(repeated.ok, true);
  const two = await core.readRecallState(root);
  assert.equal(two.state.controls.length, 2);
  assert.deepEqual(two.state.controls[0], two.state.controls[1]);
  assert.notEqual(
    two.controlsRevision,
    one.controlsRevision,
    "effective no-op retains a new control event",
  );
  assert.equal(
    (await core.revalidateContext(root, prepared.bundle, { binding })).reason,
    "stale",
  );
  const fresh = await core.prepareContext(root, request(project), { binding });
  assert.equal(fresh.ok, true);
  const statePath = join(root, "bookie-recall.json"),
    bytes = await readFile(statePath);
  await writeFile(
    statePath,
    JSON.stringify({ ...two.state, registrations: [{}] }),
  );
  const invalid = await core.readRecallState(root);
  assert.equal(invalid.reason, "invalid-state");
  assert.equal("controlsRevision" in invalid, false);
  assert.equal(
    (await core.revalidateContext(root, fresh.bundle, { binding })).ok,
    false,
  );
  await rm(statePath);
  assert.equal((await core.readRecallState(root)).reason, "invalid-state");
  assert.equal(
    (await core.initializeRecallState(root, authority)).reason,
    "invalid-state",
  );
  await writeFile(statePath, bytes);
  assert.equal(
    (
      await core.prepareContext(
        root,
        { ...request(project), selectors: [{ path: other.source.path }] },
        { binding },
      )
    ).reason,
    "suppressed",
  );
});

test("legacy whole-state bundles become stale without migration and fresh preparation succeeds", async (t) => {
  const { root, project } = await fixture(t);
  await core.initializeRecallState(root, authority);
  const state = await core.readRecallState(root);
  const fresh = await core.prepareContext(root, request(project), { binding });
  assert.equal(fresh.ok, true);
  const { digest: _digest, ...body } = fresh.bundle;
  void _digest;
  body.controlRevision = state.revision;
  const canonical = (value) =>
    JSON.stringify(value, (_, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, v[k]]),
          )
        : v,
    );
  const legacy = {
    ...body,
    digest: core.computeConceptSourceHash(Buffer.from(canonical(body))),
  };
  const bytes = await readFile(join(root, "bookie-recall.json"));
  assert.equal(
    (await core.revalidateContext(root, legacy, { binding })).reason,
    "stale",
  );
  assert.equal(
    (await core.revalidateContext(root, fresh.bundle, { binding })).ok,
    true,
  );
  assert.deepEqual(await readFile(join(root, "bookie-recall.json")), bytes);
});

async function exportFixture(t, edit) {
  const value = await fixture(t);
  if (edit) await edit(value.root);
  const git = (args) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Bookie Export Tests",
        "-c",
        "user.email=bookie@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "-C",
        value.root,
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-qm", "synthetic export source"]);
  const commit = git(["rev-parse", "HEAD"]);
  await core.initializeRecallState(value.root, authority);
  return { ...value, commit };
}
function exportRequest(f, selectors = [{ path: taskPath }]) {
  return { project: f.project, selectors, commit: f.commit, maxBytes: 24000 };
}

test("bounded canonical selection export returns exact full records and preserves permitted history", async (t) => {
  const f = await exportFixture(t, async (root) => {
    const path = join(root, taskPath),
      source = await readFile(path, "utf8"),
      end = source.indexOf("\n---\n", 4);
    const fm = JSON.parse(source.slice(4, end));
    fm.custom_export = {
      "Unicode café": ["line\nnext", "tab\tvalue", true, 3],
    };
    await writeFile(path, "---\n" + JSON.stringify(fm) + source.slice(end));
  });
  const lines = [];
  const full = await core.exportCanonicalJsonl(f.root, {
    sourceRef: f.commit,
    write: (bytes) => lines.push(Buffer.from(bytes)),
  });
  assert.equal(full.ok, true);
  const selection = [taskPath, projectPath];
  const expected = Buffer.concat(
    lines.filter((line) =>
      selection.includes(JSON.parse(line.toString()).path),
    ),
  ).toString();
  await writeFile(
    join(f.root, taskPath),
    (await readFile(join(f.root, taskPath), "utf8")) +
      "\nNew current body only\n",
  );
  const result = await core.prepareCanonicalExport(
    f.root,
    exportRequest(
      f,
      selection.map((path) => ({ path })),
    ),
    { binding },
  );
  assert.equal(result.ok, true);
  assert.equal(result.artifact.jsonl, expected);
  assert.equal(result.artifact.scope, "selected-records");
  assert.equal(result.artifact.sourceCommit, f.commit);
  assert.equal(result.artifact.recordCount, 2);
  assert.equal(result.artifact.byteLength, Buffer.byteLength(expected));
  assert.equal(
    result.artifact.outputHash,
    core.computeConceptSourceHash(Buffer.from(expected)),
  );
  assert.match(result.artifact.jsonl, /custom_export/);
  assert.doesNotMatch(result.artifact.jsonl, /New current body only/);
  assert.equal("sourceManifest" in result.artifact, false);
});

test("bounded canonical selection export refuses partial, wrong and duplicate selections", async (t) => {
  const f = await exportFixture(t);
  for (const args of [
    { ...exportRequest(f), maxBytes: 1 },
    exportRequest(f, [
      { path: taskPath, sourceHash: "sha256:" + "f".repeat(64) },
    ]),
    exportRequest(f, [{ path: taskPath }, { path: taskPath }]),
    exportRequest(f, [{ path: "/projects/fixture/missing.md" }]),
    { ...exportRequest(f), commit: "HEAD" },
    { ...exportRequest(f), secretPolicy: "allow-unchecked" },
  ]) {
    const result = await core.prepareCanonicalExport(f.root, args, { binding });
    assert.equal(result.ok, false);
    assert.equal("artifact" in result, false);
    assert.equal("sourceManifest" in result, false);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    core.prepareCanonicalExport(f.root, exportRequest(f), {
      binding,
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
});

test("bounded canonical selection export protects decoded metadata but permits correction provenance", async (t) => {
  const replacementPath = "/projects/fixture/research/Δ-findings.md";
  for (const disposition of ["suppressed", "superseded", "excluded"]) {
    await t.test(disposition, async (t) => {
      const f = await exportFixture(t, async (root) => {
        const path = join(root, replacementPath),
          source = await readFile(path, "utf8"),
          end = source.indexOf("\n---\n", 4);
        const fm = JSON.parse(source.slice(4, end));
        // Both a decoded metadata key and a nested value mention the predecessor.
        // The source's escaped T must not hide the identity from the policy check.
        fm.provenance = { [taskUid]: { path: taskPath } };
        await writeFile(
          path,
          "---\n" +
            JSON.stringify(fm).replace(taskUid, "\\u0054" + taskUid.slice(1)) +
            source.slice(end),
        );
      });
      const args = exportRequest(f, [{ path: replacementPath }]);
      const before = await core.prepareCanonicalExport(f.root, args, {
        binding,
      });
      assert.equal(before.ok, true);
      assert.equal(
        JSON.parse(before.artifact.jsonl).frontmatter.provenance[taskUid].path,
        taskPath,
      );
      if (disposition === "excluded") {
        const path = join(f.root, "bookie.yaml");
        await writeFile(
          path,
          (await readFile(path, "utf8")).replace(
            "    - exports/**",
            "    - exports/**\n    - projects/fixture/tasks/**",
          ),
        );
      } else {
        const state = await core.readRecallState(f.root);
        const replacement = await core.inspectConcept(f.root, {
          path: replacementPath,
        });
        const updated = await core.updateRecallControl(
          f.root,
          {
            project: f.project,
            expectedRevision: state.revision,
            control: {
              target: { kind: "concept", uid: taskUid },
              disposition,
              ...(disposition === "superseded"
                ? {
                    replacement: {
                      path: replacementPath,
                      uid: replacement.uid,
                      sourceHash: replacement.source.sourceHash,
                    },
                  }
                : {}),
            },
          },
          authority,
        );
        assert.equal(updated.ok, true);
      }
      const after = await core.prepareCanonicalExport(f.root, args, {
        binding,
      });
      if (disposition === "superseded") {
        assert.equal(after.ok, true);
        assert.equal(after.artifact.jsonl, before.artifact.jsonl);
        assert.equal(
          (
            await core.prepareCanonicalExport(f.root, exportRequest(f), {
              binding,
            })
          ).ok,
          false,
          "predecessor content remains refused",
        );
      } else {
        assert.equal(after.ok, false);
        assert.equal("artifact" in after, false);
        assert.doesNotMatch(
          JSON.stringify(after),
          /TSK-|tasks\/task|provenance/,
        );
      }
    });
  }
});
