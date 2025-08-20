import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron'
import type { Debugger as ElectronDebugger, Input } from 'electron'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

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

type Ok<T extends object = {}> = { ok: true } & T
type Err = { ok: false; error: string }
type CreateTabResponse = Ok<{ tabId: string }> | Err
type SimpleResponse = Ok | Err

// Capture now may return a disk file path in addition to dataUrl.
type CaptureUnifiedResponse = Ok<{ dataUrl?: string; filePath?: string }> | Err
type GetNavStateResponse = (Ok & ViewState['navState'] & { isLoading: boolean }) | Err

// New: thumbnailer response for cold-start screenshots
type GetOrCreateThumbResponse = Ok<{ filePath?: string; dataUrl?: string }> | Err

const CHROME_MIN = 0.25
const CHROME_MAX = 5
const ZOOM_RATIO = 1
const MAX_VIEWS = 32
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

let canvasZoom = 1

function thumbsDir(): string {
  const dir = path.join(app.getPath('userData'), 'thumbs')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}
function thumbPath(shapeId: string): string {
  return path.join(thumbsDir(), `${shapeId}.png`)
}
async function writeFileAtomic(filePath: string, buf: Buffer): Promise<void> {
  const tmp = `${filePath}.${randomUUID()}.tmp`
  await fs.promises.writeFile(tmp, buf)
  await fs.promises.rename(tmp, filePath)
}

