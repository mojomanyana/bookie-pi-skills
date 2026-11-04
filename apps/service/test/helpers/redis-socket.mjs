// Test-only RESP2 over the exact owned Unix socket. Serialized into image drivers,
// never shipped in the runtime. No retries, pipelines, credential/argument logs or
// redis-cli/stdout payload envelope. Native cap matches the verifier's legal domain.
export function socketExecutor(connect, path) {
  const MAX_REPLY = 6297245,
    MAX_BULK = 6291456,
    MAX_REQUEST = 8 * 1048576;
  const clients = new Set();
  let closing;
  const failure = () => Error("Redis fixture transport failed.");
  async function execute(args, signal) {
    if (
      closing ||
      signal?.aborted ||
      !Array.isArray(args) ||
      args.length < 1 ||
      args.length > 1024
    )
      throw failure();
    const allowed = [
      "EVAL",
      "PING",
      "JSON.GET",
      "JSON.SET",
      "JSON.MSET",
      "HGETALL",
      "HGET",
      "HSET",
      "ACL",
      "DEL",
      "EXISTS",
      "PTTL",
      "TYPE",
      "CONFIG",
    ];
    if (!allowed.includes(args[0])) throw failure();
    const parts = [Buffer.from(`*${args.length}\r\n`)];
    let requestBytes = parts[0].length;
    for (const arg of args) {
      if (typeof arg !== "string" || /[\uD800-\uDFFF]/u.test(arg))
        throw failure();
      const bytes = Buffer.from(arg);
      const header = Buffer.from(`$${bytes.length}\r\n`);
      requestBytes += header.length + bytes.length + 2;
      if (requestBytes > MAX_REQUEST) throw failure();
      parts.push(header, bytes, Buffer.from("\r\n"));
    }
    let socket;
    try {
      socket = connect({ path });
    } catch {
      throw failure();
    }
    let close;
    const closed = new Promise((r) => {
      close = r;
    });
    const entry = { socket, closed };
    clients.add(entry);
    socket.once("close", () => {
      clients.delete(entry);
      close();
    });
    let timer, onAbort;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false,
          total = 0,
          header = [],
          bulk,
          received = 0,
          trailer = 0,
          result,
          complete = false;
        const stack = [];
        let values = 0;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          // Bound the call even if closure is unconfirmed. Retain the client
          // until close; the fixture owner must join it before directory removal.
          if (error) reject(failure());
          else resolve(result);
        };
        const value = (v) => {
          if (++values > 1024) throw failure();
          if (!stack.length) {
            result = v;
            complete = true;
            return;
          }
          const top = stack.at(-1);
          top.items.push(v);
          if (top.items.length === top.count) {
            stack.pop();
            value(top.items);
          }
        };
        const number = (s, min) => {
          if (!/^-?(?:0|[1-9][0-9]*)$/u.test(s)) throw failure();
          const n = Number(s);
          if (!Number.isSafeInteger(n) || n < min) throw failure();
          return n;
        };
        onAbort = () => finish(true);
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(onAbort, 2000);
        socket.once("error", onAbort);
        socket.once("end", () => {
          if (!complete) finish(true);
        });
        socket.once("close", () => {
          if (!settled) finish(true);
        });
        socket.once("connect", () => {
          if (signal?.aborted || closing) finish(true);
          else socket.write(Buffer.concat(parts, requestBytes));
        });
        socket.on("data", (chunk) => {
          if (settled) return;
          try {
            total += chunk.length;
            if (total > MAX_REPLY) throw failure();
            let offset = 0;
            while (offset < chunk.length) {
              if (complete) throw failure();
              if (bulk !== undefined) {
                if (received < bulk.length) {
                  const count = Math.min(
                    bulk.length - received,
                    chunk.length - offset,
                  );
                  chunk.copy(bulk, received, offset, offset + count);
                  received += count;
                  offset += count;
                } else {
                  if (chunk[offset++] !== (trailer === 0 ? 13 : 10))
                    throw failure();
                  if (++trailer === 2) {
                    const text = new TextDecoder("utf-8", {
                      fatal: true,
                      ignoreBOM: true,
                    }).decode(bulk);
                    bulk = undefined;
                    received = 0;
                    trailer = 0;
                    value(text);
                  }
                }
                continue;
              }
              header.push(chunk[offset++]);
              if (header.length > 64) throw failure();
              if (header.at(-1) !== 10) continue;
              if (header.length < 3 || header.at(-2) !== 13) throw failure();
              const line = Buffer.from(header).toString("ascii"),
                type = line[0],
                text = line.slice(1, -2);
              if (header.some((b) => b > 127)) throw failure();
              header = [];
              if (type === "$" || type === "*") {
                const count = number(text, -1);
                if (count === -1) value(null);
                else if (type === "$") {
                  if (count > MAX_BULK) throw failure();
                  bulk = Buffer.alloc(count);
                } else {
                  if (count > 129 || stack.length === 4) throw failure();
                  if (!count) value([]);
                  else stack.push({ count, items: [] });
                }
              } else if (type === "+") value(text);
              else if (type === ":")
                value(number(text, -Number.MAX_SAFE_INTEGER));
              else throw failure(); // Redis errors are never echoed.
            }
            if (complete) finish(false);
          } catch {
            finish(true);
          }
        });
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  function close() {
    return (closing ??= (async () => {
      const owned = [...clients];
      for (const { socket } of owned) socket.destroy();
      await Promise.all(owned.map((c) => c.closed));
    })());
  }
  return { execute, close };
}
