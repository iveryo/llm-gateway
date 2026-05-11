import { BrowserWindow } from "electron";
import http, { IncomingMessage, ServerResponse, STATUS_CODES } from "node:http";
import { GatewayConfig, GatewayRuntimeState, GatewayStatus, LlmProtocol, LogEntry, ProviderConfig } from "../shared/types.js";
import { ConfigStore } from "./config.js";
import { LogStore } from "./store.js";
import {
  anthropicEventsToMessage,
  anthropicStreamToEvents,
  anthropicStreamToOpenAIChunks,
  anthropicToOpenAI,
  anthropicToOpenAIResponse,
  anthropicTransparentRequest,
  openAIRequestToAnthropic,
  openAISseFormat,
  openAIStreamToAnthropicEvents,
  openAIStreamToJson,
  openAIToAnthropic,
  openAITransparentRequest,
  redact,
  resolveModelRoute,
  sseFormat
} from "./protocol.js";
import { providerChatCompletionsUrl, providerMessagesUrl } from "./provider.js";
import { RequestQueue } from "./requestQueue.js";

const ANTHROPIC_VERSION = "2023-06-01";

type ConvertedRequest = {
  clientModel: string;
  anthropicModel?: string;
  providerId: string;
  providerModel: string;
  warning?: string;
  request: unknown;
};

type StreamTransform = {
  body: string;
  providerLog: unknown;
  clientLog: unknown;
  streamEvents?: unknown[];
};

type PreparedProviderRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

type RawHeaderValue = string | string[] | number | undefined;
type RawHeaderMap = Record<string, RawHeaderValue>;

