import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export interface IndexedNote {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly mtimeMs: number;
  readonly rank: number;
}

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

function extractTitle(content: string, fallbackPath: string): string {
  const fmTitle = /^title\s*:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(content);
  if (fmTitle?.[1]) return fmTitle[1].trim().slice(0, 140);
  const heading = /^#\s+(.+)$/m.exec(content);
  if (heading?.[1]) return heading[1].trim().slice(0, 140);
  return fallbackPath;
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  return end > 0 ? content.slice(end + 4).trim() : content;
}

function toFtsQuery(raw: string): string | undefined {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 10);
  if (tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

/**
 * Rebuildable local SQLite FTS5 index over a canonical OKF Markdown vault.
 * Uses Node 24's built-in `node:sqlite` (zero native npm dependencies, zero daemon).
 */
export async function queryVaultFts(
  vaultDir: string,
  indexDbPath: string,
  query: string,
  limit = 5,
): Promise<IndexedNote[]> {
  if (!existsSync(vaultDir)) return [];
  const db = await openSqlite(indexDbPath);
  if (!db) return [];
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_meta (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        title TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
        path UNINDEXED,
        title,
        body,
        tokenize = 'porter unicode61'
      );
    `);

    const existingRows = db.prepare("SELECT path, mtime_ms FROM doc_meta").all();
    const existing = new Map<string, number>();
    for (const row of existingRows) {
      existing.set(String(row.path), Number(row.mtime_ms));
    }

    const files = collectMarkdownFiles(vaultDir);
    const seen = new Set<string>();
    const upsertMeta = db.prepare(
      "INSERT OR REPLACE INTO doc_meta (path, mtime_ms, sha256, title) VALUES (?, ?, ?, ?)",
    );
    const deleteFts = db.prepare("DELETE FROM doc_fts WHERE path = ?");
    const insertFts = db.prepare(
      "INSERT INTO doc_fts (path, title, body) VALUES (?, ?, ?)",
    );

    for (const full of files) {
      const rel = relative(vaultDir, full).replace(/\\/g, "/");
      seen.add(rel);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.size > 512 * 1024) continue;
      const mtimeMs = Math.floor(st.mtimeMs);
      if (existing.get(rel) === mtimeMs) continue;
      let raw: string;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const title = extractTitle(raw, rel);
      const body = stripFrontmatter(raw).slice(0, 32_000);
      const sha = createHash("sha256").update(raw).digest("hex");
      upsertMeta.run(rel, mtimeMs, sha, title);
      deleteFts.run(rel);
      insertFts.run(rel, title, body);
    }

    const deleteMeta = db.prepare("DELETE FROM doc_meta WHERE path = ?");
    for (const stalePath of existing.keys()) {
      if (!seen.has(stalePath)) {
        deleteMeta.run(stalePath);
        deleteFts.run(stalePath);
      }
    }

    const capped = Math.max(1, Math.min(20, limit));
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) {
      const recent = db
        .prepare(
          `SELECT m.path, m.title, m.mtime_ms, substr(f.body, 1, 220) AS snippet
           FROM doc_meta m JOIN doc_fts f ON f.path = m.path
           ORDER BY m.mtime_ms DESC LIMIT ?`,
        )
        .all(capped);
      return recent.map((row) => ({
        path: String(row.path),
        title: String(row.title),
        snippet: String(row.snippet ?? "").replace(/\s+/g, " ").trim(),
        mtimeMs: Number(row.mtime_ms ?? 0),
        rank: 0,
      }));
    }

    const hits = db
      .prepare(
        `SELECT f.path, f.title, m.mtime_ms,
                snippet(doc_fts, 2, '', '', '…', 28) AS snippet,
                bm25(doc_fts) AS rank
         FROM doc_fts f
         JOIN doc_meta m ON m.path = f.path
         WHERE doc_fts MATCH ?
         ORDER BY rank ASC, m.mtime_ms DESC
         LIMIT ?`,
      )
      .all(ftsQuery, capped);

    return hits.map((row) => ({
      path: String(row.path),
      title: String(row.title),
      snippet: String(row.snippet ?? "").replace(/\s+/g, " ").trim(),
      mtimeMs: Number(row.mtime_ms ?? 0),
      rank: Number(row.rank ?? 0),
    }));
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
