import { BrowserWindow } from "electron";
import http, { IncomingMessage, ServerResponse, STATUS_CODES } from "node:http";
import { once } from "node:events";
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
import { providerChatCompletionsUrl, providerMessagesUrl, providerResponsesUrl } from "./provider.js";
import { RequestQueue } from "./requestQueue.js";

const ANTHROPIC_VERSION = "2023-06-01";
const SUPPORTED_ENDPOINTS =
  "Supported endpoints are GET /v1/models, GET /v1/models/{model_id}, POST /v1/messages, POST /v1/chat/completions, and POST /v1/responses";

type ProviderEndpoint = "messages" | "chatCompletions" | "responses";

type ClientRoute = {
  protocol: LlmProtocol;
  endpoint: ProviderEndpoint;
  path: string;
};

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

type StreamProxyResult = {
  providerBody: string;
  clientBody: string;
  transformed: StreamTransform;
};

type OpenAIToAnthropicStreamState = {
  messageStart: any;
  started: boolean;
  thinkingBlockOpen: boolean;
  thinkingIndex: number;
  textBlockOpen: boolean;
  textIndex: number;
  toolCalls: Map<number, { id: string; name: string; arguments: string; index: number }>;
  nextBlockIndex: number;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  stopped: boolean;
};

type AnthropicToOpenAIStreamState = {
  id: string;
  created: number;
  promptTokens: number;
  completionTokens: number;
  nextToolIndex: number;
  toolIndexes: Map<number, number>;
  done: boolean;
};

type PreparedProviderRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

type ModelsResponseFormat = "openai" | "anthropic";

type RawHeaderValue = string | string[] | number | undefined;
type RawHeaderMap = Record<string, RawHeaderValue>;

