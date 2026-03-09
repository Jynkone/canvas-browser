import { app, BrowserWindow, Menu, ipcMain, powerSaveBlocker } from "electron";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import os from "os";
import { setupOverlayIPC } from "./overlay";
import { startCookieServer, stopCookieServer } from './canvas-cookie-server'



const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-site-isolation-trials");
app.commandLine.appendSwitch("process-per-site");
app.commandLine.appendSwitch('force-device-scale-factor', '1.5')

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setAppUserModelId("com.example.Paper");
app.setName("Paper");
Menu.setApplicationMenu(null);

let mainWindow: BrowserWindow | null = null;
let blockerId: number | null = null;

function getWindowIconPath(): string | undefined {
  const isPackaged = app.isPackaged;
  if (process.platform === "win32") {
    return isPackaged
      ? join(process.resourcesPath, "assets", "icon.ico")
      : join(process.cwd(), "build", "icon.ico");
  } else if (process.platform === "linux") {
    return isPackaged
      ? join(process.resourcesPath, "assets", "icon.png")
      : join(process.cwd(), "build", "icon.png");
  }
  return undefined;
}

function getValidUrl(envVar: string | undefined): string | null {
  return typeof envVar === "string" && envVar.trim().length > 0 ? envVar.trim() : null;
}

function setHighPerformanceMode(enable: boolean): void {
  if (enable) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setBackgroundThrottling(false);
    }
    if (blockerId === null) {
      blockerId = powerSaveBlocker.start("prevent-app-suspension");
    }
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_HIGH);
    } catch { /* ignore */ }
  } else {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setBackgroundThrottling(true);
    }
    if (blockerId !== null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_NORMAL);
    } catch { /* ignore */ }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: true,
    title: "Paper",
    backgroundColor: "#111111",
    icon: getWindowIconPath(),
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      devTools: true,
      nodeIntegration: true,       // required for electronSharedTexture
      contextIsolation: false,     // required for nodeIntegration + no contextBridge
      zoomFactor: 1.0,
    },
  });

  mainWindow.webContents.openDevTools({ mode: "detach" });

  const wc = mainWindow.webContents;
  const reassertZoom = (): void => wc.setZoomFactor(1);

  reassertZoom();
  wc.setVisualZoomLevelLimits(1, 1);

  wc.on("before-input-event", (event, input) => {
    const isMetaOrCtrl = input.control || input.meta;
    const key = (input.key ?? "").toLowerCase();
    if (isMetaOrCtrl && (key === "+" || key === "=" || key === "-" || key === "0")) {
      event.preventDefault();
    }
  });

  wc.on("did-finish-load", reassertZoom);
  wc.on("did-navigate", reassertZoom);
  wc.on("did-navigate-in-page", reassertZoom);

  setupOverlayIPC(() => mainWindow);
  ipcMain.on("request-high-performance", (_evt, enable: boolean) => {
    setHighPerformanceMode(enable);
  });

  const rendererUrl = getValidUrl(process.env.ELECTRON_RENDERER_URL);
  const viteUrl = getValidUrl(process.env.VITE_DEV_SERVER_URL);
  const devUrl = rendererUrl || viteUrl || "http://localhost:5173/";

  if (rendererUrl || viteUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("close", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startCookieServer()  
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on("before-quit", () => {
  stopCookieServer()
  setHighPerformanceMode(false);
});
