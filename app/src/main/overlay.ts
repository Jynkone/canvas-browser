import { BrowserWindow, WebContentsView, ipcMain } from 'electron'
import type { Debugger as ElectronDebugger, Input } from 'electron'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

type Rect = { x: number; y: number; width: number; height: number }

type ViewState = {
  view: WebContentsView
  attached: boolean
  lastBounds: { x: number; y: number; w: number; h: number }
  lastAppliedZoom?: number
  navState: {
    currentUrl: string
    canGoBack: boolean
    canGoForward: boolean
    title: string
  }
}

type Ok<T = {}> = { ok: true } & T
type Err = { ok: false; error: string }
type CreateTabResponse = Ok<{ tabId: string }> | Err
type SimpleResponse = Ok | Err
type GetNavStateResponse = (Ok & ViewState['navState'] & { isLoading: boolean }) | Err

// ---- Zoom config -----------------------------------------------------------
const CHROME_MIN = 0.25
const CHROME_MAX = 5
const ZOOM_RATIO = 1
const MAX_VIEWS = 32

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

let canvasZoom = 1
const STARTUP_DELAY_MS = 500
let startupRestoreComplete = false
let startupBrowserState: Record<string, { currentUrl: string; lastInteraction: number }> = {}
let startupQueue: Array<{ shapeId: string; url: string; lastInteraction: number }> = []

async function initializeStartupRestore(): Promise<void> {
  if (startupRestoreComplete) return
  try {
    const stateFile = join(process.cwd(), 'browser-state.json')
    if (existsSync(stateFile)) {
      const fileContent = readFileSync(stateFile, 'utf8')
      startupBrowserState = JSON.parse(fileContent)
      startupQueue = Object.entries(startupBrowserState).map(([shapeId, data]) => ({
        shapeId,
        url: data.currentUrl,
        lastInteraction: data.lastInteraction || 0,
      }))
      startupQueue.sort((a, b) => b.lastInteraction - a.lastInteraction)
    }
  } catch (e) {
    console.error('[overlay] Failed to read startup state:', e)
  }
  startupRestoreComplete = true
}

const browserState: Record<string, { currentUrl: string; lastInteraction: number }> = {}
const STATE_FILE = join(process.cwd(), 'browser-state.json')
if (existsSync(STATE_FILE)) {
  try {
    Object.assign(browserState, JSON.parse(readFileSync(STATE_FILE, 'utf8')))
  } catch (e) {
    console.error('[overlay] Failed to read browser state:', e)
  }
}

// Safe writer with debounce
let writeTimer: NodeJS.Timeout | null = null
function flushBrowserState(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    try {
      writeFileSync(STATE_FILE, JSON.stringify(browserState, null, 2))
    } catch (e) {
      console.error('[overlay] Failed to write browser state:', e)
    }
  }, 100)
}

export function setupOverlayIPC(getWindow: () => BrowserWindow | null): void {
  const views = new Map<string, ViewState>()

  const S = {
    resolve(id?: string | null) {
      if (id && views.has(id)) {
        const s = views.get(id)!
        return { view: s.view, state: s }
      }
      return { view: null as WebContentsView | null, state: null as ViewState | null }
    },
    attach(win: BrowserWindow, s: ViewState) {
      if (s.attached) return
      try { win.contentView.addChildView(s.view); s.attached = true } catch {}
    },
    detach(win: BrowserWindow, s: ViewState) {
      if (!s.attached) return
      try { win.contentView.removeChildView(s.view); s.attached = false } catch {}
    },
    currentEff() { return clamp((canvasZoom || 1) * ZOOM_RATIO, 0.05, CHROME_MAX) },
    hasRealBounds(b?: { width: number; height: number } | null) { return !!b && b.width >= 2 && b.height >= 2 },

    async clearEmuIfAny(view: WebContentsView) {
      try {
        const dbg: ElectronDebugger = view.webContents.debugger
        if (dbg.isAttached()) {
          await dbg.sendCommand('Emulation.clearDeviceMetricsOverride', {})
          dbg.detach()
        }
      } catch {}
    },

    async setEff(view: WebContentsView, eff: number) {
      if (eff >= CHROME_MIN) {
        try { await view.webContents.setZoomFactor(eff) } catch {}
        await S.clearEmuIfAny(view)
        return
      }
      try { await view.webContents.setZoomFactor(CHROME_MIN) } catch {}
      let b: { width: number; height: number }
      try { b = view.getBounds() } catch { return }
      if (!S.hasRealBounds(b)) return
      try {
        const dbg: ElectronDebugger = view.webContents.debugger
        if (!dbg.isAttached()) dbg.attach('1.3')
        const scale = Math.max(0.05, Math.min(1, eff / CHROME_MIN))
        const emuW = Math.max(1, Math.floor(b.width / scale))
        const emuH = Math.max(1, Math.floor(b.height / scale))
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: emuW, height: emuH, deviceScaleFactor: 0, scale,
          mobile: false, screenWidth: emuW, screenHeight: emuH,
          positionX: 0, positionY: 0, dontSetVisibleSize: false,
        })
      } catch {}
    },


