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
  screenshotCache?: string // data URL
  isShowingScreenshot: boolean
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
type CaptureResponse = Ok<{ dataUrl: string }> | Err
type GetNavStateResponse = (Ok & ViewState['navState'] & { isLoading: boolean }) | Err

// ---- Zoom / swap config ----------------------------------------------------
const CHROME_MAX = 5
const ZOOM_RATIO = 1
const SHOW_AT = 0.24   // enter screenshot mode when eff < SHOW_AT
const HIDE_AT = 0.26   // leave screenshot mode when eff > HIDE_AT
const PRECAPTURE_BAND = 0.02 // pre-capture just above SHOW_AT to avoid pop
const MAX_VIEWS = 32

// Fresh recapture: wait a tick after did-stop-loading before re-shot
const WARM_RECAPTURE_DELAY_MS = 80

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
      console.log('[overlay] Reading startup state file once...')
      const fileContent = readFileSync(stateFile, 'utf8')
      startupBrowserState = JSON.parse(fileContent)
      
      // Build startup queue from saved state
      startupQueue = Object.entries(startupBrowserState).map(([shapeId, data]) => ({
        shapeId,
        url: data.currentUrl,
        lastInteraction: data.lastInteraction || 0
      }))
      
      // Sort by last interaction (most recent first)
      startupQueue.sort((a, b) => b.lastInteraction - a.lastInteraction)
      console.log(`[overlay] Prepared startup queue for ${startupQueue.length} tabs`)
    }
  } catch (e) {
    console.error('[overlay] Failed to read startup state:', e)
  }
  
  startupRestoreComplete = true
}


