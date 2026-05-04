import { BrowserWindow } from "electron";
import http, { IncomingMessage, ServerResponse } from "node:http";
import { GatewayConfig, LogEntry, ProviderConfig } from "../shared/types.js";
import { ConfigStore } from "./config.js";
import { LogStore } from "./store.js";
import {
  anthropicToOpenAI,
  anthropicEventsToMessage,
  openAIStreamToJson,
  openAIStreamToAnthropicEvents,
  openAIToAnthropic,
  redact,
  sseFormat
} from "./protocol.js";
import { providerChatCompletionsUrl } from "./provider.js";
import { RequestQueue } from "./requestQueue.js";

export class GatewayServer {
  private server?: http.Server;
  private readonly queues = new Map<string, RequestQueue>();

  constructor(
    private readonly configStore: ConfigStore,
    private readonly logStore: LogStore,
    private readonly getWindow: () => BrowserWindow | undefined
  ) {}

  async restart(): Promise<void> {
    await this.stop();
    const config = this.configStore.get();
    this.configureQueues(config);
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => this.writeError(res, 500, "internal_error", String(error)));
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(config.port, config.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = this.configStore.get();
    if (!this.isAuthorized(req, config)) {
      this.writeError(res, 401, "authentication_error", "Invalid local gateway token");
      return;
    }

    if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/messages") {
      this.writeError(res, 404, "not_found_error", "Only POST /v1/messages is supported");
      return;
    }

    const rawBody = await readBody(req);
    const anthropicRequest = JSON.parse(rawBody);
    const converted = anthropicToOpenAI(anthropicRequest, config);
    const provider = config.providers[converted.providerId];
    if (!provider) {
      this.writeError(res, 500, "configuration_error", `Provider "${converted.providerId}" is not configured`);
      return;
    }
    const log: LogEntry = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      method: req.method,
      path: req.url ?? "/v1/messages",
      status: "pending",
      anthropicModel: converted.anthropicModel,
      providerId: converted.providerId,
      providerModel: converted.providerModel,
      stream: Boolean(anthropicRequest.stream),
      warning: converted.warning,
      requestHeaders: config.redactSensitive ? redact(req.headers) : req.headers,
      anthropicRequest: config.redactSensitive ? redact(anthropicRequest) : anthropicRequest,
      providerRequest: config.redactSensitive ? redact(converted.request) : converted.request
    };
    this.saveAndNotify(log);

    const started = Date.now();
    try {
      const queued = await this.queueFor(converted.providerId, provider).run(() => this.callProvider(config, provider, converted.request));
      log.queueWaitMs = queued.waitMs;
      this.saveAndNotify(log);
      const providerResponse = queued.value;
      const text = await providerResponse.text();
      log.statusCode = providerResponse.status;

      if (!providerResponse.ok) {
        const errorBody = tryParseJson(text);
        log.status = "error";
        log.error = providerErrorMessage(errorBody, providerResponse.statusText);
        log.providerResponse = config.redactSensitive ? redact(errorBody) : errorBody;
        this.finish(log, started);
        this.writeError(res, providerResponse.status, "api_error", log.error);
        return;
      }

      if (anthropicRequest.stream) {
        const lines = text.split(/\r?\n/);
        const responseModel = converted.anthropicModel || converted.providerModel;
        const events = openAIStreamToAnthropicEvents(lines, responseModel);
        const providerJson = openAIStreamToJson(lines);
        const anthropicResponse = anthropicEventsToMessage(events);
        log.status = "ok";
        log.streamEvents = config.redactSensitive ? (redact(events) as unknown[]) : events;
        log.providerResponse = config.redactSensitive ? redact({ json: providerJson, sse: lines }) : { json: providerJson, sse: lines };
        log.anthropicResponse = config.redactSensitive ? redact({ json: anthropicResponse, sse: events }) : { json: anthropicResponse, sse: events };
        this.finish(log, started);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        res.end(sseFormat(events));
      } else {
        const providerJson = JSON.parse(text);
        const anthropicResponse = openAIToAnthropic(providerJson, converted.anthropicModel || converted.providerModel);
        log.status = "ok";
        log.providerResponse = config.redactSensitive ? redact(providerJson) : providerJson;
        log.anthropicResponse = config.redactSensitive ? redact(anthropicResponse) : anthropicResponse;
        this.finish(log, started);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(anthropicResponse));
      }
    } catch (error) {
      log.status = "error";
      log.error = error instanceof Error ? error.message : String(error);
      this.finish(log, started);
      this.writeError(res, 502, "api_error", log.error);
    }
  }

  private async callProvider(config: GatewayConfig, provider: ProviderConfig, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      return await fetch(providerChatCompletionsUrl(provider.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private configureQueues(config: GatewayConfig): void {
    for (const [providerId, provider] of Object.entries(config.providers)) {
      this.queueFor(providerId, provider).setConcurrency(provider.concurrency);
    }
    for (const providerId of this.queues.keys()) {
      if (!config.providers[providerId]) this.queues.delete(providerId);
    }
  }

  private queueFor(providerId: string, provider: ProviderConfig): RequestQueue {
    const existing = this.queues.get(providerId);
    if (existing) return existing;
    const created = new RequestQueue(provider.concurrency);
    this.queues.set(providerId, created);
    return created;
  }

  private isAuthorized(req: IncomingMessage, config: GatewayConfig): boolean {
    const auth = req.headers.authorization;
    const apiKey = req.headers["x-api-key"];
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    return token === config.localToken || apiKey === config.localToken;
  }

  private finish(log: LogEntry, started: number): void {
    log.completedAt = new Date().toISOString();
    log.durationMs = Date.now() - started;
    this.saveAndNotify(log);
  }

  private saveAndNotify(log: LogEntry): void {
    this.logStore.upsert(log);
    this.getWindow()?.webContents.send("log-updated", log);
  }

  private writeError(res: ServerResponse, status: number, type: string, message: string): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type, message } }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function providerErrorMessage(body: any, fallback: string): string {
  return body?.error?.message ?? body?.message ?? fallback;
}
