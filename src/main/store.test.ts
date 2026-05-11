import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogEntry } from "../shared/types.js";

const mockApp = vi.hoisted(() => ({ userDataPath: "" }));

vi.mock("electron", () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn(() => mockApp.userDataPath)
  }
}));

import { LogStore } from "./store.js";

describe("LogStore stats", () => {
  let userDataPath = "";

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), "llm-gateway-store-"));
    mockApp.userDataPath = userDataPath;
  });

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true });
    mockApp.userDataPath = "";
  });

  it("groups UTC ISO timestamps by local hour", async () => {
    const store = await createStore();

    store.upsert(logEntry({ id: "log-1", startedAt: "2026-05-10T09:12:00.000Z" }));

    expect(store.stats("hour", "provider")).toMatchObject([
      {
        bucket: formatLocalBucket("2026-05-10T09:12:00.000Z", "hour"),
        groupKey: "openai",
        requestCount: 1
      }
    ]);
  });

  it("uses the local day and month when UTC timestamps cross a local date boundary", async () => {
    const store = await createStore();
    const startedAt = "2026-05-10T16:30:00.000Z";

    store.upsert(logEntry({ id: "log-1", startedAt }));

    expect(store.stats("hour", "provider")[0]?.bucket).toBe(formatLocalBucket(startedAt, "hour"));
    expect(store.stats("day", "provider")[0]?.bucket).toBe(formatLocalBucket(startedAt, "day"));
    expect(store.stats("month", "provider")[0]?.bucket).toBe(formatLocalBucket(startedAt, "month"));
  });
});

async function createStore(): Promise<LogStore> {
  const store = new LogStore();
  await store.init();
  return store;
}

function logEntry({ id, startedAt }: { id: string; startedAt: string }): LogEntry {
  return {
    id,
    startedAt,
    completedAt: startedAt,
    durationMs: 100,
    method: "POST",
    path: "/v1/messages",
    status: "ok",
    statusCode: 200,
    anthropicModel: "claude-test",
    providerId: "openai",
    providerModel: "gpt-test",
    stream: false,
    queueWaitMs: 0,
    providerResponse: {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5
      }
    }
  };
}

function formatLocalBucket(value: string, granularity: "hour" | "day" | "month"): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());

  if (granularity === "month") return `${year}-${month}`;
  if (granularity === "day") return `${year}-${month}-${day}`;
  return `${year}-${month}-${day} ${hour}:00`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
