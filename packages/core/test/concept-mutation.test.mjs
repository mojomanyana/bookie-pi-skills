import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { watch as watchDirectory } from "node:fs";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  amendConcept,
  computeConceptSourceHash,
  createConcept,
  loadConcept,
  validateVault,
} from "../dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const validVault = resolve(repositoryRoot, "fixtures/valid-vault");
const existingTaskUid = "TSK-00000000000000000000000002";
const taskUidA = "TSK-0000000000000000000000000A";
const taskUidB = "TSK-0000000000000000000000000B";
const taskUidC = "TSK-0000000000000000000000000C";

async function temporaryVault(t) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-mutation-"));
  const vault = join(parent, "vault");
  await cp(validVault, vault, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, vault };
}

function taskFrontmatter(uid, title = "New task") {
  return {
    type: "Task",
    title,
    status: "draft",
    generated: {
      by: "human:mutation-test",
      at: "2026-09-02T20:00:00Z",
    },
    bookie: {
      profile: "1.0",
      uid,
      project: "/projects/fixture/project.md",
      state: "ready",
      created_at: "2026-09-02T20:00:00Z",
    },
  };
}

function diagnosticCodes(result) {
  return [...new Set(result.diagnostics.map((diagnostic) => diagnostic.code))];
}

function assertRejected(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.conflict, code === "MUTATION-CONFLICT");
  assert.ok(result.diagnostics.length >= 1);
  assert.ok(diagnosticCodes(result).includes(code), JSON.stringify(result));
  for (const diagnostic of result.diagnostics) {
    assert.equal(diagnostic.severity, "error");
    assert.ok(
      diagnostic.message.length > 0 && diagnostic.message.length <= 160,
    );
    assert.equal(diagnostic.message.includes("\n"), false);
    assert.ok(diagnostic.remediation.length > 0);
  }
}

function exactHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function nextMutationTemporary(directory) {
  let watcher;
  return new Promise((resolveTemporary, rejectTemporary) => {
    const timeout = setTimeout(() => {
      watcher?.close();
      rejectTemporary(new Error("mutation temporary file was not observed"));
    }, 5_000);
    watcher = watchDirectory(directory, (_event, filename) => {
      const name = String(filename);
      if (name.includes(".bookie-")) {
        clearTimeout(timeout);
        watcher.close();
        resolveTemporary(name);
      }
    });
  });
}

async function writeCommentedTask(vault, name = "commented.md") {
  const path = join(vault, "projects/fixture/tasks", name);
  const source = `---\n# leading concept comment\ntype: Task # inline type comment\ntitle   : 'Original title'\nunknown_extension:\n  nested: yes # unknown comment\n  remove_me: old\ndescription: |-\n  literal line one\n  literal line two\nsummary: >+\n  folded line one\n  folded line two\n\ntags: [alpha, "beta"]\nstatus: draft\ngenerated:\n  by: "human:mutation-test"\n  at: 2026-09-02T20:00:00Z\nbookie:\n  profile: "1.0"\n  uid: ${taskUidA}\n  project: /projects/fixture/project.md\n  state: ready\n  created_at: 2026-09-02T20:00:00Z\n---\n\n# Exact body Δ\n\nDo not normalize this body.\n`;
  await writeFile(path, source);
  return {
    path,
    source: Buffer.from(source),
    bundlePath: `/projects/fixture/tasks/${name}`,
  };
}

test("concept source hashes are exact, prefixed lowercase SHA-256 tokens", () => {
  const bytes = Buffer.from("line one\r\nline two\n\0", "utf8");
  assert.equal(computeConceptSourceHash(bytes), exactHash(bytes));
  assert.equal(
    computeConceptSourceHash(Uint8Array.from(bytes)),
    exactHash(bytes),
  );
});

test("create publishes one complete validated concept through the supplied queue", async (t) => {
  const { vault } = await temporaryVault(t);
  const relativePath = "projects/fixture/tasks/Δ created.md";
  const target = join(vault, relativePath);
  const bodyText = "\n# Created task\n\nExact body Δ.\n";
  let calls = 0;
  let queuedTarget;

  const result = await createConcept(
    vault,
    {
      path: relativePath,
      frontmatter: taskFrontmatter(taskUidA),
      bodyText,
    },
    {
      async runExclusive(absoluteTargetPath, mutation) {
        calls += 1;
        queuedTarget = absoluteTargetPath;
        assert.equal(
          await readFile(target).then(
            () => true,
            () => false,
          ),
          false,
        );
        return mutation();
      },
    },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.operation, "create");
  assert.equal(result.outcome, "created");
  assert.equal(result.path, `/${relativePath}`);
  assert.deepEqual(result.changedPaths, [`/${relativePath}`]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.previousSourceHash, undefined);
  assert.equal(calls, 1);
  assert.equal(queuedTarget, target);

  const stored = await readFile(target);
  assert.equal(result.sourceHash, exactHash(stored));
  const loaded = loadConcept(stored, { file: result.path });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  assert.deepEqual(loaded.concept.frontmatter, taskFrontmatter(taskUidA));
  assert.equal(loaded.concept.bodyText, bodyText);
  assert.equal(
    (await readdir(dirname(target))).some((name) => name.includes(".bookie-")),
    false,
  );

  const validated = await validateVault(vault);
  assert.equal(validated.valid, true, JSON.stringify(validated.diagnostics));
});

