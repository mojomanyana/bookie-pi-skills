import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadConcept, serializeConcept, validateVault } from "../dist/index.js";
import { DiagnosticCollector } from "../dist/vault-diagnostics.js";
import {
  createPathTracker,
  hashSafeBoundedFile,
} from "../dist/vault-filesystem.js";
import { validateMarkdownLinks } from "../dist/vault-markdown.js";
import { validateCurrentTree } from "../dist/vault-policy.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const validVault = resolve(repositoryRoot, "fixtures/valid-vault");

async function temporaryVault(t) {
  const parent = await mkdtemp(join(tmpdir(), "bookie-review-regression-"));
  const vault = join(parent, "vault");
  await cp(validVault, vault, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return vault;
}

async function rewriteFlowConcept(path, mutate, body) {
  const loaded = loadConcept(await readFile(path), { file: path });
  assert.equal(loaded.ok, true);
  const frontmatter = structuredClone(loaded.concept.frontmatter);
  mutate(frontmatter);
  const serialized = Buffer.from(serializeConcept(loaded.concept)).toString(
    "utf8",
  );
  const closing = serialized.indexOf("\n---", 4);
  assert.notEqual(closing, -1);
  const originalBody = serialized.slice(closing + 4);
  await writeFile(
    path,
    `---\n${JSON.stringify(frontmatter)}\n---${body ?? originalBody}`,
  );
}

function codes(result) {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

async function markdownBytesBelow(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await markdownBytesBelow(child);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      total += (await readFile(child)).byteLength;
    }
  }
  return total;
}

test("manifest parsing consumes exactly one direct YAML document", async (t) => {
  const leadingMarkerVault = await temporaryVault(t);
  const leadingManifest = join(leadingMarkerVault, "bookie.yaml");
  await writeFile(
    leadingManifest,
    `---\n${await readFile(leadingManifest, "utf8")}`,
  );
  assert.equal((await validateVault(leadingMarkerVault)).valid, true);

  const trailingDocumentVault = await temporaryVault(t);
  const trailingManifest = join(trailingDocumentVault, "bookie.yaml");
  await writeFile(
    trailingManifest,
    `${await readFile(trailingManifest, "utf8")}---\nignored: true\n`,
  );
  const trailing = await validateVault(trailingDocumentVault);
  assert.equal(trailing.complete, false);
  assert.ok(codes(trailing).includes("MANIFEST-SYNTAX"));
});

test("manifest numeric text cannot round into a schema-valid safe integer", async (t) => {
  const vault = await temporaryVault(t);
  const manifestPath = join(vault, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "attachment_max_bytes: 1024",
      "attachment_max_bytes: 9007199254740990.9",
    ),
  );
  const result = await validateVault(vault);
  assert.equal(result.complete, false);
  assert.ok(codes(result).includes("MANIFEST-SYNTAX"));
});

test("a vault requires valid OKF 0.2 bundle metadata", async (t) => {
  const missingVault = await temporaryVault(t);
  await unlink(join(missingVault, "index.md"));
  const missing = await validateVault(missingVault);
  assert.equal(missing.valid, false);
  assert.ok(codes(missing).includes("CONCEPT-SCHEMA"));

  const plainVault = await temporaryVault(t);
  await writeFile(join(plainVault, "index.md"), "# Not bundle metadata\n");
  const plain = await validateVault(plainVault);
  assert.equal(plain.valid, false);
  assert.ok(codes(plain).includes("FRONTMATTER-OPEN"));

  const wrongVersionVault = await temporaryVault(t);
  const indexPath = join(wrongVersionVault, "index.md");
  await writeFile(
    indexPath,
    (await readFile(indexPath, "utf8")).replace(
      'okf_version: "0.2"',
      'okf_version: "0.1"',
    ),
  );
  const wrong = await validateVault(wrongVersionVault);
  assert.ok(
    wrong.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "CONCEPT-SCHEMA" &&
        diagnostic.file === "/index.md" &&
        diagnostic.instancePath === "/okf_version",
    ),
  );
});

test("malformed Evidence cannot classify Markdown as resource bytes", async (t) => {
  const vault = await temporaryVault(t);
  const evidencePath = join(vault, "projects/fixture/evidence/evidence.md");
  const hiddenPath = join(vault, "references/files/hidden.md");
  await writeFile(hiddenPath, "# Missing frontmatter\n");
  await rewriteFlowConcept(evidencePath, (frontmatter) => {
    delete frontmatter.title;
    frontmatter.resource = "/references/files/hidden.md";
  });

  const result = await validateVault(vault);
  assert.ok(codes(result).includes("CONCEPT-SCHEMA"));
  assert.ok(codes(result).includes("FRONTMATTER-OPEN"));
});

