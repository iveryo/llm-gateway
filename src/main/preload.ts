import { contextBridge, ipcRenderer } from "electron";
import { GatewayConfig, GatewayStatus, LogEntry, RendererApi, StatsGranularity, StatsGroupBy } from "../shared/types.js";

const api: RendererApi = {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config: GatewayConfig) => ipcRenderer.invoke("config:save", config),
  getGatewayStatus: () => ipcRenderer.invoke("gateway:status"),
  getLogs: () => ipcRenderer.invoke("logs:list"),
  getLog: (id: string) => ipcRenderer.invoke("logs:get", id),
  getStats: (granularity: StatsGranularity, groupBy: StatsGroupBy) => ipcRenderer.invoke("stats:list", granularity, groupBy),
  clearLogs: () => ipcRenderer.invoke("logs:clear"),
  onLogUpdated: (listener: (entry: LogEntry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: LogEntry) => listener(entry);
    ipcRenderer.on("log-updated", handler);
    return () => ipcRenderer.removeListener("log-updated", handler);
  },
  onGatewayStatusUpdated: (listener: (status: GatewayStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: GatewayStatus) => listener(status);
    ipcRenderer.on("gateway-status-updated", handler);
    return () => ipcRenderer.removeListener("gateway-status-updated", handler);
  }
};

contextBridge.exposeInMainWorld("gateway", api);
