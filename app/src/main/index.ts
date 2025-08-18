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

function getWindowIconPath(): string | undefined {
  const isPackaged = app.isPackaged
  if (process.platform === 'win32') {
    // use ICO on Windows
    return isPackaged
      ? join(process.resourcesPath, 'assets', 'icon.ico')
      : join(process.cwd(), 'build', 'icon.ico')
  } else if (process.platform === 'linux') {
    // use PNG on Linux (you'll need a PNG — see Option B)
    return isPackaged
      ? join(process.resourcesPath, 'assets', 'icon.png')
      : join(process.cwd(), 'build', 'icon.png')
  } else {
    // macOS ignores BrowserWindow.icon for dock; uses .icns from the bundle
    return undefined
  }
}

// Type guard for environment variables
function getValidUrl(envVar: string | undefined): string | null {
  return (typeof envVar === 'string' && envVar.trim().length > 0) ? envVar.trim() : null
}

// Optional (Windows): make sure the app ID is set for proper taskbar grouping
app.setAppUserModelId('com.example.Paper')
app.setName('Paper')
let mainWindow: BrowserWindow | null = null
Menu.setApplicationMenu(null)

function createWindow(): void {
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

  // DEV vs PROD load with proper type checking
  const rendererUrl = getValidUrl(process.env.ELECTRON_RENDERER_URL)
  const viteUrl = getValidUrl(process.env.VITE_DEV_SERVER_URL)
  const devUrl = rendererUrl || viteUrl || 'http://localhost:5173/'

  if (rendererUrl || viteUrl) {
    console.log('[main] loading DEV URL:', devUrl)
    mainWindow.loadURL(devUrl).catch((error) => {
      console.error('[main] Failed to load DEV URL:', error)
    })
  } else {
    const indexHtml = join(__dirname, '../renderer/index.html')
    console.log('[main] loading PROD file:', indexHtml)
    mainWindow.loadFile(indexHtml).catch((error) => {
      console.error('[main] Failed to load PROD file:', error)
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  
  // Debug: Log when renderer is ready
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] Renderer finished loading')
  })
  
  // Properly typed event handler with validation
  mainWindow.webContents.on('did-fail-load', (
    _event: Electron.Event, 
    errorCode: number, 
    errorDescription: string,
    validatedURL?: string,
    isMainFrame?: boolean
  ) => {
    console.error('[main] Renderer failed to load:', {
      errorCode: typeof errorCode === 'number' ? errorCode : 'unknown',
      errorDescription: typeof errorDescription === 'string' ? errorDescription : 'unknown error',
      url: validatedURL,
      isMainFrame: Boolean(isMainFrame)
    })
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
}).catch((error) => {
  console.error('[main] App failed to initialize:', error)
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
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
  }
})