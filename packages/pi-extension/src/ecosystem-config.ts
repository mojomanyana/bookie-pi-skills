import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EcosystemConfig {
  readonly models?: {
    readonly fast?: string;
    readonly work?: string;
    readonly strong?: string;
  };
  readonly modelFallbacks?: {
    readonly fast?: readonly string[];
    readonly work?: readonly string[];
    readonly strong?: readonly string[];
  };
  readonly bookie?: {
    readonly autoRecall?: boolean;
    readonly autoDistill?: boolean;
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function ecosystemConfigPath(env = process.env): string {
  const dir =
    env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(dir, "ecosystem.json");
}

/**
 * Returns `undefined` when `ecosystem.json` does not exist, and throws on
 * invalid/unreadable JSON or invalid nested sections consumed by Bookie so
 * callers can fail closed on damaged configs.
 */
export function readEcosystemConfig(
  env = process.env,
): EcosystemConfig | undefined {
  const file = ecosystemConfigPath(env);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid ecosystem config object in ${file}`);
  }
  if ("models" in parsed) {
    if (!isPlainObject(parsed.models)) {
      throw new Error(`Expected an object for models in ${file}`);
    }
    for (const tier of ["fast", "work", "strong"]) {
      if (tier in parsed.models && typeof parsed.models[tier] !== "string") {
        throw new Error(`Expected a string for models.${tier} in ${file}`);
      }
    }
  }
  if ("modelFallbacks" in parsed) {
    if (!isPlainObject(parsed.modelFallbacks)) {
      throw new Error(`Expected an object for modelFallbacks in ${file}`);
    }
    for (const tier of ["fast", "work", "strong"]) {
      if (!(tier in parsed.modelFallbacks)) continue;
      const list = parsed.modelFallbacks[tier];
      if (
        !Array.isArray(list) ||
        !list.every(
          (item) => typeof item === "string" && item.trim().length > 0,
        )
      ) {
        throw new Error(
          `Expected an array of non-empty strings for modelFallbacks.${tier} in ${file}`,
        );
      }
    }
  }
  if ("bookie" in parsed) {
    if (!isPlainObject(parsed.bookie)) {
      throw new Error(`Expected an object for bookie in ${file}`);
    }
    for (const flag of ["autoRecall", "autoDistill"]) {
      if (flag in parsed.bookie && typeof parsed.bookie[flag] !== "boolean") {
        throw new Error(`Expected a boolean for bookie.${flag} in ${file}`);
      }
    }
  }
  return parsed as EcosystemConfig;
}

export function loadEcosystemConfig(env = process.env): EcosystemConfig {
  try {
    return readEcosystemConfig(env) ?? {};
  } catch {
    return {};
  }
}

export function resolveFastModelCandidates(
  env = process.env,
  config?: EcosystemConfig,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const clean = raw.trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  const envFast = env.PI_ECO_MODEL_FAST?.trim();
  if (envFast) {
    for (const part of envFast.split(",")) push(part);
  }
  const cfg = config ?? loadEcosystemConfig(env);
  push(cfg.models?.fast);
  if (Array.isArray(cfg.modelFallbacks?.fast)) {
    for (const item of cfg.modelFallbacks.fast) push(item);
  }
  return out;
}
