import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

test("BK-016 records the accepted service architecture and advances lexical work", () => {
  const adr = read(
    "docs/architecture/decisions/0010-service-protocol-auth-and-projection.md",
  );
  const specification = read("docs/specs/004-retrieval-service.md");
  const questions = read("docs/planning/open-questions.md");
  const backlog = read("docs/planning/backlog.md");

  assert.match(adr, /\*\*Status:\*\* Accepted/u);
  assert.match(adr, /Fastify/u);
  assert.match(adr, /opaque/u);
  assert.match(adr, /constant-time/u);
  assert.match(adr, /read-only/u);
  assert.match(adr, /compare-and-set/u);
  assert.match(
    adr,
    /candidate already equals `active`[\s\S]*`BUILD_CONFLICT`/u,
  );
  assert.match(adr, /Every candidate mutation/u);
  assert.match(adr, /64 KiB aggregate UTF-8 context content/u);
  assert.match(adr, /no Redis host port/u);
  assert.match(specification, /service\/v1\/protocol\.schema\.json/u);
  const oq003 =
    questions.match(/## OQ-003:[\s\S]*?(?=\n## OQ-004:)/u)?.[0] ?? "";
  const oq004 =
    questions.match(/## OQ-004:[\s\S]*?(?=\n## OQ-005:)/u)?.[0] ?? "";
  assert.match(oq003, /\*\*State:\*\* Resolved/u);
  assert.match(oq004, /\*\*State:\*\* Resolved/u);

  const bk016 = backlog.match(/^\| BK-016 .*$/mu)?.[0] ?? "";
  const bk017 = backlog.match(/^\| BK-017 .*$/mu)?.[0] ?? "";
  assert.match(bk016, /^\| BK-016 \| Done\s+\|/u);
  assert.match(bk016, /\[evidence\]\(evidence\/BK-016\.md\)/u);
  assert.doesNotMatch(bk016.split("|")[5] ?? "", /OQ-00[34]/u);
  assert.match(bk017, /^\| BK-017 \| Ready\s+\|/u);
});

test("service protocol schema is strict and covers success, error, and boundaries", () => {
  const commonSchema = JSON.parse(read("schemas/bookie-common.schema.json"));
  const schema = JSON.parse(read("schemas/service/v1/protocol.schema.json"));
  const ajv = createAjv();

  assert.equal(ajv.validateSchema(schema), true, ajv.errorsText(ajv.errors));
  ajv.addSchema(commonSchema);
  ajv.addSchema(schema);
  for (const name of Object.keys(schema.$defs)) {
    assert.doesNotThrow(
      () => ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }),
      `failed to compile public definition ${name}`,
    );
  }
  const validateSearch = ajv.compile({
    $ref: `${schema.$id}#/$defs/searchRequest`,
  });
  const validateError = ajv.compile({
    $ref: `${schema.$id}#/$defs/errorResponse`,
  });
  const validatePath = ajv.compile({
    $ref: `${schema.$id}#/$defs/canonicalPath`,
  });
  const validateUid = ajv.compile({
    $ref: `${schema.$id}#/$defs/conceptUid`,
  });
  const validateFreshness = ajv.compile({
    $ref: `${schema.$id}#/$defs/freshness`,
  });

  const validSearch = {
    schema_version: "1",
    vault: "team-ledger",
    query: "atomic generation",
    filters: {
      projects: ["/projects/demo/project.md"],
      types: ["Decision"],
      lifecycle: ["stable"],
      workflow: ["accepted"],
      sensitivity: ["internal"],
      trust: ["verified"],
      freshness: ["fresh"],
    },
    limit: 50,
  };
  assert.equal(
    validateSearch(validSearch),
    true,
    JSON.stringify(validateSearch.errors),
  );

  const unknown = structuredClone(validSearch);
  unknown.other_vault = "secret";
  assert.equal(
    validateSearch(unknown),
    false,
    "unknown request fields must fail",
  );

  const oversized = structuredClone(validSearch);
  oversized.query = "x".repeat(4097);
  assert.equal(validateSearch(oversized), false, "oversized queries must fail");

  for (const [field, value] of [
    ["trust", "trusted-by-rumor"],
    ["freshness", "recent-ish"],
  ]) {
    const invalidFilter = structuredClone(validSearch);
    invalidFilter.filters[field] = [value];
    assert.equal(
      validateSearch(invalidFilter),
      false,
      `${field} must be bounded`,
    );
  }

  assert.equal(
    validateError({
      schema_version: "1",
      code: "AUTH_INVALID",
      request_id: "req_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      retryable: false,
    }),
    true,
    JSON.stringify(validateError.errors),
  );
  assert.equal(
    validateError({
      schema_version: "1",
      code: "AUTH_INVALID",
      request_id: "req_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      retryable: false,
      detail: "token or vault name",
    }),
    false,
    "error responses must not expose value-bearing details",
  );

  assert.equal(
    validatePath("/valid^caret.md"),
    true,
    JSON.stringify(validatePath.errors),
  );
  for (const invalidPath of ["/../x.md", "/./x.md", "//x.md", "/x%2fy.md"]) {
    assert.equal(validatePath(invalidPath), false, `${invalidPath} must fail`);
  }
  assert.equal(validateUid("TSK-7ZZZZZZZZZZZZZZZZZZZZZZZZZ"), true);
  assert.equal(validateUid("TSK-8ZZZZZZZZZZZZZZZZZZZZZZZZZ"), false);
  assert.equal(
    validateFreshness({ state: "fresh", stale_after: "2026-09-15" }),
    true,
    JSON.stringify(validateFreshness.errors),
  );
  assert.equal(
    validateFreshness({ state: "fresh", stale_after: "2026-09-15T00:00:00Z" }),
    false,
  );
  assert.equal(validateFreshness({ state: "fresh", stale_after: null }), false);
  assert.equal(
    validateFreshness({ state: "unknown", stale_after: "2026-09-15" }),
    false,
  );
  assert.equal(
    validateFreshness({ state: "unknown", stale_after: null }),
    true,
  );

  const requestId = "req_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const jobId = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const buildId = `bld_${"a".repeat(64)}`;
  const commit = "b".repeat(40);
  const embeddingGeneration = `emb_${"c".repeat(64)}`;
  const trust = { level: "verified", verified_by: ["human:alice"] };
  const freshness = { state: "fresh", stale_after: "2026-09-15" };
  const result = {
    uid: "TSK-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    path: "/projects/demo/task.md",
    source_commit: commit,
    heading: "Outcome",
    excerpt: "Bounded untrusted text",
    type: "Task",
    lifecycle: "stable",
    workflow: "done",
    sensitivity: "internal",
    trust,
    freshness,
    score: {
      lexical: 1,
      semantic: null,
      fused: 0.5,
      adjustments: [{ signal: "trust", value: 0.1 }],
    },
    untrusted: true,
    truncated: false,
  };
  const payloads = {
    healthResponse: { schema_version: "1", status: "ok" },
    searchRequest: validSearch,
    searchResponse: {
      schema_version: "1",
      request_id: requestId,
      mode: "shared",
      build_id: buildId,
      embedding_generation: embeddingGeneration,
      source_commit: commit,
      degradation: "none",
      results: [result],
      truncated: false,
    },
    contextRequest: {
      schema_version: "1",
      vault: "team-ledger",
      references: [{ uid: result.uid, source_commit: commit }],
      max_bytes: 65536,
    },
    contextResponse: {
      schema_version: "1",
      request_id: requestId,
      mode: "shared",
      build_id: buildId,
      source_commit: commit,
      items: [
        {
          uid: result.uid,
          path: result.path,
          source_commit: commit,
          content: "Untrusted context",
          trust,
          freshness,
          untrusted: true,
          truncated: false,
        },
      ],
      truncated: false,
    },
    indexResponse: {
      schema_version: "1",
      request_id: requestId,
      indexes: [
        {
          vault: "team-ledger",
          status: "ready",
          active_build: buildId,
          source_commit: commit,
          embedding_generation: null,
        },
      ],
    },
    rebuildRequest: {
      schema_version: "1",
      vault: "team-ledger",
      source_commit: commit,
      embedding_generation: null,
    },
    rebuildResponse: {
      schema_version: "1",
      request_id: requestId,
      job_id: jobId,
      build_id: buildId,
      state: "queued",
    },
    rebuildStatusResponse: {
      schema_version: "1",
      request_id: requestId,
      job_id: jobId,
      build_id: buildId,
      vault: "team-ledger",
      source_commit: commit,
      state: "failed",
      failure_code: "VALIDATION_FAILED",
    },
    cancelResponse: {
      schema_version: "1",
      request_id: requestId,
      job_id: jobId,
      state: "cancelling",
    },
    activateRequest: {
      schema_version: "1",
      vault: "team-ledger",
      build_id: buildId,
      expected_active_build: null,
    },
    activateResponse: {
      schema_version: "1",
      request_id: requestId,
      active_build: buildId,
      previous_build: null,
      source_commit: commit,
    },
  };

  for (const [name, payload] of Object.entries(payloads)) {
    const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
    assert.equal(
      validate(payload),
      true,
      `${name}: ${JSON.stringify(validate.errors)}`,
    );
    assert.equal(
      validate({ ...payload, unexpected: true }),
      false,
      `${name} must reject unknown fields`,
    );
  }

  const validateIndexEntry = ajv.compile({
    $ref: `${schema.$id}#/$defs/indexEntry`,
  });
  assert.equal(
    validateIndexEntry({
      vault: "team-ledger",
      status: "ready",
      active_build: null,
      source_commit: null,
      embedding_generation: null,
    }),
    false,
    "ready indexes require a coherent active pointer",
  );
  assert.equal(
    validateIndexEntry({
      vault: "team-ledger",
      status: "unavailable",
      active_build: buildId,
      source_commit: commit,
      embedding_generation: null,
    }),
    false,
    "unavailable indexes cannot claim an active pointer",
  );

  const invalidWorkflow = structuredClone(result);
  invalidWorkflow.workflow = "invented";
  const validateResult = ajv.compile({
    $ref: `${schema.$id}#/$defs/searchResult`,
  });
  assert.equal(validateResult(invalidWorkflow), false);

  const invalidFailure = structuredClone(payloads.rebuildStatusResponse);
  invalidFailure.failure_code = null;
  const validateStatus = ajv.compile({
    $ref: `${schema.$id}#/$defs/rebuildStatusResponse`,
  });
  assert.equal(validateStatus(invalidFailure), false);
  for (const [state, failureCode] of [
    ["queued", null],
    ["building", null],
    ["verifying", null],
    ["evaluating", null],
    ["complete", null],
    ["cancelling", null],
    ["cancelled", "CANCELLED"],
    ["failed", "INTERRUPTED"],
  ]) {
    assert.equal(
      validateStatus({
        ...payloads.rebuildStatusResponse,
        state,
        failure_code: failureCode,
      }),
      true,
      `${state}: ${JSON.stringify(validateStatus.errors)}`,
    );
  }
  assert.equal(
    validateStatus({
      ...payloads.rebuildStatusResponse,
      state: "queued",
      failure_code: "INTERNAL",
    }),
    false,
  );

  const validateContextRequest = ajv.compile({
    $ref: `${schema.$id}#/$defs/contextRequest`,
  });
  assert.equal(
    validateContextRequest({
      ...payloads.contextRequest,
      references: Array.from({ length: 21 }, (_, index) => ({
        uid: `TSK-0${index.toString().padStart(25, "0")}`,
        source_commit: commit,
      })),
    }),
    false,
    "context references stop at 20",
  );
  assert.equal(
    validateContextRequest({ ...payloads.contextRequest, max_bytes: 65537 }),
    false,
    "context output requests stop at 64 KiB",
  );

  const validateIndexResponse = ajv.compile({
    $ref: `${schema.$id}#/$defs/indexResponse`,
  });
  const unavailableIndex = {
    vault: "team-ledger",
    status: "unavailable",
    active_build: null,
    source_commit: null,
    embedding_generation: null,
  };
  assert.equal(
    validateIndexResponse({
      schema_version: "1",
      request_id: requestId,
      indexes: Array.from({ length: 64 }, () => unavailableIndex),
    }),
    true,
  );
  assert.equal(
    validateIndexResponse({
      schema_version: "1",
      request_id: requestId,
      indexes: Array.from({ length: 65 }, () => unavailableIndex),
    }),
    false,
    "index listings stop at the grant cap",
  );

  const validateCancel = ajv.compile({
    $ref: `${schema.$id}#/$defs/cancelResponse`,
  });
  assert.equal(
    validateCancel({ ...payloads.cancelResponse, state: "complete" }),
    false,
  );
  const validateActivate = ajv.compile({
    $ref: `${schema.$id}#/$defs/activateRequest`,
  });
  assert.equal(
    validateActivate({
      ...payloads.activateRequest,
      expected_active_build: "bld_short",
    }),
    false,
  );
});
