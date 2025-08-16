import { BrowserWindow, BrowserView, ipcMain } from 'electron'
import { randomUUID } from 'crypto'

type Rect = { x: number; y: number; width: number; height: number }

export function setupOverlayIPC(getWindow: () => BrowserWindow | null) {
  const views = new Map<string, BrowserView>()
  let lastId: string | null = null

  const resolveView = (tabId?: string | null) => {
    const id = tabId ?? lastId
    return id ? { id, view: views.get(id) ?? null } : { id: null, view: null }
  }

  ipcMain.handle('overlay:create-tab', async (_e, url: string) => {
    const win = getWindow()
    if (!win) throw new Error('No window')

    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })

    // Keep autoresize off; we control bounds.
    view.setAutoResize({ width: false, height: false, horizontal: false, vertical: false })
    try { await view.webContents.setVisualZoomLevelLimits(0.25, 5) } catch {}

    const id = randomUUID()
    views.set(id, view)
    lastId = id

    // Attach *before* load to avoid ERR_ABORTED, and ensure it's on top.
    try {
      win.addBrowserView(view)
      // Electron 14+; ensures z-order
      // @ts-ignore
      if (typeof win.setTopBrowserView === 'function') win.setTopBrowserView(view)
    } catch {}

    // Give it a tiny visible footprint first so the load isn't aborted.
    view.setBounds({ x: 0, y: 0, width: 2, height: 2 })

    // Debug hooks
    view.webContents.on('did-finish-load', () => {
      console.log('[overlay] did-finish-load:', url)
    })
    view.webContents.on('did-fail-load', (_e, code, desc, failingUrl, _isMainFrame) => {
      console.error('[overlay] did-fail-load:', { code, desc, failingUrl })
    })
    view.webContents.on('render-process-gone', (_e, details) => {
      console.error('[overlay] render-process-gone:', details)
    })

    if (process.env.DEBUG_OVERLAY === '1') {
      try { view.webContents.openDevTools({ mode: 'detach' }) } catch {}
    }

    try {
      await view.webContents.loadURL(url)
    } catch (err) {
      console.error('[overlay] loadURL failed:', err)
    }

    return id
  })

  ipcMain.handle('overlay:close-tab', async (_e, tabId: string) => {
    const { view } = resolveView(tabId)
    if (!view) return
    const win = BrowserWindow.fromWebContents(view.webContents)
    try { view.webContents.stop() } catch {}
    if (win) { try { win.removeBrowserView(view) } catch {} }
    for (const [k, v] of views) if (v === view) views.delete(k)
    if (lastId && !views.has(lastId)) lastId = null
  })

  ipcMain.handle('overlay:set-bounds', async (_e, payload: any, maybeRect?: Rect) => {
    let tabId: string | undefined
    let rect: Rect | undefined

    if (typeof payload === 'string') {
      tabId = payload
      rect = maybeRect
    } else if (payload && typeof payload.tabId === 'string' && payload.rect) {
      tabId = payload.tabId
      rect = payload.rect
    } else if (payload && typeof payload.x === 'number') {
      rect = payload as Rect
    }

    const { view } = resolveView(tabId ?? null)
    if (!view || !rect) return
    const win = BrowserWindow.fromWebContents(view.webContents)
    if (!win) return

    const [cw, ch] = win.getContentSize()
    const x = Math.max(0, Math.min(Math.floor(rect.x), cw))
    const y = Math.max(0, Math.min(Math.floor(rect.y), ch))
    const width  = Math.max(0, Math.min(Math.ceil(rect.width),  cw - x))
    const height = Math.max(0, Math.min(Math.ceil(rect.height), ch - y))

    try {
      view.setBounds({ x, y, width, height })
      // Keep attached and on top
      win.addBrowserView(view)
      // @ts-ignore
      if (typeof win.setTopBrowserView === 'function') win.setTopBrowserView(view)
    } catch {}
  })

  ipcMain.handle('overlay:set-zoom', async (_e, payload: any) => {
    const factor = typeof payload === 'number' ? payload : payload?.factor
    const tabId  = typeof payload === 'object' ? payload?.tabId : undefined
    if (typeof factor !== 'number') return
    const { view } = resolveView(tabId ?? null)
    if (!view) return
    try { await view.webContents.setZoomFactor(factor) } catch {}
  })

  ipcMain.handle('overlay:show', async (_e, a: any, b?: Rect) => {
    const payload = (typeof a === 'string') ? { tabId: a, rect: b! } : a
    const { view } = resolveView(payload?.tabId ?? null)
    if (!view || !payload?.rect) return
    const win = BrowserWindow.fromWebContents(view.webContents)
    if (!win) return
    try {
      win.addBrowserView(view)
      view.setBounds(payload.rect)
      // @ts-ignore
      if (typeof win.setTopBrowserView === 'function') win.setTopBrowserView(view)
    } catch {}
  })

  ipcMain.handle('overlay:hide', async (_e, payload?: { tabId?: string }) => {
    const { view } = resolveView(payload?.tabId ?? null)
    if (!view) return
    try { view.setBounds({ x: 0, y: 0, width: 2, height: 2 }) } catch {}
  })

  ipcMain.handle('overlay:focus', async (_e, payload?: { tabId?: string }) => {
    const { view } = resolveView(payload?.tabId ?? null)
    if (!view) return
    try { view.webContents.focus() } catch {}
  })

  ipcMain.handle('overlay:blur', async () => {
    const win = getWindow()
    if (!win) return
    try { win.webContents.focus() } catch {}
  })
}
