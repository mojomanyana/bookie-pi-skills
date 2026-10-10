import { posix } from "node:path";
import { beneath } from "./path-boundary.js";
export { beneath } from "./path-boundary.js";
import {
  snapshotProjectionConfig,
  type ProjectionConfig,
} from "./projection.js";

export interface SourceDeployment {
  readonly handle: string;
  readonly root: string;
  readonly repositoryRoot: string;
  readonly approvedRef: string;
  readonly rollbackWindow: number;
  readonly timeoutMs: number;
  readonly projection: ProjectionConfig;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function path(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "/" &&
    value.startsWith("/") &&
    posix.normalize(value) === value &&
    Buffer.byteLength(value) <= 4096 &&
    value.split("/").length <= 65 &&
    !/[\p{Cc}\p{Cs}\\]/u.test(value) &&
    value
      .slice(1)
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part.toLowerCase() !== ".git" &&
          Buffer.byteLength(part) <= 255,
      )
  );
}
function ref(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("refs/") &&
    !value.startsWith("refs/replace/") &&
    Buffer.byteLength(value) <= 255 &&
    !/[\p{Cc}\p{Cs}\p{White_Space}~^:?*[\\]/u.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "" && !part.startsWith(".") && !part.endsWith(".lock"),
      )
  );
}
function invalid(): never {
  throw new TypeError("Deployment config is invalid.");
}
/** Source registry only; token/Redis/provider secret-file configuration is separate. */
export function compileSourceDeployments(
  input: readonly SourceDeployment[],
): readonly SourceDeployment[] {
  if (!Array.isArray(input) || input.length > 64) invalid();
  const output: SourceDeployment[] = [];
  const items: readonly SourceDeployment[] = input;
  for (const item of items) {
    if (
      !object(item) ||
      Object.keys(item).length !== 7 ||
      Object.keys(item).some(
        (key) =>
          ![
            "handle",
            "root",
            "repositoryRoot",
            "approvedRef",
            "rollbackWindow",
            "timeoutMs",
            "projection",
          ].includes(key),
      ) ||
      typeof item.handle !== "string" ||
      !/^[a-z][a-z0-9-]{0,62}(?![\s\S])/u.test(item.handle) ||
      !path(item.root) ||
      !path(item.repositoryRoot) ||
      !beneath(item.root, item.repositoryRoot) ||
      !ref(item.approvedRef) ||
      !Number.isSafeInteger(item.rollbackWindow) ||
      item.rollbackWindow < 0 ||
      item.rollbackWindow > 1024 ||
      !Number.isSafeInteger(item.timeoutMs) ||
      item.timeoutMs < 1 ||
      item.timeoutMs > 21600000
    )
      invalid();
    let projection: ProjectionConfig;
    try {
      projection = snapshotProjectionConfig(item.projection);
    } catch {
      invalid();
    }
    if (
      output.some(
        (old) =>
          old.handle === item.handle ||
          old.projection.vaultUid === projection.vaultUid ||
          beneath(old.root, item.root) ||
          beneath(item.root, old.root),
      )
    )
      invalid();
    output.push(
      Object.freeze({
        handle: item.handle,
        root: item.root,
        repositoryRoot: item.repositoryRoot,
        approvedRef: item.approvedRef,
        rollbackWindow: item.rollbackWindow,
        timeoutMs: item.timeoutMs,
        projection,
      }),
    );
  }
  return Object.freeze(output);
}
