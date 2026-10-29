import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import * as assembly from "../dist/build-input-assembly.js";
import * as qualification from "../dist/runtime-qualification.js";

const invalidRuntime = {
  name: "TypeError",
  message: "Runtime qualification failed.",
};

test("qualified recipe assembly rejects structural runtime approvals before producing any recipe", () => {
  assert.equal(typeof assembly.assembleQualifiedInputRecipe, "function");
  for (const fake of [
    undefined,
    true,
    "sha256:" + "0".repeat(64),
    { hash: "sha256:" + "0".repeat(64) },
  ]) {
    assert.throws(() => assembly.assembleQualifiedInputRecipe({}, {}, fake), {
      name: "TypeError",
      message: "Build recipe assembly is invalid.",
    });
  }
});

test("expected identity startup cannot qualify a writable checkout or accept an inline approval", async (t) => {
  assert.equal(typeof qualification.loadBuildRuntime, "function");
  const root = await mkdtemp(join(tmpdir(), "bookie-expected-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "expected-runtime");
  for (const value of ["PRIVATE", "sha256:" + "0".repeat(64) + "\n"]) {
    await writeFile(path, value);
    await assert.rejects(qualification.loadBuildRuntime(path), invalidRuntime);
  }
  for (const value of [
    true,
    {},
    "sha256:" + "0".repeat(64),
    "relative",
    process.cwd() + "/apps/service/expected-runtime",
  ]) {
    await assert.rejects(qualification.loadBuildRuntime(value), invalidRuntime);
  }
  await assert.rejects(
    qualification.loadBuildRuntime(path, { approved: true }),
    invalidRuntime,
  );
});

test("private source work reuses token authentication and per-vault rebuild scope", async () => {
  const { createServiceAuthorizer } = await import("../dist/server.js");
  assert.equal(typeof createServiceAuthorizer, "function");
  const secret = "x".repeat(43);
  const authorize = createServiceAuthorizer([
    {
      id: "admin",
      digest: createHash("sha256").update(secret).digest("hex"),
      principal: "builder",
      not_before: "2020-01-01T00:00:00Z",
      expires_at: "2100-01-01T00:00:00Z",
      grants: [{ vault: "demo", scopes: ["rebuild:create"] }],
    },
  ]);
  for (const header of [
    undefined,
    "PRIVATE",
    "Bearer bka_admin_" + "y".repeat(43),
    [],
    {},
    1,
  ])
    assert.deepEqual(authorize(header, "demo", "rebuild:create"), {
      ok: false,
      reason: "auth-invalid",
    });
  assert.deepEqual(
    authorize("Bearer bka_admin_" + secret, "other", "rebuild:create"),
    { ok: false, reason: "auth-forbidden" },
  );
  assert.deepEqual(authorize("Bearer bka_admin_" + secret, "demo", "search"), {
    ok: false,
    reason: "auth-forbidden",
  });
  assert.deepEqual(
    authorize("Bearer bka_admin_" + secret, "demo", "rebuild:create"),
    { ok: true },
  );
});

test("trusted builder startup exposes no runtime path/hash/approval request bypass", async () => {
  const api = await import("../dist/trusted-builder.js");
  assert.equal(typeof api.createTrustedLexicalBuilder, "function");
  const options = {
    runtimeIdentityFile: "/missing/deployment-runtime-identity",
    tokens: [],
    configuration: () => ({ epoch: 1, sources: [] }),
  };
  for (const patch of [
    { runtimeRoot: process.cwd() },
    { runtimeArtifactHash: "sha256:" + "0".repeat(64) },
    { qualified: true },
    { preflightReceipt: {} },
  ]) {
    await assert.rejects(
      api.createTrustedLexicalBuilder({ ...options, ...patch }),
      {
        name: "TypeError",
        message: "Trusted builder configuration is invalid.",
      },
    );
  }
  await assert.rejects(
    api.createTrustedLexicalBuilder(options),
    invalidRuntime,
  );
});