test("schema-valid exclusion patterns cannot exhaust the call stack", async (t) => {
  const vault = await temporaryVault(t);
  const manifestPath = join(vault, "bookie.yaml");
  const pattern = [
    ...Array.from({ length: 8_000 }, () => "**"),
    "never-match",
  ].join("/");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "    - exports/**",
      `    - "${pattern}"`,
    ),
  );
  const result = await validateVault(vault);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
});

test("exclude globs are anchored and segment-aware", async (t) => {
  const vault = await temporaryVault(t);
  const manifestPath = join(vault, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8")).replace(
      "    - exports/**",
      "    - scratch/*",
    ),
  );
  await mkdir(join(vault, "scratch"));
  await writeFile(join(vault, "scratch/ignored.md"), "not frontmatter\n");
  const excluded = await validateVault(vault);
  assert.equal(excluded.valid, true, JSON.stringify(excluded.diagnostics));

  await mkdir(join(vault, "nested/scratch"), { recursive: true });
  await writeFile(
    join(vault, "nested/scratch/not-anchored.md"),
    "not frontmatter\n",
  );
  const anchored = await validateVault(vault);
  assert.ok(codes(anchored).includes("FRONTMATTER-OPEN"));

  const boundedVault = await temporaryVault(t);
  const boundedManifest = join(boundedVault, "bookie.yaml");
  await writeFile(
    boundedManifest,
    (await readFile(boundedManifest, "utf8")).replace(
      "    - exports/**",
      "    - ignored/*",
    ),
  );
  await mkdir(join(boundedVault, "ignored"));
  for (let index = 0; index < 101; index += 1) {
    await writeFile(join(boundedVault, "ignored", `${index}.txt`), "ignored");
  }
  const bounded = await validateVault(boundedVault, { maxEntries: 100 });
  assert.equal(bounded.complete, false);
  assert.ok(codes(bounded).includes("VAULT-BOUNDS"));

  const segmentVault = await temporaryVault(t);
  const segmentManifest = join(segmentVault, "bookie.yaml");
  const baseManifest = await readFile(segmentManifest, "utf8");
  await writeFile(
    segmentManifest,
    baseManifest.replace("    - exports/**", "    - scratch/*/target.md"),
  );
  await mkdir(join(segmentVault, "scratch/one/deeper"), { recursive: true });
  await writeFile(
    join(segmentVault, "scratch/one/target.md"),
    "not frontmatter\n",
  );
  await writeFile(
    join(segmentVault, "scratch/one/deeper/target.md"),
    "not frontmatter\n",
  );
  const oneSegment = await validateVault(segmentVault);
  assert.ok(codes(oneSegment).includes("FRONTMATTER-OPEN"));
  await writeFile(
    segmentManifest,
    baseManifest.replace("    - exports/**", "    - scratch/**/target.md"),
  );
  const recursive = await validateVault(segmentVault);
  assert.equal(recursive.valid, true, JSON.stringify(recursive.diagnostics));
});

test("multiply linked vault files cannot alias an outside inode", async (t) => {
  const vault = await temporaryVault(t);
  const resource = join(vault, "references/files/source.bin");
  const outside = join(dirname(vault), "outside-hardlink.bin");
  await writeFile(outside, await readFile(resource));
  await unlink(resource);
  await link(outside, resource);
  const result = await validateVault(vault);
  assert.ok(codes(result).includes("EVIDENCE-RESOURCE"));
  assert.equal(result.complete, true);

  const unconsumedVault = await temporaryVault(t);
  const unconsumedOutside = join(dirname(unconsumedVault), "outside-alias.bin");
  await writeFile(unconsumedOutside, "outside alias");
  await link(
    unconsumedOutside,
    join(unconsumedVault, "references/files/alias.bin"),
  );
  const indexPath = join(unconsumedVault, "index.md");
  await writeFile(
    indexPath,
    `${await readFile(indexPath, "utf8")}\n[alias](references/files/alias.bin)\n`,
  );
  const unconsumed = await validateVault(unconsumedVault);
  assert.ok(codes(unconsumed).includes("VAULT-IO"));
  assert.equal(unconsumed.complete, true);
});

