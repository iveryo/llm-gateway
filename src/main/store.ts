import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { LogEntry, StatsGranularity, StatsGroupBy, UsageStatsRow } from "../shared/types.js";

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
    `);
    this.migrate();
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_logs_started_at ON logs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_stats ON logs(started_at DESC, provider_id, provider_model, client_model, anthropic_model);
    `);
    this.backfillStatsColumns();
    this.persist();
  }

  upsert(entry: LogEntry): void {
    const db = this.requireDb();
    const usage = usageTokens(entry.providerResponse);
    db.run(
      `INSERT OR REPLACE INTO logs (
        id,
        started_at,
        completed_at,
        status,
        status_code,
        client_protocol,
        provider_protocol,
        client_model,
        anthropic_model,
        provider_id,
        provider_model,
        stream,
        prompt_tokens,
        completion_tokens,
        duration_ms,
        queue_wait_ms,
        entry_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.startedAt,
        entry.completedAt ?? null,
        entry.status,
        entry.statusCode ?? null,
        entry.clientProtocol ?? null,
        entry.providerProtocol ?? null,
        entry.clientModel ?? entry.anthropicModel ?? null,
        entry.anthropicModel ?? null,
        entry.providerId ?? null,
        entry.providerModel ?? null,
        entry.stream ? 1 : 0,
        usage.promptTokens,
        usage.completionTokens,
        entry.durationMs ?? null,
        entry.queueWaitMs ?? null,
        JSON.stringify(entry)
      ]
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

  stats(granularity: StatsGranularity, groupBy: StatsGroupBy, limit = 500): UsageStatsRow[] {
    const db = this.requireDb();
    const bucketExpression = bucketSql(granularity);
    const groupColumn = groupBySql(groupBy);
    const rows = db.exec(
      `SELECT
        ${bucketExpression} AS bucket,
        COALESCE(${groupColumn}, '-') AS group_key,
        COUNT(*) AS request_count,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS stream_count,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(prompt_tokens + completion_tokens) AS total_tokens,
        AVG(duration_ms) AS avg_duration_ms,
        AVG(queue_wait_ms) AS avg_queue_wait_ms
      FROM logs
      WHERE status != 'pending'
      GROUP BY bucket, group_key
      ORDER BY bucket DESC, total_tokens DESC, request_count DESC
      LIMIT ?`,
      [limit]
    );

    return rows[0]?.values.map((row) => ({
      bucket: String(row[0]),
      groupKey: String(row[1]),
      requestCount: numberValue(row[2]),
      successCount: numberValue(row[3]),
      errorCount: numberValue(row[4]),
      streamCount: numberValue(row[5]),
      promptTokens: numberValue(row[6]),
      completionTokens: numberValue(row[7]),
      totalTokens: numberValue(row[8]),
      avgDurationMs: Math.round(numberValue(row[9])),
      avgQueueWaitMs: Math.round(numberValue(row[10]))
    })) ?? [];
  }

  clear(): void {
    this.requireDb().run("DELETE FROM logs");
    this.persist();
  }

  private migrate(): void {
    const db = this.requireDb();
    const columns = new Set(
      (db.exec("PRAGMA table_info(logs)")[0]?.values ?? []).map((row) => String(row[1]))
    );
    const additions: Record<string, string> = {
      completed_at: "ALTER TABLE logs ADD COLUMN completed_at TEXT",
      status_code: "ALTER TABLE logs ADD COLUMN status_code INTEGER",
      client_protocol: "ALTER TABLE logs ADD COLUMN client_protocol TEXT",
      provider_protocol: "ALTER TABLE logs ADD COLUMN provider_protocol TEXT",
      client_model: "ALTER TABLE logs ADD COLUMN client_model TEXT",
      anthropic_model: "ALTER TABLE logs ADD COLUMN anthropic_model TEXT",
      provider_id: "ALTER TABLE logs ADD COLUMN provider_id TEXT",
      provider_model: "ALTER TABLE logs ADD COLUMN provider_model TEXT",
      stream: "ALTER TABLE logs ADD COLUMN stream INTEGER NOT NULL DEFAULT 0",
      prompt_tokens: "ALTER TABLE logs ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0",
      completion_tokens: "ALTER TABLE logs ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0",
      duration_ms: "ALTER TABLE logs ADD COLUMN duration_ms INTEGER",
      queue_wait_ms: "ALTER TABLE logs ADD COLUMN queue_wait_ms INTEGER"
    };
    for (const [column, sql] of Object.entries(additions)) {
      if (!columns.has(column)) db.run(sql);
    }
  }

  private backfillStatsColumns(): void {
    const db = this.requireDb();
    const rows = db.exec("SELECT id, entry_json FROM logs WHERE provider_id IS NULL OR completed_at IS NULL OR client_model IS NULL");
    for (const row of rows[0]?.values ?? []) {
      const id = String(row[0]);
      const entry = JSON.parse(String(row[1])) as LogEntry;
      const usage = usageTokens(entry.providerResponse);
      db.run(
        `UPDATE logs SET
          started_at = ?,
          completed_at = ?,
          status = ?,
          status_code = ?,
          client_protocol = ?,
          provider_protocol = ?,
          client_model = ?,
          anthropic_model = ?,
          provider_id = ?,
          provider_model = ?,
          stream = ?,
          prompt_tokens = ?,
          completion_tokens = ?,
          duration_ms = ?,
          queue_wait_ms = ?
        WHERE id = ?`,
        [
          entry.startedAt,
          entry.completedAt ?? null,
          entry.status,
          entry.statusCode ?? null,
          entry.clientProtocol ?? (entry.anthropicModel ? "anthropic" : null),
          entry.providerProtocol ?? (entry.providerId ? "openai" : null),
          entry.clientModel ?? entry.anthropicModel ?? null,
          entry.anthropicModel ?? null,
          entry.providerId ?? null,
          entry.providerModel ?? null,
          entry.stream ? 1 : 0,
          usage.promptTokens,
          usage.completionTokens,
          entry.durationMs ?? null,
          entry.queueWaitMs ?? null,
          id
        ]
      );
    }
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

function bucketSql(granularity: StatsGranularity): string {
  if (granularity === "month") return "strftime('%Y-%m', started_at, 'localtime')";
  if (granularity === "day") return "strftime('%Y-%m-%d', started_at, 'localtime')";
  return "strftime('%Y-%m-%d %H:00', started_at, 'localtime')";
}

function groupBySql(groupBy: StatsGroupBy): string {
  if (groupBy === "providerModel") return "COALESCE(provider_id, '-') || ' / ' || COALESCE(provider_model, '-')";
  if (groupBy === "clientModel" || groupBy === "anthropicModel") return "COALESCE(client_model, anthropic_model)";
  if (groupBy === "clientProtocol") return "client_protocol";
  if (groupBy === "providerProtocol") return "provider_protocol";
  return "provider_id";
}

function usageTokens(providerResponse: unknown): { promptTokens: number; completionTokens: number } {
  if (!providerResponse || typeof providerResponse !== "object") return { promptTokens: 0, completionTokens: 0 };
  const response = providerResponse as { usage?: unknown; json?: unknown };
  const usage = response.usage ?? (response.json && typeof response.json === "object" ? (response.json as { usage?: unknown }).usage : undefined);
  if (!usage || typeof usage !== "object") return { promptTokens: 0, completionTokens: 0 };
  const record = usage as Record<string, unknown>;
  return {
    promptTokens: numberValue(record.prompt_tokens ?? record.input_tokens),
    completionTokens: numberValue(record.completion_tokens ?? record.output_tokens)
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
