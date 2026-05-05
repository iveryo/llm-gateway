import { Copy, Download, Globe2, Radio, RefreshCw, Save, Search, Trash2, Upload } from "lucide-react";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CONFIG, GatewayConfig, LogEntry, StatsGranularity, StatsGroupBy, UsageStatsRow } from "../shared/types";

type Language = "en" | "zh";
type LanguagePreference = "auto" | Language;
type TabId = "anthropic" | "provider" | "stats" | "config";

type JsonTreeProps = {
  data: unknown;
  name?: string;
  defaultOpen?: boolean;
  query: string;
};

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

const LANGUAGE_STORAGE_KEY = "llm-gateway-language";

const TEXT = {
  en: {
    actions: {
      clearLogs: "Clear logs",
      exportJson: "Export JSON",
      importJson: "Import JSON",
      refreshLogs: "Refresh logs",
      save: "Save and restart gateway",
      saved: "Saved"
    },
    config: {
      advancedText: "Edit provider definitions and Claude-to-provider model mappings as JSON.",
      advancedTitle: "Advanced routing",
      basicsText: "These values control the local listener, default provider, and request behavior.",
      basicsTitle: "Gateway settings",
      defaultModel: "Default model",
      defaultProvider: "Default provider",
      host: "Gateway host",
      language: "Language",
      languageAuto: "Auto",
      languageChinese: "Chinese",
      languageEnglish: "English",
      localToken: "Local token",
      modelMappings: "Model mappings",
      port: "Gateway port",
      providers: "Providers",
      recordLogs: "Record logs",
      redactSensitive: "Redact sensitive fields",
      timeout: "Timeout ms",
      title: "Configuration"
    },
    empty: {
      noRequests: "No request selected",
      noStats: "No completed requests to summarize",
      waiting: "Waiting for Claude Code requests"
    },
    errors: {
      saveFailed: "Failed to save configuration"
    },
    logs: {
      json: "json",
      paused: "Paused",
      queued: "queued",
      recording: "Recording",
      search: "Search JSON",
      stream: "stream",
      unknownModel: "unknown model"
    },
    status: {
      error: "error",
      ok: "ok",
      pending: "pending"
    },
    stats: {
      avgLatency: "Avg latency",
      avgQueue: "Avg queue",
      claudeModel: "Claude model",
      day: "Day",
      errors: "Errors",
      group: "Group",
      hour: "Hour",
      inputTokens: "Input tokens",
      month: "Month",
      ok: "OK",
      outputTokens: "Output tokens",
      provider: "Provider",
      providerModel: "Provider model",
      requests: "Requests",
      stream: "Stream",
      time: "Time",
      totalTokens: "Total tokens"
    },
    summary: {
      claudeModel: "Claude model",
      error: "Error",
      latency: "Latency",
      openaiRequestTokens: "OpenAI request tokens",
      openaiResponseTokens: "OpenAI response tokens",
      provider: "Provider",
      providerModel: "Provider model",
      queueWait: "Queue wait",
      status: "Status",
      warning: "Warning"
    },
    tabs: {
      anthropic: "Anthropic",
      config: "Config",
      provider: "OpenAI",
      stats: "Stats"
    }
  },
  zh: {
    actions: {
      clearLogs: "清空日志",
      exportJson: "导出 JSON",
      importJson: "导入 JSON",
      refreshLogs: "刷新日志",
      save: "保存并重启网关",
      saved: "已保存"
    },
    config: {
      advancedText: "用 JSON 编辑服务商定义，以及 Claude 模型到服务商模型的映射。",
      advancedTitle: "高级路由",
      basicsText: "这些值控制本地监听、默认服务商和请求行为。",
      basicsTitle: "网关设置",
      defaultModel: "默认模型",
      defaultProvider: "默认服务商",
      host: "网关主机",
      language: "语言",
      languageAuto: "自动",
      languageChinese: "中文",
      languageEnglish: "English",
      localToken: "本地令牌",
      modelMappings: "模型映射",
      port: "网关端口",
      providers: "服务商",
      recordLogs: "记录日志",
      redactSensitive: "隐藏敏感字段",
      timeout: "超时时间 ms",
      title: "配置"
    },
    empty: {
      noRequests: "未选择请求",
      noStats: "还没有可汇总的完成请求",
      waiting: "等待 Claude Code 请求"
    },
    errors: {
      saveFailed: "保存配置失败"
    },
    logs: {
      json: "json",
      paused: "已暂停",
      queued: "排队",
      recording: "记录中",
      search: "搜索 JSON",
      stream: "流式",
      unknownModel: "未知模型"
    },
    status: {
      error: "错误",
      ok: "成功",
      pending: "处理中"
    },
    stats: {
      avgLatency: "平均延迟",
      avgQueue: "平均排队",
      claudeModel: "Claude 模型",
      day: "日",
      errors: "错误",
      group: "分组",
      hour: "小时",
      inputTokens: "输入 tokens",
      month: "月",
      ok: "成功",
      outputTokens: "输出 tokens",
      provider: "服务商",
      providerModel: "服务商模型",
      requests: "请求数",
      stream: "流式",
      time: "时间",
      totalTokens: "总 tokens"
    },
    summary: {
      claudeModel: "Claude 模型",
      error: "错误",
      latency: "延迟",
      openaiRequestTokens: "OpenAI 请求 tokens",
      openaiResponseTokens: "OpenAI 响应 tokens",
      provider: "服务商",
      providerModel: "服务商模型",
      queueWait: "排队等待",
      status: "状态",
      warning: "警告"
    },
    tabs: {
      anthropic: "Anthropic",
      config: "配置",
      provider: "OpenAI",
      stats: "统计"
    }
  }
} as const;

