// Actual Redis/socket fixture lifetime controls, separate from synthetic scheduling.
import { rm } from "node:fs/promises";
import {
  privateWorkspace,
  runRuntime,
} from "../../scripts/qualify-runtime.mjs";
import { ownedRedisFixture } from "./owned-redis-fixture.mjs";
const [mode, image] = process.argv.slice(2);
if (!["success", "failure", "cancel"].includes(mode))
  throw Error("Redis fixture mode invalid.");
const parent = await privateWorkspace();
const fixture = await ownedRedisFixture(parent);
// An unresolved await and an idle IPC channel do not keep Node alive. Own the
// cancellation lifetime before readiness, through the owner's signal teardown.
if (mode === "cancel") process.channel.ref();
process.send({
  event: "ready",
  name: fixture.name,
  directory: fixture.directory,
  parent,
});
if (mode === "cancel") await new Promise(() => {});
let failed = false;
try {
  await runRuntime(
    image,
    mode === "failure"
      ? "throw Error('PRIVATE_EXPECTED_FAILURE')"
      : "console.log('fixture-ok')",
    { mounts: [fixture.mount] },
  );
} catch {
  failed = true;
} finally {
  await fixture.finish();
  await rm(parent, { recursive: true });
}
process.send({ event: "settled", failed, cleaned: true });
process.disconnect();
