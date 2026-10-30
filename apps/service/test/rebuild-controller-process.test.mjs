import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { OwnedRebuildController } from "../dist/rebuild-controller.js";
import { runIngestionProcess } from "../dist/ingestion-isolation.js";
import {
  configuration,
  authorization,
  commit,
  recipeFor,
  MemoryCandidateStore,
} from "./helpers/controller-fixture.mjs";

async function running(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(
      stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
    );
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

test(
  "controller cancellation acknowledges only after its real leader and descendant are stopped",
  { skip: process.platform !== "linux", timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "bookie-controller-process-"));
    const marker = join(root, "started.json");
    const fixture = join(root, "worker.mjs");
    await writeFile(
      fixture,
      `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; process.once('message',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);});`,
    );
    const cp = createRequire(import.meta.url)("node:child_process");
    const original = cp.fork;
    let group;
    const redirect = t.mock.method(cp, "fork", (_path, args, options) => {
      const child = original(fixture, args, options);
      group = child.pid;
      return child;
    });
    syncBuiltinESMExports();
    const config = configuration();
    const stores = new Map(
      config.sources.map((s) => [
        s.handle,
        new MemoryCandidateStore(s.projection.vaultUid),
      ]),
    );
    let controller;
    const builder = {
      async preflight(request) {
        return { ok: true, recipe: recipeFor(config, request.vault) };
      },
      async build(_recipe, { signal }) {
        return await runIngestionProcess(
          {},
          {
            signal,
            timeoutMs: 10000,
            decode: () => ({ ok: false, reason: "ingestion-error" }),
          },
        );
      },
    };
    controller = new OwnedRebuildController({
      configuration: config,
      stores,
      builder,
    });
    t.after(async () => {
      await controller.shutdown();
      redirect.mock.restore();
      syncBuiltinESMExports();
      if (group) {
        try {
          process.kill(-group, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    });
    await controller.start(async () => {});
    const job = await controller.submit({
      authorization,
      vault: "alpha",
      sourceRef: commit,
    });
    let pids;
    for (let n = 0; n < 150; n++) {
      try {
        pids = JSON.parse(await readFile(marker, "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await delay(10);
    }
    assert.equal(
      pids?.length,
      2,
      "synchronize both owned processes, not a guessed sleep",
    );
    for (const pid of pids) assert.equal(await running(pid), true);
    await controller.cancel({ authorization, jobId: job.jobId });
    const store = stores.get("alpha");
    for (
      let n = 0;
      n < 200 && (await store.readJob(job.jobId)).state !== "cancelled";
      n++
    )
      await delay(10);
    assert.equal((await store.readJob(job.jobId)).state, "cancelled");
    // No post-settlement polling may turn live-at-ack into a passing assertion.
    for (const pid of pids) assert.equal(await running(pid), false);
    assert.equal(store.calls.includes("attach"), false);
  },
);
