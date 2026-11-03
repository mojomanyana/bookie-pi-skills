// Synthetic native transport controls, not Redis or protected-image qualification.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { socketExecutor } from "./helpers/redis-socket.mjs";

function fixture() {
  const sockets = [];
  const connect = () => {
    const socket = new EventEmitter();
    socket.write = () => {
      queueMicrotask(() => socket.emit("written"));
      return true;
    };
    socket.destroy = () => queueMicrotask(() => socket.emit("close"));
    sockets.push(socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };
  return { ...socketExecutor(connect, "/owned/synthetic.sock"), sockets };
}
const failure = { name: "Error", message: "Redis fixture transport failed." };

test("native arrays and split UTF-8 preserve bytes through socket settlement", async () => {
  const f = fixture();
  const pending = f.execute(["PING"]);
  const socket = f.sockets[0];
  await new Promise((r) => socket.once("written", r));
  // The scalar string is nine bytes: use independent byte length.
  const text = Buffer.from("café😀");
  const reply = Buffer.concat([
    Buffer.from(`*2\r\n$4\r\nmeta\r\n$${text.length}\r\n`),
    text,
    Buffer.from("\r\n"),
  ]);
  assert.equal(text.length, 9);
  for (const byte of reply) socket.emit("data", Buffer.from([byte]));
  assert.deepEqual(await pending, ["meta", "café😀"]);
  await f.close();
});

for (const reply of [
  "$6297246\r\n",
  "*130\r\n",
  "$2\r\n\xc0\xaf\r\n",
  "$1\r\naXX",
  "+OK\r\n+OK\r\n",
  ":9007199254740992\r\n",
  "*1\r\n*1\r\n*1\r\n*1\r\n*1\r\n",
  "-PRIVATE_DEPENDENCY\r\n",
])
  test("native malformed/oversize replies fail statically and cannot replay", async () => {
    const f = fixture();
    const pending = f.execute(["PING"]);
    const rejected = assert.rejects(pending, failure);
    await new Promise((r) => f.sockets[0].once("written", r));
    f.sockets[0].emit("data", Buffer.from(reply, "latin1"));
    await rejected;
    assert.equal(f.sockets.length, 1);
    await f.close();
  });

test("pre-abort dispatches nothing; dispatched abort closes once and rejects late replies", async () => {
  const f = fixture(),
    abort = new AbortController();
  abort.abort();
  await assert.rejects(f.execute(["PING"], abort.signal), failure);
  assert.equal(f.sockets.length, 0);
  const active = new AbortController();
  const pending = f.execute(["PING"], active.signal);
  const rejected = assert.rejects(pending, failure);
  await new Promise((r) => f.sockets[0].once("written", r));
  active.abort();
  await rejected;
  f.sockets[0].emit("data", Buffer.from("+PONG\r\n"));
  await f.close();
  await assert.rejects(f.execute(["PING"]), failure);
  assert.equal(f.sockets.length, 1);
});