test("excluded field and body paths redact unsafe ancestor diagnostics", async (t) => {
  const vault = await temporaryVault(t);
  const manifestPath = join(vault, "bookie.yaml");
  await writeFile(
    manifestPath,
    (await readFile(manifestPath, "utf8"))
      .replace("      - public\n", "      - public\n      - restricted\n")
      .replace(
        "    excluded_classes: []",
        "    excluded_classes:\n      - restricted",
      ),
  );

  const evidencePath = join(vault, "projects/fixture/evidence/evidence.md");
  await rewriteFlowConcept(
    evidencePath,
    (frontmatter) => {
      frontmatter.resource =
        "/references/files/TOP-SECRET-RESOURCE-DIR/source.bin";
      frontmatter.sources = [{ resource: "/TOP-SECRET-SOURCE-DIR/source.txt" }];
      frontmatter.bookie.sensitivity = "restricted";
      frontmatter.bookie.project =
        "/projects/fixture/TOP-SECRET-PROJECT-DIR/project.md";
      frontmatter.bookie.supports = [
        "/projects/fixture/TOP-SECRET-SUPPORT-DIR/target.md",
      ];
      frontmatter.bookie.relations = [
        {
          kind: "relates_to",
          target: "/projects/fixture/TOP-SECRET-RELATION-DIR/target.md",
        },
        {
          kind: "relates_to",
          target:
            "/projects/fixture/placeholder/../TOP-SECRET-TRAVERSAL-DIR/target.md",
        },
      ];
    },
    "\n[secret link](/TOP-SECRET-LINK-DIR/target.md)\n",
  );

  const outside = join(dirname(vault), "outside");
  await mkdir(outside);
  await symlink(
    outside,
    join(vault, "references/files/TOP-SECRET-RESOURCE-DIR"),
    "dir",
  );
  for (const relativePath of [
    "projects/fixture/TOP-SECRET-RELATION-DIR",
    "projects/fixture/TOP-SECRET-TRAVERSAL-DIR",
    "projects/fixture/TOP-SECRET-PROJECT-DIR",
    "projects/fixture/TOP-SECRET-SUPPORT-DIR",
    "TOP-SECRET-SOURCE-DIR",
    "TOP-SECRET-LINK-DIR",
  ]) {
    await symlink(outside, join(vault, relativePath), "dir");
  }

  const result = await validateVault(vault);
  const serialized = JSON.stringify(result.diagnostics);
  for (const marker of [
    "TOP-SECRET-RESOURCE-DIR",
    "TOP-SECRET-RELATION-DIR",
    "TOP-SECRET-TRAVERSAL-DIR",
    "TOP-SECRET-PROJECT-DIR",
    "TOP-SECRET-SUPPORT-DIR",
    "TOP-SECRET-SOURCE-DIR",
    "TOP-SECRET-LINK-DIR",
  ]) {
    assert.equal(serialized.includes(marker), false, marker);
  }
  assert.ok(
    result.diagnostics.some((diagnostic) => diagnostic.file === "<excluded>"),
  );
});

test("unrelated schema errors do not suppress trustworthy policy facts", async (t) => {
  const vault = await temporaryVault(t);
  const taskPath = join(vault, "projects/fixture/tasks/task.md");
  await rewriteFlowConcept(taskPath, (frontmatter) => {
    delete frontmatter.title;
    frontmatter.bookie.relations = [
      { kind: "relates_to", target: "/projects/fixture/missing.md" },
    ];
  });
  const result = await validateVault(vault);
  assert.ok(codes(result).includes("CONCEPT-SCHEMA"));
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "RELATION-TARGET" &&
        diagnostic.file === "/projects/fixture/tasks/task.md",
    ),
  );

  const missingUidVault = await temporaryVault(t);
  const missingUidTask = join(
    missingUidVault,
    "projects/fixture/tasks/task.md",
  );
  await rewriteFlowConcept(missingUidTask, (frontmatter) => {
    delete frontmatter.bookie.uid;
    frontmatter.bookie.relations = [
      { kind: "depends_on", target: "/projects/fixture/missing-uid.md" },
    ];
  });
  const missingUid = await validateVault(missingUidVault);
  assert.ok(
    missingUid.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "RELATION-TARGET" &&
        diagnostic.file === "/projects/fixture/tasks/task.md",
    ),
  );
});

