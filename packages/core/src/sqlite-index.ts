import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { containsDetectedSecret } from "./vault-secret-detection.js";

export interface IndexedNote {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly mtimeMs: number;
  readonly rank: number;
}

export interface QueryVaultFtsOptions {
  /** Sensitivity classes permitted for automatic recall. Defaults fail-closed to public + internal only. */
  readonly allowedSensitivities?: readonly string[];
}

const DEFAULT_ALLOWED_SENSITIVITIES = new Set(["public", "internal"]);
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "not",
  "but",
  "can",
  "will",
  "should",
  "could",
  "would",
  "our",
  "your",
  "their",
  "into",
  "over",
  "under",
  "about",
  "there",
  "where",
  "when",
  "what",
  "which",
  "how",
  "why",
  "all",
  "any",
  "also",
  "just",
  "only",
  "make",
  "fix",
  "add",
  "use",
  "run",
  "please",
  "code",
  "file",
  "files",
]);

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

async function openSqlite(dbPath: string): Promise<SqliteDb | undefined> {
  try {
    const mod = (await import("node:sqlite")) as {
      DatabaseSync?: new (path: string) => SqliteDb;
    };
    if (!mod.DatabaseSync) return undefined;
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    return new mod.DatabaseSync(dbPath);
  } catch {
    return undefined;
  }
}

function collectMarkdownFiles(root: string, maxFiles = 2000): string[] {
  const results: string[] = [];
  if (!existsSync(root)) return results;
  const stack = [root];
  while (stack.length > 0 && results.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full);
        if (results.length >= maxFiles) break;
      }
    }
  }
  return results;
}

function parseFrontmatterBlock(content: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  return end > 0 ? content.slice(3, end) : undefined;
}

