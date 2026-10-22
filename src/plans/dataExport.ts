// KS_SERVER_v8_DATA_EXPORT - everything this copy holds, for the licensee's admins (always available to them, and the
// one thing besides the Plan page and Help still open once cancelled): a zip with
//   tables/<table>.jsonl      every row of every table, one JSON object per line (read in pages of 2,000)
//   documents/<table>/<id>-<filename>   the uploaded files those tables point at, from blob storage
//   manifest.json             what is in the zip, row counts, and any file that could not be read
// Credentials are left out: tables holding passwords, one-time codes, sign-in tokens or keys are not exported.
import archiver from "archiver";
import { Readable, type Writable } from "node:stream";
import type { Q } from "./state.js";

export const EXPORT_PAGE_ROWS = 2000;
/** Tables never exported: they hold secrets, not the licensee's business data. */
export const EXPORT_SKIP = /(^|_)(otp|otps|password|passwords|refresh_tokens?|tokens?|secrets?|webauthn|credentials?|sessions_keys|idempotency)(_|$)|^schema_migrations$|^auth_/;
/** Tables whose rows point at stored files, and the columns that may hold the blob name. */
export const FILE_TABLES = ["documents", "contact_documents", "collateral_assets", "application_packages"];
const FILE_KEY_COLUMNS = ["blob_name", "storage_path", "storage_key", "object_key"];
const NAME_COLUMNS = ["filename", "file_name", "original_name", "name", "title"];

export type ExportDeps = {
  fetchBlob: (key: string) => Promise<Buffer | null>;
};

export async function exportTables(db: Q): Promise<string[]> {
  const r = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return r.rows.map((x: any) => String(x.table_name)).filter((t: string) => /^[a-z_][a-z0-9_]*$/.test(t) && !EXPORT_SKIP.test(t));
}

async function columnsOf(db: Q, table: string): Promise<string[]> {
  const r = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x: any) => String(x.column_name));
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120) || "file";

/** Writes the export zip to `out`. Resolves with the manifest once the zip is finished. */
export async function writeExport(db: Q, out: Writable, deps: ExportDeps, now: Date = new Date()) {
  const zip = archiver("zip", { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    out.on("close", () => resolve());
    out.on("finish", () => resolve());
    zip.on("error", reject);
  });
  zip.pipe(out);
  const manifest = {
    generated_at: now.toISOString(),
    tables: [] as Array<{ table: string; rows: number }>,
    documents: 0,
    errors: [] as Array<{ where: string; error: string }>,
  };

  // Each table is streamed page by page while the zip is written, so a large table is never held in memory.
  // Entries are read strictly one after another (each waits for the one before), so at most one page of rows or
  // one file is in memory however eagerly the zip writer pulls.
  const finished: Promise<void>[] = [];
  let previous: Promise<void> = Promise.resolve();
  const tracked = (gen: AsyncGenerator<Buffer | string>) => {
    const before = previous;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    finished.push(done);
    previous = done;
    return Readable.from((async function* () { try { await before; yield* gen; } finally { resolve(); } })());
  };
  const tableStream = (table: string, entry: { table: string; rows: number }) => tracked((async function* () {
    try {
      for (let offset = 0; ; offset += EXPORT_PAGE_ROWS) {
        const page = await db.query(`SELECT * FROM "${table}" ORDER BY ctid LIMIT ${EXPORT_PAGE_ROWS} OFFSET ${offset}`);
        entry.rows += page.rows.length;
        if (page.rows.length) yield page.rows.map((row: unknown) => JSON.stringify(row)).join("\n") + "\n";
        if (page.rows.length < EXPORT_PAGE_ROWS) break;
      }
    } catch (err) {
      console.warn("[data-export] table not fully exported", table, (err as Error)?.message ?? String(err));
      manifest.errors.push({ where: `tables/${table}`, error: (err as Error)?.message ?? String(err) });
    }
  })());
  const tables = await exportTables(db);
  for (const table of tables) {
    const entry = { table, rows: 0 };
    manifest.tables.push(entry);
    zip.append(tableStream(table, entry), { name: `tables/${table}.jsonl` });
  }

  for (const table of FILE_TABLES.filter((t) => tables.includes(t))) {
    const cols = await columnsOf(db, table);
    const keyCols = FILE_KEY_COLUMNS.filter((c) => cols.includes(c));
    if (!keyCols.length) continue;
    const nameCol = NAME_COLUMNS.find((c) => cols.includes(c));
    const r = await db.query(
      `SELECT id::text AS id, COALESCE(${keyCols.map((c) => `NULLIF(${c}, '')`).join(", ")}) AS file_key${nameCol ? `, ${nameCol} AS file_name` : ""}
         FROM "${table}" WHERE COALESCE(${keyCols.map((c) => `NULLIF(${c}, '')`).join(", ")}) IS NOT NULL`,
    );
    for (const row of r.rows) {
      const key = String(row.file_key);
      const where = `${table}/${row.id}`;
      // Fetched only when the zip reaches this entry, so files are not all held in memory at once.
      zip.append(tracked((async function* () {
        try {
          const buf = await deps.fetchBlob(key);
          if (!buf) { manifest.errors.push({ where, error: "file not found" }); return; }
          manifest.documents += 1;
          yield buf;
        } catch (err) {
          console.warn("[data-export] file not exported", where, (err as Error)?.message ?? String(err));
          manifest.errors.push({ where, error: (err as Error)?.message ?? String(err) });
        }
      })()), { name: `documents/${table}/${safe(String(row.id))}-${safe(String(row.file_name ?? key.split("/").pop() ?? "file"))}` });
    }
  }

  // Written last, once every table and file entry has been read, so the counts are final.
  // If the download is cut off, stop instead of waiting for entries nobody will read.
  let closedEarly = false;
  const closed = new Promise<void>((resolve) => out.once("close", () => { closedEarly = true; resolve(); }));
  await Promise.race([Promise.all(finished), closed]);
  if (closedEarly && finished.length) {
    console.warn("[data-export] download closed before the export finished");
    zip.abort();
    return manifest;
  }
  zip.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
  await zip.finalize();
  await done;
  return manifest;
}