test("create supports the portable target basename byte limit", async (t) => {
  const { vault } = await temporaryVault(t);
  const name = `${"x".repeat(252)}.md`;
  const path = `projects/fixture/tasks/${name}`;
  const result = await createConcept(vault, {
    path,
    frontmatter: taskFrontmatter(taskUidA, "Long target basename"),
    bodyText: "",
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.path, `/${path}`);
  assert.equal(Buffer.byteLength(name), 255);
  assert.equal(
    (await readFile(join(vault, ...path.split("/")))).byteLength > 0,
    true,
  );
});

test("Git metadata and excessive paths are rejected before coordination", async (t) => {
  const { vault } = await temporaryVault(t);
  await mkdir(join(vault, ".git/refs/heads"), { recursive: true });
  await mkdir(join(vault, "projects/.GiT"), { recursive: true });

  const exactTotalPath = [
    ...Array.from({ length: 16 }, () => "d".repeat(254)),
    `${"f".repeat(13)}.md`,
  ].join("/");
  const overTotalPath = [
    ...Array.from({ length: 16 }, () => "d".repeat(254)),
    `${"f".repeat(14)}.md`,
  ].join("/");
  const overUtf8TotalPath = [
    ...Array.from({ length: 16 }, () => "é".repeat(126)),
    `${"f".repeat(48)}.md`,
  ].join("/");
  const exactSegmentsPath = [
    ...Array.from({ length: 63 }, () => "d"),
    "target.md",
  ].join("/");
  const excessiveSegments = [
    ...Array.from({ length: 64 }, () => "d"),
    "target.md",
  ].join("/");
  assert.equal(exactSegmentsPath.split("/").length, 64);
  assert.equal(excessiveSegments.split("/").length, 65);
  assert.equal(Buffer.byteLength(exactTotalPath), 4_096);
  assert.equal(Buffer.byteLength(overTotalPath), 4_097);
  assert.equal(Buffer.byteLength(overUtf8TotalPath), 4_099);

  let coordinated = 0;
  const options = {
    async runExclusive(_path, mutation) {
      coordinated += 1;
      return mutation();
    },
  };
  const invalidPaths = [
    ".git/refs/heads/bookie-review.md",
    "projects/.GiT/bookie-review.md",
    `projects/fixture/tasks/${"x".repeat(253)}.md`,
    `projects/fixture/tasks/${"é".repeat(127)}.md`,
    overTotalPath,
    overUtf8TotalPath,
    excessiveSegments,
  ];

  for (const path of invalidPaths) {
    const created = await createConcept(
      vault,
      {
        path,
        frontmatter: taskFrontmatter(taskUidA),
        bodyText: "",
      },
      options,
    );
    assertRejected(created, "MUTATION-PATH");
    assert.ok(
      created.diagnostics.every((diagnostic) => diagnostic.file.length < 32),
    );

    const amended = await amendConcept(
      vault,
      {
        path,
        expectedSourceHash: computeConceptSourceHash(Buffer.from("absent")),
        edits: [{ op: "set", path: ["title"], value: "changed" }],
      },
      options,
    );
    assertRejected(amended, "MUTATION-PATH");
    assert.ok(
      amended.diagnostics.every((diagnostic) => diagnostic.file.length < 32),
    );
  }
  assert.equal(coordinated, 0);
  await assert.rejects(
    readFile(join(vault, ".git/refs/heads/bookie-review.md")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readFile(join(vault, "projects/.GiT/bookie-review.md")),
    {
      code: "ENOENT",
    },
  );

  const boundary = await createConcept(
    vault,
    {
      path: exactTotalPath,
      frontmatter: taskFrontmatter(taskUidA),
      bodyText: "",
    },
    options,
  );
  assertRejected(boundary, "MUTATION-PATH");
  assert.equal(coordinated, 1);

  const segmentBoundary = await createConcept(
    vault,
    {
      path: exactSegmentsPath,
      frontmatter: taskFrontmatter(taskUidA),
      bodyText: "",
    },
    options,
  );
  assertRejected(segmentBoundary, "MUTATION-PATH");
  assert.equal(coordinated, 2);
});

test("a coordinator error after publication explicitly reports that mutation completed", async (t) => {
  const { vault } = await temporaryVault(t);
  const target = join(vault, "projects/fixture/tasks/committed.md");

  await assert.rejects(
    createConcept(
      vault,
      {
        path: "projects/fixture/tasks/committed.md",
        frontmatter: taskFrontmatter(taskUidA),
        bodyText: "",
      },
      {
        async runExclusive(_path, mutation) {
          await mutation();
          throw new Error("simulated coordinator cleanup failure");
        },
      },
    ),
    /mutation completed/u,
  );

  const stored = await readFile(target);
  assert.equal(loadConcept(stored, { file: "/committed.md" }).ok, true);
});

test("a coordinator cannot substitute the completed mutation result", async (t) => {
  const { vault } = await temporaryVault(t);
  const target = join(vault, "projects/fixture/tasks/substituted.md");

  await assert.rejects(
    createConcept(
      vault,
      {
        path: "projects/fixture/tasks/substituted.md",
        frontmatter: taskFrontmatter(taskUidA),
        bodyText: "",
      },
      {
        async runExclusive(_path, mutation) {
          return { ...(await mutation()) };
        },
      },
    ),
    /concept mutation completed/u,
  );

  const stored = await readFile(target);
  assert.equal(loadConcept(stored, { file: "/substituted.md" }).ok, true);
});

test("a coordinator cannot return before the mutation callback completes", async (t) => {
  const { vault } = await temporaryVault(t);
  let callback;

  try {
    await assert.rejects(
      createConcept(
        vault,
        {
          path: "projects/fixture/tasks/early-return.md",
          frontmatter: taskFrontmatter(taskUidA),
          bodyText: "",
        },
        {
          async runExclusive(_path, mutation) {
            callback = mutation();
            return { early: true };
          },
        },
      ),
      /concept mutation completed/u,
    );
  } finally {
    await callback;
  }
  const stored = await readFile(
    join(vault, "projects/fixture/tasks/early-return.md"),
  );
  assert.equal(loadConcept(stored, { file: "/early-return.md" }).ok, true);
});

test("root replacement while waiting for coordination fails closed", async (t) => {
  const { parent, vault } = await temporaryVault(t);
  const originalRoot = join(parent, "original-vault");
  const target = join(vault, "projects/fixture/tasks/root-swap.md");

  const result = await createConcept(
    vault,
    {
      path: "projects/fixture/tasks/root-swap.md",
      frontmatter: taskFrontmatter(taskUidA),
      bodyText: "",
    },
    {
      async runExclusive(_path, mutation) {
        await rename(vault, originalRoot);
        await cp(validVault, vault, { recursive: true });
        return mutation();
      },
    },
  );

  assertRejected(result, "MUTATION-PATH");
  await assert.rejects(readFile(target), { code: "ENOENT" });
  await assert.rejects(
    readFile(join(originalRoot, "projects/fixture/tasks/root-swap.md")),
    { code: "ENOENT" },
  );
});

test("create rejects traversal, host paths, encoding, reserved names, and unsafe parents", async (t) => {
  const { parent, vault } = await temporaryVault(t);
  const outside = join(parent, "outside");
  await mkdir(outside);
  await symlink(outside, join(vault, "linked"));

  const cases = [
    "/tmp/host-absolute.md",
    "../outside.md",
    "projects/fixture/tasks/../../outside.md",
    "projects/%2e%2e/outside.md",
    "projects\\fixture\\tasks\\outside.md",
    "projects/fixture/index.md",
    "missing-parent/task.md",
    "linked/escape.md",
    "references/files/concept.md",
  ];

  for (const [index, path] of cases.entries()) {
    const result = await createConcept(vault, {
      path,
      frontmatter: taskFrontmatter(`${taskUidA.slice(0, -1)}${index}`),
      bodyText: "",
    });
    assertRejected(result, "MUTATION-PATH");
  }

  await mkdir(join(vault, "exports"));
  const excluded = await createConcept(vault, {
    path: "exports/hidden.md",
    frontmatter: taskFrontmatter(taskUidA),
    bodyText: "",
  });
  assertRejected(excluded, "MUTATION-PATH");
  await assert.rejects(readFile(join(vault, "exports/hidden.md")), {
    code: "ENOENT",
  });
  assert.deepEqual(await readdir(outside), []);
});

test("create rejects an existing target and a UID collision without changing files", async (t) => {
  const { vault } = await temporaryVault(t);
  const existingPath = join(vault, "projects/fixture/tasks/task.md");
  const before = await readFile(existingPath);

  const existing = await createConcept(vault, {
    path: "projects/fixture/tasks/task.md",
    frontmatter: taskFrontmatter(taskUidA),
    bodyText: "",
  });
  assertRejected(existing, "MUTATION-TARGET");
  assert.deepEqual(await readFile(existingPath), before);

  const collisionPath = join(vault, "projects/fixture/tasks/collision.md");
  const collision = await createConcept(vault, {
    path: "projects/fixture/tasks/collision.md",
    frontmatter: taskFrontmatter(existingTaskUid),
    bodyText: "",
  });
  assertRejected(collision, "UID-UNIQUE");
  await assert.rejects(readFile(collisionPath), { code: "ENOENT" });
});

test("concurrent creates cannot publish the same UID at different paths", async (t) => {
  const { vault } = await temporaryVault(t);
  const [left, right] = await Promise.all([
    createConcept(vault, {
      path: "projects/fixture/tasks/uid-left.md",
      frontmatter: taskFrontmatter(taskUidA, "Left UID claimant"),
      bodyText: "",
    }),
    createConcept(vault, {
      path: "projects/fixture/tasks/uid-right.md",
      frontmatter: taskFrontmatter(taskUidA, "Right UID claimant"),
      bodyText: "",
    }),
  ]);

  const successes = [left, right].filter((result) => result.ok);
  const collisions = [left, right].filter(
    (result) => !result.ok && diagnosticCodes(result).includes("UID-UNIQUE"),
  );
  assert.equal(successes.length, 1, JSON.stringify([left, right]));
  assert.equal(collisions.length, 1, JSON.stringify([left, right]));
  const existing = await Promise.all(
    ["uid-left.md", "uid-right.md"].map((name) =>
      readFile(join(vault, "projects/fixture/tasks", name)).then(
        () => true,
        () => false,
      ),
    ),
  );
  assert.deepEqual(existing.sort(), [false, true]);
});

test("create validates the proposed schema and manifest type allow-list", async (t) => {
  const first = await temporaryVault(t);
  const invalid = taskFrontmatter(taskUidA);
  invalid.bookie.state = "not-a-state";
  const schemaResult = await createConcept(first.vault, {
    path: "projects/fixture/tasks/invalid.md",
    frontmatter: invalid,
    bodyText: "",
  });
  assertRejected(schemaResult, "CONCEPT-SCHEMA");

  const second = await temporaryVault(t);
  const manifestPath = join(second.vault, "bookie.yaml");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, manifest.replace("  - Task\n", ""));
  const disallowed = await createConcept(second.vault, {
    path: "projects/fixture/tasks/disallowed.md",
    frontmatter: taskFrontmatter(taskUidA),
    bodyText: "",
  });
  assertRejected(disallowed, "TYPE-ALLOWED");

  const missing = await temporaryVault(t);
  await rm(join(missing.vault, "bookie.yaml"));
  const missingManifest = await createConcept(missing.vault, {
    path: "projects/fixture/tasks/missing-manifest.md",
    frontmatter: taskFrontmatter(taskUidA),
    bodyText: "",
  });
  assertRejected(missingManifest, "MANIFEST-MISSING");

  const malformed = await temporaryVault(t);
  await writeFile(join(malformed.vault, "bookie.yaml"), "broken: [");
  const malformedManifest = await createConcept(malformed.vault, {
    path: "projects/fixture/tasks/malformed-manifest.md",
    frontmatter: taskFrontmatter(taskUidA),
    bodyText: "",
  });
  assertRejected(malformedManifest, "MANIFEST-SYNTAX");
});

test("amend preserves unknown YAML structure and untouched body bytes", async (t) => {
  const { vault } = await temporaryVault(t);
  const fixture = await writeCommentedTask(vault);
  const before = await readFile(fixture.path);
  const beforeLoaded = loadConcept(before, { file: fixture.bundlePath });
  assert.equal(beforeLoaded.ok, true);

  const result = await amendConcept(vault, {
    path: "projects/fixture/tasks/commented.md",
    expectedSourceHash: computeConceptSourceHash(before),
    edits: [
      { op: "set", path: ["title"], value: "Changed title" },
      { op: "set", path: ["bookie", "state"], value: "done" },
      { op: "set", path: ["tags", 0], value: "changed" },
      {
        op: "set",
        path: ["unknown_extension", "added"],
        value: JSON.parse('{"constructor":"safe","__proto__":"inert"}'),
      },
      { op: "remove", path: ["unknown_extension", "remove_me"] },
    ],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.operation, "amend");
  assert.equal(result.outcome, "amended");
  assert.equal(result.path, fixture.bundlePath);
  assert.deepEqual(result.changedPaths, [fixture.bundlePath]);
  assert.equal(result.previousSourceHash, exactHash(before));

  const after = await readFile(fixture.path);
  assert.equal(result.sourceHash, exactHash(after));
  const text = after.toString("utf8");
  assert.match(text, /^---\n# leading concept comment\n/);
  assert.match(text, /type: Task # inline type comment/);
  assert.match(text, /title: 'Changed title'/);
  assert.match(text, /nested: yes # unknown comment/);
  assert.doesNotMatch(text, /remove_me:/);
  assert.match(text, /description: \|-\n/);
  assert.match(text, /summary: >\+\n/);
  assert.ok(text.indexOf("unknown_extension:") < text.indexOf("description:"));

  const loaded = loadConcept(after, { file: fixture.bundlePath });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  assert.equal(loaded.concept.frontmatter.title, "Changed title");
  assert.equal(loaded.concept.frontmatter.bookie.state, "done");
  assert.deepEqual(loaded.concept.frontmatter.tags, ["changed", "beta"]);
  assert.equal(loaded.concept.frontmatter.unknown_extension.nested, "yes");
  assert.equal(
    loaded.concept.frontmatter.unknown_extension.added.constructor,
    "safe",
  );
  assert.equal(
    loaded.concept.frontmatter.unknown_extension.added.__proto__,
    "inert",
  );
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(loaded.concept.bodyText, beforeLoaded.concept.bodyText);

  const validated = await validateVault(vault);
  assert.equal(validated.valid, true, JSON.stringify(validated.diagnostics));
});

test("a body-only amendment preserves frontmatter bytes exactly", async (t) => {
  const { vault } = await temporaryVault(t);
  const fixture = await writeCommentedTask(vault, "body-only.md");
  const before = await readFile(fixture.path);
  const loaded = loadConcept(before, { file: fixture.bundlePath });
  assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
  const prefixBytes =
    before.byteLength - Buffer.byteLength(loaded.concept.bodyText, "utf8");
  const bodyText = "replacement body without a final newline";

  const result = await amendConcept(vault, {
    path: "projects/fixture/tasks/body-only.md",
    expectedSourceHash: computeConceptSourceHash(before),
    edits: [],
    bodyText,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  const after = await readFile(fixture.path);
  assert.deepEqual(
    after,
    Buffer.concat([before.subarray(0, prefixBytes), Buffer.from(bodyText)]),
  );
});

test("sequence edits target original indices independent of request order", async (t) => {
  const cases = [
    {
      edits: [
        { op: "remove", path: ["tags", 0] },
        { op: "remove", path: ["tags", 1] },
      ],
      expected: ["gamma"],
    },
    {
      edits: [
        { op: "remove", path: ["tags", 1] },
        { op: "remove", path: ["tags", 0] },
      ],
      expected: ["gamma"],
    },
    {
      edits: [
        { op: "remove", path: ["tags", 0] },
        { op: "set", path: ["tags", 2], value: "changed-gamma" },
      ],
      expected: ["beta", "changed-gamma"],
    },
    {
      edits: [
        { op: "set", path: ["tags", 2], value: "changed-gamma" },
        { op: "remove", path: ["tags", 0] },
      ],
      expected: ["beta", "changed-gamma"],
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    const { vault } = await temporaryVault(t);
    const fixture = await writeCommentedTask(vault, `sequence-${index}.md`);
    const source = Buffer.from(
      fixture.source
        .toString("utf8")
        .replace('tags: [alpha, "beta"]', 'tags: [alpha, "beta", gamma]'),
    );
    await writeFile(fixture.path, source);

    const result = await amendConcept(vault, {
      path: `projects/fixture/tasks/sequence-${index}.md`,
      expectedSourceHash: computeConceptSourceHash(source),
      edits: scenario.edits,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    const loaded = loadConcept(await readFile(fixture.path), {
      file: fixture.bundlePath,
    });
    assert.equal(loaded.ok, true, JSON.stringify(loaded.diagnostics));
    assert.deepEqual(loaded.concept.frontmatter.tags, scenario.expected);
  }
});

test("amend round-trips every initial profile type", async (t) => {
  const { vault } = await temporaryVault(t);
  const cases = [
    ["Project", "projects/fixture/project.md"],
    ["Task", "projects/fixture/tasks/task.md"],
    ["Document", "projects/fixture/documents/document.md"],
    ["Research", "projects/fixture/research/Δ-findings.md"],
    ["Decision", "projects/fixture/decisions/decision.md"],
    ["Activity", "projects/fixture/activities/checkpoint.md"],
    ["Evidence", "projects/fixture/evidence/evidence.md"],
    ["Person", "people/owner.md"],
  ];

  for (const [type, path] of cases) {
    const target = join(vault, ...path.split("/"));
    const before = await readFile(target);
    const beforeLoaded = loadConcept(before, { file: `/${path}` });
    assert.equal(beforeLoaded.ok, true);
    const result = await amendConcept(vault, {
      path,
      expectedSourceHash: computeConceptSourceHash(before),
      edits: [{ op: "set", path: ["title"], value: `${type} amended` }],
    });
    assert.equal(result.ok, true, `${type}: ${JSON.stringify(result)}`);
    const after = await readFile(target);
    const afterLoaded = loadConcept(after, { file: `/${path}` });
    assert.equal(afterLoaded.ok, true, type);
    assert.equal(afterLoaded.concept.frontmatter.type, type);
    assert.equal(afterLoaded.concept.frontmatter.title, `${type} amended`);
    assert.equal(afterLoaded.concept.bodyText, beforeLoaded.concept.bodyText);
  }

  const validated = await validateVault(vault);
  assert.equal(validated.valid, true, JSON.stringify(validated.diagnostics));
});

test("a semantic no-op does not serialize or replace the source file", async (t) => {
  const { vault } = await temporaryVault(t);
  const fixture = await writeCommentedTask(vault, "no-op.md");
  const before = await readFile(fixture.path);
  const beforeMetadata = await lstat(fixture.path, { bigint: true });

  const result = await amendConcept(vault, {
    path: "projects/fixture/tasks/no-op.md",
    expectedSourceHash: computeConceptSourceHash(before),
    edits: [
      { op: "set", path: ["title"], value: "Original title" },
      {
        op: "set",
        path: ["unknown_extension"],
        value: { remove_me: "old", nested: "yes" },
      },
    ],
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.outcome, "unchanged");
  assert.deepEqual(result.changedPaths, []);
  assert.equal(result.sourceHash, exactHash(before));
  assert.equal(result.previousSourceHash, exactHash(before));
  assert.deepEqual(await readFile(fixture.path), before);
  const afterMetadata = await lstat(fixture.path, { bigint: true });
  assert.equal(afterMetadata.dev, beforeMetadata.dev);
  assert.equal(afterMetadata.ino, beforeMetadata.ino);

  const invalidSource = Buffer.from(
    before.toString("utf8").replace("state: ready", "state: invalid"),
  );
  await writeFile(fixture.path, invalidSource);
  const invalidNoOp = await amendConcept(vault, {
    path: "projects/fixture/tasks/no-op.md",
    expectedSourceHash: computeConceptSourceHash(invalidSource),
    edits: [{ op: "set", path: ["title"], value: "Original title" }],
  });
  assertRejected(invalidNoOp, "CONCEPT-SCHEMA");
  assert.deepEqual(await readFile(fixture.path), invalidSource);
});

test("amend preserves CRLF envelopes, file mode, and body newline boundaries", async (t) => {
  const crlfVault = await temporaryVault(t);
  const crlfFixture = await writeCommentedTask(crlfVault.vault, "crlf.md");
  const lfSource = await readFile(crlfFixture.path, "utf8");
  const crlfSource = Buffer.from(
    lfSource.replaceAll("\n", "\r\n").replace(/\r\n$/u, ""),
  );
  await writeFile(crlfFixture.path, crlfSource, { mode: 0o640 });
  await chmod(crlfFixture.path, 0o640);
  const beforeMode = (await lstat(crlfFixture.path)).mode & 0o777;

  const crlfResult = await amendConcept(crlfVault.vault, {
    path: "projects/fixture/tasks/crlf.md",
    expectedSourceHash: computeConceptSourceHash(crlfSource),
    edits: [{ op: "set", path: ["title"], value: "CRLF title" }],
  });
  assert.equal(crlfResult.ok, true, JSON.stringify(crlfResult));
  const crlfAfter = await readFile(crlfFixture.path);
  const crlfLoaded = loadConcept(crlfAfter, { file: crlfFixture.bundlePath });
  assert.equal(crlfLoaded.ok, true, JSON.stringify(crlfLoaded.diagnostics));
  assert.equal(
    crlfLoaded.concept.bodyText,
    "\r\n# Exact body Δ\r\n\r\nDo not normalize this body.",
  );
  assert.equal(/(?<!\r)\n/u.test(crlfLoaded.concept.frontmatterText), false);
  assert.equal((await lstat(crlfFixture.path)).mode & 0o777, beforeMode);

  const emptyVault = await temporaryVault(t);
  const emptyPath = join(
    emptyVault.vault,
    "projects/fixture/tasks/empty-body.md",
  );
  const emptySource = Buffer.from(
    `---\n${JSON.stringify(taskFrontmatter(taskUidA))}\n---`,
  );
  await writeFile(emptyPath, emptySource);
  const bodyResult = await amendConcept(emptyVault.vault, {
    path: "projects/fixture/tasks/empty-body.md",
    expectedSourceHash: computeConceptSourceHash(emptySource),
    edits: [],
    bodyText: "body-without-final-newline",
  });
  assert.equal(bodyResult.ok, true, JSON.stringify(bodyResult));
  const bodyAfter = await readFile(emptyPath);
  const bodyLoaded = loadConcept(bodyAfter, { file: "/empty-body.md" });
  assert.equal(bodyLoaded.ok, true, JSON.stringify(bodyLoaded.diagnostics));
  assert.equal(bodyLoaded.concept.bodyText, "body-without-final-newline");
  assert.equal(bodyAfter.at(-1), "e".charCodeAt(0));
});

test("amend rejects malformed, ambiguous, and unsafe edits without changing bytes", async (t) => {
  const { vault } = await temporaryVault(t);
  const fixture = await writeCommentedTask(vault, "bad-edits.md");
  const before = await readFile(fixture.path);
  const expectedSourceHash = computeConceptSourceHash(before);
  const cyclic = {};
  cyclic.self = cyclic;

  const requests = [
    {
      expectedSourceHash: "bad-token",
      edits: [{ op: "set", path: ["title"], value: "x" }],
    },
    { expectedSourceHash, edits: [] },
    {
      expectedSourceHash,
      edits: [
        {
          op: "set",
          path: ["bookie"],
          value: taskFrontmatter(taskUidA).bookie,
        },
        { op: "set", path: ["bookie", "state"], value: "done" },
      ],
    },
    { expectedSourceHash, edits: [{ op: "remove", path: ["missing"] }] },
    {
      expectedSourceHash,
      edits: [{ op: "set", path: ["tags", 9], value: "x" }],
    },
    {
      expectedSourceHash,
      edits: [{ op: "set", path: ["extra"], value: cyclic }],
    },
    { expectedSourceHash, edits: [], bodyText: "bad\ud800body" },
  ];

  for (const request of requests) {
    const result = await amendConcept(vault, {
      path: "projects/fixture/tasks/bad-edits.md",
      ...request,
    });
    assertRejected(result, "MUTATION-INPUT");
    assert.deepEqual(await readFile(fixture.path), before);
  }
});

test("amend rejects changes to stable type, profile, or UID identity", async (t) => {
  const { vault } = await temporaryVault(t);
  const fixture = await writeCommentedTask(vault, "identity.md");
  const before = await readFile(fixture.path);
  const expectedSourceHash = computeConceptSourceHash(before);
  const edits = [
    { op: "set", path: ["type"], value: "Document" },
    { op: "set", path: ["bookie", "profile"], value: "2.0" },
    { op: "set", path: ["bookie", "uid"], value: taskUidB },
  ];

  for (const edit of edits) {
    const result = await amendConcept(vault, {
      path: "projects/fixture/tasks/identity.md",
      expectedSourceHash,
      edits: [edit],
    });
    assertRejected(result, "MUTATION-IDENTITY");
    assert.deepEqual(await readFile(fixture.path), before);
  }
});

test("stale and concurrent amendments conflict without losing an update", async (t) => {
  const first = await temporaryVault(t);
  const staleFixture = await writeCommentedTask(first.vault, "stale.md");
  const staleBefore = await readFile(staleFixture.path);
  const staleHash = computeConceptSourceHash(staleBefore);
  const external = Buffer.from(
    staleBefore.toString("utf8").replace("Original title", "External title"),
  );
  let queuedTarget;
  const stale = await amendConcept(
    first.vault,
    {
      path: "projects/fixture/tasks/stale.md",
      expectedSourceHash: staleHash,
      edits: [{ op: "set", path: ["title"], value: "Bookie title" }],
    },
    {
      async runExclusive(target, mutation) {
        queuedTarget = target;
        await writeFile(staleFixture.path, external);
        return mutation();
      },
    },
  );
  assert.equal(queuedTarget, staleFixture.path);
  assertRejected(stale, "MUTATION-CONFLICT");
  assert.deepEqual(await readFile(staleFixture.path), external);

  const second = await temporaryVault(t);
  const concurrentFixture = await writeCommentedTask(
    second.vault,
    "concurrent.md",
  );
  const concurrentBefore = await readFile(concurrentFixture.path);
  const request = {
    path: "projects/fixture/tasks/concurrent.md",
    expectedSourceHash: computeConceptSourceHash(concurrentBefore),
  };
  const [left, right] = await Promise.all([
    amendConcept(second.vault, {
      ...request,
      edits: [{ op: "set", path: ["title"], value: "Left title" }],
    }),
    amendConcept(second.vault, {
      ...request,
      edits: [{ op: "set", path: ["title"], value: "Right title" }],
    }),
  ]);

  const successes = [left, right].filter((result) => result.ok);
  const conflicts = [left, right].filter(
    (result) => !result.ok && result.conflict,
  );
  assert.equal(successes.length, 1, JSON.stringify([left, right]));
  assert.equal(conflicts.length, 1, JSON.stringify([left, right]));
  const stored = await readFile(concurrentFixture.path);
  const loaded = loadConcept(stored, { file: concurrentFixture.bundlePath });
  assert.equal(loaded.ok, true);
  assert.ok(
    ["Left title", "Right title"].includes(loaded.concept.frontmatter.title),
  );
  assert.equal(successes[0].sourceHash, computeConceptSourceHash(stored));
});

test("a source change after temporary staging conflicts before publication", async (t) => {
  const { vault } = await temporaryVault(t);
  const fixture = await writeCommentedTask(vault, "late-conflict.md");
  const before = await readFile(fixture.path);
  const external = Buffer.from(
    before.toString("utf8").replace("Original title", "External late title"),
  );
  const directory = dirname(fixture.path);
  const staged = nextMutationTemporary(directory);

  const mutation = amendConcept(vault, {
    path: "projects/fixture/tasks/late-conflict.md",
    expectedSourceHash: computeConceptSourceHash(before),
    edits: [{ op: "set", path: ["title"], value: "Bookie late title" }],
    bodyText: `\n${"x".repeat(900_000)}`,
  });
  await staged;
  await writeFile(fixture.path, external);
  const result = await mutation;

  assertRejected(result, "MUTATION-CONFLICT");
  assert.deepEqual(await readFile(fixture.path), external);
  assert.equal(
    (await readdir(directory)).some((name) => name.includes(".bookie-")),
    false,
  );
});

test("target removal after staging is an observable conflict", async (t) => {
  const { vault } = await temporaryVault(t);
  const fixture = await writeCommentedTask(vault, "late-removal.md");
  const before = await readFile(fixture.path);
  const directory = dirname(fixture.path);
  const staged = nextMutationTemporary(directory);

  const mutation = amendConcept(vault, {
    path: "projects/fixture/tasks/late-removal.md",
    expectedSourceHash: computeConceptSourceHash(before),
    edits: [{ op: "set", path: ["title"], value: "Never published" }],
    bodyText: `\n${"x".repeat(900_000)}`,
  });
  await staged;
  await unlink(fixture.path);
  const result = await mutation;

  assertRejected(result, "MUTATION-CONFLICT");
  await assert.rejects(readFile(fixture.path), { code: "ENOENT" });
  assert.equal(
    (await readdir(directory)).some((name) => name.includes(".bookie-")),
    false,
  );
});

test("an ancestor swap after staging fails without deleting or publishing outside the vault", async (t) => {
  const { parent, vault } = await temporaryVault(t);
  const directory = join(vault, "projects/fixture/tasks");
  const movedDirectory = join(vault, "projects/fixture/tasks-original");
  const outsideDirectory = join(parent, "outside-parent");
  const staged = nextMutationTemporary(directory);

  const mutation = createConcept(vault, {
    path: "projects/fixture/tasks/ancestor-swap.md",
    frontmatter: taskFrontmatter(taskUidA),
    bodyText: `\n${"x".repeat(900_000)}`,
  });
  const temporaryName = await staged;
  await rename(directory, movedDirectory);
  await mkdir(outsideDirectory);
  const outsideTemporary = join(outsideDirectory, temporaryName);
  const marker = Buffer.from("outside marker must survive");
  await writeFile(outsideTemporary, marker);
  await symlink(outsideDirectory, directory);
  const result = await mutation;

  assertRejected(result, "MUTATION-IO");
  assert.deepEqual(await readFile(outsideTemporary), marker);
  await assert.rejects(readFile(join(outsideDirectory, "ancestor-swap.md")), {
    code: "ENOENT",
  });
  assert.equal(
    (await readdir(movedDirectory)).some((name) => name.includes(".bookie-")),
    true,
  );
});

test("amend rejects missing, symlink, and multiply linked targets without touching outside bytes", async (t) => {
  const missingVault = await temporaryVault(t);
  const missingResult = await amendConcept(missingVault.vault, {
    path: "projects/fixture/tasks/missing.md",
    expectedSourceHash: computeConceptSourceHash(Buffer.from("missing")),
    edits: [{ op: "set", path: ["title"], value: "changed" }],
  });
  assertRejected(missingResult, "MUTATION-TARGET");

  const symlinkVault = await temporaryVault(t);
  const symlinkOutside = join(symlinkVault.parent, "outside-symlink.md");
  const outsideSource = Buffer.from(
    `---\n${JSON.stringify(taskFrontmatter(taskUidB))}\n---\noutside`,
  );
  await writeFile(symlinkOutside, outsideSource);
  const symlinkTarget = join(
    symlinkVault.vault,
    "projects/fixture/tasks/symlink.md",
  );
  await symlink(symlinkOutside, symlinkTarget);
  const symlinkResult = await amendConcept(symlinkVault.vault, {
    path: "projects/fixture/tasks/symlink.md",
    expectedSourceHash: computeConceptSourceHash(outsideSource),
    edits: [{ op: "set", path: ["title"], value: "changed" }],
  });
  assertRejected(symlinkResult, "MUTATION-TARGET");
  assert.deepEqual(await readFile(symlinkOutside), outsideSource);

  const hardlinkVault = await temporaryVault(t);
  const hardlinkFixture = await writeCommentedTask(
    hardlinkVault.vault,
    "hardlink.md",
  );
  const alias = join(hardlinkVault.parent, "outside-hardlink.md");
  await link(hardlinkFixture.path, alias);
  const hardlinkBefore = await readFile(alias);
  const hardlinkResult = await amendConcept(hardlinkVault.vault, {
    path: "projects/fixture/tasks/hardlink.md",
    expectedSourceHash: computeConceptSourceHash(hardlinkBefore),
    edits: [{ op: "set", path: ["title"], value: "changed" }],
  });
  assertRejected(hardlinkResult, "MUTATION-TARGET");
  assert.deepEqual(await readFile(alias), hardlinkBefore);
});

test("mutation content and option bounds fail without writing", async (t) => {
  const { vault } = await temporaryVault(t);
  const cyclic = taskFrontmatter(taskUidA);
  cyclic.extra = cyclic;
  const cyclicTarget = join(vault, "projects/fixture/tasks/cyclic.md");
  const cyclicResult = await createConcept(vault, {
    path: "projects/fixture/tasks/cyclic.md",
    frontmatter: cyclic,
    bodyText: "",
  });
  assertRejected(cyclicResult, "MUTATION-INPUT");
  await assert.rejects(readFile(cyclicTarget), { code: "ENOENT" });

  const bodyTarget = join(vault, "projects/fixture/tasks/oversized.md");
  const bodyResult = await createConcept(
    vault,
    {
      path: "projects/fixture/tasks/oversized.md",
      frontmatter: taskFrontmatter(taskUidB),
      bodyText: "x".repeat(2_000),
    },
    { maxConceptBytes: 1_024 },
  );
  assertRejected(bodyResult, "MUTATION-BOUNDS");
  await assert.rejects(readFile(bodyTarget), { code: "ENOENT" });

  const fixture = await writeCommentedTask(vault, "aggregate-bounds.md");
  const before = await readFile(fixture.path);
  const aggregateResult = await amendConcept(vault, {
    path: "projects/fixture/tasks/aggregate-bounds.md",
    expectedSourceHash: computeConceptSourceHash(before),
    edits: [
      { op: "set", path: ["large_one"], value: "x".repeat(600_000) },
      { op: "set", path: ["large_two"], value: "y".repeat(600_000) },
    ],
  });
  assertRejected(aggregateResult, "MUTATION-BOUNDS");
  assert.deepEqual(await readFile(fixture.path), before);

  const editPathResult = await amendConcept(vault, {
    path: "projects/fixture/tasks/aggregate-bounds.md",
    expectedSourceHash: computeConceptSourceHash(before),
    edits: [
      {
        op: "set",
        path: ["x".repeat(1_048_576)],
        value: "bounded",
      },
    ],
  });
  assertRejected(editPathResult, "MUTATION-BOUNDS");
  assert.deepEqual(await readFile(fixture.path), before);

  await assert.rejects(
    createConcept(
      vault,
      {
        path: "projects/fixture/tasks/bad-limit.md",
        frontmatter: taskFrontmatter(taskUidC),
        bodyText: "",
      },
      { maxConceptBytes: 0 },
    ),
    TypeError,
  );
});

test("pre-publication cancellation and staging failure leave no target", async (t) => {
  const cancelledVault = await temporaryVault(t);
  const cancelledTarget = join(
    cancelledVault.vault,
    "projects/fixture/tasks/cancelled.md",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createConcept(
      cancelledVault.vault,
      {
        path: "projects/fixture/tasks/cancelled.md",
        frontmatter: taskFrontmatter(taskUidA),
        bodyText: "",
      },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  await assert.rejects(readFile(cancelledTarget), { code: "ENOENT" });

  const stagedVault = await temporaryVault(t);
  const stagedDirectory = join(stagedVault.vault, "projects/fixture/tasks");
  const stagedTarget = join(stagedDirectory, "cancelled-after-stage.md");
  const stagedController = new AbortController();
  const staged = nextMutationTemporary(stagedDirectory);
  const stagedMutation = createConcept(
    stagedVault.vault,
    {
      path: "projects/fixture/tasks/cancelled-after-stage.md",
      frontmatter: taskFrontmatter(taskUidB),
      bodyText: `\n${"x".repeat(900_000)}`,
    },
    { signal: stagedController.signal },
  );
  await staged;
  stagedController.abort();
  await assert.rejects(stagedMutation, { name: "AbortError" });
  await assert.rejects(readFile(stagedTarget), { code: "ENOENT" });
  assert.equal(
    (await readdir(stagedDirectory)).some((name) => name.includes(".bookie-")),
    false,
  );

  const failedVault = await temporaryVault(t);
  const directory = join(failedVault.vault, "projects/fixture/tasks");
  const failedTarget = join(directory, "io-failure.md");
  await chmod(directory, 0o500);
  let failed;
  try {
    failed = await createConcept(failedVault.vault, {
      path: "projects/fixture/tasks/io-failure.md",
      frontmatter: taskFrontmatter(taskUidC),
      bodyText: "",
    });
  } finally {
    await chmod(directory, 0o700);
  }
  assertRejected(failed, "MUTATION-IO");
  await assert.rejects(readFile(failedTarget), { code: "ENOENT" });
});