async function delay(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms))
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

    async clearEmuIfAny(view: WebContentsView) {
      try {
        const dbg: ElectronDebugger = view.webContents.debugger
        if (dbg.isAttached()) { await dbg.sendCommand('Emulation.clearDeviceMetricsOverride', {}); dbg.detach() }
      } catch {}
    },

    async captureScreenshot(state: ViewState): Promise<string | undefined> {
      try {
        const image = await state.view.webContents.capturePage()
        const png = image.toPNG({ scaleFactor: 1 })
        return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
      } catch {
        return undefined
      }
    },

    async pushFreshScreenshot(tabId: string, state: ViewState): Promise<void> {
      const win = getWindow()
      if (!win) return
      await delay(WARM_RECAPTURE_DELAY_MS)
      try {
        const fresh = await state.view.webContents.capturePage()
        const png = fresh.toPNG({ scaleFactor: 1 })
        const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
        if (!state.isShowingScreenshot) return
        state.screenshotCache = dataUrl
        win.webContents.send('overlay-screenshot-mode', {
          tabId,
          screenshot: dataUrl,
          bounds: state.lastBounds,
        })
      } catch {
        // keep old screenshot on failure
      }
    },

    async setEff(view: WebContentsView, eff: number, state: ViewState) {
      const win = getWindow()
      if (!win) return

      // Hysteresis: if we’re already in screenshot mode, require HIDE_AT to leave;
      // if not, require SHOW_AT to enter.
      const wantScreenshot = state.isShowingScreenshot ? eff < HIDE_AT : eff < SHOW_AT

      if (wantScreenshot) {
        // Ensure we have a screenshot before we hide the live view
        if (!state.screenshotCache) {
          await S.clearEmuIfAny(view)
          state.screenshotCache = await S.captureScreenshot(state)
        }

        if (state.screenshotCache && !state.isShowingScreenshot) {
          // Switch to screenshot mode (detach live view first)
          try { S.detach(win, state) } catch {}
          state.isShowingScreenshot = true
          const tabId = Array.from(views.entries()).find(([, s]) => s === state)?.[0]
          win.webContents.send('overlay-screenshot-mode', {
            tabId,
            screenshot: state.screenshotCache,
            bounds: state.lastBounds,
          })

          // If the page is still loading, replace provisional screenshot with a fresh one
          try {
            if (state.view.webContents.isLoading() && tabId) {
              void S.pushFreshScreenshot(tabId, state)
            }
          } catch {}
        }
        return
      }

      // Normal (live) mode
      if (state.isShowingScreenshot) {
        // Reattach first, then tell renderer to drop the image
        state.isShowingScreenshot = false
        S.attach(win, state)
        const tabId = Array.from(views.entries()).find(([, s]) => s === state)?.[0]
        win.webContents.send('overlay-screenshot-mode', { tabId, screenshot: null })
      }

      try { view.webContents.setZoomFactor(eff) } catch {}
      await S.clearEmuIfAny(view)
    },

    async reapply(state: ViewState) {
      try {
        const eff = S.currentEff()

        // Pre-emptively capture when we’re close to entering screenshot mode
        if (!state.screenshotCache && !state.isShowingScreenshot && eff <= (SHOW_AT + PRECAPTURE_BAND)) {
          state.screenshotCache = await S.captureScreenshot(state)
        }

        await S.setEff(state.view, eff, state)
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
          // Clean up screenshot mode signal
          if (state.isShowingScreenshot) {
            const tabId = Array.from(views.entries()).find(([, s]) => s === state)?.[0]
            win.webContents.send('overlay-screenshot-mode', { tabId, screenshot: null })
          }
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

  // --- creation queue (no .catch() on timers) ------------------------------
  let creating = false
  const q: Array<() => Promise<void>> = []

  function runQ(): void {
    if (creating) return
    const task = q.shift()
    if (!task) return
    creating = true

    // setImmediate returns an Immediate, NOT a Promise — no .catch()
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

    // Initialize startup restore on first call
    if (!startupRestoreComplete) {
        await initializeStartupRestore()
    }

    return enqueue(async () => {
        const tabId = payload?.shapeId!
        let savedUrl = payload?.url || 'https://google.com/'
        let delayMs = 0
        
        // Check if this is a startup restoration (only during startup)
        const isStartupRestore = startupQueue.length > 0 && startupBrowserState[tabId]
        
        if (isStartupRestore) {
            // Use saved URL from startup state
            savedUrl = startupBrowserState[tabId].currentUrl || savedUrl
            
            // Find position in startup queue for delay calculation
            const queueIndex = startupQueue.findIndex(item => item.shapeId === tabId)
            if (queueIndex >= 0) {
                delayMs = queueIndex * STARTUP_DELAY_MS
                // Remove from queue so it won't be processed again
                startupQueue.splice(queueIndex, 1)
                console.log(`[overlay] Restoring tab ${tabId} with ${delayMs}ms delay (${startupQueue.length} remaining)`)
            }
        }
        
        // Apply startup delay if needed
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs))
        }
        
        // Check if this tab already exists (restoration scenario)
        if (views.has(tabId)) {
            console.log(`[overlay] Tab ${tabId} already exists, skipping creation`)
            return { ok: true as const, tabId }
        }
        
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
                view, attached: false,
                lastBounds: { x: 0, y: 0, w: 1, h: 1 },
                lastAppliedZoom: 1,
                screenshotCache: undefined,
                isShowingScreenshot: false,
                navState: { currentUrl: savedUrl, canGoBack: false, canGoForward: false, title: '' },
            }
            views.set(tabId, state)

            const safeReapply = () => { if (!state) return; void S.reapply(state); S.updateNav(state) }
            view.webContents.on('dom-ready', safeReapply)

            // Invalidate cached screenshot on new load
            view.webContents.on('did-start-loading', () => { if (state) state.screenshotCache = undefined })

            // After the page truly finishes loading, if we're in screenshot mode,
            // refresh the image so it's not a "loading" frame.
            view.webContents.on('did-stop-loading', () => {
                if (state && state.isShowingScreenshot) void S.pushFreshScreenshot(tabId, state)
            })

            view.webContents.on('did-navigate', () => {
                if (state) { 
                    state.screenshotCache = undefined
                    safeReapply()
                    
                    const currentUrl = view.webContents.getURL()
                    console.log(`[overlay] Tab ${tabId} navigated to:`, currentUrl)
                    
                    // Save URL to simple JSON file (this continues to work as before)
                    try {
                        const stateFile = join(process.cwd(), 'browser-state.json')
                        let browserState = {}
                        if (existsSync(stateFile)) {
                            browserState = JSON.parse(readFileSync(stateFile, 'utf8'))
                        }
                        browserState[tabId] = { currentUrl, lastInteraction: Date.now() }
                        writeFileSync(stateFile, JSON.stringify(browserState, null, 2))
                    } catch (e) {
                        console.error('[overlay] Failed to save browser state:', e)
                    }
                }
            })

            view.webContents.on('did-navigate-in-page', () => {
                if (state) { 
                    state.screenshotCache = undefined
                    safeReapply()
                    
                    const currentUrl = view.webContents.getURL()
                    console.log(`[overlay] Tab ${tabId} navigated in-page to:`, currentUrl)
                    
                    // Save URL to simple JSON file (this continues to work as before)
                    try {
                        const stateFile = join(process.cwd(), 'browser-state.json')
                        let browserState = {}
                        if (existsSync(stateFile)) {
                            browserState = JSON.parse(readFileSync(stateFile, 'utf8'))
                        }
                        browserState[tabId] = { currentUrl, lastInteraction: Date.now() }
                        writeFileSync(stateFile, JSON.stringify(browserState, null, 2))
                    } catch (e) {
                        console.error('[overlay] Failed to save browser state:', e)
                    }
                }
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
                        else view.webContents.openDevTools({ mode: 'detach' }); return
                    }
                    if (input.alt && key === 'arrowleft' && state.navState.canGoBack) { event.preventDefault(); view.webContents.navigationHistory.goBack(); return }
                    if (input.alt && key === 'arrowright' && state.navState.canGoForward) { event.preventDefault(); view.webContents.navigationHistory.goForward(); return }
                    if ((mod && key === 'r') || key === 'f5') { event.preventDefault(); view.webContents.reload(); return }
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

    if (!state.isShowingScreenshot) {
      S.attach(win, state)
      try { state.view.setBounds({ x, y, width: w, height: h }) } catch {}
    }

    if (S.currentEff() < HIDE_AT) await S.reapply(state)
  })

  ipcMain.handle('overlay:set-bounds', async (_e, { tabId, rect }: { tabId: string; rect: Rect }): Promise<void> => {
    const { state } = S.resolve(tabId)
    if (!state) return
    const { x, y, w, h } = S.roundRect(rect)
    const b = state.lastBounds
    if (!b || x !== b.x || y !== b.y || w !== b.w || h !== b.h) {
      state.lastBounds = { x, y, w, h }

      if (!state.isShowingScreenshot) {
        try { state.view.setBounds({ x, y, width: w, height: h }) } catch {}
      }

      if (S.currentEff() < HIDE_AT) await S.reapply(state)
    }
  })

  ipcMain.handle('overlay:set-zoom', async (_e, { tabId, factor }: { tabId?: string; factor: number }): Promise<void> => {
    canvasZoom = factor || 1
    const target = S.currentEff()
    if (tabId) {
      const { state } = S.resolve(tabId)
      if (!state) return
      await S.setEff(state.view, target, state)
      state.lastAppliedZoom = target
    } else {
      for (const [, s] of views) {
        await S.setEff(s.view, target, s)
        s.lastAppliedZoom = target
      }
    }
  })

  ipcMain.handle('overlay:hide', async (_e, p?: { tabId?: string }): Promise<void> => {
    const win = getWindow()
    if (!win) return
    if (p?.tabId) {
      const { state } = S.resolve(p.tabId)
      if (state) {
        S.detach(win, state)
        if (state.isShowingScreenshot) {
          win.webContents.send('overlay-screenshot-mode', { tabId: p.tabId, screenshot: null })
        }
      }
    } else {
      for (const [tabId, s] of views) {
        S.detach(win, s)
        if (s.isShowingScreenshot) {
          win.webContents.send('overlay-screenshot-mode', { tabId, screenshot: null })
        }
      }
    }
  })

  ipcMain.handle('overlay:destroy', async (_e, { tabId }: { tabId: string }): Promise<void> => {
  const { state } = S.resolve(tabId)
  if (!state) return
  try { 
    S.safeDestroy(state) 
    
    // Clean up browser state file
    try {
      const stateFile = join(process.cwd(), 'browser-state.json')
      if (existsSync(stateFile)) {
        const browserState = JSON.parse(readFileSync(stateFile, 'utf8'))
        delete browserState[tabId]
        writeFileSync(stateFile, JSON.stringify(browserState, null, 2))
        console.log(`[overlay] Cleaned up state for tab ${tabId}`)
      }
    } catch (e) {
      console.error('[overlay] Failed to clean up browser state:', e)
    }
  } finally { 
    views.delete(tabId) 
  }
})

  ipcMain.handle('overlay:capture', async (_e, { tabId }: { tabId: string }): Promise<CaptureResponse> => {
    const { state } = S.resolve(tabId)
    if (!state) return { ok: false, error: 'No view' }

    if (state.isShowingScreenshot && state.screenshotCache) {
      return { ok: true, dataUrl: state.screenshotCache }
    }

    const dataUrl = await S.captureScreenshot(state)
    return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'Capture failed' }
  })

  ipcMain.handle('overlay:focus', async (_e, p?: { tabId?: string }): Promise<void> => {
    const { state } = S.resolve(p?.tabId ?? null)
    if (state && !state.isShowingScreenshot) {
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
      state.screenshotCache = undefined
      const u = url.trim()
      await state.view.webContents.loadURL(u.startsWith('http') ? u : `https://${u}`)
      return { ok: true }
    } catch { return { ok: false, error: 'Navigate failed' } }
  })

  ipcMain.handle('overlay:go-back', async (_e, { tabId }: { tabId: string }): Promise<SimpleResponse> => {
    const { state } = S.resolve(tabId)
    if (!state || !state.navState.canGoBack) return { ok: false, error: 'Cannot go back' }
    try {
      state.screenshotCache = undefined
      state.view.webContents.goBack()
      return { ok: true }
    }
    catch { return { ok: false, error: 'Back failed' } }
  })

  ipcMain.handle('overlay:go-forward', async (_e, { tabId }: { tabId: string }): Promise<SimpleResponse> => {
    const { state } = S.resolve(tabId)
    if (!state || !state.navState.canGoForward) return { ok: false, error: 'Cannot go forward' }
    try {
      state.screenshotCache = undefined
      state.view.webContents.goForward()
      return { ok: true }
    }
    catch { return { ok: false, error: 'Forward failed' } }
  })

  ipcMain.handle('overlay:reload', async (_e, { tabId }: { tabId: string }): Promise<SimpleResponse> => {
    const { state } = S.resolve(tabId)
    if (!state) return { ok: false, error: 'No view' }
    try {
      state.screenshotCache = undefined
      state.view.webContents.reload()
      return { ok: true }
    }
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