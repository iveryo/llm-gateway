import http, { IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, GatewayConfig, LogEntry } from "../shared/types.js";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn(() => process.cwd())
  }
}));

import { GatewayServer } from "./gateway.js";

class TestConfigStore {
  constructor(private readonly config: GatewayConfig) {}
  get(): GatewayConfig {
    return structuredClone(this.config);
  }
}

class TestLogStore {
  readonly entries = new Map<string, LogEntry>();
  upsert(entry: LogEntry): void {
    this.entries.set(entry.id, structuredClone(entry));
  }
  latest(): LogEntry | undefined {
    return [...this.entries.values()].at(-1);
  }
}

describe("GatewayServer streaming", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(closeServer));
    servers.length = 0;
  });

  it("forwards OpenAI provider chunks to Anthropic clients before upstream completion", async () => {
    const firstUpstreamFrame =
      'data: {"id":"chatcmpl_1","model":"provider-test","choices":[{"delta":{"reasoning_content":"Think"}}]}\n\n';
    let releaseSecondFrame: (() => void) | undefined;
    const provider = await listen((req, res) => {
      void readBody(req).then(() => {
        writeSseHead(res);
        res.write(firstUpstreamFrame.slice(0, 25));
        setTimeout(() => res.write(firstUpstreamFrame.slice(25)), 5);
        void new Promise<void>((resolve) => {
          releaseSecondFrame = resolve;
        }).then(() => {
          res.end(
            'data: {"id":"chatcmpl_1","model":"provider-test","choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
              "data: [DONE]\n\n"
          );
        });
      });
    });
    servers.push(provider.server);

    const logs = new TestLogStore();
    const gateway = createGateway(provider.url, "openai", logs);
    await gateway.restart();
    servers.push((gateway as any).server);

    const response = await fetch(`${gatewayUrl(gateway)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-dev-token" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      })
    });

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await readUntil(reader, "thinking_delta");
    expect(first).toContain("message_start");
    expect(first).toContain("thinking_delta");
    expect(first).toContain("Think");
    expect(first).not.toContain("message_stop");

    releaseSecondFrame?.();
    const rest = await readRest(reader);
    expect(rest).toContain("text_delta");
    expect(rest).toContain("message_stop");

    const log = logs.latest();
    expect(log?.status).toBe("ok");
    expect(log?.providerResponseRaw).toContain("chatcmpl_1");
    expect(log?.clientResponseRaw).toContain("Think");
    expect(log?.providerResponse).toMatchObject({
      json: { choices: [{ message: { reasoning_content: "Think", content: "Hi" } }] }
    });
    expect(log?.clientResponse).toMatchObject({
      json: { content: [{ type: "thinking", thinking: "Think" }, { type: "text", text: "Hi" }] }
    });
  });

  it("passes Anthropic provider SSE through to Anthropic clients frame by frame", async () => {
    let releaseSecondFrame: (() => void) | undefined;
    const firstFrame =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-provider-test","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
    const provider = await listen((req, res) => {
      void readBody(req).then(() => {
        writeSseHead(res);
        res.write(firstFrame);
        void new Promise<void>((resolve) => {
          releaseSecondFrame = resolve;
        }).then(() => {
          res.end(
            'event: content_block_start\n' +
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
              'event: content_block_delta\n' +
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
              'event: message_delta\n' +
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
              'event: message_stop\n' +
              'data: {"type":"message_stop"}\n\n'
          );
        });
      });
    });
    servers.push(provider.server);

    const logs = new TestLogStore();
    const gateway = createGateway(provider.url, "anthropic", logs);
    await gateway.restart();
    servers.push((gateway as any).server);

    const response = await fetch(`${gatewayUrl(gateway)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-dev-token" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      })
    });

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await readUntil(reader, "message_start");
    expect(first).toBe(firstFrame);

    releaseSecondFrame?.();
    const rest = await readRest(reader);
    expect(rest).toContain("content_block_delta");
    expect(rest).toContain("message_stop");

    expect(logs.latest()?.clientResponseRaw).toContain("text_delta");
  });

  it("keeps non-2xx provider stream responses as JSON errors", async () => {
    const provider = await listen((_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
    });
    servers.push(provider.server);

    const logs = new TestLogStore();
    const gateway = createGateway(provider.url, "openai", logs);
    await gateway.restart();
    servers.push((gateway as any).server);

    const response = await fetch(`${gatewayUrl(gateway)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "local-dev-token" },
      body: JSON.stringify({
        model: "claude-test",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }]
      })
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: { message: "rate limited" } });
    expect(logs.latest()?.status).toBe("error");
  });
});

function createGateway(providerUrl: string, providerProtocol: "openai" | "anthropic", logs: TestLogStore): GatewayServer {
  const config: GatewayConfig = {
    ...DEFAULT_CONFIG,
    host: "127.0.0.1",
    port: 0,
    redactSensitive: false,
    loggingEnabled: true,
    defaultProvider: "provider",
    defaultModel: "provider-test",
    providers: {
      provider: {
        protocol: providerProtocol,
        baseUrl: providerUrl,
        apiKey: "provider-key",
        concurrency: 1
      }
    },
    modelMappings: {
      "claude-test": { provider: "provider", model: providerProtocol === "openai" ? "provider-test" : "claude-provider-test" }
    }
  };

  return new GatewayServer(new TestConfigStore(config) as any, logs as any, () => undefined);
}

function gatewayUrl(gateway: GatewayServer): string {
  const server = (gateway as any).server as http.Server;
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

function readBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on("data", () => undefined);
    req.on("error", reject);
    req.on("end", resolve);
  });
}

function writeSseHead(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  return output;
}

async function readRest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  return output;
}
