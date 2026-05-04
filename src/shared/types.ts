export type HeaderMap = Record<string, string | string[] | undefined>;

export type ProviderConfig = {
  baseUrl: string;
  apiKey: string;
  concurrency?: number;
  model_list?: string[];
};

export type ModelMapping = {
  provider: string;
  model: string;
};

export type GatewayConfig = {
  host: string;
  port: number;
  localToken: string;
  defaultProvider: string;
  providers: Record<string, ProviderConfig>;
  defaultModel: string;
  modelMappings: Record<string, ModelMapping>;
  requestTimeoutMs: number;
  redactSensitive: boolean;
};

export type LogStatus = "pending" | "ok" | "error";

export type LogEntry = {
  id: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  method: string;
  path: string;
  status: LogStatus;
  statusCode?: number;
  anthropicModel?: string;
  providerId?: string;
  providerModel?: string;
  stream: boolean;
  queueWaitMs?: number;
  warning?: string;
  error?: string;
  requestHeaders?: unknown;
  anthropicRequest?: unknown;
  providerRequest?: unknown;
  providerResponse?: unknown;
  anthropicResponse?: unknown;
  streamEvents?: unknown[];
};

export type RendererApi = {
  getConfig: () => Promise<GatewayConfig>;
  saveConfig: (config: GatewayConfig) => Promise<GatewayConfig>;
  getLogs: () => Promise<LogEntry[]>;
  getLog: (id: string) => Promise<LogEntry | undefined>;
  clearLogs: () => Promise<void>;
  onLogUpdated: (listener: (entry: LogEntry) => void) => () => void;
};

export const DEFAULT_CONFIG: GatewayConfig = {
  host: "127.0.0.1",
  port: 3456,
  localToken: "local-dev-token",
  defaultProvider: "openai",
  providers: {
    openai: {
      baseUrl: "https://api.openai.com",
      apiKey: "",
      model_list: ["gpt-4o", "gpt-4o-mini"]
    }
  },
  defaultModel: "gpt-4o",
  modelMappings: {
    "claude-3-5-sonnet-latest": { provider: "openai", model: "gpt-4o" },
    "claude-sonnet-4-5": { provider: "openai", model: "gpt-4o" }
  },
  requestTimeoutMs: 120000,
  redactSensitive: true
};
