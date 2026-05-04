import { Copy, Download, RefreshCw, Save, Search, Trash2, Upload } from "lucide-react";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_CONFIG, GatewayConfig, LogEntry } from "../shared/types";

type JsonTreeProps = {
  data: unknown;
  name?: string;
  defaultOpen?: boolean;
  query: string;
};

export function App() {
  const [config, setConfig] = useState<GatewayConfig>(DEFAULT_CONFIG);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedLog, setSelectedLog] = useState<LogEntry>();
  const [tab, setTab] = useState<"anthropic" | "provider" | "stream" | "config">("anthropic");
  const [query, setQuery] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void refresh();
    void window.gateway.getConfig().then(setConfig);
    return window.gateway.onLogUpdated((entry) => {
      setLogs((current) => [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, 500));
      setSelectedLog((current) => (current?.id === entry.id ? entry : current));
    });
  }, []);

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
    if (tab === "stream") return selectedLog.streamEvents ?? [];
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

  async function clearLogs() {
    await window.gateway.clearLogs();
    setLogs([]);
    setSelectedId(undefined);
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="topbar">
          <div>
            <h1>LLM Gateway</h1>
            <p>{config.host}:{config.port}</p>
          </div>
          <div className="topActions">
            <button className="iconButton" onClick={refresh} title="Refresh logs"><RefreshCw size={18} /></button>
            <button className="iconButton dangerIcon" onClick={clearLogs} title="Clear logs"><Trash2 size={18} /></button>
          </div>
        </div>
        <div className="searchBox">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search JSON" />
        </div>
        <div className="logList">
          {logs.map((log) => (
            <button
              key={log.id}
              className={`logItem ${selectedId === log.id ? "active" : ""}`}
              onClick={() => setSelectedId(log.id)}
            >
              <span className={`status ${log.status}`}>{log.status}</span>
              <strong>{log.anthropicModel || "unknown model"}</strong>
              <small>{new Date(log.startedAt).toLocaleString()}</small>
              <small>{log.statusCode ?? "-"} | {log.durationMs ?? 0}ms | queued {log.queueWaitMs ?? 0}ms | {log.stream ? "stream" : "json"}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="workspace">
        <nav className="tabs">
          <button className={tab === "anthropic" ? "selected" : ""} onClick={() => setTab("anthropic")}>Anthropic</button>
          <button className={tab === "provider" ? "selected" : ""} onClick={() => setTab("provider")}>OpenAI</button>
          <button className={tab === "stream" ? "selected" : ""} onClick={() => setTab("stream")}>Stream</button>
          <button className={tab === "config" ? "selected" : ""} onClick={() => setTab("config")}>Config</button>
        </nav>

        {tab === "config" ? (
          <ConfigPanel config={config} setConfig={setConfig} setSaved={setSaved} saved={saved} />
        ) : (
          <div className="content">
            <Summary log={selectedLog} />
            <section className="jsonPanel">
              {selectedPayload ? (
                <JsonTree data={selectedPayload} defaultOpen query={query} />
              ) : (
                <div className="empty">No request selected</div>
              )}
            </section>
          </div>
        )}
      </section>
    </main>
  );
}

function Summary({ log }: { log?: LogEntry }) {
  if (!log) return <section className="summary empty">Waiting for Claude Code requests</section>;
  return (
    <section className="summary">
      <div><label>Status</label><strong className={log.status}>{log.statusCode ?? "-"} {log.status}</strong></div>
      <div><label>Claude model</label><strong>{log.anthropicModel || "-"}</strong></div>
      <div><label>Provider</label><strong>{log.providerId || "-"}</strong></div>
      <div><label>Provider model</label><strong>{log.providerModel || "-"}</strong></div>
      <div><label>Latency</label><strong>{log.durationMs ?? 0}ms</strong></div>
      <div><label>Queue wait</label><strong>{log.queueWaitMs ?? 0}ms</strong></div>
      {log.warning && <div className="wide"><label>Warning</label><strong>{log.warning}</strong></div>}
      {log.error && <div className="wide"><label>Error</label><strong>{log.error}</strong></div>}
    </section>
  );
}

function ConfigPanel({
  config,
  setConfig,
  setSaved,
  saved
}: {
  config: GatewayConfig;
  setConfig: (config: GatewayConfig) => void;
  setSaved: (saved: boolean) => void;
  saved: boolean;
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
      await onSaveWithMappings();
    } catch (error) {
      setSaved(false);
      setError(errorMessage(error));
    }
  }

  async function onSaveWithMappings() {
    const next = configFromEditor();
    const savedConfig = await window.gateway.saveConfig(next);
    setConfig(savedConfig);
    setError(undefined);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1400);
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
      setError(errorMessage(error));
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
      setError(errorMessage(error));
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
        {error && <div className="configError" role="alert">{error}</div>}
        <input ref={fileInputRef} className="fileInput" type="file" accept="application/json,.json" onChange={importConfig} />
        <button className="secondary" onClick={() => fileInputRef.current?.click()}><Upload size={16} /> Import JSON</button>
        <button className="secondary" onClick={exportConfig}><Download size={16} /> Export JSON</button>
        <button className="primary" onClick={save}><Save size={16} /> {saved ? "Saved" : "Save and restart gateway"}</button>
      </div>
      <div className="formGrid">
        <label>Gateway host<input value={config.host} onChange={(event) => update("host", event.target.value)} /></label>
        <label>Gateway port<input type="number" value={config.port} onChange={(event) => update("port", Number(event.target.value))} /></label>
        <label>Local token<input value={config.localToken} onChange={(event) => update("localToken", event.target.value)} /></label>
        <label>Default provider<input value={config.defaultProvider} onChange={(event) => update("defaultProvider", event.target.value)} /></label>
        <label>Default model<input value={config.defaultModel} onChange={(event) => update("defaultModel", event.target.value)} /></label>
        <label>Timeout ms<input type="number" value={config.requestTimeoutMs} onChange={(event) => update("requestTimeoutMs", Number(event.target.value))} /></label>
        <label className="check"><input type="checkbox" checked={config.redactSensitive} onChange={(event) => update("redactSensitive", event.target.checked)} /> Redact sensitive fields</label>
      </div>
      <label className="mapping">Providers<textarea value={providersText} onChange={(event) => setProvidersText(event.target.value)} spellCheck={false} /></label>
      <label className="mapping">Model mappings<textarea value={mappingText} onChange={(event) => setMappingText(event.target.value)} spellCheck={false} /></label>
    </section>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "Failed to save configuration";
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
        {open ? "▾" : "▸"} <span className="jsonKey">{name}</span> <small>{Array.isArray(data) ? `[${entries.length}]` : `{${entries.length}}`}</small>
      </button>
      {open && (
        <div className="jsonChildren">
          {entries.map(([key, value]) => <JsonTree key={key} name={key} data={value} query={query} />)}
        </div>
      )}
    </div>
  );
}