export class GatewayServer {
  private server?: http.Server;
  private lifecycle = Promise.resolve();
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
    await this.enqueueLifecycle(async () => {
      await this.stopNow();
      await this.startNow(this.configStore.get());
    });
  }

  async applyConfig(previousConfig: GatewayConfig): Promise<void> {
    await this.enqueueLifecycle(async () => {
      const config = this.configStore.get();
      this.configureQueues(config);

      if (!this.server) {
        await this.startNow(config);
        return;
      }

      if (!listenerAddressChanged(previousConfig, config)) {
        this.setStatus("running", config);
        return;
      }

      await this.stopNow();
      await this.startNow(config);
    });
  }

  async stop(): Promise<void> {
    await this.enqueueLifecycle(() => this.stopNow());
  }

  getStatus(): GatewayStatus {
    return this.status;
  }

  private async enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.catch(() => undefined).then(operation);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  private async startNow(config: GatewayConfig): Promise<void> {
    this.setStatus("starting", config);
    this.configureQueues(config);
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => this.writeError(res, 500, "internal_error", String(error)));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(config.port, config.host);
      });
      server.on("error", (error) => {
        if (this.server === server) this.setStatus("error", config, error.message);
      });
      this.server = server;
      this.setStatus("running", config);
    } catch (error) {
      try {
        server.close();
      } catch {
        // Ignore close errors for a server that never started listening.
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus("error", config, message);
      throw error;
    }
  }

  private async stopNow(): Promise<void> {
    const config = this.configStore.get();
    const server = this.server;
    if (!server) {
      if (this.status.state !== "error") this.setStatus("stopped", config);
      return;
    }
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections?.();
    });
    this.setStatus("stopped", config);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const config = this.configStore.get();
    if (!this.isAuthorized(req, config)) {
      this.writeError(res, 401, "authentication_error", "Invalid local gateway token");
      return;
    }

    if (this.isModelsRequest(req)) {
      this.writeJson(res, 200, modelsResponse(config, modelsResponseFormat(req)));
      return;
    }

    const modelId = this.modelDetailsId(req);
    if (modelId) {
      const format = modelsResponseFormat(req);
      const body = modelResponse(config, modelId, format);
      if (!body) {
        this.writeError(res, 404, "not_found_error", `Model ${modelId} was not found`, format === "anthropic" ? "anthropic" : "openai");
        return;
      }
      this.writeJson(res, 200, body);
      return;
    }

    const clientRoute = this.clientRoute(req);
    if (!clientRoute) {
      this.writeError(res, 404, "not_found_error", SUPPORTED_ENDPOINTS);
      return;
    }
    const clientProtocol = clientRoute.protocol;

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
    if (clientRoute.endpoint === "responses" && providerProtocol !== "openai") {
      this.writeError(res, 501, "unsupported_endpoint_error", "Responses requests require an OpenAI-compatible provider", "openai");
      return;
    }

    const converted = this.convertRequest(clientRoute, providerProtocol, clientRequest, config);
    const clientRequestBody = rawBodyForLog(rawBody, clientRequest, config);
    const providerRequest = prepareProviderRequest(provider, providerProtocol, clientRoute.endpoint, converted.request);
    const providerRequestBody = rawBodyForLog(providerRequest.body, converted.request, config);
    const log: LogEntry = {
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      method: req.method ?? "POST",
      path: req.url ?? clientRoute.path,
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
        formatHttpRequestLine(req.method ?? "POST", req.url ?? clientRoute.path),
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
      log.statusCode = providerResponse.status;

      if ((clientRequest as any).stream && providerResponse.ok) {
        const proxied = await this.proxyStream(providerResponse, res, clientRoute, providerProtocol, converted);
        log.status = "ok";
        log.providerResponseRaw = formatHttpMessage(
          formatHttpResponseLine(providerResponse.status, providerResponse.statusText),
          redactedHeaders(headersFromFetchResponse(providerResponse.headers), config),
          rawSseBodyForLog(proxied.providerBody, config)
        );
        log.streamEvents = config.redactSensitive ? (redact(proxied.transformed.streamEvents) as unknown[]) : proxied.transformed.streamEvents;
        log.providerResponse = config.redactSensitive ? redact(proxied.transformed.providerLog) : proxied.transformed.providerLog;
        log.clientResponse = config.redactSensitive ? redact(proxied.transformed.clientLog) : proxied.transformed.clientLog;
        log.anthropicResponse = clientProtocol === "anthropic" ? log.clientResponse : undefined;
        log.clientResponseRaw = formatHttpMessage(
          formatHttpResponseLine(200),
          {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive"
          },
          rawSseBodyForLog(proxied.clientBody, config)
        );
        this.finish(log, started, config);
        return;
      }

      const text = await providerResponse.text();
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

      const providerJson = JSON.parse(text);
      const clientJson = this.transformJson(providerJson, clientRoute, providerProtocol, converted);
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
    clientRoute: ClientRoute,
    providerProtocol: LlmProtocol,
    body: unknown,
    config: GatewayConfig
  ): ConvertedRequest {
    const clientProtocol = clientRoute.protocol;
    if (clientRoute.endpoint === "responses") {
      const route = resolveModelRoute(requestModel(body), config);
      return {
        clientModel: route.clientModel,
        providerId: route.providerId,
        providerModel: route.providerModel,
        warning: route.warning,
        request: openAITransparentRequest(body as any, route.providerModel)
      };
    }

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
    clientRoute: ClientRoute,
    providerProtocol: LlmProtocol,
    converted: ConvertedRequest
  ): unknown {
    if (clientRoute.endpoint === "responses") {
      return providerJson;
    }

    const clientProtocol = clientRoute.protocol;
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
    clientRoute: ClientRoute,
    providerProtocol: LlmProtocol,
    converted: ConvertedRequest
  ): StreamTransform {
    if (clientRoute.endpoint === "responses") {
      const lines = text.split(/\r?\n/);
      return {
        body: text,
        providerLog: { sse: lines },
        clientLog: { sse: lines },
        streamEvents: lines
      };
    }

    const clientProtocol = clientRoute.protocol;
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

  private async proxyStream(
    providerResponse: Response,
    res: ServerResponse,
    clientRoute: ClientRoute,
    providerProtocol: LlmProtocol,
    converted: ConvertedRequest
  ): Promise<StreamProxyResult> {
    if (!providerResponse.body) {
      throw new Error("Provider stream response did not include a readable body");
    }

    const providerChunks: string[] = [];
    const clientChunks: string[] = [];
    const decoder = new TextDecoder();
    const reader = providerResponse.body.getReader();
    const splitter = createSseFrameSplitter();
    const responseModel = converted.clientModel || converted.providerModel;
    const transformFrame = this.streamFrameTransformer(clientRoute, providerProtocol, responseModel);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.flushHeaders?.();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (!text) continue;
        providerChunks.push(text);
        for (const frame of splitter.push(text)) {
          await this.writeStreamFrames(res, transformFrame(frame), clientChunks);
        }
      }

      const tail = decoder.decode();
      if (tail) {
        providerChunks.push(tail);
        for (const frame of splitter.push(tail)) {
          await this.writeStreamFrames(res, transformFrame(frame), clientChunks);
        }
      }

      const finalFrame = splitter.flush();
      if (finalFrame !== undefined) {
        await this.writeStreamFrames(res, transformFrame(finalFrame), clientChunks);
      }
      await this.writeStreamFrames(res, transformFrame(undefined), clientChunks);
      if (!res.writableEnded) res.end();

      const providerBody = providerChunks.join("");
      const clientBody = clientChunks.join("");
      return {
        providerBody,
        clientBody,
        transformed: this.transformStream(providerBody, clientRoute, providerProtocol, converted)
      };
    } catch (error) {
      if (!res.writableEnded) res.end();
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private streamFrameTransformer(
    clientRoute: ClientRoute,
    providerProtocol: LlmProtocol,
    responseModel: string
  ): (frame: string | undefined) => string[] {
    if (clientRoute.endpoint === "responses") {
      return (frame) => frame === undefined ? [] : [frame];
    }

    const clientProtocol = clientRoute.protocol;
    if (clientProtocol === providerProtocol) {
      return (frame) => frame === undefined ? [] : [frame];
    }

    if (providerProtocol === "openai") {
      const state = createOpenAIToAnthropicStreamState(responseModel);
      return (frame) => transformOpenAIFrameToAnthropicSse(frame, state);
    }

    const state = createAnthropicToOpenAIStreamState(responseModel);
    return (frame) => transformAnthropicFrameToOpenAISse(frame, state, responseModel);
  }

  private async writeStreamFrames(res: ServerResponse, frames: string[], clientChunks: string[]): Promise<void> {
    for (const frame of frames) {
      clientChunks.push(frame);
      if (!res.write(frame)) {
        await once(res, "drain");
      }
    }
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

  private isModelsRequest(req: IncomingMessage): boolean {
    return req.method === "GET" && req.url?.split("?")[0] === "/v1/models";
  }

  private modelDetailsId(req: IncomingMessage): string | undefined {
    if (req.method !== "GET") return undefined;
    const path = req.url?.split("?")[0] ?? "";
    const prefix = "/v1/models/";
    if (!path.startsWith(prefix)) return undefined;
    const encodedId = path.slice(prefix.length);
    if (!encodedId || encodedId.includes("/")) return undefined;
    return decodeURIComponent(encodedId);
  }

  private clientRoute(req: IncomingMessage): ClientRoute | undefined {
    if (req.method !== "POST") return undefined;
    const path = req.url?.split("?")[0];
    if (path === "/v1/messages") return { protocol: "anthropic", endpoint: "messages", path };
    if (path === "/v1/chat/completions") return { protocol: "openai", endpoint: "chatCompletions", path };
    if (path === "/v1/responses") return { protocol: "openai", endpoint: "responses", path };
    return undefined;
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

  private writeJson(res: ServerResponse, status: number, body: unknown): void {
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

function providerUrl(provider: ProviderConfig, protocol: LlmProtocol, endpoint: ProviderEndpoint): string {
  if (endpoint === "responses") return providerResponsesUrl(provider.baseUrl);
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

function prepareProviderRequest(provider: ProviderConfig, protocol: LlmProtocol, endpoint: ProviderEndpoint, body: unknown): PreparedProviderRequest {
  return {
    url: providerUrl(provider, protocol, endpoint),
    headers: providerHeaders(provider, protocol),
    body: JSON.stringify(body)
  };
}

export function listenerAddressChanged(previous: GatewayConfig, next: GatewayConfig): boolean {
  return previous.host !== next.host || previous.port !== next.port;
}

export function modelsResponse(config: GatewayConfig, format: ModelsResponseFormat = "openai"): unknown {
  const ids = Object.keys(config.modelMappings).sort();

  if (format === "anthropic") {
    return {
      data: ids.map((id) => anthropicModelInfo(id)),
      first_id: ids[0] ?? null,
      has_more: false,
      last_id: ids.at(-1) ?? null
    };
  }

  return {
    object: "list",
    data: ids.map((id) => openAIModelInfo(id))
  };
}

export function modelResponse(config: GatewayConfig, id: string, format: ModelsResponseFormat = "openai"): unknown | undefined {
  if (!Object.prototype.hasOwnProperty.call(config.modelMappings, id)) return undefined;
  return format === "anthropic" ? anthropicModelInfo(id) : openAIModelInfo(id);
}

export function modelsResponseFormat(req: Pick<IncomingMessage, "headers" | "url">): ModelsResponseFormat {
  const url = new URL(req.url ?? "", "http://localhost");
  const explicitFormat = url.searchParams.get("format")?.toLowerCase();
  if (explicitFormat === "anthropic") return "anthropic";
  if (explicitFormat === "openai") return "openai";

  if (hasHeaderValue(req.headers["anthropic-version"])) return "anthropic";
  if (hasHeaderValue(req.headers["x-api-key"]) && !hasHeaderValue(req.headers.authorization)) return "anthropic";

  return "openai";
}

function hasHeaderValue(value: RawHeaderValue): boolean {
  if (Array.isArray(value)) return value.some((item) => item.trim() !== "");
  return value !== undefined && String(value).trim() !== "";
}

function openAIModelInfo(id: string): unknown {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "llm-gateway"
  };
}

function anthropicModelInfo(id: string): unknown {
  return {
    id,
    type: "model",
    display_name: id,
    created_at: "1970-01-01T00:00:00Z"
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

function createSseFrameSplitter(): { push: (chunk: string) => string[]; flush: () => string | undefined } {
  let buffer = "";
  const split = (): string[] => {
    const frames: string[] = [];
    while (true) {
      const delimiter = sseFrameDelimiter(buffer);
      if (!delimiter) break;
      const frame = buffer.slice(0, delimiter.index + delimiter.length);
      buffer = buffer.slice(delimiter.index + delimiter.length);
      frames.push(frame);
    }
    return frames;
  };

  return {
    push: (chunk) => {
      buffer += chunk;
      return split();
    },
    flush: () => {
      if (!buffer) return undefined;
      const frame = buffer;
      buffer = "";
      return frame;
    }
  };
}

function sseFrameDelimiter(value: string): { index: number; length: number } | undefined {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf === -1) return crlf === -1 ? undefined : { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function createOpenAIToAnthropicStreamState(responseModel: string): OpenAIToAnthropicStreamState {
  const messageStart = {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: responseModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }
  };

  return {
    messageStart,
    started: false,
    thinkingBlockOpen: false,
    thinkingIndex: 0,
    textBlockOpen: false,
    textIndex: 0,
    toolCalls: new Map(),
    nextBlockIndex: 0,
    stopReason: null,
    inputTokens: 0,
    outputTokens: 0,
    stopped: false
  };
}

function transformOpenAIFrameToAnthropicSse(frame: string | undefined, state: OpenAIToAnthropicStreamState): string[] {
  if (frame === undefined) return finishOpenAIToAnthropicStream(state).map(formatAnthropicSseEvent);

  const output: any[] = startOpenAIToAnthropicStream(state);
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === "[DONE]") {
      output.push(...finishOpenAIToAnthropicStream(state));
      continue;
    }

    const chunk = JSON.parse(payload);
    if (chunk.usage) {
      state.inputTokens = numberValue(chunk.usage.prompt_tokens) ?? state.inputTokens;
      state.outputTokens = numberValue(chunk.usage.completion_tokens) ?? state.outputTokens;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    if (choice?.finish_reason) state.stopReason = finishReasonToAnthropic(choice.finish_reason);

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      if (!state.thinkingBlockOpen) {
        state.thinkingIndex = state.nextBlockIndex++;
        state.thinkingBlockOpen = true;
        output.push({
          event: "content_block_start",
          data: { type: "content_block_start", index: state.thinkingIndex, content_block: { type: "thinking", thinking: "" } }
        });
      }
      output.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index: state.thinkingIndex, delta: { type: "thinking_delta", thinking: delta.reasoning_content } }
      });
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      output.push(...stopOpenAIThinkingBlock(state));
      if (!state.textBlockOpen) {
        state.textIndex = state.nextBlockIndex++;
        state.textBlockOpen = true;
        output.push({
          event: "content_block_start",
          data: { type: "content_block_start", index: state.textIndex, content_block: { type: "text", text: "" } }
        });
      }
      output.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index: state.textIndex, delta: { type: "text_delta", text: delta.content } }
      });
    }

    for (const call of delta.tool_calls ?? []) {
      output.push(...stopOpenAIThinkingBlock(state));
      const index = call.index ?? 0;
      const existing = state.toolCalls.get(index);
      if (!existing) {
        const blockIndex = state.nextBlockIndex++;
        const created = {
          id: call.id ?? `call_${crypto.randomUUID()}`,
          name: call.function?.name ?? "",
          arguments: call.function?.arguments ?? "",
          index: blockIndex
        };
        state.toolCalls.set(index, created);
        output.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id: created.id, name: created.name, input: {} }
          }
        });
        if (created.arguments) output.push(toolInputDelta(blockIndex, created.arguments));
      } else {
        if (call.function?.name) existing.name += call.function.name;
        if (call.function?.arguments) {
          existing.arguments += call.function.arguments;
          output.push(toolInputDelta(existing.index, call.function.arguments));
        }
      }
    }
  }

  return output.map(formatAnthropicSseEvent);
}

