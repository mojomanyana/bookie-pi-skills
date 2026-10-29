import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runIngestionProcess } from "../dist/ingestion-isolation.js";
import {
  prepareApprovedLexicalProjection,
  preflightDeploymentSource,
} from "../dist/ingestion.js";

const preflight = (root, request) =>
  preflightDeploymentSource(
    {
      handle: "demo",
      root,
      repositoryRoot: root,
      approvedRef: request.approvedRef,
      rollbackWindow: request.rollbackWindow,
      timeoutMs: request.timeoutMs,
      projection: request.config,
    },
    { sourceRef: request.sourceRef, timeoutMs: request.timeoutMs },
  );

test(
  "a remaining group with no visible members cannot establish teardown",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bookie-opaque-group-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = join(root, "reply.mjs");
    await writeFile(
      fixture,
      "process.once('message', () => process.send({ ok: true }));",
    );
    const cp = createRequire(import.meta.url)("node:child_process");
    const fork = cp.fork;
    const redirected = t.mock.method(cp, "fork", (_path, args, options) =>
      fork(fixture, args, options),
    );
    const kill = process.kill;
    // Preserve real SIGKILL/child close; only group-existence queries remain opaque.
    const opaque = t.mock.method(process, "kill", (pid, signal) =>
      signal === 0 ? true : Reflect.apply(kill, process, [pid, signal]),
    );
    syncBuiltinESMExports();
    try {
      assert.deepEqual(
        await runIngestionProcess(
          {},
          { timeoutMs: 2000, decode: () => ({ ok: true }) },
        ),
        { ok: false, reason: "ingestion-error" },
      );
    } finally {
      opaque.mock.restore();
      redirected.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

test(
  "unconfirmed teardown returns bounded failure and a late close cannot change it",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const operation of [prepareApprovedLexicalProjection, preflight]) {
      const root = await mkdtemp(join(tmpdir(), "bookie-ingestion-cleanup-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const fixture = join(root, "reply.mjs");
      await writeFile(
        fixture,
        "process.once('message', () => process.send({ ok: false, reason: 'source-not-approved' }));",
      );
      const cp = createRequire(import.meta.url)("node:child_process");
      const original = cp.fork;
      let lateClose;
      const mock = t.mock.method(cp, "fork", (_modulePath, args, options) => {
        const child = original(fixture, args, options);
        const emit = child.emit;
        child.emit = function (event, ...values) {
          // The real process is killed/reaped; hold only its teardown acknowledgement.
          if (event === "close") {
            lateClose = () => Reflect.apply(emit, this, [event, ...values]);
            return true;
          }
          return Reflect.apply(emit, this, [event, ...values]);
        };
        return child;
      });
      syncBuiltinESMExports();
      let timer;
      try {
        const pending = operation(root, {
          sourceRef: "a".repeat(40),
          approvedRef: "refs/heads/approved",
          rollbackWindow: 0,
          timeoutMs: 100,
          config: {
            vaultUid: "VLT-00000000000000000000000009",
            approvedSensitivityClasses: ["public"],
            maxChunkBytes: 8192,
            maxChunks: 250000,
          },
        });
        const result = await Promise.race([
          pending,
          new Promise((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Ingestion did not return within its deadline plus cleanup allowance.",
                  ),
                ),
              2500,
            );
          }),
        ]);
        assert.deepEqual(result, { ok: false, reason: "ingestion-error" });
        assert.equal(typeof lateClose, "function");
        lateClose();
        assert.deepEqual(await pending, result);
      } finally {
        clearTimeout(timer);
        mock.mock.restore();
        syncBuiltinESMExports();
      }
    }
  },
);
