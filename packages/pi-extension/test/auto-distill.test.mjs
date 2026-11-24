import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distillSessionCheckpoint } from "../dist/auto-distill.js";

test("distillSessionCheckpoint writes an internal OKF note using PI_ECO_MODEL_FAST and blocks secrets", async () => {
  const vault = mkdtempSync(join(tmpdir(), "bookie-distill-"));
  const prevFast = process.env.PI_ECO_MODEL_FAST;
  process.env.PI_ECO_MODEL_FAST = "fireworks/glm-5p3-flash";
  let usedModel;
  try {
    const makeCtx = (text, llmReply) => ({
      cwd: vault,
      hasUI: false,
      model: { provider: "google", id: "gemini-3.8-flash" },
      modelRegistry: {
        find: (provider, id) => ({ provider, id }),
        streamSimple: (model) => {
          usedModel = model;
          return {
            result: async () => ({
              content: [{ type: "text", text: llmReply }],
            }),
          };
        },
      },
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: { role: "user", content: [{ type: "text", text }] },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Implemented sliding window eviction and verified all tests pass.",
                },
              ],
            },
          },
        ],
      },
    });

    const ok = await distillSessionCheckpoint(
      makeCtx(
        "Fix rate limiter concurrency and stale key eviction.",
        JSON.stringify({
          title: "Rate limiter concurrency fix",
          summary:
            "Added per-key mutex and expired key eviction in src/limiter.mjs.",
        }),
      ),
      vault,
    );
    assert.equal(ok.saved, true);
    assert.ok(ok.path);
    assert.deepEqual(usedModel, { provider: "fireworks", id: "glm-5p3-flash" });
    const written = readFileSync(ok.path, "utf8");
    assert.match(written, /"sensitivity":"internal"/);
    assert.match(written, /"type":"Activity"/);
    assert.match(written, /Rate limiter concurrency fix/);

    const blocked = await distillSessionCheckpoint(
      makeCtx(
        "Fix auth token handling",
        JSON.stringify({
          title: "Leaked token",
          summary:
            "Used token ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD in prod.",
        }),
      ),
      vault,
    );
    assert.equal(blocked.saved, false);
    assert.equal(blocked.reason, "secret-detected-in-output");
  } finally {
    if (prevFast === undefined) delete process.env.PI_ECO_MODEL_FAST;
    else process.env.PI_ECO_MODEL_FAST = prevFast;
    rmSync(vault, { recursive: true, force: true });
  }
});
