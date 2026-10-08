import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const commonSchemaPath = resolve(root, "schemas/bookie-common.schema.json");
const typeSchemaRoot = resolve(root, "schemas/types");
const fixtureRoot = resolve(root, "fixtures/concepts/1.0");

const typeNames = [
  "Project",
  "Task",
  "Document",
  "Research",
  "Decision",
  "Activity",
  "Evidence",
  "Person",
];

const uidPrefixes = {
  Project: "PRJ",
  Task: "TSK",
  Document: "DOC",
  Research: "RSC",
  Decision: "DSN",
  Activity: "ACT",
  Evidence: "EVD",
  Person: "PER",
};

const relationKinds = [
  "part_of",
  "relates_to",
  "blocks",
  "blocked_by",
  "depends_on",
  "supports",
  "supersedes",
  "superseded_by",
  "owned_by",
];

const validFixtures = {
  activity: "Activity",
  decision: "Decision",
  document: "Document",
  evidence: "Evidence",
  person: "Person",
  project: "Project",
  research: "Research",
  "research-project": "Research",
  task: "Task",
};

const expectedError = (keyword, instancePath, missingProperty) => ({
  instancePath,
  keyword,
  ...(missingProperty === undefined ? {} : { missingProperty }),
});

const invalidFixtures = {
  "activity-missing-occurred-at": {
    type: "Activity",
    errors: [expectedError("required", "/bookie", "occurred_at")],
  },
  "decision-missing-state": {
    type: "Decision",
    errors: [expectedError("required", "/bookie", "state")],
  },
  "document-missing-project": {
    type: "Document",
    errors: [expectedError("required", "/bookie", "project")],
  },
  "evidence-invalid-sha256": {
    type: "Evidence",
    errors: [expectedError("pattern", "/bookie/sha256")],
  },
  "evidence-missing-resource": {
    type: "Evidence",
    errors: [expectedError("required", "", "resource")],
  },
  "evidence-missing-sha256": {
    type: "Evidence",
    errors: [expectedError("required", "/bookie", "sha256")],
  },
  "person-missing-created-at": {
    type: "Person",
    errors: [expectedError("required", "/bookie", "created_at")],
  },
  "project-impossible-calendar-date": {
    type: "Project",
    errors: [expectedError("pattern", "/bookie/created_at")],
  },
  "project-impossible-calendar-month": {
    type: "Project",
    errors: [expectedError("pattern", "/bookie/created_at")],
  },
  "project-impossible-clock-time": {
    type: "Project",
    errors: [expectedError("pattern", "/bookie/created_at")],
  },
  "project-invalid-state": {
    type: "Project",
    errors: [expectedError("enum", "/bookie/state")],
  },
  "project-invalid-status": {
    type: "Project",
    errors: [expectedError("enum", "/status")],
  },
  "project-malformed-uid": {
    type: "Project",
    errors: [expectedError("pattern", "/bookie/uid")],
  },
  "project-missing-created-at": {
    type: "Project",
    errors: [expectedError("required", "/bookie", "created_at")],
  },
  "project-missing-uid": {
    type: "Project",
    errors: [expectedError("required", "/bookie", "uid")],
  },
  "project-non-utc-created-at": {
    type: "Project",
    errors: [expectedError("pattern", "/bookie/created_at")],
  },
  "research-invalid-scope": {
    type: "Research",
    errors: [expectedError("const", "/bookie/scope")],
  },
  "research-missing-created-at": {
    type: "Research",
    errors: [expectedError("required", "/bookie", "created_at")],
  },
  "research-missing-project-or-scope": {
    type: "Research",
    errors: [
      expectedError("required", "/bookie", "project"),
      expectedError("required", "/bookie", "scope"),
      expectedError("oneOf", "/bookie"),
    ],
  },
  "research-project-and-scope": {
    type: "Research",
    errors: [expectedError("oneOf", "/bookie")],
  },
  "task-invalid-state": {
    type: "Task",
    errors: [expectedError("enum", "/bookie/state")],
  },
  "task-missing-project": {
    type: "Task",
    errors: [expectedError("required", "/bookie", "project")],
  },
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readFixture(kind, name) {
  return readJson(resolve(fixtureRoot, kind, `${name}.json`));
}

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

const validators = new Map();
function loadValidator(type) {
  if (!validators.has(type)) {
    const ajv = createAjv();
    ajv.addSchema(readJson(commonSchemaPath));
    validators.set(
      type,
      ajv.compile(
        readJson(resolve(typeSchemaRoot, `${type.toLowerCase()}.schema.json`)),
      ),
    );
  }
  return validators.get(type);
}

function normalizeErrors(errors) {
  return (errors ?? [])
    .map((error) =>
      expectedError(
        error.keyword,
        error.instancePath,
        error.keyword === "required"
          ? (error.missingProperty ?? error.params?.missingProperty)
          : undefined,
      ),
    )
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function deleteAtPath(value, path) {
  const parent = path
    .slice(0, -1)
    .reduce((current, property) => current[property], value);
  delete parent[path.at(-1)];
}

function setAtPath(value, path, replacement) {
  if (path.length === 0) return replacement;
  const parent = path
    .slice(0, -1)
    .reduce((current, property) => current[property], value);
  parent[path.at(-1)] = replacement;
  return value;
}

test("common and initial type schemas meta-validate in Ajv strict mode", () => {
  const ajv = createAjv();
  const commonSchema = readJson(commonSchemaPath);
  assert.equal(
    ajv.validateSchema(commonSchema),
    true,
    ajv.errorsText(ajv.errors),
  );
  assert.deepEqual(
    commonSchema.$defs.relation.properties.kind.enum,
    relationKinds,
    "Relation vocabulary drifted",
  );
  for (const name of ["bundleFilePath", "conceptPath", "prefixedUlid"]) {
    assert.ok(
      commonSchema.$defs[name].pattern.endsWith("(?![\\s\\S])"),
      `${name} must use the portable absolute end guard`,
    );
    assert.equal(
      commonSchema.$defs[name].pattern.includes("$"),
      false,
      `${name} must not use a permissive terminal $ anchor`,
    );
  }
  ajv.addSchema(commonSchema);

  for (const type of typeNames) {
    const schema = readJson(
      resolve(typeSchemaRoot, `${type.toLowerCase()}.schema.json`),
    );
    assert.equal(ajv.validateSchema(schema), true, ajv.errorsText(ajv.errors));
    assert.doesNotThrow(() => ajv.compile(schema));
  }
});

test("every initial type and Research scope form has an enumerated valid fixture", async (t) => {
  assert.deepEqual(
    readdirSync(resolve(fixtureRoot, "valid"))
      .filter((name) => name.endsWith(".json"))
      .sort(),
    Object.keys(validFixtures)
      .map((name) => `${name}.json`)
      .sort(),
  );

  for (const [name, type] of Object.entries(validFixtures)) {
    await t.test(name, () => {
      const validate = loadValidator(type);
      const fixture = readFixture("valid", name);
      assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    });
  }
});

test("invalid fixtures fail only at their declared contract boundary", async (t) => {
  assert.deepEqual(
    readdirSync(resolve(fixtureRoot, "invalid"))
      .filter((name) => name.endsWith(".json"))
      .sort(),
    Object.keys(invalidFixtures)
      .map((name) => `${name}.json`)
      .sort(),
  );

  for (const [name, { type, errors }] of Object.entries(invalidFixtures)) {
    await t.test(name, () => {
      const validate = loadValidator(type);
      const fixture = readFixture("invalid", name);
      assert.equal(validate(fixture), false, `${name} unexpectedly passed`);
      assert.deepEqual(
        normalizeErrors(validate.errors),
        normalizeErrors(errors),
        `${name} failed for the wrong reason: ${JSON.stringify(validate.errors)}`,
      );
    });
  }
});

test("every required common and type field rejects omission", async (t) => {
  const cases = [
    ["Project", "project", ["type"]],
    ["Project", "project", ["title"]],
    ["Project", "project", ["status"]],
    ["Project", "project", ["generated"]],
    ["Project", "project", ["generated", "by"]],
    ["Project", "project", ["generated", "at"]],
    ["Project", "project", ["bookie"]],
    ["Project", "project", ["bookie", "profile"]],
    ["Project", "project", ["bookie", "uid"]],
    ["Project", "project", ["bookie", "created_at"]],
    ["Project", "project", ["bookie", "state"]],
    ["Task", "task", ["bookie", "project"]],
    ["Task", "task", ["bookie", "created_at"]],
    ["Task", "task", ["bookie", "state"]],
    ["Document", "document", ["bookie", "project"]],
    ["Document", "document", ["bookie", "created_at"]],
    ["Research", "research", ["bookie", "created_at"]],
    ["Decision", "decision", ["bookie", "project"]],
    ["Decision", "decision", ["bookie", "created_at"]],
    ["Decision", "decision", ["bookie", "state"]],
    ["Activity", "activity", ["bookie", "project"]],
    ["Activity", "activity", ["bookie", "occurred_at"]],
    ["Evidence", "evidence", ["resource"]],
    ["Evidence", "evidence", ["bookie", "project"]],
    ["Evidence", "evidence", ["bookie", "captured_at"]],
    ["Evidence", "evidence", ["bookie", "sha256"]],
    ["Evidence", "evidence", ["bookie", "mime_type"]],
    ["Evidence", "evidence", ["bookie", "supports"]],
    ["Person", "person", ["bookie", "created_at"]],
  ];

  for (const [type, fixtureName, path] of cases) {
    await t.test(`${type} ${path.join(".")}`, () => {
      const fixture = readFixture("valid", fixtureName);
      deleteAtPath(fixture, path);
      const validate = loadValidator(type);

      assert.equal(
        validate(fixture),
        false,
        `${path.join(".")} omission passed`,
      );
      const instancePath =
        path.length === 1 ? "" : `/${path.slice(0, -1).join("/")}`;
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === "required" &&
            error.instancePath === instancePath &&
            error.params.missingProperty === path.at(-1),
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("every type schema rejects a mismatched type", async (t) => {
  for (const type of typeNames) {
    await t.test(type, () => {
      const fixtureName = type.toLowerCase();
      const fixture = readFixture("valid", fixtureName);
      fixture.type = "Unexpected";
      const validate = loadValidator(type);

      assert.equal(validate(fixture), false, `${type} accepted another type`);
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === "const" && error.instancePath === "/type",
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("common schema rejects an incompatible profile version", () => {
  const fixture = readFixture("valid", "project");
  fixture.bookie.profile = "2.0";
  const validate = loadValidator("Project");

  assert.equal(validate(fixture), false);
  assert.ok(
    validate.errors?.some(
      (error) =>
        error.keyword === "const" && error.instancePath === "/bookie/profile",
    ),
    JSON.stringify(validate.errors),
  );
});

test("common UID syntax covers Crockford and 128-bit boundaries", async (t) => {
  const validate = loadValidator("Project");

  await t.test("highest leading ULID symbol", () => {
    const fixture = readFixture("valid", "project");
    fixture.bookie.uid = `PRJ-7${"Z".repeat(25)}`;
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  });

  const invalidUids = [
    ["lowercase prefix", `prj-0${"0".repeat(25)}`],
    ["too short", `PRJ-0${"0".repeat(24)}`],
    ["too long", `PRJ-0${"0".repeat(26)}`],
    ["lowercase symbol", `PRJ-0${"0".repeat(24)}a`],
    ...["I", "L", "O", "U"].map((symbol) => [
      `forbidden ${symbol}`,
      `PRJ-0${"0".repeat(24)}${symbol}`,
    ]),
  ];
  for (const [name, uid] of invalidUids) {
    await t.test(name, () => {
      const fixture = readFixture("valid", "project");
      fixture.bookie.uid = uid;
      assert.equal(validate(fixture), false, `${uid} unexpectedly passed`);
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === "pattern" && error.instancePath === "/bookie/uid",
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("every concept type requires its assigned UID prefix", async (t) => {
  for (const [type, prefix] of Object.entries(uidPrefixes)) {
    await t.test(type, () => {
      const fixtureName = type.toLowerCase();
      const fixture = readFixture("valid", fixtureName);
      const validate = loadValidator(type);
      assert.equal(validate(fixture), true, JSON.stringify(validate.errors));

      for (const wrongPrefix of Object.values(uidPrefixes).filter(
        (candidate) => candidate !== prefix,
      )) {
        fixture.bookie.uid = `${wrongPrefix}-${fixture.bookie.uid.slice(4)}`;
        assert.equal(
          validate(fixture),
          false,
          `${type} accepted ${wrongPrefix}`,
        );
        assert.ok(
          validate.errors?.some(
            (error) =>
              error.keyword === "pattern" &&
              error.instancePath === "/bookie/uid",
          ),
          JSON.stringify(validate.errors),
        );
      }
    });
  }
});

test("UTC timestamps isolate calendar-day and clock boundaries", async (t) => {
  const validate = loadValidator("Project");

  const validTimestamps = [
    ["last clock value", "9999-12-31T23:59:59.999Z"],
    ["century leap day", "2000-02-29T00:00:00Z"],
  ];
  for (const [name, timestamp] of validTimestamps) {
    await t.test(name, () => {
      const fixture = readFixture("valid", "project");
      fixture.bookie.created_at = timestamp;
      assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    });
  }

  const invalidTimestamps = [
    ["day zero", "2026-01-00T00:00:00Z"],
    ["30-day month overflow", "2026-04-31T00:00:00Z"],
    ["non-leap century", "1900-02-29T00:00:00Z"],
    ["hour 24", "2026-01-01T24:00:00Z"],
    ["minute 60", "2026-01-01T23:60:00Z"],
    ["second 60", "2026-01-01T23:59:60Z"],
  ];
  for (const [name, timestamp] of invalidTimestamps) {
    await t.test(name, () => {
      const fixture = readFixture("valid", "project");
      fixture.bookie.created_at = timestamp;
      assert.equal(
        validate(fixture),
        false,
        `${timestamp} unexpectedly passed`,
      );
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === "pattern" &&
            error.instancePath === "/bookie/created_at",
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("all lifecycle and workflow enum values are covered", async (t) => {
  const cases = [
    ["Project", "project", ["status"], ["draft", "stable", "deprecated"]],
    [
      "Project",
      "project",
      ["bookie", "state"],
      ["active", "paused", "completed", "archived"],
    ],
    [
      "Task",
      "task",
      ["bookie", "state"],
      ["proposed", "ready", "in_progress", "blocked", "done", "cancelled"],
    ],
    [
      "Decision",
      "decision",
      ["bookie", "state"],
      ["proposed", "accepted", "rejected", "superseded"],
    ],
  ];

  for (const [type, fixtureName, path, values] of cases) {
    await t.test(`${type} ${path.join(".")}`, () => {
      const validate = loadValidator(type);
      for (const value of values) {
        const fixture = setAtPath(
          readFixture("valid", fixtureName),
          path,
          value,
        );
        assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
      }

      const fixture = setAtPath(
        readFixture("valid", fixtureName),
        path,
        "unexpected",
      );
      assert.equal(validate(fixture), false);
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === "enum" &&
            error.instancePath === `/${path.join("/")}`,
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("relations and canonical concept paths enforce the profile vocabulary", async (t) => {
  const validateProject = loadValidator("Project");

  for (const kind of relationKinds) {
    await t.test(kind, () => {
      const fixture = readFixture("valid", "project");
      fixture.bookie.relations = [
        {
          kind,
          target: "/projects/Δ demo/target.md",
          target_uid: "TSK-01ARZ3NDEKTSV4RRFFQ69G5FAW",
        },
      ];
      assert.equal(
        validateProject(fixture),
        true,
        JSON.stringify(validateProject.errors),
      );
    });
  }

  const invalidRelations = [
    ["unknown kind", { kind: "contains", target: "/target.md" }, "enum"],
    ["missing kind", { target: "/target.md" }, "required"],
    ["missing target", { kind: "relates_to" }, "required"],
    [
      "malformed target UID",
      { kind: "relates_to", target: "/target.md", target_uid: "TSK-bad" },
      "pattern",
    ],
  ];
  for (const [name, relation, keyword] of invalidRelations) {
    await t.test(name, () => {
      const fixture = readFixture("valid", "project");
      fixture.bookie.relations = [relation];
      assert.equal(
        validateProject(fixture),
        false,
        `${name} unexpectedly passed`,
      );
      assert.ok(
        validateProject.errors?.some((error) => error.keyword === keyword),
        JSON.stringify(validateProject.errors),
      );
    });
  }

  await t.test("duplicate exact relation", () => {
    const fixture = readFixture("valid", "project");
    const relation = { kind: "relates_to", target: "/target.md" };
    fixture.bookie.relations = [relation, structuredClone(relation)];
    assert.equal(validateProject(fixture), false);
    assert.ok(
      validateProject.errors?.some(
        (error) =>
          error.keyword === "uniqueItems" &&
          error.instancePath === "/bookie/relations",
      ),
      JSON.stringify(validateProject.errors),
    );
  });

  const invalidConceptPaths = [
    "projects/target.md",
    "//projects/target.md",
    "/projects/./target.md",
    "/projects/../target.md",
    "/projects//target.md",
    "/projects\\target.md",
    "/projects/%2e%2e/target.md",
    "/projects/target?name.md",
    "/projects/target.md#section",
    "/projects/name:target.md",
    "/projects/\u0000target.md",
    "/projects/\u0085target.md",
    "/projects/\ud800target.md",
    "/projects/target.txt",
    "/projects/target.md\n",
  ];
  for (const path of invalidConceptPaths) {
    await t.test(`invalid concept path ${JSON.stringify(path)}`, () => {
      const fixture = readFixture("valid", "project");
      fixture.bookie.relations = [{ kind: "relates_to", target: path }];
      assert.equal(
        validateProject(fixture),
        false,
        `${path} unexpectedly passed`,
      );
      assert.ok(
        validateProject.errors?.some(
          (error) =>
            error.keyword === "pattern" &&
            error.instancePath === "/bookie/relations/0/target",
        ),
        JSON.stringify(validateProject.errors),
      );
    });
  }

  const task = readFixture("valid", "task");
  task.bookie.project = "/projects/Δ 🧪 demo/project.md";
  assert.equal(
    loadValidator("Task")(task),
    true,
    "Unicode project path should pass",
  );

  const evidence = readFixture("valid", "evidence");
  evidence.resource = "/references/files/exact 🧪 bytes.bin";
  evidence.bookie.supports = ["/projects/Δ 🧪 demo/project.md"];
  assert.equal(
    loadValidator("Evidence")(evidence),
    true,
    "normalized Evidence paths should pass",
  );

  const invalidReferencePaths = [
    ["Task", "task", ["bookie", "project"], "projects/demo/project.md"],
    ["Task", "task", ["bookie", "project"], "/projects/demo/project?old.md"],
    ["Evidence", "evidence", ["bookie", "supports", 0], "/project.txt"],
    [
      "Evidence",
      "evidence",
      ["bookie", "supports", 0],
      "/projects/\ud800target.md",
    ],
    ["Evidence", "evidence", ["resource"], "/references/files/../secret.txt"],
    ["Evidence", "evidence", ["resource"], "/references/files/source?raw.txt"],
  ];
  for (const [type, fixtureName, path, replacement] of invalidReferencePaths) {
    await t.test(`invalid ${type} ${path.join(".")}`, () => {
      const fixture = setAtPath(
        readFixture("valid", fixtureName),
        path,
        replacement,
      );
      const validate = loadValidator(type);
      assert.equal(
        validate(fixture),
        false,
        `${replacement} unexpectedly passed`,
      );
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === "pattern" &&
            error.instancePath === `/${path.join("/")}`,
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("known OKF provenance, trust, freshness, and actor shapes validate", async (t) => {
  const validate = loadValidator("Project");
  const validActors = ["human:demo", "process:nightly", "bookie/1.0"];

  for (const actor of validActors) {
    await t.test(`actor ${actor}`, () => {
      const fixture = readFixture("valid", "project");
      fixture.generated.by = actor;
      fixture.resource = "/references/source.md";
      fixture.sources = [
        {
          id: "source",
          resource: "/references/source.md",
          title: "Source",
          author: "human:docs",
          usage_count: 0,
          last_modified: "2024-02-29",
          usage_window: { from: "2024-02-01", to: "2024-02-29" },
        },
      ];
      fixture.usage_window = { from: "2024-02-01", to: "2024-02-29" };
      fixture.verified = { by: "human:reviewer", at: "2024-02-29T12:00:00Z" };
      fixture.stale_after = "2024-03-31";
      assert.equal(validate(fixture), true, JSON.stringify(validate.errors));

      fixture.verified = [
        { by: "process:nightly", at: "2024-03-01T00:00:00Z" },
      ];
      assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    });
  }

  const usageContexts = [
    [
      "shared usage window only",
      (fixture) => {
        fixture.sources = [{ resource: "/source", usage_count: 1 }];
        fixture.usage_window = { from: "2025-01-01", to: "2025-01-31" };
      },
    ],
    [
      "per-source usage window only",
      (fixture) => {
        fixture.sources = [
          {
            resource: "/source",
            usage_count: 1,
            usage_window: { from: "2025-01-01", to: "2025-01-31" },
          },
        ];
      },
    ],
  ];
  for (const [name, applyContext] of usageContexts) {
    await t.test(name, () => {
      const fixture = readFixture("valid", "project");
      applyContext(fixture);
      assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    });
  }

  const invalidActors = [
    "human:",
    "process:",
    "/1.0",
    "bookie/",
    "bookie/1.0/extra",
    "human:a b",
    "human:a\n",
  ];
  for (const actor of invalidActors) {
    await t.test(`invalid actor ${JSON.stringify(actor)}`, () => {
      const fixture = readFixture("valid", "project");
      fixture.generated.by = actor;
      assert.equal(validate(fixture), false, `${JSON.stringify(actor)} passed`);
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === "pattern" &&
            error.instancePath === "/generated/by",
        ),
        JSON.stringify(validate.errors),
      );
    });
  }

  const invalidMutations = [
    [
      "actor",
      (fixture) => (fixture.generated.by = "alice"),
      "pattern",
      "/generated/by",
    ],
    [
      "source resource",
      (fixture) => (fixture.sources = [{}]),
      "required",
      "/sources/0",
    ],
    [
      "source author",
      (fixture) =>
        (fixture.sources = [{ resource: "/source", author: "alice" }]),
      "pattern",
      "/sources/0/author",
    ],
    [
      "source usage count",
      (fixture) =>
        (fixture.sources = [{ resource: "/source", usage_count: -1 }]),
      "minimum",
      "/sources/0/usage_count",
    ],
    [
      "unframed source usage count",
      (fixture) =>
        (fixture.sources = [{ resource: "/source", usage_count: 42 }]),
      "anyOf",
      "",
    ],
    [
      "source date",
      (fixture) =>
        (fixture.sources = [
          { resource: "/source", last_modified: "2025-02-29" },
        ]),
      "pattern",
      "/sources/0/last_modified",
    ],
    [
      "verified scalar",
      (fixture) => (fixture.verified = "reviewed"),
      "oneOf",
      "/verified",
    ],
    [
      "verified empty",
      (fixture) => (fixture.verified = []),
      "minItems",
      "/verified",
    ],
    [
      "verification event missing at",
      (fixture) => (fixture.verified = { by: "human:reviewer" }),
      "required",
      "/verified",
    ],
    [
      "verification event missing by",
      (fixture) => (fixture.verified = { at: "2025-01-01T00:00:00Z" }),
      "required",
      "/verified",
    ],
    [
      "verification list actor",
      (fixture) =>
        (fixture.verified = [{ by: "alice", at: "2025-01-01T00:00:00Z" }]),
      "pattern",
      "/verified/0/by",
    ],
    [
      "verification list timestamp",
      (fixture) =>
        (fixture.verified = [
          { by: "human:reviewer", at: "2025-01-01T00:00:00+01:00" },
        ]),
      "pattern",
      "/verified/0/at",
    ],
    [
      "verification list item",
      (fixture) => (fixture.verified = [1]),
      "type",
      "/verified/0",
    ],
    [
      "stale date",
      (fixture) => (fixture.stale_after = "2025-02-29"),
      "pattern",
      "/stale_after",
    ],
    [
      "usage window missing to",
      (fixture) => (fixture.usage_window = { from: "2025-01-01" }),
      "required",
      "/usage_window",
    ],
    [
      "usage window missing from",
      (fixture) => (fixture.usage_window = { to: "2025-01-31" }),
      "required",
      "/usage_window",
    ],
    [
      "source usage window missing from",
      (fixture) =>
        (fixture.sources = [
          {
            resource: "/source",
            usage_count: 1,
            usage_window: { to: "2025-01-31" },
          },
        ]),
      "required",
      "/sources/0/usage_window",
    ],
    [
      "usage window invalid from date",
      (fixture) =>
        (fixture.usage_window = { from: "2025-02-29", to: "2025-03-01" }),
      "pattern",
      "/usage_window/from",
    ],
    [
      "source usage window invalid to date",
      (fixture) =>
        (fixture.sources = [
          {
            resource: "/source",
            usage_count: 1,
            usage_window: { from: "2025-02-01", to: "2025-02-29" },
          },
        ]),
      "pattern",
      "/sources/0/usage_window/to",
    ],
  ];

  for (const [name, mutate, keyword, instancePath] of invalidMutations) {
    await t.test(name, () => {
      const fixture = readFixture("valid", "project");
      mutate(fixture);
      assert.equal(validate(fixture), false, `${name} unexpectedly passed`);
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === keyword && error.instancePath === instancePath,
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("Evidence digest isolates lowercase hexadecimal and length boundaries", async (t) => {
  const validate = loadValidator("Evidence");
  const validFixture = readFixture("valid", "evidence");
  assert.equal(validate(validFixture), true, JSON.stringify(validate.errors));

  const invalidDigests = [
    ["uppercase", "A".repeat(64)],
    ["63 characters", "a".repeat(63)],
    ["65 characters", "a".repeat(65)],
    ["non-hexadecimal", `${"a".repeat(63)}g`],
  ];
  for (const [name, digest] of invalidDigests) {
    await t.test(name, () => {
      const fixture = structuredClone(validFixture);
      fixture.bookie.sha256 = digest;
      assert.equal(validate(fixture), false, `${name} digest passed`);
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === "pattern" &&
            error.instancePath === "/bookie/sha256",
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("Evidence uses top-level resource and validates media type and web origin", async (t) => {
  const validate = loadValidator("Evidence");
  const fixture = readFixture("valid", "evidence");
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));

  await t.test("bookie-only resource", () => {
    const nested = structuredClone(fixture);
    nested.bookie.resource = nested.resource;
    delete nested.resource;
    assert.equal(validate(nested), false);
    assert.ok(
      validate.errors?.some(
        (error) =>
          error.keyword === "required" &&
          error.instancePath === "" &&
          error.params.missingProperty === "resource",
      ),
      JSON.stringify(validate.errors),
    );
  });

  const validMediaTypes = [
    "text/plain",
    "Text/Plain",
    "application/vnd.api+json",
    "a!#$&^_.+-z/b!#$&^_.+-y",
    `${"a".repeat(127)}/${"b".repeat(127)}`,
  ];
  for (const mimeType of validMediaTypes) {
    await t.test(`media type ${mimeType.slice(0, 30)}`, () => {
      const candidate = structuredClone(fixture);
      candidate.bookie.mime_type = mimeType;
      assert.equal(validate(candidate), true, JSON.stringify(validate.errors));
    });
  }

  const invalidMediaTypes = [
    "text/\u0000plain",
    "text/ plain",
    "text/plain\n",
    "text/plain/json",
    "text/*",
    "*/plain",
    "text/plain; charset=utf-8",
    "!/plain",
    "-x/y",
    "text/.",
    "a/+json",
    `${"a".repeat(128)}/plain`,
    `text/${"b".repeat(128)}`,
  ];
  for (const mimeType of invalidMediaTypes) {
    await t.test(
      `invalid media type ${JSON.stringify(mimeType).slice(0, 40)}`,
      () => {
        const candidate = structuredClone(fixture);
        candidate.bookie.mime_type = mimeType;
        assert.equal(
          validate(candidate),
          false,
          `${JSON.stringify(mimeType)} passed`,
        );
        assert.ok(
          validate.errors?.some(
            (error) =>
              error.keyword === "pattern" &&
              error.instancePath === "/bookie/mime_type",
          ),
          JSON.stringify(validate.errors),
        );
      },
    );
  }

  const validOrigins = [
    "https://example.com/source?id=1#section",
    "http://localhost:8080/source",
    "HTTPS://EXAMPLE.COM/source",
    "https://example.com./source",
    "https://example.com:080/source",
    "https://example.com:000080/source",
    "https://example.com:000065535/source",
    "https://example.com:50000/source",
    "https://example.com:60000/source",
    "https://example.com:65000/source",
    "https://example.com:65520/source",
    "https://[::1]/source",
    "https://192.168.1.1./source",
    "https://192.168.1.1:65535/source",
  ];
  for (const origin of validOrigins) {
    await t.test(`origin ${origin}`, () => {
      const candidate = structuredClone(fixture);
      candidate.bookie.origin = origin;
      assert.equal(validate(candidate), true, JSON.stringify(validate.errors));
    });
  }

  const invalidOrigins = [
    ["not a URL", "pattern"],
    ["ftp://example.com/source", "pattern"],
    ["file:///tmp/source", "pattern"],
    ["javascript:alert(1)", "pattern"],
    ["/relative/source", "pattern"],
    ["https://", "pattern"],
    ["http:///source", "pattern"],
    ["https://user:secret@example.com/source", "pattern"],
    ["https://example.com/%ZZ", "pattern"],
    ["https://256.256.256.256/source", "pattern"],
    ["https://256.256.256.256./source", "pattern"],
    ["https://[::::]/source", "format"],
    ["https://example.com:65536/source", "pattern"],
    ["https://example.com:000065536/source", "pattern"],
    ["https://example.com:99999/source", "pattern"],
  ];
  for (const [origin, keyword] of invalidOrigins) {
    await t.test(`invalid origin ${origin}`, () => {
      const candidate = structuredClone(fixture);
      candidate.bookie.origin = origin;
      assert.equal(validate(candidate), false, `${origin} passed`);
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === keyword &&
            error.instancePath === "/bookie/origin",
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("common schema rejects wrong JSON types at known locations", async (t) => {
  const base = readFixture("valid", "project");
  Object.assign(base, {
    description: "description",
    resource: "/source",
    sources: [
      {
        id: "source",
        resource: "/source",
        title: "Source",
        author: "human:docs",
        usage_count: 1,
        last_modified: "2024-02-29",
        usage_window: { from: "2024-02-01", to: "2024-02-29" },
      },
    ],
    verified: { by: "human:reviewer", at: "2024-02-29T00:00:00Z" },
    stale_after: "2024-03-01",
    usage_window: { from: "2024-02-01", to: "2024-02-29" },
  });
  Object.assign(base.bookie, {
    project: "/projects/demo/project.md",
    occurred_at: "2024-02-29T00:00:00Z",
    captured_at: "2024-02-29T00:00:00Z",
    sensitivity: "public",
    relations: [
      {
        kind: "relates_to",
        target: "/projects/demo/project.md",
        target_uid: "PRJ-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    ],
    supports: ["/projects/demo/project.md"],
    sha256: "a".repeat(64),
    mime_type: "text/plain",
    origin: "https://example.com/source",
    external_ids: {},
  });

  const baseValidator = loadValidator("Project");
  assert.equal(baseValidator(base), true, JSON.stringify(baseValidator.errors));

  const cases = [
    ["root", [], []],
    ["type", ["type"], 1],
    ["title", ["title"], 1],
    ["description", ["description"], 1],
    ["tags", ["tags"], null],
    ["tag", ["tags", 0], 1],
    ["status", ["status"], 1],
    ["generated", ["generated"], null],
    ["generated.by", ["generated", "by"], 1],
    ["generated.at", ["generated", "at"], 1],
    ["resource", ["resource"], 1],
    ["sources", ["sources"], null],
    ["source", ["sources", 0], 1],
    ["source.id", ["sources", 0, "id"], 1],
    ["source.resource", ["sources", 0, "resource"], 1],
    ["source.title", ["sources", 0, "title"], 1],
    ["source.author", ["sources", 0, "author"], 1],
    ["source.usage_count", ["sources", 0, "usage_count"], 0.5],
    ["source.last_modified", ["sources", 0, "last_modified"], 1],
    ["source.usage_window", ["sources", 0, "usage_window"], 1],
    ["source.usage_window.from", ["sources", 0, "usage_window", "from"], 1],
    ["source.usage_window.to", ["sources", 0, "usage_window", "to"], 1],
    ["verified", ["verified"], 1],
    ["verified.by", ["verified", "by"], 1],
    ["verified.at", ["verified", "at"], 1],
    ["stale_after", ["stale_after"], 1],
    ["usage_window", ["usage_window"], 1],
    ["usage_window.from", ["usage_window", "from"], 1],
    ["usage_window.to", ["usage_window", "to"], 1],
    ["bookie", ["bookie"], null],
    ["bookie.profile", ["bookie", "profile"], 1],
    ["bookie.uid", ["bookie", "uid"], 1],
    ["bookie.project", ["bookie", "project"], 1],
    ["bookie.scope", ["bookie", "scope"], 1],
    ["bookie.state", ["bookie", "state"], 1],
    ["bookie.created_at", ["bookie", "created_at"], 1],
    ["bookie.occurred_at", ["bookie", "occurred_at"], 1],
    ["bookie.captured_at", ["bookie", "captured_at"], 1],
    ["bookie.sensitivity", ["bookie", "sensitivity"], 1],
    ["bookie.relations", ["bookie", "relations"], null],
    ["bookie.relation", ["bookie", "relations", 0], 1],
    ["bookie.relation.kind", ["bookie", "relations", 0, "kind"], 1],
    ["bookie.relation.target", ["bookie", "relations", 0, "target"], 1],
    ["bookie.relation.target_uid", ["bookie", "relations", 0, "target_uid"], 1],
    ["bookie.supports", ["bookie", "supports"], null],
    ["bookie.support", ["bookie", "supports", 0], 1],
    ["bookie.sha256", ["bookie", "sha256"], 1],
    ["bookie.mime_type", ["bookie", "mime_type"], 1],
    ["bookie.origin", ["bookie", "origin"], 1],
    ["bookie.external_ids", ["bookie", "external_ids"], null],
  ];

  for (const [name, path, replacement] of cases) {
    await t.test(name, () => {
      const fixture = setAtPath(structuredClone(base), path, replacement);
      const validate = loadValidator("Project");
      assert.equal(validate(fixture), false, `${name} unexpectedly passed`);
      const instancePath = path.length === 0 ? "" : `/${path.join("/")}`;
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === "type" && error.instancePath === instancePath,
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("common collections and non-empty values enforce boundaries", async (t) => {
  const cases = [
    [
      "title",
      "Project",
      "project",
      (fixture) => (fixture.title = ""),
      "minLength",
      "/title",
    ],
    [
      "resource",
      "Project",
      "project",
      (fixture) => (fixture.resource = ""),
      "minLength",
      "/resource",
    ],
    [
      "source id",
      "Project",
      "project",
      (fixture) => (fixture.sources = [{ id: "", resource: "/source" }]),
      "minLength",
      "/sources/0/id",
    ],
    [
      "source resource",
      "Project",
      "project",
      (fixture) => (fixture.sources = [{ resource: "" }]),
      "minLength",
      "/sources/0/resource",
    ],
    [
      "source title",
      "Project",
      "project",
      (fixture) => (fixture.sources = [{ resource: "/source", title: "" }]),
      "minLength",
      "/sources/0/title",
    ],
    [
      "project",
      "Task",
      "task",
      (fixture) => (fixture.bookie.project = ""),
      "minLength",
      "/bookie/project",
    ],
    [
      "tag",
      "Project",
      "project",
      (fixture) => (fixture.tags = [""]),
      "minLength",
      "/tags/0",
    ],
    [
      "duplicate tags",
      "Project",
      "project",
      (fixture) => (fixture.tags = ["demo", "demo"]),
      "uniqueItems",
      "/tags",
    ],
    [
      "supports",
      "Evidence",
      "evidence",
      (fixture) => (fixture.bookie.supports = []),
      "minItems",
      "/bookie/supports",
    ],
    [
      "support",
      "Evidence",
      "evidence",
      (fixture) => (fixture.bookie.supports = [""]),
      "minLength",
      "/bookie/supports/0",
    ],
  ];

  for (const [
    name,
    type,
    fixtureName,
    mutate,
    keyword,
    instancePath,
  ] of cases) {
    await t.test(name, () => {
      const fixture = readFixture("valid", fixtureName);
      mutate(fixture);
      const validate = loadValidator(type);
      assert.equal(validate(fixture), false, `${name} unexpectedly passed`);
      assert.ok(
        validate.errors?.some(
          (error) =>
            error.keyword === keyword && error.instancePath === instancePath,
        ),
        JSON.stringify(validate.errors),
      );
    });
  }
});

test("custom top-level, known-object, and bookie extensions remain accepted", () => {
  const fixture = readFixture("valid", "project");
  const validate = loadValidator("Project");

  fixture.custom_top_level = { retained: true };
  fixture.generated.custom_generation = "retained";
  fixture.sources = [
    {
      resource: "/source",
      custom_source: "retained",
      usage_window: {
        from: "2024-02-01",
        to: "2024-02-29",
        custom_window: "retained",
      },
    },
  ];
  fixture.usage_window = {
    from: "2024-02-01",
    to: "2024-02-29",
    custom_window: "retained",
  };
  fixture.verified = {
    by: "human:reviewer",
    at: "2024-02-29T00:00:00Z",
    custom_verification: "retained",
  };
  fixture.bookie.custom_metadata = "retained";
  fixture.bookie.created_at = "2024-02-29T00:00:00Z";
  fixture.bookie.relations = [
    {
      kind: "relates_to",
      target: "/projects/demo/project.md",
      custom_relation: "retained",
    },
  ];
  assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
});
