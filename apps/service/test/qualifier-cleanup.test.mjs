import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import test from "node:test";

const unconfirmed = "Runtime container teardown unconfirmed.";
const ignoringPolicy = "# Preserve this existing policy byte-for-byte.\n*\n";
const nonignoringPolicy = "# PRIVATE_IGNORE_POLICY\n!*\n";

// Only the bounded synthetic module closure is copied. Each invocation gets real
// Git and its own administrative state, never the caller's .principal or policy.
async function workspaceRepository(policy) {
  const parent = await mkdtemp(join(tmpdir(), "bqc-"));
  try {
    const bytes = policy === "ignoring" ? 56 : 51;
    const root = join(
      parent,
      "c".repeat(bytes - Buffer.byteLength(parent) - 1),
    );
    assert.equal(Buffer.byteLength(root), bytes);
    for (const path of [
      "scripts/qualify-runtime.mjs",
      "scripts/qualification-labels.mjs",
      "test/helpers/qualifier-runner.mjs",
      "test/helpers/owned-redis-fixture.mjs",
      "test/helpers/redis-socket.mjs",
    ]) {
      const destination = join(root, "apps/service", path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(new URL(`../${path}`, import.meta.url), destination);
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
    const git = (...args) =>
      spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" });
    assert.equal(git("init", "--quiet", "--template=").status, 0);
    if (policy !== "absent") {
      await mkdir(join(root, ".principal"));
      if (policy !== "missing")
        await writeFile(
          join(root, ".principal/.gitignore"),
          policy === "ignoring" ? ignoringPolicy : nonignoringPolicy,
          { flag: "wx" },
        );
    }
    if (policy === "absent")
      await assert.rejects(lstat(join(root, ".principal")), { code: "ENOENT" });
    else if (policy === "missing")
      await assert.rejects(lstat(join(root, ".principal/.gitignore")), {
        code: "ENOENT",
      });
    return { parent, root, env, git };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

async function runner(
  t,
  mode = "runtime",
  count = 1,
  policy = "absent",
  trace,
  consumeStderr = true,
) {
  const fixture = mode.startsWith("workspace")
    ? await workspaceRepository(policy)
    : undefined;
  let child, closed;
  t.after(async () => {
    if (child) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      // A failed pipe-exit assertion supervises only this owned child's pipe,
      // after terminating it; draining it is never settlement evidence.
      if (!consumeStderr) child.stderr.destroy();
      await closed;
      assert.equal(child.exitCode !== null || child.signalCode !== null, true);
    }
    if (fixture) {
      // Supervised disposal after assertions on intentionally retained state and
      // after the child/IPC lifetime has settled. Only this exact owned tree.
      await rm(fixture.parent, { recursive: true, force: true });
      await assert.rejects(lstat(fixture.parent), { code: "ENOENT" });
    }
  });
  child = fork(
    fixture
      ? join(fixture.root, "apps/service/test/helpers/qualifier-runner.mjs")
      : new URL("./helpers/qualifier-runner.mjs", import.meta.url),
    [mode, String(count), ...(trace ? [JSON.stringify(trace)] : [])],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: [],
      ...(fixture ? { cwd: fixture.root, env: fixture.env } : {}),
    },
  );
  const events = [];
  const waiting = new Set();
  let stderr = "";
  let exited = false;
  child.stderr.setEncoding("utf8");
  if (consumeStderr) child.stderr.on("data", (chunk) => (stderr += chunk));
  const terminated = new Promise((resolve) =>
    child.once("exit", (code, signal) =>
      resolve({
        code,
        signal,
        consumedBeforeExit: child.stderr.readableFlowing === true,
      }),
    ),
  );
  const receive = (event) => {
    events.push(event);
    for (const notify of waiting) notify();
  };
  child.on("message", receive);
  child.on("error", (error) => receive({ event: "error", error }));
  closed = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      exited = true;
      receive({ event: "close", code, signal });
      resolve({ code, signal });
    }),
  );
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
  const operation = ["extract", "mutate", "trace-copy-image"].includes(mode)
    ? "create"
    : "run";
  const first = await wait(
    (event) => event === commands(operation)[0] || event.event === "result",
  );
  if (mode === "trace-metadata")
    assert.equal(
      events.some(
        (e) =>
          e.event === "command" &&
          (e.args[0] === "version" ||
            e.args.includes("PRIVATE_METADATA_DRIVER")),
      ),
      false,
      "executable or inherited metadata must not dispatch a command",
    );
  return {
    fixture,
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
    terminated,
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

async function assertPrivateWorkspace(r, workspace) {
  assert.equal(dirname(workspace.parent), join(r.fixture.root, ".principal"));
  const info = await lstat(workspace.parent);
  assert.equal(info.isDirectory(), true);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o077, 0);
  assert.equal(
    r.fixture.git("check-ignore", "--quiet", workspace.parent).status,
    0,
  );
  // Independent worst-case socket spelling, not a relaxed/truncated guard.
  const socketBytes = Buffer.byteLength(
    join(workspace.parent, `r-${"a".repeat(16)}`, "redis.sock"),
  );
  assert.ok(socketBytes <= 107);
  assert.match(basename(workspace.parent), /^oc-[a-zA-Z0-9]+$/u);
  return socketBytes;
}