test("cached UID errors do not suppress source Decision lifecycle diagnostics", async (t) => {
  const vault = await temporaryVault(t);
  const replacementPath = join(vault, "projects/fixture/decisions/decision.md");
  const predecessorPath = join(
    vault,
    "projects/fixture/decisions/predecessor.md",
  );
  const loaded = loadConcept(await readFile(replacementPath), {
    file: replacementPath,
  });
  assert.equal(loaded.ok, true);
  const predecessor = structuredClone(loaded.concept.frontmatter);
  predecessor.title = "Predecessor";
  predecessor.status = "deprecated";
  predecessor.bookie.uid = "DSN-00000000000000000000000008";
  predecessor.bookie.state = "superseded";
  predecessor.bookie.relations = [
    {
      kind: "superseded_by",
      target: "/projects/fixture/decisions/decision.md",
    },
  ];
  await writeFile(
    predecessorPath,
    `---\n${JSON.stringify(predecessor)}\n---\n`,
  );
  await rewriteFlowConcept(replacementPath, (frontmatter) => {
    frontmatter.status = "draft";
    frontmatter.bookie.relations = [
      {
        kind: "supersedes",
        target: "/projects/fixture/decisions/predecessor.md",
        target_uid: "DSN-00000000000000000000000009",
      },
    ];
  });

  const result = await validateVault(vault);
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "RELATION-TARGET" &&
        diagnostic.file === "/projects/fixture/decisions/decision.md",
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "DECISION-SUPERSESSION" &&
        diagnostic.file === "/projects/fixture/decisions/decision.md",
    ),
  );
});

test("self-supersession and Decision cycles fail production policy", async (t) => {
  for (const [type, relativePath] of [
    ["Activity", "projects/fixture/activities/checkpoint.md"],
    ["Evidence", "projects/fixture/evidence/evidence.md"],
  ]) {
    await t.test(`${type} self-supersession`, async (t) => {
      const vault = await temporaryVault(t);
      const path = join(vault, relativePath);
      await rewriteFlowConcept(path, (frontmatter) => {
        frontmatter.bookie.relations = [
          {
            kind: "supersedes",
            target: `/${relativePath}`,
          },
        ];
      });
      const result = await validateVault(vault);
      assert.ok(codes(result).includes("RELATION-TARGET"));
    });
  }

  const cycleVault = await temporaryVault(t);
  const firstPath = join(cycleVault, "projects/fixture/decisions/decision.md");
  const secondPath = join(cycleVault, "projects/fixture/decisions/second.md");
  const loaded = loadConcept(await readFile(firstPath), { file: firstPath });
  assert.equal(loaded.ok, true);
  const second = structuredClone(loaded.concept.frontmatter);
  second.title = "Second cyclic Decision";
  second.bookie.uid = "DSN-00000000000000000000000008";
  second.bookie.relations = [
    {
      kind: "supersedes",
      target: "/projects/fixture/decisions/decision.md",
    },
  ];
  await writeFile(secondPath, `---\n${JSON.stringify(second)}\n---\n`);
  await rewriteFlowConcept(firstPath, (frontmatter) => {
    frontmatter.bookie.relations = [
      {
        kind: "supersedes",
        target: "/projects/fixture/decisions/second.md",
      },
    ];
  });
  const cycle = await validateVault(cycleVault);
  assert.ok(codes(cycle).includes("DECISION-SUPERSESSION"));
});

function policyRecord(path, relations) {
  return {
    path,
    displayFile: path,
    type: "Task",
    status: "stable",
    frontmatter: {},
    bookie: {
      profile: "1.0",
      uid: `TSK-${path === "/source.md" ? "0" : "1"}`,
      relations,
    },
  };
}

