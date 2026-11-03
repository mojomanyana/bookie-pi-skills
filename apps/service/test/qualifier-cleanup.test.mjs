import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import test from "node:test";

const unconfirmed = "Runtime container teardown unconfirmed.";

async function runner(t, mode = "runtime", count = 1) {
  const child = fork(
    new URL("./helpers/qualifier-runner.mjs", import.meta.url),
    [mode, String(count)],
    { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [] },
  );
  const events = [];
  const waiting = new Set();
  let stderr = "";
  let exited = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const receive = (event) => {
    events.push(event);
    for (const notify of waiting) notify();
  };
  child.on("message", receive);
  child.on("error", (error) => receive({ event: "error", error }));
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      exited = true;
      receive({ event: "close", code, signal });
      resolve({ code, signal });
    }),
  );
  t.after(async () => {
    if (!exited) child.kill("SIGKILL");
    await closed;
    assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  });
  const wait = (predicate) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(Error("Synthetic CLI stalled.")),
        5000,
      );
      function finish(error, value) {
        clearTimeout(timer);
        waiting.delete(notify);
        if (error) reject(error);
        else resolve(value);
      }
      function notify() {
        const value = events.find(predicate);
        if (value) finish(undefined, value);
        else if (exited)
          finish(Error(`Runner settled before boundary: ${stderr}`));
      }
      waiting.add(notify);
      notify();
    });
  let token = 0;
  const send = (message) => {
    assert.equal(exited, false, "runner must still own pending work");
    child.send(message);
  };
  const commands = (operation) =>
    events.filter(
      (event) => event.event === "command" && event.args[0] === operation,
    );
  const command = (operation, index = 0) =>
    wait((event) => event === commands(operation)[index]);
  const close = (entry, code = 0, stdout = "", extra = {}) =>
    send({ action: "close", id: entry.id, code, stdout, ...extra });
  const barrier = async () => {
    const id = ++token;
    send({ action: "barrier", token: id });
    await wait((event) => event.event === "barrier" && event.token === id);
    assert.equal(
      events.some((event) => event.event === "result"),
      false,
    );
    assert.equal(exited, false);
  };
  const absence = async (index = 0, stdout = "", removalIndex = index) => {
    const proof = await command("ps", index);
    assert.equal(proof.timeout, 15000);
    assert.deepEqual(proof.args, [
      "ps",
      "-a",
      "--filter",
      `name=^/${commands("rm")[removalIndex].args[2]}$`,
      "--format",
      "{{.ID}}",
    ]);
    close(proof, 0, stdout);
    return proof;
  };
  const first = await command(
    mode === "extract" || mode === "mutate" ? "create" : "run",
  );
  return {
    child,
    events,
    commands,
    command,
    first,
    close,
    send,
    wait,
    barrier,
    absence,
    closed,
    get stderr() {
      return stderr;
    },
  };
}

for (const failure of ["exit", "timeout"])
  test(`runtime ${failure} identifies only the allowlisted operation after cleanup`, async (t) => {
    const r = await runner(t);
    assert.equal(r.first.timeout, 45000);
    const stderr =
      "PRIVATE_PAYLOAD\nQUALIFICATION trusted-builder stage=output-canonical\n";
    if (failure === "timeout") {
      // Observe the stage before the unchanged command deadline expires.
      r.send({ action: "stderr", id: r.first.id, stderr });
      r.send({ action: "tick", ms: 45000 });
      await r.wait(
        (event) => event.event === "kill" && event.id === r.first.id,
      );
    } else r.close(r.first, 1, "PRIVATE_OUTPUT", { stderr });
    const removal = await r.command("rm");
    await r.barrier();
    if (failure === "timeout") r.close(r.first, 137);
    r.close(removal);
    await r.absence();
    assert.deepEqual(await r.wait((event) => event.event === "result"), {
      event: "result",
      ok: false,
      message: "Runtime qualification command failed.",
      category: "runtime-driver",
      stage: "output-canonical",
    });
    await r.closed;
    assert.match(
      r.stderr,
      /QUALIFICATION category=runtime-driver stage=output-canonical/u,
    );
    assert.equal(r.stderr.includes("PRIVATE_"), false);
  });

