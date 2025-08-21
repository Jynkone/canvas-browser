import { app, BrowserWindow, Menu, ipcMain, powerSaveBlocker } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'
import { setupOverlayIPC } from './overlay'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Force discrete GPU if available
app.commandLine.appendSwitch('force_high_performance_gpu')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

// Single instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.setAppUserModelId('com.example.Paper')
app.setName('Paper')
Menu.setApplicationMenu(null)

let mainWindow: BrowserWindow | null = null
let blockerId: number | null = null

function getWindowIconPath(): string | undefined {
  const isPackaged = app.isPackaged
  if (process.platform === 'win32') {
    return isPackaged
      ? join(process.resourcesPath, 'assets', 'icon.ico')
      : join(process.cwd(), 'build', 'icon.ico')
  } else if (process.platform === 'linux') {
    return isPackaged
      ? join(process.resourcesPath, 'assets', 'icon.png')
      : join(process.cwd(), 'build', 'icon.png')
  }
  return undefined
}

function getValidUrl(envVar: string | undefined): string | null {
  return typeof envVar === 'string' && envVar.trim().length > 0 ? envVar.trim() : null
}

// Toggle performance mode on/off
function setHighPerformanceMode(enable: boolean): void {
  if (enable) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setBackgroundThrottling(false)
    }
    if (blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension')
    }
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_HIGH)
    } catch {}
  } else {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.setBackgroundThrottling(true)
    }
    if (blockerId !== null) {
      powerSaveBlocker.stop(blockerId)
      blockerId = null
    }
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_NORMAL)
    } catch {}
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: true,
    title: 'Paper',
    backgroundColor: '#111111',
    icon: getWindowIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      devTools: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  setupOverlayIPC(() => mainWindow)
  ipcMain.on('request-high-performance', (_evt, enable: boolean) => {
    setHighPerformanceMode(enable)
  })

  const rendererUrl = getValidUrl(process.env.ELECTRON_RENDERER_URL)
  const viteUrl = getValidUrl(process.env.VITE_DEV_SERVER_URL)
  const devUrl = rendererUrl || viteUrl || 'http://localhost:5173/'

  if (rendererUrl || viteUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('before-quit', () => {
  setHighPerformanceMode(false)
})
