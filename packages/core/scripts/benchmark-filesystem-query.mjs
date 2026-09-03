import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { searchVault } from "../dist/index.js";

const count = Number(process.argv[2] ?? "50000");
if (!Number.isSafeInteger(count) || count <= 0 || count > 50_000) {
  throw new TypeError("concept count must be an integer from 1 through 50000");
}

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

const root = mkdtempSync(join(tmpdir(), "bookie-query-benchmark-"));
try {
  mkdirSync(join(root, "concepts"));
  writeFileSync(
    join(root, "bookie.yaml"),
    `profile: "1.0"
vault:
  uid: VLT-00000000000000000000000009
  title: Query scale benchmark
allowed_concept_types:
  - Project
policy:
  evidence_roots:
    - references/files
  exclude: []
  sensitivity:
    classes:
      - public
    excluded_classes: []
  attachment_max_bytes: 1024
`,
  );
  writeFileSync(join(root, "index.md"), '---\nokf_version: "0.2"\n---\n');
  for (let index = 0; index < count; index += 1) {
    const frontmatter = {
      type: "Project",
      title: `Filesystem benchmark needle ${index}`,
      status: "stable",
      generated: {
        by: "process:query-benchmark",
        at: "2026-09-03T12:00:00Z",
      },
      bookie: {
        profile: "1.0",
        uid: `PRJ-${ulid(index + 1)}`,
        state: "active",
        created_at: "2026-09-03T12:00:00Z",
        sensitivity: "public",
      },
    };
    writeFileSync(
      join(root, "concepts", `${String(index).padStart(5, "0")}.md`),
      `---\n${JSON.stringify(frontmatter)}\n---\nbenchmark body\n`,
    );
  }

  const started = performance.now();
  const result = await searchVault(root, { query: "needle" });
  const elapsedMilliseconds = Math.round(performance.now() - started);
  const output = {
    concepts: count,
    complete: result.complete,
    matchedCount: result.matchedCount,
    returnedResults: result.results.length,
    resultsTruncated: result.resultsTruncated,
    diagnostics: result.diagnostics.length,
    elapsedMilliseconds,
    rssMiB: Math.round(process.memoryUsage().rss / 1_048_576),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  };
  console.log(JSON.stringify(output));
  if (
    !result.complete ||
    result.matchedCount !== count ||
    result.diagnostics.length !== 0
  ) {
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
