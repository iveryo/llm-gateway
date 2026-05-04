import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { ConfigStore } from "./config.js";
import { GatewayServer } from "./gateway.js";
import { LogStore } from "./store.js";

let mainWindow: BrowserWindow | undefined;
let configStore: ConfigStore;
let logStore: LogStore;
let gateway: GatewayServer;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: "LLM Gateway",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await mainWindow.loadFile(join(__dirname, "../../renderer/index.html"));
}

app.whenReady().then(async () => {
  configStore = new ConfigStore();
  logStore = new LogStore();
  await logStore.init();
  gateway = new GatewayServer(configStore, logStore, () => mainWindow);

  ipcMain.handle("config:get", () => configStore.get());
  ipcMain.handle("config:save", async (_event, config) => {
    const saved = configStore.save(config);
    await gateway.restart();
    return saved;
  });
  ipcMain.handle("logs:list", () => logStore.list());
  ipcMain.handle("logs:get", (_event, id: string) => logStore.get(id));
  ipcMain.handle("logs:clear", () => logStore.clear());

  await gateway.restart();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void gateway?.stop();
});
