/** The lead inbox's SQLite file: opened with a busy timeout, switched to WAL, and given its one table. */
import { Database, SQLiteError } from "bun:sqlite";

const SCHEMA = `CREATE TABLE IF NOT EXISTS items(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  kind TEXT,
  source TEXT,
  body TEXT,
  state TEXT CHECK(state IN ('queued','sent','ambiguous','done')),
  generation INTEGER,
  created_at TEXT,
  sent_at TEXT,
  attempts INTEGER DEFAULT 0,
  accepted INTEGER DEFAULT 0,
  channel TEXT,
  message TEXT)`;

const WAL_SWITCH_MS = 10_000;

// The switch to WAL takes an exclusive lock and SQLite answers SQLITE_BUSY at once, without the busy handler, while
// another process is opening the same new file. WAL is stored in the file, so the first switch that lands is enough.
const enableWal = (db: Database): void => {
  const deadline = Date.now() + WAL_SWITCH_MS;
  for (;;) {
    try {
      const row = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string } | null;
      if (row?.journal_mode === "wal") return;
    } catch (e) {
      if (!(e instanceof SQLiteError && e.code === "SQLITE_BUSY")) throw e;
    }
    if (Date.now() > deadline) throw new Error("lead inbox: could not switch the database to WAL within 10 s");
    Bun.sleepSync(20);
  }
};

export const openInboxDb = (path: string): Database => {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA busy_timeout = 10000");
  enableWal(db);
  db.run(SCHEMA);
  return db;
};
