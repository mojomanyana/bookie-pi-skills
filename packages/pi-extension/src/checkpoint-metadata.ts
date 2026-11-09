import { randomBytes } from "node:crypto";

/** Explicit host-side construction only. This neither selects a vault nor saves anything. */
export function createCheckpointMetadata(options: {
  sessionId: string;
  now?: Date;
  entropy?: Uint8Array;
}) {
  if (
    !options ||
    typeof options !== "object" ||
    Object.keys(options).some(
      (key) => !["sessionId", "now", "entropy"].includes(key),
    ) ||
    typeof options.sessionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.sessionId)
  )
    throw new TypeError(
      "Bookie checkpoint metadata requires an actual bounded Pi session identifier.",
    );
  const now = options.now === undefined ? new Date() : options.now;
  const milliseconds = now instanceof Date ? now.getTime() : NaN;
  // Canonical timestamps use four-digit UTC years; ULID stores a 48-bit timestamp.
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 253402300799999
  )
    throw new TypeError(
      "Bookie checkpoint metadata requires a valid UTC date from 1970 through 9999.",
    );
  const entropy =
    options.entropy === undefined ? randomBytes(10) : options.entropy;
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 10)
    throw new TypeError(
      "Bookie checkpoint metadata requires exactly ten entropy bytes.",
    );
  let value = BigInt(milliseconds);
  for (const byte of entropy) value = (value << 8n) | BigInt(byte);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ulid = "";
  for (let i = 0; i < 26; i++) {
    ulid = alphabet[Number(value & 31n)]! + ulid;
    value >>= 5n;
  }
  const at = new Date(milliseconds).toISOString();
  return {
    uid: `ACT-${ulid}`,
    generated: { by: `process:pi:${options.sessionId}`, at },
    occurred_at: at,
  };
}