test("inverse cardinality and attempted Decision predecessor lifecycle are independent", async () => {
  const source = {
    path: "/source.md",
    displayFile: "/source.md",
    type: "Task",
    status: "stable",
    frontmatter: {},
    bookie: {
      profile: "1.0",
      uid: "TSK-SOURCE",
      relations: [{ kind: "blocks", target: "/target.md" }],
    },
  };
  const target = {
    path: "/target.md",
    displayFile: "/target.md",
    type: "Task",
    status: "stable",
    frontmatter: {},
    bookie: {
      profile: "1.0",
      uid: "TSK-TARGET",
      relations: [
        {
          kind: "blocked_by",
          target: "/source.md",
          target_uid: "TSK-SOURCE",
          extension: 1,
        },
        {
          kind: "blocked_by",
          target: "/source.md",
          target_uid: "TSK-WRONG",
          extension: 2,
        },
      ],
    },
  };
  const project = {
    path: "/project.md",
    displayFile: "/project.md",
    type: "Project",
    status: "stable",
    frontmatter: {},
    bookie: { profile: "1.0", uid: "PRJ-PROJECT" },
  };
  const predecessor = {
    path: "/old.md",
    displayFile: "/old.md",
    type: "Decision",
    status: "stable",
    frontmatter: {},
    bookie: {
      profile: "1.0",
      uid: "DSN-OLD",
      project: "/project.md",
      state: "accepted",
      relations: [{ kind: "superseded_by", target: "/new.md" }],
    },
  };
  const replacement = {
    path: "/new.md",
    displayFile: "/new.md",
    type: "Decision",
    status: "stable",
    frontmatter: {},
    bookie: {
      profile: "1.0",
      uid: "DSN-NEW",
      project: "/project.md",
      state: "accepted",
      relations: [],
    },
  };
  const collector = new DiagnosticCollector(100);
  await validateCurrentTree(
    [source, target, project, predecessor, replacement],
    collector,
  );
  const diagnostics = collector.finish();
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "RELATION-INVERSE" &&
        diagnostic.file === "/source.md",
    ),
  );
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "DECISION-SUPERSESSION" &&
        diagnostic.file === "/old.md",
    ),
  );
});

test("cross-project Decision and correction supersession is rejected", async () => {
  const project = (path, uid) => ({
    path,
    displayFile: path,
    type: "Project",
    status: "stable",
    frontmatter: {},
    bookie: { profile: "1.0", uid },
  });
  const records = [
    project("/p1.md", "PRJ-1"),
    project("/p2.md", "PRJ-2"),
    {
      path: "/new-decision.md",
      displayFile: "/new-decision.md",
      type: "Decision",
      status: "stable",
      frontmatter: {},
      bookie: {
        profile: "1.0",
        uid: "DSN-1",
        project: "/p1.md",
        state: "accepted",
        relations: [{ kind: "supersedes", target: "/old-decision.md" }],
      },
    },
    {
      path: "/old-decision.md",
      displayFile: "/old-decision.md",
      type: "Decision",
      status: "deprecated",
      frontmatter: {},
      bookie: {
        profile: "1.0",
        uid: "DSN-2",
        project: "/p2.md",
        state: "superseded",
        relations: [{ kind: "superseded_by", target: "/new-decision.md" }],
      },
    },
    ...["Activity", "Evidence"].flatMap((type, index) => [
      {
        path: `/${type.toLowerCase()}-new.md`,
        displayFile: `/${type.toLowerCase()}-new.md`,
        type,
        status: "stable",
        frontmatter: {},
        bookie: {
          profile: "1.0",
          uid: `${type}-new-${index}`,
          project: "/p1.md",
          relations: [
            {
              kind: "supersedes",
              target: `/${type.toLowerCase()}-old.md`,
            },
          ],
        },
      },
      {
        path: `/${type.toLowerCase()}-old.md`,
        displayFile: `/${type.toLowerCase()}-old.md`,
        type,
        status: "stable",
        frontmatter: {},
        bookie: {
          profile: "1.0",
          uid: `${type}-old-${index}`,
          project: "/p2.md",
        },
      },
    ]),
  ];
  const collector = new DiagnosticCollector(100);
  await validateCurrentTree(records, collector);
  const diagnostics = collector.finish();
  assert.ok(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "DECISION-SUPERSESSION" &&
        diagnostic.file === "/new-decision.md",
    ),
  );
  for (const file of ["/activity-new.md", "/evidence-new.md"]) {
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "RELATION-TARGET" && diagnostic.file === file,
      ),
    );
  }
});