for (const policy of ["absent", "missing", "ignoring"])
  test(`synthetic workspace bootstraps ${policy} administrative policy at socket-safe checkout length`, async (t) => {
    const r = await runner(t, "workspace", 1, policy);
    assert.equal(r.first.event, "command");
    const workspace = await r.wait((e) => e.event === "workspace");
    const socketBytes = await assertPrivateWorkspace(r, workspace);
    if (policy === "ignoring") assert.equal(socketBytes, 107);
    assert.equal(
      await readFile(join(r.fixture.root, ".principal/.gitignore"), "utf8"),
      policy === "ignoring" ? ignoringPolicy : "*\n",
    );
    r.close(r.first);
    r.close(await r.command("rm"));
    await r.absence();
    for (const kind of ["clients", "directory"]) {
      const pending = await r.wait((e) => e.kind === kind);
      r.send({ action: "callback", id: pending.id });
    }
    assert.equal((await r.wait((e) => e.event === "result")).ok, true);
    assert.deepEqual(await r.closed, { code: 0, signal: null });
    await assert.rejects(lstat(workspace.parent), { code: "ENOENT" });
  });

test("synthetic workspace preserves nonignoring policy and fails statically before fixture or engine work", async (t) => {
  const r = await runner(t, "workspace", 1, "nonignoring");
  assert.deepEqual(r.first, {
    event: "result",
    ok: false,
    message: "Synthetic workspace bootstrap failed.",
  });
  assert.deepEqual(await r.closed, { code: 1, signal: null });
  assert.equal(
    r.events.some((e) => e.event === "workspace"),
    false,
  );
  assert.equal(
    r.events.some((e) => e.event === "command"),
    false,
  );
  assert.equal(r.stderr.includes("PRIVATE_"), false);
  assert.equal(r.stderr.includes(r.fixture.root), false);
  assert.equal(
    await readFile(join(r.fixture.root, ".principal/.gitignore"), "utf8"),
    nonignoringPolicy,
  );
  assert.deepEqual(await readdir(join(r.fixture.root, ".principal")), [
    ".gitignore",
  ]);
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
    await assertPrivateWorkspace(r, workspace);
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

const traceRecords = (r) =>
  r.stderr
    .split("\n")
    .filter((line) => line.startsWith("QUALIFICATION TRACE "))
    .map((line) => JSON.parse(line.slice("QUALIFICATION TRACE ".length)));
const tracedRunner = (t, mode = "runtime", limits = {}) =>
  runner(t, mode, 1, "absent", limits);
const finishSyntheticRuntime = async (r) => {
  r.close(r.first, 0, "PRIVATE_STDOUT");
  r.close(await r.command("rm"));
  await r.absence();
  assert.equal((await r.wait((e) => e.event === "result")).ok, true);
  await r.closed;
};

test("trace pairs copy and image commands with static body/finalizer callsites, never arguments", async (t) => {
  const r = await tracedRunner(t, "trace-copy-image");
  r.close(r.first);
  const copy = await r.command("cp");
  r.send({ action: "tick", ms: 37 });
  r.close(copy, 0, "PRIVATE_COPY_OUTPUT");
  r.close(await r.command("rm"));
  await r.absence();
  r.close(await r.command("image"));
  assert.equal((await r.wait((e) => e.event === "result")).ok, true);
  await r.closed;
  const records = traceRecords(r);
  assert.equal(new Set(records.map((e) => e.invocation)).size, 1);
  assert.match(records[0].invocation, /^[a-f0-9]{16}$/u);
  for (const [category, stage, context] of [
    ["container-copy", "runtime-extract-copy", "body"],
    ["image-command", "runtime-mutation-image-remove", "finalizer"],
  ]) {
    const start = records.find(
      (e) => e.event === "start" && e.category === category,
    );
    assert.ok(start);
    assert.equal(start.stage, stage);
    assert.equal(start.context, context);
    const paired = records.filter((e) => e.id === start.id);
    assert.deepEqual(
      paired.map((e) => e.event),
      ["start", "close", "settle"],
    );
    assert.equal(paired.at(-1).outcome, "ok");
    assert.equal(
      paired.at(-1).elapsedMs,
      category === "container-copy" ? 37 : 0,
    );
    assert.equal(start.capMs, 300000);
  }
  const owner = records.find(
    (e) => e.category === "ownership" && e.event === "start",
  );
  assert.deepEqual(
    records
      .filter((e) => e.id === owner.id && e.event === "proof")
      .map((e) => e.outcome),
    ["ack", "absent"],
  );
  assert.equal(
    records.find((e) => e.id === owner.id && e.event === "settle").outcome,
    "confirmed",
  );
  assert.equal(r.stderr.includes("PRIVATE_"), false);
});

for (const failure of ["deadline", "error"])
  test(`trace ${failure} settles once, preserves late close and cached owned cleanup`, async (t) => {
    const r = await tracedRunner(t);
    if (failure === "deadline") {
      r.send({ action: "tick", ms: 44999 });
      await r.barrier();
      assert.equal(
        traceRecords(r).some((e) => e.event === "deadline"),
        false,
      );
      r.send({ action: "tick", ms: 1 });
    } else r.send({ action: "error", id: r.first.id });
    const removal = await r.command("rm");
    r.close(r.first, 0, "PRIVATE_LATE_OUTPUT");
    r.close(removal);
    await r.absence();
    assert.equal((await r.wait((e) => e.event === "result")).ok, false);
    await r.closed;
    const records = traceRecords(r);
    const start = records.find(
      (e) => e.category === "runtime-driver" && e.event === "start",
    );
    const paired = records.filter((e) => e.id === start.id);
    assert.deepEqual(
      paired.map((e) => e.event),
      ["start", failure, "settle", "late-close"],
    );
    assert.equal(
      paired[2].outcome,
      failure === "deadline" ? "deadline" : "child-error",
    );
    assert.equal(paired[2].elapsedMs, failure === "deadline" ? 45000 : 0);
    assert.equal(r.commands("rm").length, 1);
    assert.equal(r.stderr.includes("PRIVATE_"), false);
  });

test("trace cancellation correlates ACK, exact absence and clients before dependent directory and success", async (t) => {
  const r = await tracedRunner(t, "fixture");
  r.close(r.first);
  const removal = await r.command("rm");
  r.child.kill("SIGTERM");
  r.child.kill("SIGINT");
  r.close(removal);
  await r.absence();
  const clients = await r.wait((e) => e.kind === "clients");
  await r.barrier();
  let records = traceRecords(r);
  assert.equal(
    records.some((e) => e.category === "fixture-directory"),
    false,
  );
  assert.equal(
    records.some((e) => e.category === "cancellation" && e.event === "settle"),
    false,
  );
  r.send({ action: "callback", id: clients.id });
  const directory = await r.wait((e) => e.kind === "directory");
  r.send({ action: "callback", id: directory.id });
  assert.deepEqual(await r.closed, { code: 1, signal: null });
  records = traceRecords(r);
  const index = (category, event, outcome) =>
    records.findIndex(
      (e) =>
        e.category === category &&
        e.event === event &&
        (outcome === undefined || e.outcome === outcome),
    );
  const ack = index("ownership", "proof", "ack");
  const absent = index("ownership", "proof", "absent");
  const closed = index("fixture-clients", "settle", "confirmed");
  const deleted = index("fixture-directory", "settle", "confirmed");
  assert.ok(ack >= 0 && ack < absent && absent < closed && closed < deleted);
  assert.equal(
    records.filter((e) => e.category === "cancellation" && e.event === "start")
      .length,
    1,
  );
  assert.equal(
    records.find(
      (e) => e.category === "container-remove" && e.event === "start",
    ).context,
    "finalizer",
  );
  assert.equal(r.commands("rm").length, 1);
  assert.equal(r.stderr.includes("PRIVATE_"), false);
});

for (const limits of [{ maxRecords: 4 }, { maxBytes: 1024 }])
  test(`trace finite ${Object.keys(limits)[0]} budget discloses incomplete evidence without abandoning cleanup`, async (t) => {
    const r = await tracedRunner(t, "runtime", limits);
    await finishSyntheticRuntime(r);
    const records = traceRecords(r);
    const lines = r.stderr
      .split("\n")
      .filter((s) => s.startsWith("QUALIFICATION TRACE "));
    assert.ok(records.length <= (limits.maxRecords ?? 8192));
    if (limits.maxRecords) assert.equal(records.length, limits.maxRecords);
    assert.ok(
      Buffer.byteLength(lines.join("\n") + "\n") <=
        (limits.maxBytes ?? 2097152),
    );
    assert.equal(records.filter((e) => e.event === "incomplete").length, 1);
    assert.equal(records.at(-1).outcome, "exhausted");
    const status = await r.wait((e) => e.event === "trace-status");
    assert.equal(status.complete, false);
    assert.equal(status.reason, "exhausted");
    assert.equal(r.commands("rm").length, 1);
    assert.equal(r.commands("ps").length, 1);
  });

test("trace rejects unknown stage/context/source/error without echo or dispatch, retaining a valid control", async (t) => {
  const r = await tracedRunner(t, "trace-invalid");
  await finishSyntheticRuntime(r);
  assert.deepEqual(
    r.events.filter((e) => e.event === "validation"),
    Array.from({ length: 4 }, () => ({
      event: "validation",
      ok: false,
      message: "Runtime trace labels invalid.",
    })),
  );
  assert.equal(r.commands("version").length, 0);
  assert.equal(r.stderr.includes("PRIVATE_"), false);
  assert.equal(
    (await r.wait((e) => e.event === "trace-status")).complete,
    true,
  );
});

for (const mode of ["trace-write-error", "trace-write-short"])
  test(`${mode} is observable but cannot discard already-owned cleanup or change command outcome`, async (t) => {
    const r = await tracedRunner(t, mode);
    await finishSyntheticRuntime(r);
    const status = await r.wait((e) => e.event === "trace-status");
    assert.equal(status.complete, false);
    assert.equal(status.reason, "write-error");
    assert.equal(r.commands("rm").length, 1);
    assert.equal(r.commands("ps").length, 1);
    assert.equal(r.stderr.includes("PRIVATE_"), false);
  });

for (const [mode, limits, reason] of [
  ["workspace", { maxRecords: 4 }, "exhausted"],
  ["workspace", { maxBytes: 1024 }, "exhausted"],
  ["workspace-trace-write-error", {}, "write-error"],
  ["workspace-trace-unavailable", {}, undefined],
])
  test(`incomplete trace ${mode}/${Object.keys(limits)[0] ?? reason ?? "unavailable"} rejects qualification after independent cleanup, never individual commands`, async (t) => {
    const r = await runner(t, mode, 1, "absent", limits);
    const workspace = await r.wait((e) => e.event === "workspace");
    r.close(r.first);
    const removal = await r.command("rm");
    r.send({ action: "finalize-workspace" });
    r.send({ action: "finalize-workspace" });
    await r.barrier();
    r.close(removal);
    await r.absence();
    for (const kind of ["clients", "directory"]) {
      const pending = await r.wait((e) => e.kind === kind);
      r.send({ action: "callback", id: pending.id });
    }
    const result = await r.wait((e) => e.event === "result");
    assert.deepEqual(result, {
      event: "result",
      ok: false,
      message: "Runtime qualification trace incomplete; record withheld.",
    });
    assert.deepEqual(await r.closed, { code: 1, signal: null });
    assert.deepEqual(
      r.events.filter((e) => e.event === "workspace-reentry"),
      Array.from({ length: 2 }, () => ({
        event: "workspace-reentry",
        ok: false,
        message: "Runtime qualification trace incomplete; record withheld.",
      })),
    );
    await assert.rejects(lstat(workspace.parent), { code: "ENOENT" });
    assert.equal(r.events.filter((e) => e.event === "parent-delete").length, 1);
    assert.equal(
      r.events.some((e) => e.event === "workspace-record"),
      false,
    );
    assert.equal(
      r.commands("image").length,
      2,
      "unqualified images are not retained",
    );
    const status = await r.wait((e) => e.event === "trace-status");
    assert.equal(status.complete, false);
    if (reason) assert.equal(status.reason, reason);
    else assert.ok(["pending-write", "backpressure"].includes(status.reason));
  });

for (const location of ["inner", "outer"])
  for (const kind of [
    "getter",
    "proxy",
    "revoked-proxy",
    "inherited-getter",
    "inherited-value",
  ])
    test(`trace ${location} ${kind} is rejected without executing metadata, leaking or dispatching`, async (t) => {
      const r = await runner(
        t,
        "trace-metadata",
        `${location}:${kind}`,
        "absent",
        {},
      );
      await finishSyntheticRuntime(r);
      assert.deepEqual(
        r.events.filter((e) => e.event === "validation"),
        ["docker", "runRuntime"].map((boundary) => ({
          event: "validation",
          boundary,
          ok: false,
          message: "Runtime trace labels invalid.",
        })),
      );
      assert.deepEqual(
        await r.wait((e) => e.event === "metadata-observations"),
        {
          event: "metadata-observations",
          calls: 0,
        },
      );
      assert.equal(r.commands("version").length, 0);
      assert.equal(
        r.commands("run").length,
        1,
        "only the valid control can dispatch",
      );
      assert.equal(r.stderr.includes("PRIVATE_"), false);
      assert.equal(
        (await r.wait((e) => e.event === "trace-status")).complete,
        true,
      );
    });

for (const kind of [
  "getter",
  "proxy",
  "revoked-proxy",
  "inherited-getter",
  "inherited-value",
])
  test(`trace configuration ${kind} is rejected statically before a valid configuration`, async (t) => {
    const r = await runner(t, "trace-config-metadata", kind, "absent", {});
    await finishSyntheticRuntime(r);
    assert.deepEqual(await r.wait((e) => e.event === "validation"), {
      event: "validation",
      ok: false,
      message: "Runtime trace labels invalid.",
    });
    assert.deepEqual(await r.wait((e) => e.event === "metadata-observations"), {
      event: "metadata-observations",
      calls: 0,
    });
    assert.equal(r.stderr.includes("PRIVATE_"), false);
    assert.equal(
      (await r.wait((e) => e.event === "trace-status")).complete,
      true,
    );
  });

for (const commandFailure of [false, true])
  test(`real unconsumed stderr pipe${commandFailure ? " after command failure" : ""} cannot retain qualification after observable owned cleanup`, async (t) => {
    const r = await runner(
      t,
      commandFailure ? "workspace-pipe-failure" : "workspace-pipe",
      1,
      "absent",
      {},
      false,
    );
    const workspace = await r.wait((e) => e.event === "workspace");
    const filled = await r.wait((e) => e.event === "pipe-filled");
    assert.equal(
      filled.nonblocking,
      true,
      "supported Node/Linux pipe must already be nonblocking",
    );
    if (commandFailure)
      assert.deepEqual(
        await r.wait((e) => e.event === "pipe-command-failure"),
        {
          event: "pipe-command-failure",
          message: "Runtime qualification command failed.",
          category: "engine-command",
        },
      );
    r.close(r.first);
    r.close(await r.command("rm"));
    await r.absence();
    for (const kind of ["clients", "directory"]) {
      const pending = await r.wait((e) => e.kind === kind);
      r.send({ action: "callback", id: pending.id });
    }
    await r.wait((e) => e.event === "parent-deleted");
    const afterCleanup = performance.now();
    const result = await r.wait((e) => e.event === "result");
    const status = await r.wait((e) => e.event === "trace-status");
    let timer;
    let termination;
    try {
      // Failure watchdog, not a sleep/drain allowance. NEVER consume stderr before
      // observing process exit; failed-test disposal may kill/destroy only its child.
      termination = await Promise.race([
        r.terminated,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  "Owned cleanup settled but the unconsumed trace pipe retained the process.",
                ),
              ),
            Math.max(0, 1500 - (performance.now() - afterCleanup)),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(termination.consumedBeforeExit, false);
    assert.deepEqual(
      { code: termination.code, signal: termination.signal },
      { code: 1, signal: null },
    );
    assert.deepEqual(result, {
      event: "result",
      ok: false,
      message: "Runtime qualification trace incomplete; record withheld.",
    });
    await assert.rejects(lstat(workspace.parent), { code: "ENOENT" });
    assert.equal(r.commands("image").length, 2);
    assert.equal(
      r.commands("rm").length,
      2,
      "fixture and parent repair each removed exactly once",
    );
    assert.equal(r.commands("ps").length, 2);
    assert.equal(
      r.events.some((e) => e.event === "workspace-record"),
      false,
    );
    assert.equal(status.complete, false);
    assert.equal(status.reason, "backpressure");
    assert.equal(
      status.records,
      filled.records,
      "no later trace write can upgrade settlement",
    );
    assert.equal(status.bytes, filled.bytes);
    assert.ok(
      status.records < 7200,
      "stop queuing at the first backpressure, before record/byte exhaustion",
    );
    assert.ok(status.bytes <= 2097152);
    t.diagnostic(
      JSON.stringify({
        records: status.records,
        bytes: status.bytes,
        cleanupToExitMs: performance.now() - afterCleanup,
        consumedBeforeExit: false,
      }),
    );
  });

for (const mode of ["trace-blocking-sink", "trace-file-sink"])
  test(`${mode} fails closed without attempting blocking output, preserving owned cleanup`, async (t) => {
    const r = await tracedRunner(t, mode);
    await finishSyntheticRuntime(r);
    const status = await r.wait((e) => e.event === "trace-status");
    assert.equal(status.complete, false);
    assert.equal(status.reason, "write-error");
    assert.equal(status.records, 0);
    assert.deepEqual(await r.wait((e) => e.event === "sink-writes"), {
      event: "sink-writes",
      count: 0,
    });
    assert.equal(r.commands("rm").length, 1);
    assert.equal(r.commands("ps").length, 1);
  });

for (const failure of ["lost-ack", "unproved-clients"])
  test(`trace ${failure} cannot turn uncertain teardown into proof or replay`, async (t) => {
    const r = await tracedRunner(t, "fixture");
    r.close(r.first);
    const removal = await r.command("rm");
    if (failure === "lost-ack") r.send({ action: "error", id: removal.id });
    r.close(removal);
    if (failure !== "lost-ack") await r.absence();
    const clients = await r.wait((e) => e.kind === "clients");
    if (failure === "lost-ack") r.send({ action: "callback", id: clients.id });
    else {
      r.send({ action: "tick", ms: 999 });
      await r.barrier();
      r.send({ action: "tick", ms: 1 });
    }
    assert.equal((await r.wait((e) => e.event === "result")).ok, false);
    await r.closed;
    const records = traceRecords(r);
    assert.equal(
      records.some((e) => e.category === "fixture-directory"),
      false,
    );
    assert.equal(
      records.find((e) => e.category === "client-drain" && e.event === "settle")
        .outcome,
      "unconfirmed",
    );
    if (failure === "lost-ack") {
      assert.equal(
        records.some((e) => e.category === "ownership" && e.event === "proof"),
        false,
      );
      assert.equal(
        records.find((e) => e.category === "ownership" && e.event === "settle")
          .outcome,
        "unconfirmed",
      );
    } else
      assert.equal(
        records.find(
          (e) => e.category === "client-drain" && e.event === "deadline",
        ).elapsedMs,
        1000,
      );
    assert.equal(r.commands("rm").length, 1);
    assert.equal(r.stderr.includes("PRIVATE_"), false);
  });

for (const operation of ["rm", "ps"])
  test(`${operation} deadline keeps uncertain ownership and drains late clients without replay`, async (t) => {
    const r = await tracedRunner(t);
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
    const records = traceRecords(r);
    assert.ok(
      records.some(
        (e) =>
          e.category === "diagnostic" &&
          e.context === "cancellation" &&
          e.event === "settle" &&
          e.outcome === "failed",
      ),
      "traced cancellation failure stays observable without async stderr output",
    );
    assert.equal(
      records.find((e) => e.category === "cancellation" && e.event === "settle")
        .outcome,
      "unconfirmed",
    );
    assert.equal(r.stderr.includes("PRIVATE_"), false);
    const stage = operation === "rm" ? "owned-remove" : "owned-absence";
    const start = records.find((e) => e.stage === stage && e.event === "start");
    assert.equal(start.context, "cancellation");
    assert.equal(start.capMs, 15000);
    const paired = records.filter((e) => e.id === start.id);
    assert.deepEqual(
      paired.map((e) => e.event),
      ["start", "deadline", "settle", "late-close"],
    );
    assert.equal(paired[2].elapsedMs, 15000);
    assert.equal(
      records.find((e) => e.category === "ownership" && e.event === "settle")
        .outcome,
      "unconfirmed",
    );
  });
