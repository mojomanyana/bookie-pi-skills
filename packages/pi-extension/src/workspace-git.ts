import { execFile } from "node:child_process";

// Read-only Git evidence for the human re-attach command. The repository is
// untrusted input: no inherited GIT_* routing, user/system config, replace
// objects, hooks or fsmonitor; bounded output and time. Absence is not evidence.
export interface GitEvidence {
  readonly head: string;
  readonly prefix: string;
}
const commit = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
export const isGitCommit = (value: unknown): value is string =>
  typeof value === "string" && commit.test(value);

function environment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("GIT_")) delete env[name];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}
function git(cwd: string, args: readonly string[]) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    execFile(
      "git",
      [
        "--no-pager",
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd,
        env: environment(),
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 8_192,
        windowsHide: true,
      },
      (error, stdout) =>
        resolve({
          code: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          stdout: typeof stdout === "string" ? stdout : "",
        }),
    );
  });
}

/** The current commit and the folder's place inside its repository, if any. */
export async function readGitEvidence(
  cwd: string,
): Promise<GitEvidence | null> {
  const { code, stdout } = await git(cwd, [
    "rev-parse",
    "--show-prefix",
    "HEAD^{commit}",
  ]);
  const lines = stdout.split("\n");
  if (code !== 0 || lines.length !== 3 || lines[2] !== "") return null;
  const [prefix, head] = lines as [string, string];
  if (
    !isGitCommit(head) ||
    prefix.length > 4096 ||
    /[\p{Cc}]/u.test(prefix) ||
    (prefix !== "" && !prefix.endsWith("/"))
  )
    return null;
  return { head, prefix };
}

/** True only when Git confirms the recorded commit is the current HEAD or one of its ancestors. */
export async function isAncestorOfHead(
  cwd: string,
  recorded: string,
): Promise<boolean> {
  if (!isGitCommit(recorded)) return false;
  return (
    (await git(cwd, ["merge-base", "--is-ancestor", recorded, "HEAD"])).code ===
    0
  );
}
