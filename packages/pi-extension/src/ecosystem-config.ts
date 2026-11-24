import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EcosystemConfig {
  readonly models?: {
    readonly fast?: string;
    readonly work?: string;
    readonly strong?: string;
  };
  readonly bookie?: {
    readonly autoRecall?: boolean;
    readonly autoDistill?: boolean;
  };
}

export function loadEcosystemConfig(env = process.env): EcosystemConfig {
  const dir =
    env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const file = join(dir, "ecosystem.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as EcosystemConfig)
      : {};
  } catch {
    return {};
  }
}
