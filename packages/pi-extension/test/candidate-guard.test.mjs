import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { guardBookieTool } from "../dist/output-guard.js";

// A synthetic host ticket isolates result shaping; real scope is exercised by
// auto-project/disclosure tests. It is not a route to production authorization.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "bookie-candidate-guard-"));
  await cp(
    resolve(import.meta.dirname, "../../../fixtures/valid-vault"),
    root,
    { recursive: true },
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  let current = true;
  const ticket = {
    root,
    managedWorkspace: true,
    scope: { project: { path: "/projects/fixture/project.md" } },
    allows: () => true,
    assertCurrent: async () => {
      if (!current) throw Error("Changed synthetic authority");
    },
  };
  const guarded = guardBookieTool(
    {
      name: "bookie_search",
      execute: () => {
        throw Error("Managed search must use guarded recall");
      },
    },
    {
      selectedRoot: async () => root,
      capture: async () => ticket,
    },
    (_name, result) => result,
  );
  return {
    root,
    revoke: () => {
      current = false;
    },
    search: (args, signal) =>
      guarded.execute("candidate-test", args, signal, undefined, { cwd: root }),
  };
}

test("only complete strict zero-match results offer candidate next steps", async (t) => {
  const f = await fixture(t);
  const empty = await f.search({ query: "unfindableterm" });
  assert.equal(empty.complete, true);
  assert.equal(empty.matchedCount, 0);
  assert.match(empty.nextStep, /mode=candidates/);
  const suggestions = await f.search({
    mode: "candidates",
    query: "unfindableterm",
  });
  assert.equal(suggestions.complete, true);
  assert.equal(suggestions.nextStep, undefined);
  assert.match(suggestions.interpretation, /does not establish empty history/);
  await writeFile(
    join(f.root, "projects/fixture/broken.md"),
    "---\n{ invalid\n---\nUnrelated malformed record.\n",
  );
  const partial = await f.search({ query: "unfindableterm" });
  assert.equal(partial.complete, false);
  assert.equal(partial.scanComplete, false);
  assert.equal(partial.nextStep, undefined);
});

test("candidate cancellation and changed authority do not return a fallback or leak causes", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.search({ mode: "candidates", query: "fixture" }, controller.signal),
    { name: "AbortError" },
  );
  const visible = await f.search({ mode: "candidates", query: "fixture" });
  assert.ok(visible.results.length > 0);
  f.revoke();
  await assert.rejects(
    f.search({ mode: "candidates", query: "fixture" }),
    (error) =>
      /withheld/.test(error.message) && !error.message.includes("synthetic"),
  );
});