test("relation policy indexes inverse edges and observes cancellation", async () => {
  const count = 1_000;
  const sourceRelations = Array.from({ length: count }, (_, index) => ({
    kind: "relates_to",
    target: "/target.md",
    extension: index,
  }));
  let targetReads = 0;
  const targetRelations = new Proxy(
    Array.from({ length: count }, (_, index) => ({
      kind: "relates_to",
      target: "/source.md",
      extension: index,
    })),
    {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) {
          targetReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const records = [
    policyRecord("/source.md", sourceRelations),
    policyRecord("/target.md", targetRelations),
  ];
  await validateCurrentTree(records, new DiagnosticCollector(10_000));
  assert.ok(targetReads < 20_000, `target relation reads: ${targetReads}`);

  let checks = 0;
  const signal = {
    get aborted() {
      checks += 1;
      return checks > 2;
    },
  };
  await assert.rejects(
    validateCurrentTree(records, new DiagnosticCollector(10_000), signal),
    (error) => error?.name === "AbortError",
  );

  const controller = new AbortController();
  setImmediate(() => controller.abort());
  await assert.rejects(
    validateCurrentTree(
      records,
      new DiagnosticCollector(10_000),
      controller.signal,
    ),
    (error) => error?.name === "AbortError",
  );
});

test("pre-read hash failures report zero streamed bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bookie-hash-accounting-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "resource.bin"), Buffer.alloc(128, 1));
  const result = await hashSafeBoundedFile(
    root,
    "resource.bin",
    64,
    undefined,
    createPathTracker(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "size");
  assert.equal(result.bytesRead, 0);
});

test("root-resolution cancellation always rejects with AbortError", async () => {
  const controller = new AbortController();
  const validation = validateVault(
    join(tmpdir(), `missing-bookie-${Date.now()}`),
    { signal: controller.signal },
  );
  queueMicrotask(() => controller.abort("late root abort"));
  await assert.rejects(validation, (error) => error?.name === "AbortError");
});

test("vault count, aggregate-byte, depth, and reserved-link bounds are executable", async (t) => {
  const countVault = await temporaryVault(t);
  const counted = await validateVault(countVault, { maxConcepts: 7 });
  assert.equal(counted.complete, false);
  assert.ok(codes(counted).includes("VAULT-BOUNDS"));
  const exactCount = await validateVault(countVault, { maxConcepts: 8 });
  assert.equal(exactCount.valid, true, JSON.stringify(exactCount.diagnostics));

  const aggregateVault = await temporaryVault(t);
  const aggregate = await validateVault(aggregateVault, {
    maxTotalConceptBytes: 100,
  });
  assert.equal(aggregate.complete, false);
  assert.ok(codes(aggregate).includes("VAULT-BOUNDS"));
  const exactBytes = await validateVault(aggregateVault, {
    maxTotalConceptBytes: await markdownBytesBelow(aggregateVault),
  });
  assert.equal(exactBytes.valid, true, JSON.stringify(exactBytes.diagnostics));

  const depthVault = await temporaryVault(t);
  await rewriteFlowConcept(
    join(depthVault, "projects/fixture/tasks/task.md"),
    (frontmatter) => {
      frontmatter.extension = { one: { two: { three: true } } };
    },
  );
  const depth = await validateVault(depthVault, { maxYamlDepth: 2 });
  assert.equal(depth.complete, false);
  assert.ok(codes(depth).includes("YAML-UNSUPPORTED"));

  const linkVault = await temporaryVault(t);
  const indexPath = join(linkVault, "index.md");
  await writeFile(
    indexPath,
    `${await readFile(indexPath, "utf8")}\n[missing](missing-reserved.md)\n`,
  );
  assert.ok(codes(await validateVault(linkVault)).includes("MARKDOWN-LINK"));
});

test("pathological CommonMark container nesting fails a structural bound", async (t) => {
  for (const token of ["> ", "+ ", "1. "]) {
    await t.test(JSON.stringify(token), async (t) => {
      const vault = await temporaryVault(t);
      const indexPath = join(vault, "index.md");
      await writeFile(
        indexPath,
        `${await readFile(indexPath, "utf8")}\n${token.repeat(300)}nested\n`,
      );
      const result = await validateVault(vault);
      assert.equal(result.complete, false);
      assert.ok(codes(result).includes("MARKDOWN-LINK"));
    });
  }

  await t.test("multiline list indentation", async (t) => {
    const vault = await temporaryVault(t);
    const indexPath = join(vault, "index.md");
    const nested = Array.from(
      { length: 300 },
      (_, depth) => `${"  ".repeat(depth)}+ nested`,
    ).join("\n");
    await writeFile(
      indexPath,
      `${await readFile(indexPath, "utf8")}\n${nested}\n`,
    );
    const result = await validateVault(vault);
    assert.equal(result.complete, false);
    assert.ok(codes(result).includes("MARKDOWN-LINK"));
  });

  await t.test(
    "empty list markers use the worker cancellation path",
    async () => {
      const nested = Array.from(
        { length: 300 },
        (_, depth) => `${"  ".repeat(depth)}-`,
      ).join("\n");
      const started = performance.now();
      await assert.rejects(
        validateMarkdownLinks(
          nested,
          "/vault/index.md",
          "/index.md",
          "/vault",
          {
            regularFiles: new Set(["index.md"]),
            directories: new Set([""]),
            markdownFiles: ["index.md"],
            incomplete: false,
          },
          new DiagnosticCollector(10),
          AbortSignal.timeout(10),
        ),
        (error) => error?.name === "AbortError",
      );
      assert.ok(
        performance.now() - started < 250,
        "empty list markers bypassed worker cancellation",
      );
    },
  );

  await t.test("fenced code markers are inert", async (t) => {
    const vault = await temporaryVault(t);
    const indexPath = join(vault, "index.md");
    await writeFile(
      indexPath,
      `${await readFile(indexPath, "utf8")}\n\`\`\`text\n${"> ".repeat(300)}literal\n\`\`\`\n`,
    );
    const result = await validateVault(vault);
    assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  });

  await t.test("invalid backtick info does not open a fence", async (t) => {
    const vault = await temporaryVault(t);
    const indexPath = join(vault, "index.md");
    await writeFile(
      indexPath,
      `${await readFile(indexPath, "utf8")}\n\`\`\` bad\`info\n${"> ".repeat(300)}nested\n`,
    );
    const result = await validateVault(vault);
    assert.equal(result.complete, false);
    assert.ok(codes(result).includes("MARKDOWN-LINK"));
    await writeFile(
      indexPath,
      `${await readFile(indexPath, "utf8")}\n\`\`\` bad\`info\n${"> ".repeat(40_000)}nested\n`,
    );
    const started = performance.now();
    await assert.rejects(
      validateVault(vault, { signal: AbortSignal.timeout(10) }),
      (error) => error?.name === "AbortError",
    );
    assert.ok(
      performance.now() - started < 1_000,
      "invalid fence bypassed worker cancellation",
    );
  });

  await t.test(
    "worker parsing observes cancellation and deadline",
    async (t) => {
      const vault = await temporaryVault(t);
      const indexPath = join(vault, "index.md");
      await writeFile(
        indexPath,
        `${await readFile(indexPath, "utf8")}\n${"> ".repeat(40_000)}nested\n`,
      );
      await assert.rejects(
        validateVault(vault, { signal: AbortSignal.timeout(10) }),
        (error) => error?.name === "AbortError",
      );
      const started = performance.now();
      const bounded = await validateVault(vault);
      assert.ok(
        performance.now() - started < 6_500,
        "Markdown worker exceeded its deadline budget",
      );
      assert.equal(bounded.complete, false);
      assert.ok(codes(bounded).includes("MARKDOWN-LINK"));
    },
  );
});

test("aggregate resource bounds accept the exact byte boundary", async (t) => {
  const vault = await temporaryVault(t);
  const size = (await readFile(join(vault, "references/files/source.bin")))
    .byteLength;
  const exact = await validateVault(vault, { maxTotalResourceBytes: size });
  assert.equal(exact.valid, true, JSON.stringify(exact.diagnostics));
  const below = await validateVault(vault, {
    maxTotalResourceBytes: size - 1,
  });
  assert.equal(below.complete, false);
  assert.ok(codes(below).includes("VAULT-BOUNDS"));
});

test("production digest validation hashes binary CRLF bytes exactly", async (t) => {
  const vault = await temporaryVault(t);
  const bytes = Uint8Array.from([0x00, 0xff, 0x0d, 0x0a, 0x41, 0x0d, 0x0a]);
  const resourcePath = join(vault, "references/files/source.bin");
  await writeFile(resourcePath, bytes);
  const exact = createHash("sha256").update(bytes).digest("hex");
  const normalized = createHash("sha256")
    .update(Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n"))
    .digest("hex");
  assert.notEqual(exact, normalized);
  await rewriteFlowConcept(
    join(vault, "projects/fixture/evidence/evidence.md"),
    (frontmatter) => {
      frontmatter.bookie.sha256 = exact;
    },
  );
  const result = await validateVault(vault);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
});
