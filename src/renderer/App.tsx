import { ArrowRight, Copy, Download, FileText, Globe2, LogIn, LogOut, Radio, RefreshCw, Save, Search, Trash2, Upload, X } from "lucide-react";
import { ChangeEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CONFIG, GatewayConfig, GatewayStatus, LogEntry, StatsGranularity, StatsGroupBy, UsageStatsRow } from "../shared/types";

type Language = "en" | "zh";
type LanguagePreference = "auto" | Language;
type TabId = "client" | "provider" | "stats" | "config" | "help";
type PayloadViewMode = "tree" | "json" | "http";

type JsonTreeProps = {
  data: unknown;
  name?: string;
  path?: string;
  defaultOpen?: boolean;
  query: string;
  labels: {
    copyValue: string;
    noMatches: string;
    previewMarkdown: string;
  };
  showAll?: boolean;
  onPreviewMarkdown: (preview: MarkdownPreviewState) => void;
};

type UsageTokens = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

type MarkdownPreviewState = {
  title: string;
  content: string;
};

type MarkdownBlock =
  | { type: "heading"; depth: number; content: string }
  | { type: "paragraph"; content: string }
  | { type: "code"; language: string; content: string }
  | { type: "quote"; content: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

const LANGUAGE_STORAGE_KEY = "llm-gateway-language";
const LOG_LIST_LIMIT = 500;
const PAYLOAD_VIEW_LABELS: Record<Language, Record<PayloadViewMode, string>> = {
  en: {
    tree: "Tree",
    json: "JSON text",
    http: "HTTP raw"
  },
  zh: {
    tree: "\u6811\u89c6\u56fe",
    json: "JSON \u6587\u672c",
    http: "HTTP \u539f\u6587"
  }
};

const TEXT = {
  en: {
    actions: {
      clearLogs: "Clear logs",
      close: "Close",
      copyHttp: "Copy HTTP",
      copyJson: "Copy JSON",
      copyRaw: "Copy raw",
      copyValue: "Copy value",
      exportJson: "Export JSON",
      importJson: "Import JSON",
      previewMarkdown: "Markdown preview",
      refreshLogs: "Refresh logs",
      save: "Save and restart gateway",
      saved: "Saved"
    },
    config: {
      advancedHelp: {
        sections: [
          {
            title: "Provider fields",
            items: [
              "Each key in providers is a provider id, such as openai, anthropic, or ark.",
              "protocol selects the upstream API shape: openai or anthropic.",
              "baseUrl is the upstream API base URL.",
              "apiKey is the upstream provider API key.",
              "concurrency is optional. Missing or 0 means unlimited; values above 0 set a per-provider limit.",
              "model_list is optional reference text for supported models. It is saved and exported, but does not affect routing."
            ]
          },
          {
            title: "Model mapping fields",
            items: [
              "Each key in modelMappings is the model name received from the client.",
              "provider must match a provider id defined in providers.",
              "model is the actual model name sent to that upstream provider."
            ]
          },
          {
            title: "Routing relationship",
            items: [
              "The gateway detects the client protocol from the request path, then looks up the requested model in modelMappings.",
              "The mapping chooses the provider config and the upstream model. The provider protocol decides whether the request is proxied directly or adapted between OpenAI and Anthropic formats.",
              "If no mapping matches, the gateway uses Default provider and Default model, then records a warning in the log."
            ]
          }
        ],
        exampleTitle: "Example",
        exampleText: "If providers.openai uses protocol openai, and modelMappings[\"claude-sonnet-4-5\"] is { provider: \"openai\", model: \"gpt-4o\" }, a client request for claude-sonnet-4-5 is sent to the openai provider as gpt-4o."
      },
      advancedText: "Edit provider definitions and client-to-provider model mappings as JSON.",
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
      noMatches: "No matching JSON fields",
      noRequests: "No request selected",
      noStats: "No completed requests to summarize",
      waiting: "Waiting for LLM requests"
    },
    errors: {
      saveFailed: "Failed to save configuration"
    },
    logs: {
      gatewayStatus: "Gateway",
      gatewayStatusUpdated: "Updated",
      json: "json",
      paused: "Paused",
      queued: "queued",
      recentLimit: "Latest 500 requests",
      recording: "Recording",
      search: "Search JSON",
      stream: "stream",
      unknownModel: "unknown model"
    },
    help: {
      anthropicEndpoint: "Anthropic Messages endpoint",
      authText: "Send either header with the local token.",
      authTitle: "Authentication",
      claudeCode: "Claude Code",
      closeBehavior: "Closing the window hides LLM Gateway to the system tray. Use the tray right-click menu to exit.",
      openaiClient: "OpenAI-compatible clients",
      openaiClientText: "Use the /v1 base URL and set the API key to the local token.",
      openaiEndpoint: "OpenAI Chat Completions endpoint",
      subtitle: "Use these values in clients that connect to the local gateway.",
      title: "Client setup"
    },
    status: {
      error: "error",
      ok: "ok",
      pending: "pending"
    },
    gatewayRuntime: {
      error: "Error",
      running: "Running",
      starting: "Starting",
      stopped: "Stopped"
    },
    stats: {
      avgLatency: "Avg latency",
      avgQueue: "Avg queue",
      claudeModel: "Inbound model",
      clientProtocol: "Inbound protocol",
      day: "Day",
      errors: "Errors",
      group: "Group",
      hour: "Hour",
      inputTokens: "Input tokens",
      month: "Month",
      ok: "OK",
      outputTokens: "Output tokens",
      provider: "Provider",
      providerModel: "Outbound model",
      requests: "Requests",
      stream: "Stream",
      time: "Time",
      totalTokens: "Total tokens"
    },
    summary: {
      claudeModel: "Inbound model",
      clientProtocol: "Inbound protocol",
      error: "Error",
      latency: "Latency",
      openaiRequestTokens: "Input tokens",
      openaiResponseTokens: "Output tokens",
      provider: "Provider",
      providerModel: "Outbound model",
      providerProtocol: "Outbound protocol",
      queueWait: "Queue wait",
      status: "Status",
      warning: "Warning"
    },
    tabs: {
      inbound: "Inbound",
      config: "Config",
      help: "Help",
      outbound: "Outbound",
      stats: "Stats"
    }
  },
  zh: {
    actions: {
      close: "关闭",
      copyHttp: "复制 HTTP",
      copyJson: "复制 JSON",
      copyRaw: "复制原文",
      copyValue: "复制值",
      previewMarkdown: "Markdown 预览",
      clearLogs: "清空日志",
      exportJson: "导出 JSON",
      importJson: "导入 JSON",
      refreshLogs: "刷新日志",
      save: "保存并重启网关",
      saved: "已保存"
    },
    config: {
      advancedHelp: {
        sections: [
          {
            title: "服务商字段",
            items: [
              "providers 里的每个 key 都是一个服务商 ID，例如 openai、anthropic 或 ark。",
              "protocol 选择上游接口协议，可选 openai 或 anthropic。",
              "baseUrl 是上游服务商的 API 基础地址。",
              "apiKey 是上游服务商的 API key。",
              "concurrency 是可选并发限制。缺失或 0 表示不限并发，大于 0 表示该服务商单独限流。",
              "model_list 是可选模型备注，会保存和导出，但不参与路由匹配。"
            ]
          },
          {
            title: "模型映射字段",
            items: [
              "modelMappings 里的每个 key 是客户端请求里的模型名。",
              "provider 必须对应 providers 中已经定义的服务商 ID。",
              "model 是实际发送给上游服务商的模型名。"
            ]
          },
          {
            title: "路由关系",
            items: [
              "网关先根据请求路径识别客户端协议，再用请求模型名查找 modelMappings。",
              "映射结果决定使用哪个服务商配置和哪个上游模型；服务商的 protocol 决定是同协议透明转发，还是在 OpenAI 和 Anthropic 格式之间适配。",
              "如果没有匹配映射，网关会使用默认服务商和默认模型，并在日志里记录 warning。"
            ]
          }
        ],
        exampleTitle: "示例",
        exampleText: "如果 providers.openai 的 protocol 是 openai，且 modelMappings[\"claude-sonnet-4-5\"] 是 { provider: \"openai\", model: \"gpt-4o\" }，那么客户端请求 claude-sonnet-4-5 时，实际会转发到 openai 服务商并使用 gpt-4o。"
      },
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
      waiting: "等待 LLM 请求"
    },
    errors: {
      saveFailed: "保存配置失败"
    },
    logs: {
      gatewayStatus: "网关",
      gatewayStatusUpdated: "更新",
      json: "json",
      paused: "已暂停",
      queued: "排队",
      recentLimit: "最近 500 条请求",
      recording: "记录中",
      search: "搜索 JSON",
      stream: "流式",
      unknownModel: "未知模型"
    },
    help: {
      anthropicEndpoint: "Anthropic Messages 入口",
      authText: "本地网关接受以下任意一种请求头。",
      authTitle: "鉴权",
      claudeCode: "Claude Code",
      closeBehavior: "关闭窗口会隐藏到系统托盘。需要完全退出时，在托盘图标上右键选择退出。",
      openaiClient: "OpenAI 兼容客户端",
      openaiClientText: "base URL 使用 /v1 地址，API key 使用本地令牌。",
      openaiEndpoint: "OpenAI Chat Completions 入口",
      subtitle: "把这些值填到连接本地网关的客户端里。",
      title: "客户端入口说明"
    },
    status: {
      error: "错误",
      ok: "成功",
      pending: "处理中"
    },
    gatewayRuntime: {
      error: "错误",
      running: "运行中",
      starting: "启动中",
      stopped: "已停止"
    },
    stats: {
      avgLatency: "平均延迟",
      avgQueue: "平均排队",
      claudeModel: "入口模型",
      clientProtocol: "入口协议",
      day: "日",
      errors: "错误",
      group: "分组",
      hour: "小时",
      inputTokens: "输入 tokens",
      month: "月",
      ok: "成功",
      outputTokens: "输出 tokens",
      provider: "服务商",
      providerModel: "出口模型",
      requests: "请求数",
      stream: "流式",
      time: "时间",
      totalTokens: "总 tokens"
    },
    summary: {
      claudeModel: "入口模型",
      clientProtocol: "入口协议",
      error: "错误",
      latency: "延迟",
      openaiRequestTokens: "输入 tokens",
      openaiResponseTokens: "输出 tokens",
      provider: "服务商",
      providerModel: "出口模型",
      providerProtocol: "出口协议",
      queueWait: "排队等待",
      status: "状态",
      warning: "警告"
    },
    tabs: {
      inbound: "入口侧",
      config: "配置",
      help: "说明",
      outbound: "出口侧",
      stats: "统计"
    }
  }
} as const;

type UiText = (typeof TEXT)[Language];

export function App() {
  const [config, setConfig] = useState<GatewayConfig>(DEFAULT_CONFIG);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<UsageStatsRow[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>(() => gatewayStatusFromConfig(DEFAULT_CONFIG, "stopped"));
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedLog, setSelectedLog] = useState<LogEntry>();
  const [tab, setTab] = useState<TabId>("client");
  const [statsGranularity, setStatsGranularity] = useState<StatsGranularity>("day");
  const [statsGroupBy, setStatsGroupBy] = useState<StatsGroupBy>("providerModel");
  const [query, setQuery] = useState("");
  const [payloadViewMode, setPayloadViewMode] = useState<PayloadViewMode>("tree");
  const [markdownPreview, setMarkdownPreview] = useState<MarkdownPreviewState>();
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
    void window.gateway.getGatewayStatus().then(setGatewayStatus);
    const offLogUpdated = window.gateway.onLogUpdated((entry) => {
      setLogs((current) => [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, LOG_LIST_LIMIT));
      setSelectedLog((current) => (current?.id === entry.id ? entry : current));
      void refreshStats(statsGranularity, statsGroupBy);
    });
    const offGatewayStatusUpdated = window.gateway.onGatewayStatusUpdated(setGatewayStatus);
    return () => {
      offLogUpdated();
      offGatewayStatusUpdated();
    };
  }, [statsGranularity, statsGroupBy]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedLog(undefined);
      return;
    }
    void window.gateway.getLog(selectedId).then(setSelectedLog);
  }, [selectedId]);

  useEffect(() => {
    if (!markdownPreview) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMarkdownPreview(undefined);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [markdownPreview]);

  const selectedPayload = useMemo(() => {
    if (!selectedLog) return undefined;
    if (tab === "provider") {
      return {
        providerRequest: selectedLog.providerRequest,
        providerResponse: selectedLog.providerResponse
      };
    }
    return {
      clientRequest: selectedLog.clientRequest ?? selectedLog.anthropicRequest,
      clientResponse: selectedLog.clientResponse ?? selectedLog.anthropicResponse
    };
  }, [selectedLog, tab]);
  const jsonTextPayload = useMemo(() => {
    if (!selectedLog) return "";
    return formatJsonForDisplay(protocolBodyPayload(selectedLog, tab));
  }, [selectedLog, tab]);
  const httpTextPayload = useMemo(() => {
    if (!selectedLog) return "";
    return httpRawPayload(selectedLog, tab);
  }, [selectedLog, tab]);
  const textPayload = payloadViewMode === "http" ? httpTextPayload : jsonTextPayload;
  const copyTextAction = payloadViewMode === "http"
    ? textValue(t.actions, "copyHttp", "Copy HTTP")
    : textValue(t.actions, "copyJson", "Copy JSON");
  const payloadViewLabels = PAYLOAD_VIEW_LABELS[language];
  const noMatchesText = textValue(t.empty, "noMatches", language === "zh" ? "\u6ca1\u6709\u5339\u914d\u7684 JSON \u5b57\u6bb5" : "No matching JSON fields");
  const clearSearchLabel = language === "zh" ? "\u6e05\u7a7a\u641c\u7d22" : "Clear search";

  async function refresh() {
    const entries = await window.gateway.getLogs();
    setLogs(entries);
    if (!selectedId && entries[0]) setSelectedId(entries[0].id);
  }

  async function refreshStats(granularity = statsGranularity, groupBy = statsGroupBy) {
    setStats(await window.gateway.getStats(granularity, groupBy));
  }

  async function clearLogs() {
    const confirmed = window.confirm(language === "zh" ? "\u786e\u5b9a\u8981\u6e05\u7a7a\u65e5\u5fd7\u5417\uff1f\u6b64\u64cd\u4f5c\u65e0\u6cd5\u64a4\u9500\u3002" : "Clear all logs? This action cannot be undone.");
    if (!confirmed) return;

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
            <div className="titleRow">
              <h1>LLM Gateway</h1>
              <GatewayStatusView status={gatewayStatus} t={t} language={language} />
            </div>
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
        <div className="listMeta">{t.logs.recentLimit}</div>
        <div className="logList">
          {logs.map((log) => (
            <button
              key={log.id}
              className={`logItem ${selectedId === log.id ? "active" : ""}`}
              onClick={() => setSelectedId(log.id)}
            >
              <span className={`status ${log.status}`}>{log.status}</span>
              <strong>{log.clientModel || log.anthropicModel || t.logs.unknownModel}</strong>
              <small>{new Date(log.startedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</small>
              <small>{t.status[log.status]} | {log.statusCode ?? "-"} | {formatDuration(log.durationMs)} | {t.logs.queued} {formatDuration(log.queueWaitMs)} | {log.stream ? t.logs.stream : t.logs.json}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="workspace">
        <nav className="tabs">
          <div className="tabGroup">
            <button className={tab === "client" ? "selected" : ""} onClick={() => setTab("client")}><LogIn size={16} />{t.tabs.inbound}</button>
            <button className={tab === "provider" ? "selected" : ""} onClick={() => setTab("provider")}><LogOut size={16} />{t.tabs.outbound}</button>
            <button className={tab === "stats" ? "selected" : ""} onClick={() => setTab("stats")}>{t.tabs.stats}</button>
            <button className={tab === "config" ? "selected" : ""} onClick={() => setTab("config")}>{t.tabs.config}</button>
            <button className={tab === "help" ? "selected" : ""} onClick={() => setTab("help")}>{t.tabs.help}</button>
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
        ) : tab === "help" ? (
          <HelpPanel config={config} t={t} />
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
            <div className="detailHeader">
              <Summary log={selectedLog} t={t} />
              <RequestFlow log={selectedLog} t={t} />
            </div>
            <section className="jsonPanel">
              {selectedPayload ? (
                <>
                  <div className="jsonPanelHeader">
                    <div className="jsonViewToggle" role="group" aria-label="JSON view mode">
                      <button
                        className={payloadViewMode === "tree" ? "selected" : ""}
                        onClick={() => setPayloadViewMode("tree")}
                        aria-pressed={payloadViewMode === "tree"}
                      >
                        {payloadViewLabels.tree}
                      </button>
                      <button
                        className={payloadViewMode === "json" ? "selected" : ""}
                        onClick={() => setPayloadViewMode("json")}
                        aria-pressed={payloadViewMode === "json"}
                      >
                        {payloadViewLabels.json}
                      </button>
                      <button
                        className={payloadViewMode === "http" ? "selected" : ""}
                        onClick={() => setPayloadViewMode("http")}
                        aria-pressed={payloadViewMode === "http"}
                      >
                        {payloadViewLabels.http}
                      </button>
                    </div>
                    {payloadViewMode === "tree" ? (
                      <div className="searchBox jsonSearchBox">
                        <Search size={16} />
                        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.logs.search} />
                        {query && (
                          <button className="searchClear" type="button" onClick={() => setQuery("")} title={clearSearchLabel} aria-label={clearSearchLabel}>
                            <X size={15} />
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        className="jsonCopyRaw"
                        onClick={() => navigator.clipboard.writeText(textPayload)}
                        title={copyTextAction}
                      >
                        <Copy size={14} />
                        {copyTextAction}
                      </button>
                    )}
                  </div>
                  {payloadViewMode === "tree" ? (
                    <JsonTree
                      data={selectedPayload}
                      defaultOpen
                      query={query}
                      labels={{ copyValue: t.actions.copyValue, noMatches: noMatchesText, previewMarkdown: t.actions.previewMarkdown }}
                      onPreviewMarkdown={setMarkdownPreview}
                    />
                  ) : (
                    <pre className="jsonTextView">{textPayload}</pre>
                  )}
                </>
              ) : (
                <div className="empty">{t.empty.noRequests}</div>
              )}
            </section>
          </div>
        )}
      </section>
      {markdownPreview && (
        <MarkdownPreviewModal
          preview={markdownPreview}
          t={t}
          onClose={() => setMarkdownPreview(undefined)}
        />
      )}
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
            <option value="clientModel">{t.stats.claudeModel}</option>
            <option value="clientProtocol">{textValue(t.stats, "clientProtocol", "Client protocol")}</option>
            <option value="providerProtocol">{textValue(t.summary, "providerProtocol", "Provider protocol")}</option>
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
                  <td>{formatDuration(row.avgDurationMs)}</td>
                  <td>{formatDuration(row.avgQueueWaitMs)}</td>
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

function GatewayStatusView({ status, t, language }: { status: GatewayStatus; t: UiText; language: Language }) {
  const updatedAt = new Date(status.updatedAt).toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US");
  const details = [
    `${t.logs.gatewayStatus}: ${t.gatewayRuntime[status.state]}`,
    status.url,
    status.message || `${t.logs.gatewayStatusUpdated} ${updatedAt}`
  ].join("\n");

  return (
    <span className={`gatewayStatus ${status.state}`} aria-label={details} title={details}>
      <span className="gatewayStatusDot" aria-hidden="true" />
      {t.gatewayRuntime[status.state]}
    </span>
  );
}

function Summary({ log, t }: { log?: LogEntry; t: UiText }) {
  if (!log) return <section className="summary empty">{t.empty.waiting}</section>;
  const usage = usageTokens(log.providerResponse);
  return (
    <section className="summary compactSummary">
      <div><label>{t.summary.status}</label><strong className={log.status}>{log.statusCode ?? "-"} {t.status[log.status]}</strong></div>
      <div><label>{t.summary.openaiRequestTokens}</label><strong>{formatTokenCount(usage?.prompt_tokens)}</strong></div>
      <div><label>{t.summary.openaiResponseTokens}</label><strong>{formatTokenCount(usage?.completion_tokens)}</strong></div>
      <div><label>{t.summary.latency}</label><strong>{formatDuration(log.durationMs)}</strong></div>
      <div><label>{t.summary.queueWait}</label><strong>{formatDuration(log.queueWaitMs)}</strong></div>
      {log.warning && <div className="wide"><label>{t.summary.warning}</label><strong>{log.warning}</strong></div>}
      {log.error && <div className="wide"><label>{t.summary.error}</label><strong>{log.error}</strong></div>}
    </section>
  );
}

function RequestFlow({ log, t }: { log?: LogEntry; t: UiText }) {
  if (!log) return null;
  const inboundProtocol = log.clientProtocol || "-";
  const inboundModel = log.clientModel || log.anthropicModel || "-";
  const outboundProvider = log.providerId || "-";
  const outboundProtocol = log.providerProtocol || "-";
  const outboundModel = log.providerModel || "-";

  return (
    <section className="requestFlow" aria-label={`${t.tabs.inbound} to ${t.tabs.outbound}`}>
      <div className="flowEndpoint">
        <span className="flowIcon"><LogIn size={16} /></span>
        <div>
          <label>{t.tabs.inbound}</label>
          <strong>{inboundProtocol} / {inboundModel}</strong>
        </div>
      </div>
      <ArrowRight className="flowArrow" size={18} />
      <div className="flowGateway">
        <span>LLM Gateway</span>
      </div>
      <ArrowRight className="flowArrow" size={18} />
      <div className="flowEndpoint">
        <span className="flowIcon"><LogOut size={16} /></span>
        <div>
          <label>{t.tabs.outbound}</label>
          <strong>{outboundProvider} / {outboundProtocol} / {outboundModel}</strong>
        </div>
      </div>
    </section>
  );
}

function usageTokens(providerResponse: unknown): UsageTokens | undefined {
  if (!providerResponse || typeof providerResponse !== "object") return undefined;
  const response = providerResponse as { usage?: unknown; json?: unknown };
  const usage = response.usage ?? (response.json && typeof response.json === "object" ? (response.json as { usage?: unknown }).usage : undefined);
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  return {
    prompt_tokens: numericUsage(record.prompt_tokens ?? record.input_tokens),
    completion_tokens: numericUsage(record.completion_tokens ?? record.output_tokens)
  };
}

function numericUsage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTokenCount(value: number | undefined): string {
  return value === undefined ? "-" : value.toLocaleString();
}

function protocolBodyPayload(log: LogEntry, tab: TabId): unknown {
  if (tab === "provider") {
    return {
      providerRequest: log.providerRequest,
      providerResponse: combinedResponseBody(log.providerResponse)
    };
  }

  return {
    clientRequest: log.clientRequest ?? log.anthropicRequest,
    clientResponse: combinedResponseBody(log.clientResponse ?? log.anthropicResponse)
  };
}

function httpRawPayload(log: LogEntry, tab: TabId): string {
  const request = tab === "provider" ? log.providerRequestRaw : log.clientRequestRaw;
  const response = tab === "provider" ? log.providerResponseRaw : log.clientResponseRaw;
  const parts = [request, response].filter((part): part is string => typeof part === "string" && part.length > 0);
  if (parts.length) return `${parts.join("\n\n")}\n`;
  return formatJsonForDisplay(protocolBodyPayload(log, tab));
}

function combinedResponseBody(response: unknown): unknown {
  if (!response || typeof response !== "object" || Array.isArray(response)) return response;
  const record = response as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, "json") ? record.json : response;
}

function formatJsonForDisplay(value: unknown): string {
  if (value === undefined) return "";
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return String(value);
  }
}

function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  if (Math.abs(value) < 1000) return `${Math.round(value).toLocaleString()}ms`;
  const seconds = value / 1000;
  const maximumFractionDigits = Math.abs(seconds) < 10 ? 2 : 1;
  return `${seconds.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits
  })}s`;
}

function textValue(source: object, key: string, fallback: string): string {
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : fallback;
}

function gatewayStatusFromConfig(config: GatewayConfig, state: GatewayStatus["state"], message?: string): GatewayStatus {
  return {
    state,
    host: config.host,
    port: config.port,
    url: `http://${config.host}:${config.port}`,
    message,
    updatedAt: new Date().toISOString()
  };
}

function HelpPanel({ config, t }: { config: GatewayConfig; t: UiText }) {
  const gatewayUrl = `http://${config.host}:${config.port}`;
  const openAIBaseUrl = `${gatewayUrl}/v1`;
  const authHeader = `Authorization: Bearer ${config.localToken}`;
  const apiKeyHeader = `X-Api-Key: ${config.localToken}`;

  return (
    <section className="helpPanel">
      <div className="helpHeader">
        <h2>{t.help.title}</h2>
        <p>{t.help.subtitle}</p>
      </div>

      <section className="helpGrid">
        <div className="helpBlock">
          <h3>{t.help.anthropicEndpoint}</h3>
          <code>POST {gatewayUrl}/v1/messages</code>
        </div>
        <div className="helpBlock">
          <h3>{t.help.openaiEndpoint}</h3>
          <code>POST {openAIBaseUrl}/chat/completions</code>
        </div>
        <div className="helpBlock">
          <h3>{t.help.authTitle}</h3>
          <p>{t.help.authText}</p>
          <code>{authHeader}</code>
          <code>{apiKeyHeader}</code>
        </div>
        <div className="helpBlock">
          <h3>{t.help.openaiClient}</h3>
          <p>{t.help.openaiClientText}</p>
          <code>base URL: {openAIBaseUrl}</code>
          <code>API key: {config.localToken}</code>
        </div>
        <div className="helpBlock wide">
          <h3>{t.help.claudeCode}</h3>
          <pre>{`$env:ANTHROPIC_BASE_URL="${gatewayUrl}"
$env:ANTHROPIC_API_KEY="${config.localToken}"
claude`}</pre>
        </div>
        <div className="helpBlock wide">
          <h3>LLM Gateway</h3>
          <p>{t.help.closeBehavior}</p>
        </div>
      </section>
    </section>
  );
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
        <div className="routingHelp" aria-label={`${t.config.advancedTitle} details`}>
          {t.config.advancedHelp.sections.map((section) => (
            <section className="routingHelpSection" key={section.title}>
              <h4>{section.title}</h4>
              <ul>
                {section.items.map((item) => <li key={`${section.title}-${item}`}>{item}</li>)}
              </ul>
            </section>
          ))}
          <section className="routingHelpSection routingExample">
            <h4>{t.config.advancedHelp.exampleTitle}</h4>
            <p>{t.config.advancedHelp.exampleText}</p>
          </section>
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

function MarkdownPreviewModal({ preview, t, onClose }: { preview: MarkdownPreviewState; t: UiText; onClose: () => void }) {
  return (
    <div className="modalBackdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="markdownModal" role="dialog" aria-modal="true" aria-labelledby="markdownPreviewTitle">
        <header className="markdownModalHeader">
          <div className="markdownModalTitle">
            <h2 id="markdownPreviewTitle">{t.actions.previewMarkdown}</h2>
            <p>{preview.title}</p>
          </div>
          <div className="markdownModalActions">
            <button className="secondary compact" onClick={() => navigator.clipboard.writeText(preview.content)}><Copy size={14} /> {t.actions.copyRaw}</button>
            <button className="iconButton" onClick={onClose} title={t.actions.close} aria-label={t.actions.close}><X size={18} /></button>
          </div>
        </header>
        <div className="markdownPreview">
          <RenderedMarkdown content={preview.content} />
        </div>
      </section>
    </div>
  );
}

function RenderedMarkdown({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);
  if (!blocks.length) return <p className="markdownEmpty">{content}</p>;
  return <>{blocks.map(renderMarkdownBlock)}</>;
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const language = fence[1].trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, content: codeLines.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", depth: heading[1].length, content: heading[2].trim() });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index]);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", content: quoteLines.join("\n") });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !isMarkdownBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trimEnd());
      index += 1;
    }
    if (paragraphLines.length) {
      blocks.push({ type: "paragraph", content: paragraphLines.join("\n") });
    } else {
      index += 1;
    }
  }

  return blocks;
}