function parseFrontmatterObject(
  fm: string,
): Record<string, unknown> | undefined {
  const trimmed = fm.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Fail closed: missing or unrecognized sensitivity defaults to "restricted". Supports YAML & JSON frontmatter. */
function extractSensitivity(content: string): string {
  const fm = parseFrontmatterBlock(content);
  if (!fm) return "restricted";
  const jsonObj = parseFrontmatterObject(fm);
  if (jsonObj) {
    const bookie = jsonObj.bookie as Record<string, unknown> | undefined;
    const raw =
      typeof bookie?.sensitivity === "string"
        ? bookie.sensitivity
        : typeof jsonObj.sensitivity === "string"
          ? jsonObj.sensitivity
          : undefined;
    return raw ? raw.toLowerCase() : "restricted";
  }
  const match = /^\s*sensitivity\s*:\s*["']?([a-zA-Z0-9_-]+)["']?\s*$/m.exec(
    fm,
  );
  return match?.[1] ? match[1].toLowerCase() : "restricted";
}

function extractTitle(content: string, fallbackPath: string): string {
  const fm = parseFrontmatterBlock(content);
  if (fm) {
    const jsonObj = parseFrontmatterObject(fm);
    if (jsonObj && typeof jsonObj.title === "string" && jsonObj.title.trim()) {
      return jsonObj.title.trim().slice(0, 140);
    }
    const fmTitle = /^\s*title\s*:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(fm);
    if (fmTitle?.[1]) return fmTitle[1].trim().slice(0, 140);
  }
  const heading = /^#\s+(.+)$/m.exec(content);
  if (heading?.[1]) return heading[1].trim().slice(0, 140);
  return fallbackPath;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  return end > 0 ? content.slice(end + 4).trim() : content;
}

function extractKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(/\s+/);
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Rebuildable local SQLite FTS5 index over a canonical OKF Markdown vault.
 * Uses Node 24's built-in `node:sqlite` (zero native npm dependencies, zero daemon).
 * Enforces fail-closed sensitivity filtering and secret detection before indexing/returning.
 */
export async function queryVaultFts(
  vaultDir: string,
  indexDbPath: string,
  query: string,
  limit = 5,
  options: QueryVaultFtsOptions = {},
): Promise<IndexedNote[]> {
  if (!existsSync(vaultDir)) return [];
  const allowed = options.allowedSensitivities
    ? new Set(options.allowedSensitivities.map((s) => s.toLowerCase()))
    : DEFAULT_ALLOWED_SENSITIVITIES;
  const db = await openSqlite(indexDbPath);
  if (!db) return [];
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_meta (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        title TEXT NOT NULL,
        sensitivity TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
        path UNINDEXED,
        title,
        body,
        tokenize = 'porter unicode61'
      );
    `);

    const existingRows = db
      .prepare("SELECT path, mtime_ms FROM doc_meta")
      .all();
    const existing = new Map<string, number>();
    for (const row of existingRows) {
      existing.set(String(row.path), Number(row.mtime_ms));
    }

    const files = collectMarkdownFiles(vaultDir);
    const seen = new Set<string>();
    const upsertMeta = db.prepare(
      "INSERT OR REPLACE INTO doc_meta (path, mtime_ms, sha256, title, sensitivity) VALUES (?, ?, ?, ?, ?)",
    );
    const deleteMeta = db.prepare("DELETE FROM doc_meta WHERE path = ?");
    const deleteFts = db.prepare("DELETE FROM doc_fts WHERE path = ?");
    const insertFts = db.prepare(
      "INSERT INTO doc_fts (path, title, body) VALUES (?, ?, ?)",
    );

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const full of files) {
        const rel = relative(vaultDir, full).replace(/\\/g, "/");
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.size > 512 * 1024) continue;
        const mtimeMs = Math.floor(st.mtimeMs);
        if (existing.get(rel) === mtimeMs) {
          seen.add(rel);
          continue;
        }
        let raw: string;
        try {
          raw = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const sensitivity = extractSensitivity(raw);
        const title = extractTitle(raw, rel);
        const body = stripFrontmatter(raw).slice(0, 32_000);
        // Fail closed: never index excluded/restricted/secret-bearing notes into FTS.
        if (!allowed.has(sensitivity) || containsDetectedSecret(raw)) {
          deleteMeta.run(rel);
          deleteFts.run(rel);
          continue;
        }
        seen.add(rel);
        const sha = createHash("sha256").update(raw).digest("hex");
        upsertMeta.run(rel, mtimeMs, sha, title, sensitivity);
        deleteFts.run(rel);
        insertFts.run(rel, title, body);
      }

      for (const stalePath of existing.keys()) {
        if (!seen.has(stalePath)) {
          deleteMeta.run(stalePath);
          deleteFts.run(stalePath);
        }
      }
      db.exec("COMMIT");
    } catch (txErr) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw txErr;
    }

    const capped = Math.max(1, Math.min(20, limit));
    const allowedList = [...allowed];
    if (allowedList.length === 0) return [];
    const placeholders = allowedList.map(() => "?").join(",");

    const keywords = extractKeywords(query);
    const runMatch = (expr: string) =>
      db
        .prepare(
          `SELECT f.path, f.title, m.mtime_ms,
                  snippet(doc_fts, 2, '', '', '…', 28) AS snippet,
                  bm25(doc_fts) AS rank
           FROM doc_fts f
           JOIN doc_meta m ON m.path = f.path
           WHERE doc_fts MATCH ? AND m.sensitivity IN (${placeholders})
           ORDER BY rank ASC, m.mtime_ms DESC
           LIMIT ?`,
        )
        .all(expr, ...allowedList, capped);

    let rows: Record<string, unknown>[] = [];
    if (keywords.length === 0) {
      rows = db
        .prepare(
          `SELECT m.path, m.title, m.mtime_ms, substr(f.body, 1, 220) AS snippet, 0 AS rank
           FROM doc_meta m JOIN doc_fts f ON f.path = m.path
           WHERE m.sensitivity IN (${placeholders})
           ORDER BY m.mtime_ms DESC LIMIT ?`,
        )
        .all(...allowedList, capped);
    } else {
      // Prefer strict AND on filtered keywords first; fall back to OR only when AND returns 0.
      const andExpr = keywords.map((t) => `"${t}"*`).join(" AND ");
      rows = runMatch(andExpr);
      if (rows.length === 0 && keywords.length > 1) {
        const orExpr = keywords.map((t) => `"${t}"*`).join(" OR ");
        rows = runMatch(orExpr);
      }
    }

    return rows
      .map((row) => ({
        path: String(row.path),
        title: String(row.title),
        snippet: String(row.snippet ?? "")
          .replace(/\s+/g, " ")
          .trim(),
        mtimeMs: Number(row.mtime_ms ?? 0),
        rank: Number(row.rank ?? 0),
      }))
      .filter(
        (note) => !containsDetectedSecret(`${note.title}\n${note.snippet}`),
      );
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}
