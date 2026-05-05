import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, GatewayConfig, ModelMapping, ProviderConfig } from "../shared/types.js";

const CONFIG_FILE = "config.json";

export class ConfigStore {
  private readonly path: string;
  private config: GatewayConfig;

  constructor() {
    this.path = join(app.getPath("userData"), CONFIG_FILE);
    this.config = this.load();
  }

  get(): GatewayConfig {
    return {
      ...this.config,
      providers: structuredClone(this.config.providers),
      modelMappings: structuredClone(this.config.modelMappings)
    };
  }

  save(next: GatewayConfig): GatewayConfig {
    this.config = normalizeConfig(next);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.config, null, 2), "utf8");
    return this.get();
  }

  private load(): GatewayConfig {
    if (!existsSync(this.path)) {
      return { ...DEFAULT_CONFIG };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<GatewayConfig>;
      return normalizeConfig({ ...DEFAULT_CONFIG, ...parsed });
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
}

function normalizeConfig(config: GatewayConfig): GatewayConfig {
  const providers = normalizeProviders(config.providers);
  const defaultProvider = config.defaultProvider || DEFAULT_CONFIG.defaultProvider;
  if (!providers[defaultProvider]) {
    throw new Error(`Default provider "${defaultProvider}" is not configured`);
  }

  const modelMappings = normalizeModelMappings(config.modelMappings, providers);
  return {
    ...DEFAULT_CONFIG,
    ...config,
    host: config.host || DEFAULT_CONFIG.host,
    port: Number(config.port) || DEFAULT_CONFIG.port,
    localToken: config.localToken || DEFAULT_CONFIG.localToken,
    defaultProvider,
    providers,
    defaultModel: config.defaultModel || DEFAULT_CONFIG.defaultModel,
    modelMappings,
    requestTimeoutMs: Number(config.requestTimeoutMs) || DEFAULT_CONFIG.requestTimeoutMs,
    redactSensitive: Boolean(config.redactSensitive),
    loggingEnabled: config.loggingEnabled !== false
  };
}

function normalizeProviders(providers: GatewayConfig["providers"]): Record<string, ProviderConfig> {
  const normalized: Record<string, ProviderConfig> = {};
  for (const [id, provider] of Object.entries(providers || {})) {
    const trimmedId = id.trim();
    const baseUrl = provider?.baseUrl?.replace(/\/+$/, "");
    if (!trimmedId) throw new Error("Provider id cannot be empty");
    if (!baseUrl) throw new Error(`Provider "${trimmedId}" requires a baseUrl`);
    normalized[trimmedId] = {
      baseUrl,
      apiKey: provider.apiKey ?? "",
      concurrency: normalizeConcurrency(provider.concurrency),
      model_list: normalizeModelList(provider.model_list)
    };
  }
  return Object.keys(normalized).length ? normalized : structuredClone(DEFAULT_CONFIG.providers);
}

function normalizeConcurrency(concurrency: ProviderConfig["concurrency"]): number | undefined {
  const value = Math.floor(Number(concurrency) || 0);
  return value > 0 ? value : undefined;
}

function normalizeModelList(modelList: ProviderConfig["model_list"]): string[] | undefined {
  if (!Array.isArray(modelList)) return undefined;
  const normalized = modelList
    .map((model) => String(model).trim())
    .filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : undefined;
}

function normalizeModelMappings(
  modelMappings: GatewayConfig["modelMappings"],
  providers: Record<string, ProviderConfig>
): Record<string, ModelMapping> {
  const normalized: Record<string, ModelMapping> = {};
  for (const [anthropicModel, mapping] of Object.entries(modelMappings || {})) {
    const key = anthropicModel.trim();
    if (!key) throw new Error("Model mapping key cannot be empty");
    if (!mapping?.provider) throw new Error(`Model mapping "${key}" requires a provider`);
    if (!providers[mapping.provider]) throw new Error(`Model mapping "${key}" references unknown provider "${mapping.provider}"`);
    if (!mapping.model?.trim()) throw new Error(`Model mapping "${key}" requires a model`);
    normalized[key] = {
      provider: mapping.provider,
      model: mapping.model.trim()
    };
  }
  return normalized;
}
