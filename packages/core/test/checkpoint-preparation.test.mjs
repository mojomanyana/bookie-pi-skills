import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, watch, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  MAX_CHECKPOINT_PREVIEW_BYTES,
  amendConceptWithPolicy,
  createCheckpointWithPolicy,
  createConceptWithPolicy,
  prepareCheckpoint,
} from "../dist/index.js";
import { getSchemaValidators } from "../dist/vault-manifest.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixture = resolve(repositoryRoot, "fixtures/valid-vault");
const sections = [
  "outcome",
  "changed-artifacts",
  "decisions",
  "evidence",
  "validation",
  "unresolved-work",
  "next-action",
];

async function temporaryVault(t) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-checkpoint-"));
  const vault = join(parent, "vault");
  await cp(fixture, vault, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return vault;
}

function request(overrides = {}) {
  return {
    path: "projects/fixture/activities/prepared.md",
    frontmatter: {
      type: "Activity",
      title: "Prepared checkpoint",
      status: "stable",
      generated: { by: "human:test", at: "2026-09-14T12:00:00Z" },
      bookie: {
        profile: "1.0",
        uid: "ACT-00000000000000000000000150",
        project: "/projects/fixture/project.md",
        occurred_at: "2026-09-14T12:00:00Z",
        sensitivity: "public",
      },
    },
    fragments: sections.map((section) => ({
      section,
      sensitivity: "public",
      text: `Included ${section}.`,
    })),
    ...overrides,
  };
}

async function excludeRestricted(vault) {
  const path = join(vault, "bookie.yaml");
  await writeFile(
    path,
    (await readFile(path, "utf8"))
      .replace("      - public\n", "      - public\n      - restricted\n")
      .replace(
        "    excluded_classes: []",
        "    excluded_classes:\n      - restricted",
      ),
  );
}

test("checkpoint preparation retains included fragments and omits excluded fragments", async (t) => {
  const vault = await temporaryVault(t);
  await excludeRestricted(vault);
  const excludedUid = "TSK-00000000000000000000000999";
  const excludedPath = "/projects/private/hidden.md";
  const excludedMarker = "DO-NOT-CHECKPOINT-ME";
  const prepared = await prepareCheckpoint(
    vault,
    request({
      fragments: [
        ...request().fragments.filter(({ section }) => section !== "evidence"),
        {
          section: "evidence",
          sensitivity: "restricted",
          text: `${excludedUid} ${excludedPath} ${excludedMarker}`,
        },
      ],
    }),
  );

  assert.equal(prepared.ok, true);
  assert.equal(prepared.preview.includedFragments, 6);
  assert.equal("omittedFragments" in prepared.preview, false);
  assert.match(prepared.preview.bodyText, /Included outcome\./u);
  assert.equal(prepared.preview.bodyText.includes(excludedUid), false);
  assert.equal(prepared.preview.bodyText.includes(excludedPath), false);
  assert.equal(prepared.preview.bodyText.includes(excludedMarker), false);
  assert.equal("request" in prepared, false);
  assert.equal(prepared.preparedInput.path, request().path);
  assert.equal(prepared.preparedInput.fragments.length, 7);
  assert.equal(
    JSON.stringify(prepared.preparedInput).includes(excludedMarker),
    false,
  );
  const reprepared = await prepareCheckpoint(vault, prepared.preparedInput);
  assert.equal(reprepared.ok, true);
  assert.equal(reprepared.preview.bodyText, prepared.preview.bodyText);
  const created = await createCheckpointWithPolicy(reprepared.publication);
  assert.equal(created.ok, true);
  const activity = await readFile(join(vault, request().path), "utf8");
  assert.equal(created.redacted, undefined);
  assert.equal(
    created.sourceHash,
    `sha256:${createHash("sha256").update(activity).digest("hex")}`,
  );
  assert.equal(activity.includes(excludedMarker), false);
});

test("ordinary policy writes cannot bypass checkpoint preparation for Activities", async (t) => {
  const vault = await temporaryVault(t);
  const activityRequest = request();
  const created = await createConceptWithPolicy(vault, {
    path: activityRequest.path,
    frontmatter: activityRequest.frontmatter,
    bodyText: "Unclassified Activity body.\n",
  });
  assert.equal(created.ok, false);
  assert.equal(created.diagnostics[0]?.code, "MUTATION-INPUT");
  await assert.rejects(readFile(join(vault, activityRequest.path)), {
    code: "ENOENT",
  });

  const existingPath = "projects/fixture/activities/checkpoint.md";
  const existing = await readFile(join(vault, existingPath));
  const amended = await amendConceptWithPolicy(vault, {
    path: existingPath,
    expectedSourceHash: `sha256:${createHash("sha256").update(existing).digest("hex")}`,
    edits: [{ op: "set", path: ["title"], value: "Bypassed amendment" }],
  });
  assert.equal(amended.ok, false);
  assert.equal(amended.diagnostics[0]?.code, "MUTATION-INPUT");
  assert.deepEqual(await readFile(join(vault, existingPath)), existing);
});