function stopOpenAIThinkingBlock(state: OpenAIToAnthropicStreamState): any[] {
  if (!state.thinkingBlockOpen) return [];
  state.thinkingBlockOpen = false;
  return [{ event: "content_block_stop", data: { type: "content_block_stop", index: state.thinkingIndex } }];
}

function startOpenAIToAnthropicStream(state: OpenAIToAnthropicStreamState): any[] {
  if (state.started) return [];
  state.started = true;
  return [state.messageStart];
}

function finishOpenAIToAnthropicStream(state: OpenAIToAnthropicStreamState): any[] {
  if (state.stopped) return [];
  state.stopped = true;
  const output = [...startOpenAIToAnthropicStream(state), ...stopOpenAIThinkingBlock(state)];
  if (state.textBlockOpen) {
    output.push({ event: "content_block_stop", data: { type: "content_block_stop", index: state.textIndex } });
  }
  for (const call of state.toolCalls.values()) {
    output.push({ event: "content_block_stop", data: { type: "content_block_stop", index: call.index } });
  }
  output.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: state.stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: state.outputTokens }
    }
  });
  output.push({ event: "message_stop", data: { type: "message_stop" } });
  return output;
}

function createAnthropicToOpenAIStreamState(responseModel: string): AnthropicToOpenAIStreamState {
  return {
    id: `chatcmpl_${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    promptTokens: 0,
    completionTokens: 0,
    nextToolIndex: 0,
    toolIndexes: new Map(),
    done: false
  };
}

function transformAnthropicFrameToOpenAISse(
  frame: string | undefined,
  state: AnthropicToOpenAIStreamState,
  responseModel: string
): string[] {
  if (frame === undefined) return finishAnthropicToOpenAIStream(state, responseModel);

  const chunks: unknown[] = [];
  const event = anthropicStreamToEvents(frame.split(/\r?\n/))[0] as any;
  if (!event) return [];

  if (event.event === "message_start") {
    const message = event.data?.message ?? {};
    state.id = message.id ? `chatcmpl_${message.id}` : state.id;
    state.promptTokens = numberValue(message.usage?.input_tokens) ?? state.promptTokens;
    chunks.push(openAIChunk(state.id, state.created, responseModel, { role: "assistant" }, null));
  }

  if (event.event === "content_block_start") {
    const block = event.data?.content_block;
    if (block?.type === "tool_use") {
      const toolIndex = state.nextToolIndex++;
      state.toolIndexes.set(event.data.index, toolIndex);
      chunks.push(openAIChunk(state.id, state.created, responseModel, {
        tool_calls: [{
          index: toolIndex,
          id: block.id ?? `call_${crypto.randomUUID()}`,
          type: "function",
          function: { name: block.name ?? "", arguments: "" }
        }]
      }, null));
    }
  }

  if (event.event === "content_block_delta") {
    const delta = event.data?.delta;
    if (delta?.type === "text_delta") {
      chunks.push(openAIChunk(state.id, state.created, responseModel, { content: delta.text ?? "" }, null));
    }
    if (delta?.type === "input_json_delta") {
      const toolIndex = state.toolIndexes.get(event.data.index) ?? 0;
      chunks.push(openAIChunk(state.id, state.created, responseModel, {
        tool_calls: [{
          index: toolIndex,
          function: { arguments: delta.partial_json ?? "" }
        }]
      }, null));
    }
  }

  if (event.event === "message_delta") {
    const finishReason = anthropicStopReasonToOpenAI(event.data?.delta?.stop_reason);
    state.completionTokens = numberValue(event.data?.usage?.output_tokens) ?? state.completionTokens;
    chunks.push(openAIChunk(state.id, state.created, responseModel, {}, finishReason));
  }

  if (event.event === "message_stop") {
    return [...chunks.map(formatOpenAISseChunk), ...finishAnthropicToOpenAIStream(state, responseModel)];
  }

  return chunks.map(formatOpenAISseChunk);
}

function finishAnthropicToOpenAIStream(state: AnthropicToOpenAIStreamState, responseModel: string): string[] {
  if (state.done) return [];
  state.done = true;
  return [
    formatOpenAISseChunk({
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: responseModel,
      choices: [],
      usage: {
        prompt_tokens: state.promptTokens,
        completion_tokens: state.completionTokens,
        total_tokens: state.promptTokens + state.completionTokens
      }
    }),
    "data: [DONE]\n\n"
  ];
}

function formatAnthropicSseEvent(event: any): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function formatOpenAISseChunk(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function finishReasonToAnthropic(reason: string | null | undefined): string {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "stop_sequence";
  return "end_turn";
}

function anthropicStopReasonToOpenAI(reason: string | null | undefined): string {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return "stop";
}

function toolInputDelta(index: number, partialJson: string) {
  return {
    event: "content_block_delta",
    data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partialJson } }
  };
}

function openAIChunk(id: string, created: number, model: string, delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
