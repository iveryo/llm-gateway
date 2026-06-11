import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } from "electron";
import { join } from "node:path";
import { ConfigStore } from "./config.js";
import { GatewayServer } from "./gateway.js";
import { LogStore } from "./store.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let configStore: ConfigStore;
let logStore: LogStore;
let gateway: GatewayServer;
let isQuitting = false;

const TRAY_ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABySURBVDhPY1AuqflPCR7WBvQf+v/oPwI82j8VqzrsBkA1H16BzH/9f3E/khooxmpA2P7X//9fXYMhjg1jNaD+KtB6mAErroO9AALYvEGkC6b+XwwUItoA7GFAigEgjBYL/18f+h+GRR1uA4jEowbU/AcAseU8uZxqk1sAAAAASUVORK5CYII=";

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

async function createWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return;
  }

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

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  await mainWindow.loadFile(join(__dirname, "../../renderer/index.html"));
}

function createTray(): void {
  if (tray) return;

  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, "base64")).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("LLM Gateway");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "显示 LLM Gateway",
      click: () => {
        showMainWindow();
      }
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("click", () => {
    showMainWindow();
  });
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    configStore = new ConfigStore();
    logStore = new LogStore();
    await logStore.init();
    gateway = new GatewayServer(configStore, logStore, () => mainWindow);

    ipcMain.handle("config:get", () => configStore.get());
    ipcMain.handle("config:save", async (_event, config) => {
      const previous = configStore.get();
      const saved = configStore.save(config);
      await gateway.applyConfig(previous);
      return saved;
    });
    ipcMain.handle("gateway:status", () => gateway.getStatus());
    ipcMain.handle("logs:list", () => logStore.list());
    ipcMain.handle("logs:get", (_event, id: string) => logStore.get(id));
    ipcMain.handle("stats:list", (_event, granularity, groupBy) => logStore.stats(granularity, groupBy));
    ipcMain.handle("logs:clear", () => logStore.clear());

    await gateway.restart();
    await createWindow();
    createTray();

    app.on("activate", () => {
      showMainWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (isQuitting && process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  void gateway?.stop();
});
