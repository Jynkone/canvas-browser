import { app, BrowserWindow, Menu } from 'electron'
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

function getWindowIconPath() {
  const isPackaged = app.isPackaged
  if (process.platform === 'win32') {
    // use ICO on Windows
    return isPackaged
      ? join(process.resourcesPath, 'assets', 'icon.ico')
      : join(process.cwd(), 'build', 'icon.ico')
  } else if (process.platform === 'linux') {
    // use PNG on Linux (you’ll need a PNG — see Option B)
    return isPackaged
      ? join(process.resourcesPath, 'assets', 'icon.png')
      : join(process.cwd(), 'build', 'icon.png')
  } else {
    // macOS ignores BrowserWindow.icon for dock; uses .icns from the bundle
    return undefined
  }
}

// Optional (Windows): make sure the app ID is set for proper taskbar grouping
app.setAppUserModelId('com.example.Paper')
app.setName('Paper')
let mainWindow: BrowserWindow | null = null
Menu.setApplicationMenu(null)
function createWindow() {
  console.log('[main] Creating main window...')
  
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: true,
    title: "Paper",  
    backgroundColor: '#111111',
        icon: getWindowIconPath(),
        autoHideMenuBar: true,
    webPreferences: {
      // IMPORTANT: points to the built preload (electron-vite outputs to out/preload/index.js)
      preload: join(__dirname, '../preload/index.js'),
     devTools: false,          // 👈 disables devtools for the TLdraw window
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  console.log('[main] Preload path:', join(__dirname, '../preload/index.js'))

  // Wire overlay IPC
  console.log('[main] Setting up overlay IPC...')
  setupOverlayIPC(() => mainWindow)
  console.log('[main] Overlay IPC setup complete')

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
  
  // Debug: Log when renderer is ready
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] Renderer finished loading')
  })
  
  mainWindow.webContents.on('did-fail-load', ( errorCode, errorDescription) => {
    console.error('[main] Renderer failed to load:', errorCode, errorDescription)
  })

    mainWindow.setMenuBarVisibility(false)

}

// Standard app lifecycle
app.whenReady().then(() => {
  console.log('[main] App ready, creating window...')
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