async reapply(state: ViewState) {
  try {
    const eff = S.currentEff()
    void S.setEff(state.view, eff)
    state.lastAppliedZoom = eff
  } catch {}
},


    updateNav(state: ViewState) {
      try {
        const wc = state.view.webContents
        state.navState = {
          currentUrl: wc.getURL() || 'about:blank',
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          title: wc.getTitle() || '',
        }
      } catch {}
    },

    safeDestroy(state: ViewState) {
      try { void S.clearEmuIfAny(state.view) } catch {}
      try { state.view.webContents.stop() } catch {}
      try { state.view.webContents.setAudioMuted(true) } catch {}
      try {
        const win = getWindow()
        if (win && !win.isDestroyed()) {
          win.contentView.removeChildView(state.view)
          state.attached = false
        }
      } catch {}
      try { (state.view.webContents as { destroy?: () => void }).destroy?.() } catch {}
    },

    roundRect(rect: Rect) {
      const x = Math.floor(rect.x), y = Math.floor(rect.y)
      const w = Math.ceil(rect.width), h = Math.ceil(rect.height)
      return { x, y, w, h }
    },
  }

  let creating = false
  const q: Array<() => Promise<void>> = []

  function runQ(): void {
    if (creating) return
    const task = q.shift()
    if (!task) return
    creating = true
    setImmediate(() => {
      void (async () => {
        try { await task() }
        finally { creating = false; runQ() }
      })()
    })
  }

  function enqueue<TSuccess extends { ok: true }>(fn: () => Promise<TSuccess>): Promise<TSuccess | Err> {
    return new Promise((resolve) => {
      q.push(async () => {
        try { resolve(await fn()) }
        catch (e) { resolve({ ok: false, error: e instanceof Error ? e.message : 'Operation failed' }) }
      })
      runQ()
    })
  }

  // -------------------- IPC handlers ---------------------------------------
  ipcMain.handle('overlay:create-tab', async (_e, payload?: { url?: string; shapeId?: string }): Promise<CreateTabResponse> => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return { ok: false, error: 'No window' }
    if (views.size >= MAX_VIEWS) return { ok: false, error: `Too many tabs (${views.size})` }

    if (!startupRestoreComplete) {
      await initializeStartupRestore()
    }

    return enqueue(async () => {
      const tabId = payload?.shapeId!
      let savedUrl = payload?.url || 'https://google.com/'
      let delayMs = 0

      const isStartupRestore = startupQueue.length > 0 && startupBrowserState[tabId]
      if (isStartupRestore) {
        savedUrl = startupBrowserState[tabId].currentUrl || savedUrl
        const queueIndex = startupQueue.findIndex(item => item.shapeId === tabId)
        if (queueIndex >= 0) {
          delayMs = queueIndex * STARTUP_DELAY_MS
          startupQueue.splice(queueIndex, 1)
        }
      }

      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))

      if (views.has(tabId)) return { ok: true as const, tabId }

      let state: ViewState | undefined
      try {
        const view = new WebContentsView({
          webPreferences: {
            devTools: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: true,
          },
        })

        try {
          view.webContents.setZoomFactor(1)
          view.webContents.setVisualZoomLevelLimits(1, 1)
        } catch {}

        state = {
          view,
          attached: false,
          lastBounds: { x: 0, y: 0, w: 1, h: 1 },
          lastAppliedZoom: 1,
          navState: { currentUrl: savedUrl, canGoBack: false, canGoForward: false, title: '' },
        }
        views.set(tabId, state)

        const safeReapply = () => { if (!state) return; void S.reapply(state); S.updateNav(state) }
        view.webContents.on('dom-ready', safeReapply)

        view.webContents.on('did-navigate', () => {
          if (!state) return
          safeReapply()
          const currentUrl = view.webContents.getURL()
          browserState[tabId] = { currentUrl, lastInteraction: Date.now() }
          flushBrowserState()
        })

        view.webContents.on('did-navigate-in-page', () => {
          if (!state) return
          safeReapply()
          const currentUrl = view.webContents.getURL()
          browserState[tabId] = { currentUrl, lastInteraction: Date.now() }
          flushBrowserState()
        })

        view.webContents.on('page-title-updated', () => { if (state) S.updateNav(state) })
        view.webContents.on('render-process-gone', () => {
          try {
            const w = getWindow()
            if (w && !w.isDestroyed() && state) S.detach(w, state)
          } catch {}
          views.delete(tabId)
        })

        view.webContents.on('before-input-event', (event, input: Input) => {
          if (!state) return
          try {
            const mod = input.control || input.meta
            const key = (input.key || '').toLowerCase()
            if ((key === 'i' && mod && input.shift) || key === 'f12') {
              event.preventDefault()
              if (view.webContents.isDevToolsOpened()) view.webContents.closeDevTools()
              else view.webContents.openDevTools({ mode: 'detach' })
              return
            }
            if (input.alt && key === 'arrowleft' && state.navState.canGoBack) {
              event.preventDefault(); view.webContents.navigationHistory.goBack(); return
            }
            if (input.alt && key === 'arrowright' && state.navState.canGoForward) {
              event.preventDefault(); view.webContents.navigationHistory.goForward(); return
            }
            if ((mod && key === 'r') || key === 'f5') {
              event.preventDefault(); view.webContents.reload(); return
            }
            if (mod && ['=', '+', '-', '_', '0'].includes(key)) event.preventDefault()
            if (input.type === 'mouseWheel' && mod) event.preventDefault()
          } catch {}
        })

        await S.reapply(state)
        try { await view.webContents.loadURL(savedUrl) } catch {}

        return { ok: true as const, tabId }
      } catch (err) {
        if (state) {
          try { const w2 = getWindow(); if (w2 && !w2.isDestroyed()) S.detach(w2, state) } catch {}
          views.delete(tabId)
        }
        throw err ?? new Error('Create failed')
      }
    })
  })

  ipcMain.handle('overlay:get-zoom', async (): Promise<number> => canvasZoom)

  ipcMain.handle('overlay:show', async (_e, { tabId, rect }: { tabId: string; rect: Rect }): Promise<void> => {
    const win = getWindow()
    const { state } = S.resolve(tabId)
    if (!win || !state) return
    const { x, y, w, h } = S.roundRect(rect)
    state.lastBounds = { x, y, w, h }
    S.attach(win, state)
    try { state.view.setBounds({ x, y, width: w, height: h }) } catch {}
  })

  ipcMain.handle('overlay:set-bounds', async (_e, { tabId, rect }: { tabId: string; rect: Rect }): Promise<void> => {
    const { state } = S.resolve(tabId)
    if (!state) return
    const { x, y, w, h } = S.roundRect(rect)
    const b = state.lastBounds
    if (!b || x !== b.x || y !== b.y || w !== b.w || h !== b.h) {
      state.lastBounds = { x, y, w, h }
      try { state.view.setBounds({ x, y, width: w, height: h }) } catch {}
      if (S.currentEff() < CHROME_MIN) await S.reapply(state)
    }
  })


  ipcMain.handle('overlay:set-zoom', async (_e, { tabId, factor }: { tabId?: string; factor: number }): Promise<void> => {
    canvasZoom = factor || 1
    const target = S.currentEff()
    if (tabId) {
      const { state } = S.resolve(tabId)
      if (!state) return
      await S.setEff(state.view, target); state.lastAppliedZoom = target
    } else {
      for (const [, s] of views) { await S.setEff(s.view, target); s.lastAppliedZoom = target }
    }
  })

  ipcMain.handle('overlay:hide', async (_e, p?: { tabId?: string }): Promise<void> => {
    const win = getWindow()
    if (!win) return
    if (p?.tabId) {
      const { state } = S.resolve(p.tabId)
      if (state) S.detach(win, state)
    } else {
      for (const [, s] of views) {
        S.detach(win, s)
      }
    }
  })

  ipcMain.handle('overlay:destroy', async (_e, { tabId }: { tabId: string }): Promise<void> => {
    const entry = S.resolve(tabId)
    const state = entry.state
    try {
      if (state) {
        try { S.safeDestroy(state) } catch (err) {
          console.warn(`[overlay] SafeDestroy failed for ${tabId}:`, err)
        }
      }
      views.delete(tabId)
      delete browserState[tabId]
      flushBrowserState()
    } catch (err) {
      console.error(`[overlay] Destroy handler error for ${tabId}:`, err)
      try {
        views.delete(tabId)
        delete browserState[tabId]
      } catch {}
    }
  })

  ipcMain.handle('overlay:focus', async (_e, p?: { tabId?: string }): Promise<void> => {
    const { state } = S.resolve(p?.tabId ?? null)
    if (state) {
      try { state.view.webContents.focus() } catch {}
    }
  })

  ipcMain.handle('overlay:blur', async (): Promise<void> => {
    const win = getWindow()
    if (win) try { win.webContents.focus() } catch {}
  })

  ipcMain.handle('overlay:navigate', async (_e, { tabId, url }: { tabId: string; url: string }): Promise<SimpleResponse> => {
    const { state } = S.resolve(tabId)
    if (!state) return { ok: false, error: 'No view' }
    try {
      const u = url.trim()
      await state.view.webContents.loadURL(u.startsWith('http') ? u : `https://${u}`)
      return { ok: true }
    } catch { return { ok: false, error: 'Navigate failed' } }
  })

  ipcMain.handle('overlay:go-back', async (_e, { tabId }: { tabId: string }): Promise<SimpleResponse> => {
    const { state } = S.resolve(tabId)
    if (!state || !state.navState.canGoBack) return { ok: false, error: 'Cannot go back' }
    try { state.view.webContents.navigationHistory.goBack(); return { ok: true } }
    catch { return { ok: false, error: 'Back failed' } }
  })

  ipcMain.handle('overlay:go-forward', async (_e, { tabId }: { tabId: string }): Promise<SimpleResponse> => {
    const { state } = S.resolve(tabId)
    if (!state || !state.navState.canGoForward) return { ok: false, error: 'Cannot go forward' }
    try { state.view.webContents.navigationHistory.goForward(); return { ok: true } }
    catch { return { ok: false, error: 'Forward failed' } }
  })

  ipcMain.handle('overlay:reload', async (_e, { tabId }: { tabId: string }): Promise<SimpleResponse> => {
    const { state } = S.resolve(tabId)
    if (!state) return { ok: false, error: 'No view' }
    try { state.view.webContents.reload(); return { ok: true } }
    catch { return { ok: false, error: 'Reload failed' } }
  })

  ipcMain.handle('overlay:get-navigation-state', async (_e, { tabId }: { tabId: string }): Promise<GetNavStateResponse> => {
    const { state } = S.resolve(tabId)
    if (!state) return { ok: false, error: 'No view' }
    return {
      ok: true,
      ...state.navState,
      isLoading: (() => { try { return state.view.webContents.isLoading() } catch { return false } })(),
    }
  })
}