export class GatewayServer {
  private server?: http.Server;
  private readonly queues = new Map<string, RequestQueue>();
  private status: GatewayStatus;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly logStore: LogStore,
    private readonly getWindow: () => BrowserWindow | undefined
  ) {
    const config = this.configStore.get();
    this.status = this.createStatus("stopped", config);
  }

  async restart(): Promise<void> {
    await this.stop();
    const config = this.configStore.get();
    this.setStatus("starting", config);
    this.configureQueues(config);
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => this.writeError(res, 500, "internal_error", String(error)));
    });
    this.server.on("error", (error) => {
      this.setStatus("error", config, error.message);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(config.port, config.host, () => resolve());
      });
      this.setStatus("running", config);
    } catch (error) {
      this.server = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", config, message);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const config = this.configStore.get();
    if (!this.server) {
      if (this.status.state !== "error") this.setStatus("stopped", config);
      return;
    }
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = undefined;
    this.setStatus("stopped", config);
  }

  getStatus(): GatewayStatus {
    return this.status;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = this.configStore.get();
    if (!this.isAuthorized(req, config)) {
      this.writeError(res, 401, "authentication_error", "Invalid local gateway token");
      return;
    }

    const clientProtocol = this.clientProtocol(req);
    if (!clientProtocol) {
      this.writeError(res, 404, "not_found_error", "Supported endpoints are POST /v1/messages and POST /v1/chat/completions");
      return;
    }

    const rawBody = await readBody(req);
    const clientRequest = tryParseJson(rawBody);
    if (clientRequest === undefined) {
      this.writeError(res, 400, "invalid_request_error", "Request body must be valid JSON", clientProtocol);
      return;
    }

    const route = resolveModelRoute(requestModel(clientRequest), config);
    const provider = config.providers[route.providerId];
    if (!provider) {
      this.writeError(res, 500, "configuration_error", `Provider "${route.providerId}" is not configured`, clientProtocol);
      return;
    }

    const providerProtocol = provider.protocol ?? "openai";
    const converted = this.convertRequest(clientProtocol, providerProtocol, clientRequest, config);
    const clientRequestBody = rawBodyForLog(rawBody, clientRequest, config);
    const providerRequest = prepareProviderRequest(provider, providerProtocol, converted.request);
    const providerRequestBody = rawBodyForLog(providerRequest.body, converted.request, config);
    const log: LogEntry = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      method: req.method ?? "POST",
      path: req.url ?? this.defaultPath(clientProtocol),
      status: "pending",
      clientProtocol,
      providerProtocol,
      clientModel: converted.clientModel,
      anthropicModel: clientProtocol === "anthropic" ? converted.clientModel : undefined,
      providerId: converted.providerId,
      providerModel: converted.providerModel,
      stream: Boolean((clientRequest as any).stream),
      warning: converted.warning,
      requestHeaders: config.redactSensitive ? redact(req.headers) : req.headers,
      clientRequest: config.redactSensitive ? redact(clientRequest) : clientRequest,
      anthropicRequest: clientProtocol === "anthropic" ? (config.redactSensitive ? redact(clientRequest) : clientRequest) : undefined,
      providerRequest: config.redactSensitive ? redact(converted.request) : converted.request,
      clientRequestRaw: formatHttpMessage(
        formatHttpRequestLine(req.method ?? "POST", req.url ?? this.defaultPath(clientProtocol)),
        redactedHeaders(req.headers, config),
        clientRequestBody
      ),
      providerRequestRaw: formatHttpMessage(
        formatHttpRequestLine("POST", pathAndQuery(providerRequest.url)),
        redactedHeaders(providerRequest.headers, config),
        providerRequestBody
      )
    };
    this.saveAndNotify(log, config);

    const started = Date.now();
    try {
      const queued = await this.queueFor(converted.providerId, provider).run(() =>
        this.callProvider(config, providerRequest)
      );
      log.queueWaitMs = queued.waitMs;
      this.saveAndNotify(log, config);
      const providerResponse = queued.value;
      const text = await providerResponse.text();
      log.statusCode = providerResponse.status;
      log.providerResponseRaw = formatHttpMessage(
        formatHttpResponseLine(providerResponse.status, providerResponse.statusText),
        redactedHeaders(headersFromFetchResponse(providerResponse.headers), config),
        rawProviderResponseBodyForLog(text, config)
      );

      if (!providerResponse.ok) {
        const errorBody = tryParseJson(text) ?? { message: text };
        const providerError = providerErrorMessage(errorBody, providerResponse.statusText);
        const clientErrorBody = errorBodyForProtocol(providerResponse.status, "api_error", providerError, clientProtocol);
        log.status = "error";
        log.error = providerError;
        log.providerResponse = config.redactSensitive ? redact(errorBody) : errorBody;
        log.clientResponse = config.redactSensitive ? redact(clientErrorBody) : clientErrorBody;
        log.clientResponseRaw = formatHttpMessage(
          formatHttpResponseLine(providerResponse.status),
          { "content-type": "application/json" },
          JSON.stringify(config.redactSensitive ? redact(clientErrorBody) : clientErrorBody)
        );
        this.finish(log, started, config);
        this.writeErrorBody(res, providerResponse.status, clientErrorBody);
        return;
      }

      if ((clientRequest as any).stream) {
        const transformed = this.transformStream(text, clientProtocol, providerProtocol, converted);
        log.status = "ok";
        log.streamEvents = config.redactSensitive ? (redact(transformed.streamEvents) as unknown[]) : transformed.streamEvents;
        log.providerResponse = config.redactSensitive ? redact(transformed.providerLog) : transformed.providerLog;
        log.clientResponse = config.redactSensitive ? redact(transformed.clientLog) : transformed.clientLog;
        log.anthropicResponse = clientProtocol === "anthropic" ? log.clientResponse : undefined;
        log.clientResponseRaw = formatHttpMessage(
          formatHttpResponseLine(200),
          {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive"
          },
          rawSseBodyForLog(transformed.body, config)
        );
        this.finish(log, started, config);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        res.end(transformed.body);
      } else {
        const providerJson = JSON.parse(text);
        const clientJson = this.transformJson(providerJson, clientProtocol, providerProtocol, converted);
        log.status = "ok";
        log.providerResponse = config.redactSensitive ? redact(providerJson) : providerJson;
        log.clientResponse = config.redactSensitive ? redact(clientJson) : clientJson;
        log.anthropicResponse = clientProtocol === "anthropic" ? log.clientResponse : undefined;
        log.clientResponseRaw = formatHttpMessage(
          formatHttpResponseLine(200),
          { "content-type": "application/json" },
          JSON.stringify(config.redactSensitive ? redact(clientJson) : clientJson)
        );
        this.finish(log, started, config);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(clientJson));
      }
    } catch (error) {
      log.status = "error";
      log.error = error instanceof Error ? error.message : String(error);
      const clientErrorBody = errorBodyForProtocol(502, "api_error", log.error, clientProtocol);
      log.clientResponse = config.redactSensitive ? redact(clientErrorBody) : clientErrorBody;
      log.clientResponseRaw = formatHttpMessage(
        formatHttpResponseLine(502),
        { "content-type": "application/json" },
        JSON.stringify(config.redactSensitive ? redact(clientErrorBody) : clientErrorBody)
      );
      this.finish(log, started, config);
      this.writeErrorBody(res, 502, clientErrorBody);
    }
  }

  private convertRequest(
    clientProtocol: LlmProtocol,
    providerProtocol: LlmProtocol,
    body: unknown,
    config: GatewayConfig
  ): ConvertedRequest {
    if (clientProtocol === "anthropic" && providerProtocol === "openai") {
      return anthropicToOpenAI(body as any, config);
    }

    if (clientProtocol === "openai" && providerProtocol === "anthropic") {
      return openAIRequestToAnthropic(body as any, config);
    }

    const route = resolveModelRoute(requestModel(body), config);
    const request = clientProtocol === "openai"
      ? openAITransparentRequest(body as any, route.providerModel)
      : anthropicTransparentRequest(body as any, route.providerModel);

    return {
      clientModel: route.clientModel,
      anthropicModel: clientProtocol === "anthropic" ? route.clientModel : undefined,
      providerId: route.providerId,
      providerModel: route.providerModel,
      warning: route.warning,
      request
    };
  }

  private transformJson(
    providerJson: unknown,
    clientProtocol: LlmProtocol,
    providerProtocol: LlmProtocol,
    converted: ConvertedRequest
  ): unknown {
    const responseModel = converted.clientModel || converted.providerModel;

    if (clientProtocol === providerProtocol) {
      return providerJson;
    }

    if (clientProtocol === "anthropic" && providerProtocol === "openai") {
      return openAIToAnthropic(providerJson, responseModel);
    }

    return anthropicToOpenAIResponse(providerJson, responseModel);
  }

  private transformStream(
    text: string,
    clientProtocol: LlmProtocol,
    providerProtocol: LlmProtocol,
    converted: ConvertedRequest
  ): StreamTransform {
    const responseModel = converted.clientModel || converted.providerModel;

    if (providerProtocol === "openai") {
      const lines = text.split(/\r?\n/);
      const providerJson = openAIStreamToJson(lines);

      if (clientProtocol === "openai") {
        return {
          body: text,
          providerLog: { json: providerJson, sse: lines },
          clientLog: { json: providerJson, sse: lines },
          streamEvents: lines
        };
      }

      const events = openAIStreamToAnthropicEvents(lines, responseModel);
      const anthropicResponse = anthropicEventsToMessage(events);
      return {
        body: sseFormat(events),
        providerLog: { json: providerJson, sse: lines },
        clientLog: { json: anthropicResponse, sse: events },
        streamEvents: events
      };
    }

    const providerLines = text.split(/\r?\n/);
    const providerEvents = anthropicStreamToEvents(providerLines);
    const providerJson = anthropicEventsToMessage(providerEvents);

    if (clientProtocol === "anthropic") {
      return {
        body: text,
        providerLog: { json: providerJson, sse: providerEvents },
        clientLog: { json: providerJson, sse: providerEvents },
        streamEvents: providerEvents
      };
    }

    const chunks = anthropicStreamToOpenAIChunks(providerEvents, responseModel);
    const body = openAISseFormat(chunks);
    return {
      body,
      providerLog: { json: providerJson, sse: providerEvents },
      clientLog: { json: openAIStreamToJson(body.split(/\r?\n/)), sse: chunks },
      streamEvents: chunks
    };
  }

  private async callProvider(config: GatewayConfig, request: PreparedProviderRequest): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      return await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
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

  private clientProtocol(req: IncomingMessage): LlmProtocol | undefined {
    if (req.method !== "POST") return undefined;
    const path = req.url?.split("?")[0];
    if (path === "/v1/messages") return "anthropic";
    if (path === "/v1/chat/completions") return "openai";
    return undefined;
  }

  private defaultPath(protocol: LlmProtocol): string {
    return protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  }

  private finish(log: LogEntry, started: number, config: GatewayConfig): void {
    log.completedAt = new Date().toISOString();
    log.durationMs = Date.now() - started;
    this.saveAndNotify(log, config);
  }

  private saveAndNotify(log: LogEntry, config: GatewayConfig): void {
    if (!config.loggingEnabled) return;
    this.logStore.upsert(log);
    this.getWindow()?.webContents.send("log-updated", log);
  }

  private setStatus(state: GatewayRuntimeState, config: GatewayConfig, message?: string): void {
    this.status = this.createStatus(state, config, message);
    this.getWindow()?.webContents.send("gateway-status-updated", this.status);
  }

  private createStatus(state: GatewayRuntimeState, config: GatewayConfig, message?: string): GatewayStatus {
    return {
      state,
      host: config.host,
      port: config.port,
      url: `http://${config.host}:${config.port}`,
      message,
      updatedAt: new Date().toISOString()
    };
  }

  private writeError(res: ServerResponse, status: number, type: string, message: string, protocol?: LlmProtocol): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(errorBodyForProtocol(status, type, message, protocol)));
  }

  private writeErrorBody(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
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

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function requestModel(body: unknown): string | undefined {
  return body && typeof body === "object" ? String((body as { model?: unknown }).model ?? "") : undefined;
}

function providerUrl(provider: ProviderConfig, protocol: LlmProtocol): string {
  return protocol === "anthropic"
    ? providerMessagesUrl(provider.baseUrl)
    : providerChatCompletionsUrl(provider.baseUrl);
}

function providerHeaders(provider: ProviderConfig, protocol: LlmProtocol): Record<string, string> {
  if (protocol === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    };
  }

  return {
    "content-type": "application/json",
    authorization: `Bearer ${provider.apiKey}`
  };
}