type UiText = (typeof TEXT)[Language];

export function App() {
  const [config, setConfig] = useState<GatewayConfig>(DEFAULT_CONFIG);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<UsageStatsRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedLog, setSelectedLog] = useState<LogEntry>();
  const [tab, setTab] = useState<TabId>("anthropic");
  const [statsGranularity, setStatsGranularity] = useState<StatsGranularity>("day");
  const [statsGroupBy, setStatsGroupBy] = useState<StatsGroupBy>("providerModel");
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState(false);
  const [loggingSaving, setLoggingSaving] = useState(false);
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>(readLanguagePreference);
  const language = useMemo(() => resolveLanguage(languagePreference), [languagePreference]);
  const t = TEXT[language];

  useEffect(() => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference);
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language, languagePreference]);

  useEffect(() => {
    void refresh();
    void refreshStats(statsGranularity, statsGroupBy);
    void window.gateway.getConfig().then(setConfig);
    return window.gateway.onLogUpdated((entry) => {
      setLogs((current) => [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 500));
      setSelectedLog((current) => (current?.id === entry.id ? entry : current));
      void refreshStats(statsGranularity, statsGroupBy);
    });
  }, [statsGranularity, statsGroupBy]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedLog(undefined);
      return;
    }
    void window.gateway.getLog(selectedId).then(setSelectedLog);
  }, [selectedId]);

  const selectedPayload = useMemo(() => {
    if (!selectedLog) return undefined;
    if (tab === "provider") {
      return {
        providerRequest: selectedLog.providerRequest,
        providerResponse: selectedLog.providerResponse
      };
    }
    return {
      anthropicRequest: selectedLog.anthropicRequest,
      anthropicResponse: selectedLog.anthropicResponse
    };
  }, [selectedLog, tab]);

  async function refresh() {
    const entries = await window.gateway.getLogs();
    setLogs(entries);
    if (!selectedId && entries[0]) setSelectedId(entries[0].id);
  }

  async function refreshStats(granularity = statsGranularity, groupBy = statsGroupBy) {
    setStats(await window.gateway.getStats(granularity, groupBy));
  }

  async function clearLogs() {
    await window.gateway.clearLogs();
    setLogs([]);
    setStats([]);
    setSelectedId(undefined);
  }

  async function toggleLogging() {
    const next = { ...config, loggingEnabled: !config.loggingEnabled };
    setConfig(next);
    setLoggingSaving(true);
    try {
      setConfig(await window.gateway.saveConfig(next));
    } catch (error) {
      console.error(error);
      setConfig(await window.gateway.getConfig());
    } finally {
      setLoggingSaving(false);
    }
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="topbar">
          <div>
            <h1>LLM Gateway</h1>
            <p>{config.host}:{config.port}</p>
          </div>
        </div>
        <div className="logToolbar">
          <button
            className={`recordToggle ${config.loggingEnabled ? "recording" : "paused"}`}
            onClick={toggleLogging}
            disabled={loggingSaving}
            aria-pressed={config.loggingEnabled}
            title={config.loggingEnabled ? t.logs.recording : t.logs.paused}
          >
            <Radio size={16} />
            {config.loggingEnabled ? t.logs.recording : t.logs.paused}
          </button>
          <div className="topActions">
            <button className="iconButton" onClick={refresh} title={t.actions.refreshLogs}><RefreshCw size={18} /></button>
            <button className="iconButton dangerIcon" onClick={clearLogs} title={t.actions.clearLogs}><Trash2 size={18} /></button>
          </div>
        </div>
        <div className="searchBox">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.logs.search} />
        </div>
        <div className="logList">
          {logs.map((log) => (
            <button
              key={log.id}
              className={`logItem ${selectedId === log.id ? "active" : ""}`}
              onClick={() => setSelectedId(log.id)}
            >
              <span className={`status ${log.status}`}>{log.status}</span>
              <strong>{log.anthropicModel || t.logs.unknownModel}</strong>
              <small>{new Date(log.startedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</small>
              <small>{log.statusCode ?? "-"} | {log.durationMs ?? 0}ms | {t.logs.queued} {log.queueWaitMs ?? 0}ms | {log.stream ? t.logs.stream : t.logs.json}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="workspace">
        <nav className="tabs">
          <div className="tabGroup">
            <button className={tab === "anthropic" ? "selected" : ""} onClick={() => setTab("anthropic")}>{t.tabs.anthropic}</button>
            <button className={tab === "provider" ? "selected" : ""} onClick={() => setTab("provider")}>{t.tabs.provider}</button>
            <button className={tab === "stats" ? "selected" : ""} onClick={() => setTab("stats")}>{t.tabs.stats}</button>
            <button className={tab === "config" ? "selected" : ""} onClick={() => setTab("config")}>{t.tabs.config}</button>
          </div>
          <label className="languageSelect">
            <Globe2 size={16} />
            <select value={languagePreference} onChange={(event) => setLanguagePreference(event.target.value as LanguagePreference)} title={t.config.language}>
              <option value="auto">{t.config.languageAuto}</option>
              <option value="zh">{t.config.languageChinese}</option>
              <option value="en">{t.config.languageEnglish}</option>
            </select>
          </label>
        </nav>

        {tab === "config" ? (
          <ConfigPanel config={config} setConfig={setConfig} setSaved={setSaved} saved={saved} t={t} />
        ) : tab === "stats" ? (
          <StatsPanel
            rows={stats}
            granularity={statsGranularity}
            groupBy={statsGroupBy}
            t={t}
            onGranularityChange={(value) => {
              setStatsGranularity(value);
              void refreshStats(value, statsGroupBy);
            }}
            onGroupByChange={(value) => {
              setStatsGroupBy(value);
              void refreshStats(statsGranularity, value);
            }}
          />
        ) : (
          <div className="content">
            <Summary log={selectedLog} t={t} />
            <section className="jsonPanel">
              {selectedPayload ? (
                <JsonTree data={selectedPayload} defaultOpen query={query} />
              ) : (
                <div className="empty">{t.empty.noRequests}</div>
              )}
            </section>
          </div>
        )}
      </section>
    </main>
  );
}

function StatsPanel({
  rows,
  granularity,
  groupBy,
  t,
  onGranularityChange,
  onGroupByChange
}: {
  rows: UsageStatsRow[];
  granularity: StatsGranularity;
  groupBy: StatsGroupBy;
  t: UiText;
  onGranularityChange: (value: StatsGranularity) => void;
  onGroupByChange: (value: StatsGroupBy) => void;
}) {
  const totals = rows.reduce(
    (sum, row) => ({
      requestCount: sum.requestCount + row.requestCount,
      promptTokens: sum.promptTokens + row.promptTokens,
      completionTokens: sum.completionTokens + row.completionTokens,
      totalTokens: sum.totalTokens + row.totalTokens
    }),
    { requestCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  );

  return (
    <section className="statsPanel">
      <div className="statsToolbar">
        <div className="segmented" aria-label="Stats granularity">
          <button className={granularity === "hour" ? "selected" : ""} onClick={() => onGranularityChange("hour")}>{t.stats.hour}</button>
          <button className={granularity === "day" ? "selected" : ""} onClick={() => onGranularityChange("day")}>{t.stats.day}</button>
          <button className={granularity === "month" ? "selected" : ""} onClick={() => onGranularityChange("month")}>{t.stats.month}</button>
        </div>
        <label>
          {t.stats.group}
          <select value={groupBy} onChange={(event) => onGroupByChange(event.target.value as StatsGroupBy)}>
            <option value="providerModel">{t.stats.providerModel}</option>
            <option value="provider">{t.stats.provider}</option>
            <option value="anthropicModel">{t.stats.claudeModel}</option>
          </select>
        </label>
      </div>

      <section className="summary statsSummary">
        <div><label>{t.stats.requests}</label><strong>{totals.requestCount.toLocaleString()}</strong></div>
        <div><label>{t.stats.inputTokens}</label><strong>{totals.promptTokens.toLocaleString()}</strong></div>
        <div><label>{t.stats.outputTokens}</label><strong>{totals.completionTokens.toLocaleString()}</strong></div>
        <div><label>{t.stats.totalTokens}</label><strong>{totals.totalTokens.toLocaleString()}</strong></div>
      </section>

      <div className="statsTableWrap">
        {rows.length ? (
          <table className="statsTable">
            <thead>
              <tr>
                <th>{t.stats.time}</th>
                <th>{t.stats.group}</th>
                <th>{t.stats.requests}</th>
                <th>{t.stats.ok}</th>
                <th>{t.stats.errors}</th>
                <th>{t.stats.stream}</th>
                <th>{t.stats.inputTokens}</th>
                <th>{t.stats.outputTokens}</th>
                <th>{t.stats.totalTokens}</th>
                <th>{t.stats.avgLatency}</th>
                <th>{t.stats.avgQueue}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.bucket}:${row.groupKey}`}>
                  <td>{row.bucket}</td>
                  <td>{row.groupKey}</td>
                  <td>{row.requestCount.toLocaleString()}</td>
                  <td>{row.successCount.toLocaleString()}</td>
                  <td>{row.errorCount.toLocaleString()}</td>
                  <td>{row.streamCount.toLocaleString()}</td>
                  <td>{row.promptTokens.toLocaleString()}</td>
                  <td>{row.completionTokens.toLocaleString()}</td>
                  <td>{row.totalTokens.toLocaleString()}</td>
                  <td>{row.avgDurationMs.toLocaleString()}ms</td>
                  <td>{row.avgQueueWaitMs.toLocaleString()}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">{t.empty.noStats}</div>
        )}
      </div>
    </section>
  );
}

function Summary({ log, t }: { log?: LogEntry; t: UiText }) {
  if (!log) return <section className="summary empty">{t.empty.waiting}</section>;
  const usage = openAIUsage(log.providerResponse);
  return (
    <section className="summary">
      <div><label>{t.summary.status}</label><strong className={log.status}>{log.statusCode ?? "-"} {t.status[log.status]}</strong></div>
      <div><label>{t.summary.claudeModel}</label><strong>{log.anthropicModel || "-"}</strong></div>
      <div><label>{t.summary.provider}</label><strong>{log.providerId || "-"}</strong></div>
      <div><label>{t.summary.providerModel}</label><strong>{log.providerModel || "-"}</strong></div>
      <div><label>{t.summary.openaiRequestTokens}</label><strong>{formatTokenCount(usage?.prompt_tokens)}</strong></div>
      <div><label>{t.summary.openaiResponseTokens}</label><strong>{formatTokenCount(usage?.completion_tokens)}</strong></div>
      <div><label>{t.summary.latency}</label><strong>{log.durationMs ?? 0}ms</strong></div>
      <div><label>{t.summary.queueWait}</label><strong>{log.queueWaitMs ?? 0}ms</strong></div>
      {log.warning && <div className="wide"><label>{t.summary.warning}</label><strong>{log.warning}</strong></div>}
      {log.error && <div className="wide"><label>{t.summary.error}</label><strong>{log.error}</strong></div>}
    </section>
  );
}

function openAIUsage(providerResponse: unknown): OpenAIUsage | undefined {
  if (!providerResponse || typeof providerResponse !== "object") return undefined;
  const response = providerResponse as { usage?: unknown; json?: unknown };
  const usage = response.usage ?? (response.json && typeof response.json === "object" ? (response.json as { usage?: unknown }).usage : undefined);
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  return {
    prompt_tokens: numericUsage(record.prompt_tokens),
    completion_tokens: numericUsage(record.completion_tokens)
  };
}

function numericUsage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTokenCount(value: number | undefined): string {
  return value === undefined ? "-" : value.toLocaleString();
}

function ConfigPanel({
  config,
  setConfig,
  setSaved,
  saved,
  t
}: {
  config: GatewayConfig;
  setConfig: (config: GatewayConfig) => void;
  setSaved: (saved: boolean) => void;
  saved: boolean;
  t: UiText;
}) {
  const [providersText, setProvidersText] = useState(JSON.stringify(config.providers, null, 2));
  const [mappingText, setMappingText] = useState(JSON.stringify(config.modelMappings, null, 2));
  const [error, setError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setProvidersText(JSON.stringify(config.providers, null, 2));
    setMappingText(JSON.stringify(config.modelMappings, null, 2));
  }, [config.providers, config.modelMappings]);

  function update<K extends keyof GatewayConfig>(key: K, value: GatewayConfig[K]) {
    setConfig({ ...config, [key]: value });
  }

  async function save() {
    try {
      setError(undefined);
      const savedConfig = await window.gateway.saveConfig(configFromEditor());
      setConfig(savedConfig);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1400);
    } catch (error) {
      setSaved(false);
      setError(errorMessage(error, t.errors.saveFailed));
    }
  }

  function exportConfig() {
    try {
      setError(undefined);
      const current = configFromEditor();
      const blob = new Blob([`${JSON.stringify(current, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `llm-gateway-config-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setError(errorMessage(error, t.errors.saveFailed));
    }
  }

  async function importConfig(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      setError(undefined);
      const imported = JSON.parse(await file.text()) as Partial<GatewayConfig>;
      const next = { ...config, ...imported };
      setConfig(next as GatewayConfig);
      setProvidersText(JSON.stringify(next.providers ?? {}, null, 2));
      setMappingText(JSON.stringify(next.modelMappings ?? {}, null, 2));
      setSaved(false);
    } catch (error) {
      setSaved(false);
      setError(errorMessage(error, t.errors.saveFailed));
    }
  }

  function configFromEditor(): GatewayConfig {
    return {
      ...config,
      providers: JSON.parse(providersText),
      modelMappings: JSON.parse(mappingText)
    };
  }

  return (
    <section className="configPanel">
      <div className="configHeader">
        <div className="configTitle">
          <h2>{t.config.title}</h2>
          <p>{config.host}:{config.port}</p>
        </div>
        {error && <div className="configError" role="alert">{error}</div>}
        <div className="configActions">
          <input ref={fileInputRef} className="fileInput" type="file" accept="application/json,.json" onChange={importConfig} />
          <button className="secondary" onClick={() => fileInputRef.current?.click()}><Upload size={16} /> {t.actions.importJson}</button>
          <button className="secondary" onClick={exportConfig}><Download size={16} /> {t.actions.exportJson}</button>
          <button className="primary" onClick={save}><Save size={16} /> {saved ? t.actions.saved : t.actions.save}</button>
        </div>
      </div>
      <section className="configSection wideSection">
        <div className="sectionIntro">
          <h3>{t.config.basicsTitle}</h3>
          <p>{t.config.basicsText}</p>
        </div>
        <div className="formGrid">
          <label>{t.config.host}<input value={config.host} onChange={(event) => update("host", event.target.value)} /></label>
          <label>{t.config.port}<input type="number" value={config.port} onChange={(event) => update("port", Number(event.target.value))} /></label>
          <label>{t.config.localToken}<input value={config.localToken} onChange={(event) => update("localToken", event.target.value)} /></label>
          <label>{t.config.defaultProvider}<input value={config.defaultProvider} onChange={(event) => update("defaultProvider", event.target.value)} /></label>
          <label>{t.config.defaultModel}<input value={config.defaultModel} onChange={(event) => update("defaultModel", event.target.value)} /></label>
          <label>{t.config.timeout}<input type="number" value={config.requestTimeoutMs} onChange={(event) => update("requestTimeoutMs", Number(event.target.value))} /></label>
          <label className="check"><input type="checkbox" checked={config.loggingEnabled} onChange={(event) => update("loggingEnabled", event.target.checked)} /> {t.config.recordLogs}</label>
          <label className="check"><input type="checkbox" checked={config.redactSensitive} onChange={(event) => update("redactSensitive", event.target.checked)} /> {t.config.redactSensitive}</label>
        </div>
      </section>
      <section className="configSection wideSection">
        <div className="sectionIntro">
          <h3>{t.config.advancedTitle}</h3>
          <p>{t.config.advancedText}</p>
        </div>
        <div className="editorGrid">
          <label className="mapping">{t.config.providers}<textarea value={providersText} onChange={(event) => setProvidersText(event.target.value)} spellCheck={false} /></label>
          <label className="mapping">{t.config.modelMappings}<textarea value={mappingText} onChange={(event) => setMappingText(event.target.value)} spellCheck={false} /></label>
        </div>
      </section>
    </section>
  );
}

function readLanguagePreference(): LanguagePreference {
  const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored === "auto" || stored === "en" || stored === "zh" ? stored : "auto";
}

function resolveLanguage(preference: LanguagePreference): Language {
  if (preference !== "auto") return preference;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const value of languages) {
    const normalized = value.toLowerCase();
    if (normalized.startsWith("zh")) return "zh";
    if (normalized.startsWith("en")) return "en";
  }
  return "en";
}

function errorMessage(error: unknown, fallback: string = TEXT.en.errors.saveFailed): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return fallback;
}

function JsonTree({ data, name = "root", defaultOpen = false, query }: JsonTreeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const isObject = data !== null && typeof data === "object";
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const matches = query && text?.toLowerCase().includes(query.toLowerCase());

  if (!isObject) {
    return (
      <div className={`jsonLine ${matches ? "match" : ""}`}>
        <span className="jsonKey">{name}</span>: <span className="jsonValue">{JSON.stringify(data)}</span>
        <button className="copy" onClick={() => navigator.clipboard.writeText(String(data))}><Copy size={13} /></button>
      </div>
    );
  }

  const entries = Array.isArray(data) ? data.map((value, index) => [String(index), value] as const) : Object.entries(data);
  return (
    <div className="jsonNode">
      <button className="twisty" onClick={() => setOpen(!open)}>
        {open ? "-" : "+"} <span className="jsonKey">{name}</span> <small>{Array.isArray(data) ? `[${entries.length}]` : `{${entries.length}}`}</small>
      </button>
      {open && (
        <div className="jsonChildren">
          {entries.map(([key, value]) => <JsonTree key={key} name={key} data={value} query={query} />)}
        </div>
      )}
    </div>
  );
}
