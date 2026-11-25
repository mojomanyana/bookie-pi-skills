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

export function ecosystemConfigPath(env = process.env): string {
  const dir =
    env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(dir, "ecosystem.json");
}

/**
 * Returns `undefined` when `ecosystem.json` does not exist, and throws on
 * invalid/unreadable JSON so callers can fail closed on damaged configs.
 */
export function readEcosystemConfig(
  env = process.env,
): EcosystemConfig | undefined {
  const file = ecosystemConfigPath(env);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ecosystem config object in ${file}`);
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
