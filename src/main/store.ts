import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { LogEntry } from "../shared/types.js";

export class LogStore {
  private db?: Database;
  private SQL?: SqlJsStatic;
  private readonly path = join(app.getPath("userData"), "logs.sqlite");

  async init(): Promise<void> {
    this.SQL = await initSqlJs({
      locateFile: (file: string) => join(app.getAppPath(), "node_modules", "sql.js", "dist", file)
    });
    this.db = existsSync(this.path)
      ? new this.SQL.Database(readFileSync(this.path))
      : new this.SQL.Database();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL,
        entry_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_started_at ON logs(started_at DESC);
    `);
    this.persist();
  }

  upsert(entry: LogEntry): void {
    const db = this.requireDb();
    db.run(
      "INSERT OR REPLACE INTO logs (id, started_at, status, entry_json) VALUES (?, ?, ?, ?)",
      [entry.id, entry.startedAt, entry.status, JSON.stringify(entry)]
    );
    this.persist();
  }

  list(limit = 500): LogEntry[] {
    const db = this.requireDb();
    const rows = db.exec("SELECT entry_json FROM logs ORDER BY started_at DESC LIMIT ?", [limit]);
    return rows[0]?.values.map((row) => JSON.parse(String(row[0])) as LogEntry) ?? [];
  }

  get(id: string): LogEntry | undefined {
    const db = this.requireDb();
    const stmt = db.prepare("SELECT entry_json FROM logs WHERE id = ?");
    try {
      stmt.bind([id]);
      if (!stmt.step()) return undefined;
      return JSON.parse(String(stmt.getAsObject().entry_json)) as LogEntry;
    } finally {
      stmt.free();
    }
  }

  clear(): void {
    this.requireDb().run("DELETE FROM logs");
    this.persist();
  }

  private persist(): void {
    const db = this.requireDb();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, Buffer.from(db.export()));
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("LogStore has not been initialized");
    }
    return this.db;
  }
}
