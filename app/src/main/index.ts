import { app, BrowserWindow } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { setupOverlayIPC } from './overlay'

const __filename = fileURLToPath(import.meta.url)
// Use dirname() instead of join(__filename, '..')
const __dirname = dirname(__filename)

// Single instance lock (optional but nice to have)
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: true,
    backgroundColor: '#111111',
    webPreferences: {
      // IMPORTANT: points to the built preload (electron-vite outputs to out/preload/index.js)
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  // Wire overlay IPC
  setupOverlayIPC(() => mainWindow)

  // DEV vs PROD load
  const devUrl =
    process.env.ELECTRON_RENDERER_URL ||
    process.env.VITE_DEV_SERVER_URL ||
    'http://localhost:5173/'

  if (process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL) {
    console.log('[main] loading DEV URL:', devUrl)
    mainWindow.loadURL(devUrl)
  } else {
    const indexHtml = join(__dirname, '../renderer/index.html')
    console.log('[main] loading PROD file:', indexHtml)
    mainWindow.loadFile(indexHtml)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// Standard app lifecycle
app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS, typical to keep app alive until Cmd+Q
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// If another instance is launched, focus the existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})