function isMarkdownBlockStart(lines: string[], index: number): boolean {
  const line = lines[index];
  if (!line.trim()) return true;
  return (
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    isTableStart(lines, index)
  );
}

function isTableStart(lines: string[], index: number): boolean {
  return Boolean(lines[index]?.includes("|") && lines[index + 1] && isTableSeparator(lines[index + 1]));
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): ReactNode {
  if (block.type === "heading") return renderMarkdownHeading(block.depth, block.content, index);
  if (block.type === "paragraph") return <p key={index}>{parseInlineMarkdown(block.content)}</p>;
  if (block.type === "quote") return <blockquote key={index}><RenderedMarkdown content={block.content} /></blockquote>;
  if (block.type === "ul") return <ul key={index}>{block.items.map(renderMarkdownListItem)}</ul>;
  if (block.type === "ol") return <ol key={index}>{block.items.map(renderMarkdownListItem)}</ol>;
  if (block.type === "table") {
    return (
      <div className="markdownTableWrap" key={index}>
        <table>
          <thead>
            <tr>{block.headers.map((cell, cellIndex) => <th key={cellIndex}>{parseInlineMarkdown(cell)}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.headers.map((_, cellIndex) => <td key={cellIndex}>{parseInlineMarkdown(row[cellIndex] ?? "")}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="markdownCodeBlock" key={index}>
      {block.language && <div className="markdownCodeLanguage">{block.language}</div>}
      <pre><code>{block.content}</code></pre>
    </div>
  );
}

function renderMarkdownHeading(depth: number, content: string, index: number): ReactNode {
  if (depth === 1) return <h1 key={index}>{parseInlineMarkdown(content)}</h1>;
  if (depth === 2) return <h2 key={index}>{parseInlineMarkdown(content)}</h2>;
  if (depth === 3) return <h3 key={index}>{parseInlineMarkdown(content)}</h3>;
  if (depth === 4) return <h4 key={index}>{parseInlineMarkdown(content)}</h4>;
  if (depth === 5) return <h5 key={index}>{parseInlineMarkdown(content)}</h5>;
  return <h6 key={index}>{parseInlineMarkdown(content)}</h6>;
}

function renderMarkdownListItem(item: string, index: number): ReactNode {
  const task = item.match(/^\[( |x|X)\]\s+(.+)$/);
  if (task) {
    return (
      <li className="markdownTaskItem" key={index}>
        <input type="checkbox" checked={task[1].toLowerCase() === "x"} readOnly />
        <span>{parseInlineMarkdown(task[2])}</span>
      </li>
    );
  }
  return <li key={index}>{parseInlineMarkdown(item)}</li>;
}

function parseInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < text.length) {
    const key = `inline-${index}-${nodes.length}`;

    if (text[index] === "\n") {
      nodes.push(<br key={key} />);
      index += 1;
      continue;
    }

    if (text[index] === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        nodes.push(<code className="markdownInlineCode" key={key}>{text.slice(index + 1, end)}</code>);
        index = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", index)) {
      const end = text.indexOf("**", index + 2);
      if (end > index + 2) {
        nodes.push(<strong key={key}>{parseInlineMarkdown(text.slice(index + 2, end))}</strong>);
        index = end + 2;
        continue;
      }
    }

    if (text[index] === "*" && text[index + 1] !== "*") {
      const end = text.indexOf("*", index + 1);
      if (end > index + 1) {
        nodes.push(<em key={key}>{parseInlineMarkdown(text.slice(index + 1, end))}</em>);
        index = end + 1;
        continue;
      }
    }

    if (text[index] === "[") {
      const labelEnd = text.indexOf("]", index + 1);
      const urlStart = labelEnd + 1;
      if (labelEnd > index + 1 && text[urlStart] === "(") {
        const urlEnd = text.indexOf(")", urlStart + 1);
        if (urlEnd > urlStart + 1) {
          const label = text.slice(index + 1, labelEnd);
          const href = text.slice(urlStart + 1, urlEnd).trim();
          if (isSafeMarkdownUrl(href)) {
            nodes.push(<a key={key} href={href} target="_blank" rel="noreferrer">{parseInlineMarkdown(label)}</a>);
          } else {
            nodes.push(<span key={key}>{parseInlineMarkdown(label)}</span>, ` (${href})`);
          }
          index = urlEnd + 1;
          continue;
        }
      }
    }

    const next = nextInlineMarkerIndex(text, index + 1);
    nodes.push(text.slice(index, next));
    index = next;
  }

  return nodes;
}

function nextInlineMarkerIndex(text: string, start: number): number {
  const indexes = ["`", "[", "*", "\n"]
    .map((marker) => text.indexOf(marker, start))
    .filter((value) => value !== -1);
  return indexes.length ? Math.min(...indexes) : text.length;
}

function isSafeMarkdownUrl(value: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(value);
}

function JsonTree({ data, name = "root", path, defaultOpen = false, query, labels, showAll = false, onPreviewMarkdown }: JsonTreeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const currentPath = path ?? name;
  const normalizedQuery = query.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;
  const isObject = data !== null && typeof data === "object";
  const selfMatches = isSearching && jsonTreeNodeMatches(name, currentPath, data, normalizedQuery);
  const childShowAll = showAll || selfMatches;

  if (!isObject) {
    if (isSearching && !showAll && !selfMatches) return null;

    return (
      <div className={`jsonLine ${selfMatches ? "match" : ""}`}>
        <span className="jsonKey">{name}</span>: <span className="jsonValue">{JSON.stringify(data)}</span>
        <span className="jsonActions">
          <button className="jsonAction" onClick={() => navigator.clipboard.writeText(String(data))} title={labels.copyValue} aria-label={labels.copyValue}><Copy size={13} /></button>
          {typeof data === "string" && (
            <button
              className="jsonAction"
              onClick={() => onPreviewMarkdown({ title: currentPath, content: data })}
              title={labels.previewMarkdown}
              aria-label={labels.previewMarkdown}
            >
              <FileText size={13} />
            </button>
          )}
        </span>
      </div>
    );
  }

  const entries = Array.isArray(data) ? data.map((value, index) => [String(index), value] as const) : Object.entries(data);
  const visibleEntries = isSearching && !childShowAll
    ? entries.filter(([key, value]) => jsonTreeHasMatch(value, key, Array.isArray(data) ? `${currentPath}[${key}]` : `${currentPath}.${key}`, normalizedQuery))
    : entries;
  const hasVisibleChildren = visibleEntries.length > 0;
  const shouldRender = !isSearching || selfMatches || hasVisibleChildren || showAll;
  const isOpen = isSearching ? true : open;

  if (!shouldRender) {
    if (path) return null;
    return <div className="empty">{labels.noMatches}</div>;
  }

  return (
    <div className="jsonNode">
      <button className={`twisty ${selfMatches ? "match" : ""}`} onClick={() => setOpen(!open)}>
        {isOpen ? "-" : "+"} <span className="jsonKey">{name}</span> <small>{Array.isArray(data) ? `[${visibleEntries.length}]` : `{${visibleEntries.length}}`}</small>
      </button>
      {isOpen && (
        <div className="jsonChildren">
          {visibleEntries.map(([key, value]) => (
            <JsonTree
              key={key}
              name={key}
              path={Array.isArray(data) ? `${currentPath}[${key}]` : `${currentPath}.${key}`}
              data={value}
              query={query}
              labels={labels}
              showAll={childShowAll}
              onPreviewMarkdown={onPreviewMarkdown}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function jsonTreeHasMatch(data: unknown, name: string, path: string, normalizedQuery: string): boolean {
  if (jsonTreeNodeMatches(name, path, data, normalizedQuery)) return true;
  if (data === null || typeof data !== "object") return false;

  const entries = Array.isArray(data) ? data.map((value, index) => [String(index), value] as const) : Object.entries(data);
  return entries.some(([key, value]) => jsonTreeHasMatch(value, key, Array.isArray(data) ? `${path}[${key}]` : `${path}.${key}`, normalizedQuery));
}

function jsonTreeNodeMatches(name: string, path: string, data: unknown, normalizedQuery: string): boolean {
  return name.toLowerCase().includes(normalizedQuery)
    || path.toLowerCase().includes(normalizedQuery)
    || jsonTreeValueText(data).toLowerCase().includes(normalizedQuery);
}

function jsonTreeValueText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === null || typeof data !== "object") return String(data);
  return "";
}