test("unrecognized diagnostic stages cannot echo arbitrary dependency data", async (t) => {
  const r = await runner(t);
  r.close(r.first, 1, "PRIVATE_OUTPUT", {
    stderr: "QUALIFICATION trusted-builder stage=PRIVATE_SOURCE_KEY\n",
  });
  r.close(await r.command("rm"));
  await r.absence();
  assert.deepEqual(await r.wait((event) => event.event === "result"), {
    event: "result",
    ok: false,
    message: "Runtime qualification command failed.",
    category: "runtime-driver",
  });
  await r.closed;
  assert.equal(r.stderr.includes("PRIVATE_"), false);
});

test("cancellation and attached close share one teardown through exact absence", async (t) => {
  const r = await runner(t);
  r.child.kill("SIGTERM");
  const removal = await r.command("rm");
  assert.equal(removal.timeout, 15000);
  r.close(r.first, 137);
  await r.barrier();
  assert.equal(
    r.commands("rm").length,
    1,
    "finalizer must join pending removal",
  );
  r.send({ action: "late-operation" });
  await r.barrier();
  assert.equal(
    r.commands("run").length,
    1,
    "shutdown must not dispatch new work",
  );
  assert.equal(
    r.events.some((event) => event.event === "late-result"),
    false,
  );
  // Both a repeated signal and the other cancellation signal join the lifecycle.
  r.child.kill("SIGTERM");
  r.child.kill("SIGINT");
  await r.barrier();
  assert.equal(r.commands("rm").length, 1);
  r.close(removal);
  await r.command("ps");
  await r.barrier();
  await r.absence();
  assert.deepEqual(await r.closed, { code: 1, signal: null });
  assert.equal(r.stderr.includes("teardown unconfirmed"), false);
});

test("operation rejection cannot settle the parent ahead of cancellation drain", async (t) => {
  const r = await runner(t, "command");
  const operation = await r.command("version");
  r.child.kill("SIGTERM");
  const removal = await r.command("rm");
  r.close(operation, 1, "", { stderr: "PRIVATE_COMMAND_ERROR" });
  await r.barrier();
  r.close(r.first, 137);
  await r.barrier();
  r.close(removal);
  await r.absence();
  assert.deepEqual(await r.closed, { code: 1, signal: null });
});

test("a finalizer already removing when cancellation starts also joins the whole drain", async (t) => {
  const r = await runner(t, "runtime", 2);
  const other = await r.command("run", 1);
  r.close(r.first);
  const firstRemoval = await r.command("rm");
  r.child.kill("SIGTERM");
  const otherRemoval = await r.command("rm", 1);
  r.close(firstRemoval, 1);
  await r.barrier();
  r.close(other, 137);
  r.close(otherRemoval);
  await r.absence(0, "", 1);
  assert.deepEqual(await r.closed, { code: 1, signal: null });
  assert.equal(r.commands("rm").length, 2);
  assert.match(r.stderr, /Runtime container\/child teardown unconfirmed\./u);
});

for (const mode of ["runtime", "docker", "extract", "mutate"])
  test(`${mode} finalizer does not publish success before acknowledged removal and absence`, async (t) => {
    const r = await runner(t, mode);
    if (mode === "extract" || mode === "mutate") {
      r.close(r.first);
      const next = await r.command(mode === "extract" ? "cp" : "start");
      r.close(next);
      if (mode === "mutate")
        r.close(await r.command("commit"), 0, "synthetic-image");
    } else r.close(r.first, 0, "synthetic-output");
    const removal = await r.command("rm");
    await r.barrier();
    r.close(removal);
    await r.command("ps");
    await r.barrier();
    await r.absence();
    const result = await r.wait((event) => event.event === "result");
    assert.equal(result.ok, true);
    assert.equal(r.commands("rm").length, 1);
    assert.deepEqual(await r.closed, { code: 0, signal: null });
  });