test("checkpoint publication is opaque and detached from public prepared input", async (t) => {
  assert.throws(
    () => createCheckpointWithPolicy({}),
    /opaque value returned by prepareCheckpoint/u,
  );

  const vault = await temporaryVault(t);
  const prepared = await prepareCheckpoint(vault, request());
  assert.equal(prepared.ok, true);
  prepared.preparedInput.frontmatter.title = "MUTATED TITLE";
  prepared.preparedInput.frontmatter.bookie.sensitivity = "restricted";
  prepared.preparedInput.fragments[0].text = "MUTATED BODY";
  const created = await createCheckpointWithPolicy(prepared.publication);
  assert.equal(created.ok, true);
  const activity = await readFile(join(vault, request().path), "utf8");
  assert.match(activity, /title: Prepared checkpoint/u);
  assert.match(activity, /sensitivity: public/u);
  assert.match(activity, /Included outcome\./u);
  assert.equal(activity.includes("MUTATED"), false);
});

test("checkpoint publication rejects a manifest-policy change after temporary staging", async (t) => {
  const vault = await temporaryVault(t);
  const prepared = await prepareCheckpoint(vault, request());
  assert.equal(prepared.ok, true);
  const activityParent = join(vault, "projects/fixture/activities");
  const manifestPath = join(vault, "bookie.yaml");
  let changed = false;
  const watcher = watch(activityParent, (_event, filename) => {
    if (
      changed ||
      !filename?.startsWith(".bookie-") ||
      !filename.endsWith(".tmp")
    ) {
      return;
    }
    changed = true;
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, "utf8").replace(
        "    - exports/**",
        "    - exports/**\n    - projects/fixture/activities/**",
      ),
    );
  });
  t.after(() => watcher.close());

  const result = await createCheckpointWithPolicy(prepared.publication, {
    runExclusive: async (_target, mutation) => mutation(),
  });
  watcher.close();
  assert.equal(changed, true);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, "MUTATION-CONFLICT");
  await assert.rejects(readFile(join(vault, request().path)), {
    code: "ENOENT",
  });
});

test("checkpoint preparation fails closed for secrets and sensitivity ambiguity", async (t) => {
  const vault = await temporaryVault(t);
  const secret = request({
    fragments: request().fragments.map((fragment, index) =>
      index === 0
        ? {
            ...fragment,
            text: ["password", "do-not-store-this-value"].join("="),
          }
        : fragment,
    ),
  });
  assert.deepEqual(await prepareCheckpoint(vault, secret), {
    ok: false,
    reason: "secret-policy",
  });

  const undeclared = request({
    fragments: request().fragments.map((fragment, index) =>
      index === 0 ? { ...fragment, sensitivity: "unknown" } : fragment,
    ),
  });
  assert.deepEqual(await prepareCheckpoint(vault, undeclared), {
    ok: false,
    reason: "sensitivity-policy",
  });

  await excludeRestricted(vault);
  const excludedActivity = request();
  excludedActivity.frontmatter.bookie.sensitivity = "restricted";
  assert.deepEqual(await prepareCheckpoint(vault, excludedActivity), {
    ok: false,
    reason: "sensitivity-policy",
  });
});