export function setupOverlayIPC(getWindow: () => BrowserWindow | null) {
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
        if (dbg.isAttached()) { await dbg.sendCommand('Emulation.clearDeviceMetricsOverride', {}); dbg.detach() }
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
      try { const eff = S.currentEff(); await S.setEff(state.view, eff); state.lastAppliedZoom = eff } catch {}
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
        if (win && !win.isDestroyed()) { win.contentView.removeChildView(state.view); state.attached = false }
      } catch {}
      try { (state.view.webContents as unknown as { destroy?: () => void }).destroy?.() } catch {}
    },
    roundRect(rect: Rect) {
      const x = Math.floor(rect.x), y = Math.floor(rect.y)
      const w = Math.ceil(rect.width), h = Math.ceil(rect.height)
      return { x, y, w, h }
    },
  }

  // creation queue
  let creating = false
  const q: Array<() => void> = []
  function runQ() {
    if (creating) return
    const task = q.shift()
    if (!task) return
    creating = true
    setImmediate(async () => { try { await task() } finally { creating = false; runQ() } })
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

  // IPC

  ipcMain.handle('overlay:create-tab', async (_e, payload?: { url?: string }): Promise<CreateTabResponse> => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return { ok: false, error: 'No window' }
    if (views.size >= MAX_VIEWS) return { ok: false, error: `Too many tabs (${views.size})` }

    return enqueue(async () => {
      const tabId = randomUUID()
      let state: ViewState | undefined

      try {
        const view = new WebContentsView({
          webPreferences: { devTools: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
        })
        try { view.webContents.setZoomFactor(1); view.webContents.setVisualZoomLevelLimits(1, 1) } catch {}

        state = {
          view, attached: false,
          lastBounds: { x: 0, y: 0, w: 1, h: 1 },
          lastAppliedZoom: 1,
          navState: { currentUrl: payload?.url || 'https://google.com/', canGoBack: false, canGoForward: false, title: '' },
        }
        views.set(tabId, state)

        const safeReapply = () => { if (!state) return; void S.reapply(state); S.updateNav(state) }
        view.webContents.on('dom-ready', safeReapply)
        view.webContents.on('did-navigate', safeReapply)
        view.webContents.on('did-navigate-in-page', safeReapply)
        view.webContents.on('page-title-updated', () => { if (state) S.updateNav(state) })
        view.webContents.on('render-process-gone', () => { try { const w = getWindow(); if (w && !w.isDestroyed() && state) S.detach(w, state) } catch {}; views.delete(tabId) })

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
        try { await view.webContents.loadURL(state.navState.currentUrl) } catch {}

        return { ok: true as const, tabId }
      } catch (err) {
        if (state) { try { const w2 = getWindow(); if (w2 && !w2.isDestroyed()) S.detach(w2, state) } catch {}; views.delete(tabId) }
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
    if (S.currentEff() < CHROME_MIN) await S.reapply(state)
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
      for (const [, s] of views) S.detach(win, s)
    }
  })

  ipcMain.handle('overlay:destroy', async (_e, { tabId }: { tabId: string }): Promise<void> => {
    const { state } = S.resolve(tabId)
    if (!state) return
    try { S.safeDestroy(state) } finally { views.delete(tabId) }
  })

  /**
   * Capture the current tab into a PNG. If shapeId is provided, the PNG is also
   * written to userData/thumbs/<shapeId>.png and filePath is returned.
   */
  ipcMain.handle('overlay:capture', async (_e, { tabId, shapeId }: { tabId: string; shapeId?: string }): Promise<CaptureUnifiedResponse> => {
    const { state } = S.resolve(tabId)
    if (!state) return { ok: false, error: 'No view' }
    try {
      // Ensure no audio glitch during capture
      try { state.view.webContents.setAudioMuted(true) } catch {}

      const image = await state.view.webContents.capturePage()
      const png = image.toPNG({ scaleFactor: 1 })
      const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`

      if (shapeId) {
        const filePath = thumbPath(shapeId)
        try { await writeFileAtomic(filePath, png) } catch { /* fall back to dataUrl-only */ }
        return { ok: true, dataUrl, filePath }
      }
      return { ok: true, dataUrl }
    } catch {
      return { ok: false, error: 'Capture failed' }
    }
  })

  ipcMain.handle('overlay:focus', async (_e, p?: { tabId?: string }): Promise<void> => {
    const { state } = S.resolve(p?.tabId ?? null)
    if (state) try { state.view.webContents.focus() } catch {}
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

  /**
   * Cold-start thumbnail generator: muted, offscreen, no BrowserView usage.
   * Returns a disk file when possible, falling back to dataUrl.
   */
  ipcMain.handle('overlay:get-or-create-thumbnail', async (_e, args: { shapeId: string; url: string; w?: number; h?: number }): Promise<GetOrCreateThumbResponse> => {
    const out = thumbPath(args.shapeId)
    try {
      // If we already have a file, reuse it
      if (fs.existsSync(out)) return { ok: true, filePath: out }

      const w = Math.max(128, Math.min(1600, Math.floor(args.w ?? 1200)))
      const h = Math.max(96, Math.min(1200, Math.floor(args.h ?? 800)))

      const win = new BrowserWindow({
        show: false,
        width: w,
        height: h,
        webPreferences: {
          offscreen: true,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })

      try {
        // Never emit audio while we snapshot
        win.webContents.setAudioMuted(true)
        await win.loadURL(args.url.startsWith('http') ? args.url : `https://${args.url}`)

        // Give the page a brief moment to paint its first frame
        await new Promise((r) => setTimeout(r, 150))

        const img = await win.webContents.capturePage()
        const buf = img.toPNG()
        await writeFileAtomic(out, buf)
        return { ok: true, filePath: out }
      } catch (e) {
        // Fall back to returning a dataUrl so renderer can still show something
        try {
          const img = await win.webContents.capturePage()
          const buf = img.toPNG()
          const dataUrl = `data:image/png;base64,${Buffer.from(buf).toString('base64')}`
          return { ok: true, dataUrl }
        } catch {
          return { ok: false, error: e instanceof Error ? e.message : 'Thumbnail failed' }
        }
      } finally {
        try { win.destroy() } catch {}
      }
    } catch {
      return { ok: false, error: 'Thumbnail failed' }
    }
  })
}