for (const failure of [
  "remove",
  "no-such",
  "lost-ack",
  "observation",
  "nonempty",
])
  test(`cleanup ${failure} stays a static failure, never a successful record or mutation retry`, async (t) => {
    const r = await runner(t);
    r.close(r.first, 0, "synthetic-output");
    const removal = await r.command("rm");
    if (failure === "lost-ack") {
      r.send({ action: "error", id: removal.id });
      r.close(removal);
    } else if (failure === "remove" || failure === "no-such") {
      r.close(removal, 1, "", {
        stderr:
          failure === "no-such"
            ? "No such container: private"
            : "PRIVATE_REMOVE_ERROR",
      });
      // Even an independently empty observation cannot turn failed rm into success.
      if (failure === "no-such") {
        const next = await r.wait(
          (event) =>
            event.event === "result" ||
            (event.event === "command" && event.args[0] === "ps"),
        );
        if (next.event === "command") r.close(next);
      }
    } else {
      r.close(removal);
      const proof = await r.command("ps");
      r.close(
        proof,
        failure === "observation" ? 1 : 0,
        failure === "nonempty" ? "owned-id" : "",
        { stderr: "PRIVATE_OBSERVATION_ERROR" },
      );
    }
    const result = await r.wait((event) => event.event === "result");
    assert.deepEqual(result, {
      event: "result",
      ok: false,
      message: unconfirmed,
    });
    assert.equal(r.commands("rm").length, 1);
    await r.closed;
    assert.equal(r.stderr.includes("PRIVATE_"), false);
  });

test("one failed owned removal cannot abandon another teardown or its clients", async (t) => {
  const r = await runner(t, "runtime", 2);
  const other = await r.command("run", 1);
  r.child.kill("SIGTERM");
  const firstRemoval = await r.command("rm");
  const otherRemoval = await r.command("rm", 1);
  r.close(firstRemoval, 1, "", { stderr: "PRIVATE_REMOVE_ERROR" });
  r.close(other, 137);
  await r.barrier();
  assert.equal(r.commands("rm").length, 2);
  r.close(otherRemoval);
  await r.absence(0, "", 1); // Only the successful removal is observed.
  await r.wait((event) => event.event === "kill" && event.id === r.first.id);
  await r.barrier();
  r.close(r.first, 137);
  assert.deepEqual(await r.closed, { code: 1, signal: null });
  assert.match(r.stderr, /Runtime container\/child teardown unconfirmed\./u);
  assert.equal(r.stderr.includes("PRIVATE_"), false);
});

test("unconfirmed client drain fails within its one-second allowance", async (t) => {
  const r = await runner(t);
  r.child.kill("SIGTERM");
  r.close(await r.command("rm"), 1);
  await r.wait((event) => event.event === "kill" && event.id === r.first.id);
  await r.barrier();
  r.send({ action: "tick", ms: 999 });
  await r.barrier();
  r.send({ action: "tick", ms: 1 });
  assert.deepEqual(await r.closed, { code: 1, signal: null });
  assert.match(r.stderr, /Runtime container\/child teardown unconfirmed\./u);
  assert.equal(
    r.events.some((event) => event.event === "result" && event.ok),
    false,
  );
});

for (const signal of [undefined, "SIGINT", "SIGTERM"])
  test(`synthetic fixture ${signal ?? "normal"} joins container, clients and directory once`, async (t) => {
    const r = await runner(t, "fixture");
    r.close(r.first);
    const removal = await r.command("rm");
    if (signal) {
      r.child.kill(signal);
      r.child.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      r.send({ action: "late-registration" });
      assert.deepEqual(await r.wait((e) => e.event === "registration"), {
        event: "registration",
        ok: false,
        message: "Runtime fixture registration closed.",
      });
    }
    await r.barrier();
    r.close(removal);
    await r.absence();
    const clients = await r.wait(
      (e) => e.event === "callback" && e.kind === "clients",
    );
    await r.barrier();
    assert.equal(
      r.events.some((e) => e.kind === "directory"),
      false,
    );
    r.send({ action: "callback", id: clients.id });
    const directory = await r.wait(
      (e) => e.event === "callback" && e.kind === "directory",
    );
    await r.barrier();
    r.send({ action: "callback", id: directory.id });
    if (!signal)
      assert.equal((await r.wait((e) => e.event === "result")).ok, true);
    assert.deepEqual(await r.closed, { code: signal ? 1 : 0, signal: null });
    assert.equal(r.commands("rm").length, 1);
    assert.equal(r.events.filter((e) => e.kind === "clients").length, 1);
    assert.equal(r.events.filter((e) => e.kind === "directory").length, 1);
  });