test("checkpoint preparation enforces required sections, bounds, and cancellation", async (t) => {
  const vault = await temporaryVault(t);
  assert.deepEqual(
    await prepareCheckpoint(
      vault,
      request({ fragments: request().fragments.slice(1) }),
    ),
    { ok: false, reason: "input" },
  );
  const incompleteMetadata = request();
  delete incompleteMetadata.frontmatter.generated;
  assert.deepEqual(await prepareCheckpoint(vault, incompleteMetadata), {
    ok: false,
    reason: "input",
  });
  assert.deepEqual(
    await prepareCheckpoint(
      vault,
      request({
        fragments: Array.from({ length: 129 }, (_, index) => ({
          section: sections[index % sections.length],
          sensitivity: "public",
          text: `Fragment ${index}`,
        })),
      }),
    ),
    { ok: false, reason: "bounds" },
  );
  const base = await prepareCheckpoint(vault, request());
  assert.equal(base.ok, true);
  const originalOutcome = request().fragments[0].text;
  const exactText = "x".repeat(
    MAX_CHECKPOINT_PREVIEW_BYTES -
      Buffer.byteLength(base.preview.bodyText) +
      Buffer.byteLength(originalOutcome),
  );
  const exact = request();
  exact.fragments[0].text = exactText;
  const exactResult = await prepareCheckpoint(vault, exact);
  assert.equal(exactResult.ok, true);
  assert.equal(
    Buffer.byteLength(exactResult.preview.bodyText),
    MAX_CHECKPOINT_PREVIEW_BYTES,
  );
  const over = request();
  over.fragments[0].text = `${exactText}x`;
  assert.deepEqual(await prepareCheckpoint(vault, over), {
    ok: false,
    reason: "bounds",
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    prepareCheckpoint(vault, request(), { signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
});

test("checkpoint relations preserve distinct objects and reject duplicate values", async (t) => {
  const vault = await temporaryVault(t);
  const input = request();
  const relations = [
    { kind: "part_of", target: "/projects/fixture/project.md" },
    { kind: "depends_on", target: "/projects/fixture/tasks/task.md" },
  ];
  input.frontmatter.bookie.relations = relations;
  const prepared = await prepareCheckpoint(vault, input);
  assert.equal(prepared.ok, true);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(prepared.preparedInput.frontmatter.bookie.relations),
    ),
    relations,
  );
  assert.equal(
    (await prepareCheckpoint(vault, prepared.preparedInput)).ok,
    true,
  );
  await assert.rejects(readFile(join(vault, input.path)), { code: "ENOENT" });

  input.frontmatter.bookie.relations = [relations[0], { ...relations[0] }];
  assert.deepEqual(await prepareCheckpoint(vault, input), {
    ok: false,
    reason: "input",
  });
  const validate = (await getSchemaValidators()).byType.get("Activity");
  assert.equal(validate(input.frontmatter), false);
  const error = validate.errors.find(
    ({ keyword }) => keyword === "uniqueItems",
  );
  assert.equal(error.instancePath, "/bookie/relations");
  assert.deepEqual(error.params, { i: 1, j: 0 });
  assert.equal(
    error.message,
    "must NOT have duplicate items (items ## 0 and 1 are identical)",
  );
  assert.ok(error.schemaPath.endsWith("/properties/relations/uniqueItems"));
  await assert.rejects(readFile(join(vault, input.path)), { code: "ENOENT" });
});

test("checkpoint relation equality treats prototype-named properties as JSON data", async (t) => {
  const vault = await temporaryVault(t);
  for (const key of ["valueOf", "toString", "constructor", "__proto__"]) {
    const input = request();
    const first = {
      kind: "part_of",
      target: "/projects/fixture/project.md",
      [key]: { marker: "first", sequence: [1, 2] },
    };
    const second = {
      [key]: { sequence: [2, 1], marker: "first" },
      target: first.target,
      kind: first.kind,
    };
    input.frontmatter.bookie.relations = [first, second];
    const before = JSON.stringify(input);
    const prepared = await prepareCheckpoint(vault, input);
    assert.equal(prepared.ok, true, key);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(prepared.preparedInput.frontmatter.bookie.relations),
      ),
      [first, second],
    );
    assert.equal(
      (await prepareCheckpoint(vault, prepared.preparedInput)).ok,
      true,
    );
    second[key].sequence = [1, 2];
    assert.deepEqual(await prepareCheckpoint(vault, input), {
      ok: false,
      reason: "input",
    });
    second[key].sequence = [2, 1];
    assert.equal(JSON.stringify(input), before);
    assert.equal(Object.getPrototypeOf(first), Object.prototype);
    assert.equal(Object.hasOwn(Object.prototype, "marker"), false);
  }
  const input = request();
  input.frontmatter.bookie.relations = [0, -0].map((value) => ({
    kind: "part_of",
    target: "/projects/fixture/project.md",
    valueOf: { value },
  }));
  assert.deepEqual(await prepareCheckpoint(vault, input), {
    ok: false,
    reason: "input",
  });
  assert.equal(
    Object.is(input.frontmatter.bookie.relations[1].valueOf.value, -0),
    true,
  );
  await assert.rejects(readFile(join(vault, input.path)), { code: "ENOENT" });
});
