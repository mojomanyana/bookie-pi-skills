import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

import { exportCanonicalJsonl } from "../dist/index.js";

const count = Number(process.argv[2] ?? "50000");
if (!Number.isSafeInteger(count) || count <= 0 || count > 50_000) {
  throw new TypeError("concept count must be an integer from 1 through 50000");
}
const sensitivityMode = process.argv[3] ?? "included";
if (!new Set(["included", "mixed", "excluded"]).has(sensitivityMode)) {
  throw new TypeError("sensitivity mode must be included, mixed, or excluded");
}
const expectedRecords =
  sensitivityMode === "included"
    ? count
    : sensitivityMode === "excluded"
      ? 0
      : Math.ceil(count / 2);

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(index) {
  let value = BigInt(index);
  let encoded = "";
  do {
    encoded = alphabet[Number(value % 32n)] + encoded;
    value /= 32n;
  } while (value > 0n);
  return encoded.padStart(26, "0");
}

function git(root, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=Bookie Export Benchmark",
      "-c",
      "user.email=bookie-export-benchmark@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "-C",
      root,
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function runExport(root, sourceRef, inspectLines) {
  const hash = createHash("sha256");
  let lines = 0;
  let previousUid = "";
  const started = performance.now();
  const result = await exportCanonicalJsonl(root, {
    sourceRef,
    write(bytes) {
      hash.update(bytes);
      lines += 1;
      if (inspectLines) {
        if (bytes.at(-1) !== 0x0a) throw new Error("line is not LF framed");
        const record = JSON.parse(
          Buffer.from(bytes.subarray(0, bytes.byteLength - 1)).toString("utf8"),
        );
        if (record.uid <= previousUid) {
          throw new Error("records are not strictly UID ordered");
        }
        previousUid = record.uid;
      }
    },
  });
  return {
    result,
    lines,
    digest: hash.digest("hex"),
    elapsedMilliseconds: Math.round(performance.now() - started),
  };
}

const root = mkdtempSync(join(tmpdir(), "bookie-export-benchmark-"));
try {
  mkdirSync(join(root, "concepts"));
  writeFileSync(
    join(root, "bookie.yaml"),
    `profile: "1.0"
vault:
  uid: VLT-00000000000000000000000009
  title: Canonical export scale benchmark
allowed_concept_types:
  - Project
policy:
  evidence_roots:
    - references/files
  exclude: []
  sensitivity:
    classes:
      - public
      - restricted
    excluded_classes:
      - restricted
  attachment_max_bytes: 1024
`,
  );
  writeFileSync(join(root, "index.md"), '---\nokf_version: "0.2"\n---\n');
  for (let index = 0; index < count; index += 1) {
    const sensitivity =
      sensitivityMode === "included" ||
      (sensitivityMode === "mixed" && index % 2 === 0)
        ? "public"
        : "restricted";
    const frontmatter = {
      type: "Project",
      title: `Canonical export benchmark ${index}`,
      status: "stable",
      generated: {
        by: "process:export-benchmark",
        at: "2026-09-03T12:00:00Z",
      },
      bookie: {
        profile: "1.0",
        uid: `PRJ-${ulid(index + 1)}`,
        state: "active",
        created_at: "2026-09-03T12:00:00Z",
        sensitivity,
      },
    };
    writeFileSync(
      join(root, "concepts", `${String(index).padStart(5, "0")}.md`),
      `---\n${JSON.stringify(frontmatter)}\n---\nbenchmark body\n`,
    );
  }
  git(root, ["init", "-q"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "--no-gpg-sign", "-m", "benchmark source"]);
  const commit = git(root, ["rev-parse", "HEAD"]);

  const first = await runExport(root, commit, true);
  const second = await runExport(root, commit, false);
  const output = {
    concepts: count,
    sensitivityMode,
    sourceCommit: first.result.sourceCommit,
    complete: first.result.complete,
    records: first.result.ok ? first.result.recordCount : 0,
    byteLength: first.result.ok ? first.result.byteLength : 0,
    deterministic:
      first.result.ok &&
      second.result.ok &&
      first.result.outputHash === second.result.outputHash &&
      first.digest === second.digest,
    diagnostics: first.result.diagnostics.length,
    firstElapsedMilliseconds: first.elapsedMilliseconds,
    secondElapsedMilliseconds: second.elapsedMilliseconds,
    rssMiB: Math.round(process.memoryUsage().rss / 1_048_576),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  console.log(JSON.stringify(output));
  if (
    !first.result.ok ||
    !second.result.ok ||
    first.lines !== expectedRecords ||
    second.lines !== expectedRecords ||
    !output.deterministic ||
    first.result.diagnostics.length !== 0
  ) {
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