for (const failure of [
  "container",
  "clients",
  "directory",
  "hung-clients",
  "hung-directory",
])
  test(`synthetic fixture ${failure} drains other resources without false directory proof`, async (t) => {
    const r = await runner(t, "fixture", 2);
    const other = await r.command("run", 1);
    r.child.kill("SIGTERM");
    r.close(r.first, 137);
    r.close(other, 137);
    const removals = [await r.command("rm"), await r.command("rm", 1)];
    r.close(removals[0], failure === "container" ? 1 : 0);
    r.close(removals[1]);
    await r.absence(0, "", failure === "container" ? 1 : 0);
    if (failure !== "container") await r.absence(1);
    const a = await r.wait((e) => e.id === "clients-0");
    const b = await r.wait((e) => e.id === "clients-1");
    r.send({ action: "callback", id: b.id });
    const otherDirectory = await r.wait((e) => e.id === "directory-1");
    r.send({ action: "callback", id: otherDirectory.id });
    if (failure !== "hung-clients")
      r.send({ action: "callback", id: a.id, fail: failure === "clients" });
    if (["directory", "hung-directory"].includes(failure)) {
      const directory = await r.wait((e) => e.id === "directory-0");
      if (failure === "directory")
        r.send({ action: "callback", id: directory.id, fail: true });
    }
    if (failure.startsWith("hung")) {
      r.send({ action: "tick", ms: 999 });
      await r.barrier();
      r.send({ action: "late-registration" });
      assert.equal((await r.wait((e) => e.event === "registration")).ok, false);
      r.send({ action: "tick", ms: 1 });
    }
    assert.deepEqual(await r.closed, { code: 1, signal: null });
    assert.equal(r.commands("rm").length, 2);
    assert.equal(r.stderr.includes("PRIVATE_"), false);
    assert.equal(
      r.events.some((e) => e.event === "result" && e.ok),
      false,
    );
    if (["container", "clients", "hung-clients"].includes(failure))
      assert.equal(
        r.events.some((e) => e.id === "directory-0"),
        false,
      );
  });

test("synthetic client and external directory work share the same remaining one-second deadline", async (t) => {
  const r = await runner(t, "fixture");
  r.close(r.first);
  r.close(await r.command("rm"));
  await r.absence();
  const clients = await r.wait((e) => e.kind === "clients");
  r.send({ action: "tick", ms: 600 });
  r.send({ action: "callback", id: clients.id });
  await r.wait((e) => e.kind === "directory");
  r.send({ action: "tick", ms: 399 });
  await r.barrier();
  r.send({ action: "tick", ms: 1 });
  assert.equal((await r.wait((e) => e.event === "result")).ok, false);
  await r.closed;
  assert.equal(r.events.filter((e) => e.kind === "directory").length, 1);
  assert.equal(r.commands("rm").length, 1);
});

test("synthetic completed fixture cannot cache away later ordinary-client cancellation drain", async (t) => {
  const r = await runner(t, "fixture-later");
  r.close(r.first);
  r.close(await r.command("rm"));
  await r.absence();
  for (const kind of ["clients", "directory"]) {
    const c = await r.wait((e) => e.kind === kind);
    r.send({ action: "callback", id: c.id });
  }
  const later = await r.command("run", 1);
  r.child.kill("SIGTERM");
  r.close(await r.command("rm", 1));
  await r.absence(1);
  await r.wait((e) => e.event === "kill" && e.id === later.id);
  await r.barrier();
  r.close(later, 137);
  assert.deepEqual(await r.closed, { code: 1, signal: null });
  assert.equal(r.commands("rm").length, 2);
});