function prepareProviderRequest(provider: ProviderConfig, protocol: LlmProtocol, body: unknown): PreparedProviderRequest {
  return {
    url: providerUrl(provider, protocol),
    headers: providerHeaders(provider, protocol),
    body: JSON.stringify(body)
  };
}

function providerErrorMessage(body: any, fallback: string): string {
  return body?.error?.message ?? body?.message ?? fallback;
}

function errorBodyForProtocol(_status: number, type: string, message: string, protocol?: LlmProtocol): unknown {
  if (protocol === "openai") {
    return { error: { message, type, param: null, code: null } };
  }
  return { type: "error", error: { type, message } };
}

function formatHttpRequestLine(method: string, path: string): string {
  return `${method} ${path || "/"} HTTP/1.1`;
}

function formatHttpResponseLine(status: number, statusText?: string): string {
  return `HTTP/1.1 ${status} ${statusText || STATUS_CODES[status] || ""}`.trimEnd();
}

function formatHeaders(headers: RawHeaderMap): string {
  return Object.entries(headers)
    .filter((entry): entry is [string, string | string[] | number] => entry[1] !== undefined)
    .flatMap(([key, value]) => {
      if (Array.isArray(value)) return value.map((item) => `${key}: ${item}`);
      return [`${key}: ${value}`];
    })
    .join("\n");
}

function formatHttpMessage(startLine: string, headers: RawHeaderMap, body?: string): string {
  const headerText = formatHeaders(headers);
  const head = headerText ? `${startLine}\n${headerText}` : startLine;
  return body === undefined || body === "" ? `${head}\n\n` : `${head}\n\n${body}`;
}

function headersFromFetchResponse(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

function redactedHeaders(headers: RawHeaderMap, config: GatewayConfig): RawHeaderMap {
  return config.redactSensitive ? (redact(headers) as RawHeaderMap) : headers;
}

function rawBodyForLog(rawBody: string, structuredBody: unknown, config: GatewayConfig): string {
  if (!config.redactSensitive) return rawBody;
  return stringifyForHttpBody(redact(structuredBody));
}

function rawProviderResponseBodyForLog(rawBody: string, config: GatewayConfig): string {
  if (!config.redactSensitive) return rawBody;
  const parsed = tryParseJson(rawBody);
  return parsed === undefined ? rawSseBodyForLog(rawBody, config) : stringifyForHttpBody(redact(parsed));
}

function rawSseBodyForLog(rawBody: string, config: GatewayConfig): string {
  if (!config.redactSensitive) return rawBody;
  return rawBody
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith("data: ")) return line;
      const data = line.slice(6);
      if (data === "[DONE]") return line;
      const parsed = tryParseJson(data);
      return parsed === undefined ? line : `data: ${stringifyForHttpBody(redact(parsed))}`;
    })
    .join("\n");
}

function stringifyForHttpBody(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pathAndQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