// Invoke the same callback wired into runtime.test.mjs's enclosing t.after.
// Engine replies are synthetic; directory preservation/deletion is real.
for (const [mode, failure] of [
  ["workspace", "remove"],
  ["workspace", "lost-ack"],
  ["workspace", "clients"],
  ["workspace-setup", "remove"],
  ["workspace-setup", "lost-ack"],
  ["workspace", undefined],
])
  test(`actual enclosing finalizer ${mode} ${failure ?? "success"} retains the fixture ownership boundary under reentry`, async (t) => {
    const setup = mode === "workspace-setup";
    const count = setup ? 1 : 2;
    const r = await runner(t, mode, count);
    const workspace = await r.wait((e) => e.event === "workspace");
    assert.equal(
      dirname(workspace.parent),
      resolve(import.meta.dirname, "../../../.principal"),
    );
    assert.match(basename(workspace.parent), /^outer-cleanup-[a-zA-Z0-9]+$/u);
    assert.equal(
      spawnSync("git", ["check-ignore", "--quiet", workspace.parent]).status,
      0,
    );
    t.after(async () => {
      if (r.child.exitCode === null && r.child.signalCode === null)
        r.child.kill("SIGKILL");
      await r.closed;
      // Supervised disposal only after observing intentionally retained failure state.
      await rm(workspace.parent, { recursive: true, force: true });
      await assert.rejects(lstat(workspace.parent), { code: "ENOENT" });
    });
    const directory = setup
      ? r.first.args
          .find((arg) => arg.startsWith("type=bind,src="))
          .slice("type=bind,src=".length)
          .split(",dst=")[0]
      : workspace.directory;
    assert.equal((await lstat(directory)).isDirectory(), true);
    r.close(r.first, setup ? 1 : 0, "", { stderr: "PRIVATE_SETUP_ERROR" });
    if (setup) {
      // The failed setup client's own acknowledged removal is independent of
      // the already-registered Redis owner, whose removal is tested below.
      r.close(await r.command("rm"));
      await r.absence();
    } else r.close(await r.command("run", 1));
    const removals = [];
    for (let i = 0; i < count; i++)
      removals.push(await r.command("rm", i + (setup ? 1 : 0)));
    // Normal inner cleanup, enclosing cleanup and reentrant finalizers must join.
    r.send({ action: "finalize-workspace" });
    r.send({ action: "finalize-workspace" });
    for (let i = 0; i < count; i++) {
      const removal = removals[i];
      if (i === 0 && failure === "lost-ack")
        r.send({ action: "error", id: removal.id });
      r.close(removal, i === 0 && failure === "remove" ? 1 : 0);
      if (i !== 0 || !["remove", "lost-ack"].includes(failure)) {
        const proof = await r.wait(
          (e) =>
            e.event === "command" &&
            e.args[0] === "ps" &&
            e.args.includes(`name=^/${removal.args[2]}$`),
        );
        r.close(proof);
      }
    }
    if (!setup) {
      for (let i = count - 1; i >= 0; i--) {
        const clients = await r.wait((e) => e.id === `clients-${i}`);
        if (i === 0 && failure === "clients") continue;
        r.send({ action: "callback", id: clients.id });
        if (i !== 0 || failure === undefined) {
          const dependent = await r.wait((e) => e.id === `directory-${i}`);
          r.send({ action: "callback", id: dependent.id });
        }
      }
      if (failure === "clients") {
        r.send({ action: "tick", ms: 999 });
        await r.barrier();
        r.send({ action: "tick", ms: 1 });
      }
    }
    const result = await r.wait((e) => e.event === "result");
    assert.deepEqual(await r.closed, { code: 0, signal: null });
    assert.equal(r.stderr.includes("PRIVATE_"), false);
    for (const removal of removals)
      assert.equal(
        r.commands("rm").filter((e) => e.args[2] === removal.args[2]).length,
        1,
      );
    if (setup)
      assert.deepEqual(await r.wait((e) => e.event === "setup-settled"), {
        event: "setup-settled",
        fixtureReturned: false,
      });
    const retained = await lstat(directory).then(
      () => true,
      (error) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    );
    t.diagnostic(
      JSON.stringify({
        parentChowns: r
          .commands("run")
          .filter((e) => e.args.at(-1).startsWith("chown -R")).length,
        parentDeletes: r.events.filter((e) => e.event === "parent-delete")
          .length,
        directoryRetained: retained,
      }),
    );
    if (failure) {
      assert.deepEqual(result, {
        event: "result",
        ok: false,
        message: "Runtime container/child teardown unconfirmed.",
      });
      assert.equal(
        r.commands("run").filter((e) => e.args.at(-1).startsWith("chown -R"))
          .length,
        0,
        "uncertainty must not dispatch privileged parent chown",
      );
      assert.equal(
        r.events.filter((e) => e.event === "parent-delete").length,
        0,
        "uncertainty must not dispatch recursive parent deletion",
      );
      assert.equal(retained, true);
      assert.equal(r.events.filter((e) => e.id === "directory-0").length, 0);
      assert.equal(
        r.events.filter((e) => e.event === "workspace-record").length,
        0,
      );
      assert.equal(
        r.commands("image").length,
        2,
        "independent images still drain once",
      );
      t.diagnostic(
        "Synthetic failure state retained before exact supervised directory disposal.",
      );
    } else {
      assert.equal(result.ok, true);
      assert.equal(
        r.commands("run").filter((e) => e.args.at(-1).startsWith("chown -R"))
          .length,
        1,
      );
      assert.equal(
        r.events.filter((e) => e.event === "parent-delete").length,
        1,
      );
      await assert.rejects(lstat(workspace.parent), { code: "ENOENT" });
      assert.equal(
        r.events.filter((e) => e.event === "workspace-record").length,
        1,
      );
      assert.equal(r.commands("image").length, 0);
    }
    if (!setup) {
      assert.equal(r.events.filter((e) => e.id === "clients-0").length, 1);
      assert.equal(r.events.filter((e) => e.id === "clients-1").length, 1);
      assert.equal(
        r.events.filter((e) => e.id === "directory-1").length,
        1,
        "independent fixture directory drains despite failure",
      );
      await assert.rejects(lstat(join(workspace.parent, "fixture-1")), {
        code: "ENOENT",
      });
    }
    assert.deepEqual(
      r.events.filter((e) => e.event === "workspace-reentry"),
      Array.from({ length: 2 }, () =>
        failure
          ? {
              event: "workspace-reentry",
              ok: false,
              message: "Runtime container/child teardown unconfirmed.",
            }
          : { event: "workspace-reentry", ok: true },
      ),
    );
  });

for (const operation of ["rm", "ps"])
  test(`${operation} deadline keeps uncertain ownership and drains late clients without replay`, async (t) => {
    const r = await runner(t);
    r.child.kill("SIGTERM");
    const removal = await r.command("rm");
    if (operation === "ps") r.close(removal);
    const pending = await r.command(operation);
    r.send({ action: "tick", ms: 14999 });
    await r.barrier();
    assert.equal(
      r.events.some((event) => event.event === "kill"),
      false,
    );
    r.send({ action: "tick", ms: 1 });
    await r.wait((event) => event.event === "kill" && event.id === pending.id);
    await r.barrier();
    r.close(pending); // A late successful acknowledgement must not revive cleanup.
    r.close(r.first, 137);
    assert.deepEqual(await r.closed, { code: 1, signal: null });
    assert.equal(r.commands("rm").length, 1);
    assert.equal(r.commands("ps").length, operation === "ps" ? 1 : 0);
    assert.match(r.stderr, /Runtime container\/child teardown unconfirmed\./u);
  });
