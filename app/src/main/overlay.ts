// overlay.ts
import { BrowserWindow, BrowserView, ipcMain } from 'electron'
import { randomUUID } from 'crypto'

type Rect = { x: number; y: number; width: number; height: number }

type ViewState = {
  view: BrowserView
  lastIntRect: { x: number; y: number; w: number; h: number } | null
  frac: { fx: number; fy: number }
  baseCssKey: string | null
  dbgAttached: boolean
  extraScale: number // <1 when effective zoom < 0.25

  // Smoothing / mode state
  lastAppliedZoom?: number
  mode?: 'native' | 'emu'
  lastZoomAt?: number
}

const MIN_EFFECTIVE_ZOOM = 0.05
const CHROME_MIN = 0.25
const CHROME_MAX = 5
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// IMPORTANT: leave this at 1 for 1:1 mapping between canvas zoom and page zoom.
// If you want everything 30% smaller, set to 0.70 — but it'll make “matching” feel off.
const ZOOM_RATIO = 1.0

// Smoothing knobs
const ZOOM_EPS = 0.01            // ignore ~1% deltas
const ZOOM_QUANTUM = 1 / 64      // step size (~1.56%)
const MODE_HYST = 0.02           // hysteresis around 0.25 to stop flapping
const ZOOM_MIN_INTERVAL_MS = 16  // throttle (≈60 Hz)

// NEW: app-wide zoom that survives navigation & new tabs
let currentZoom = 1

export function setupOverlayIPC(getWindow: () => BrowserWindow | null) {
  const views = new Map<string, ViewState>()

  const resolve = (id?: string | null) => {
    if (id && views.has(id)) {
      const s = views.get(id)!
      return { view: s.view, state: s }
    }
    return { view: null as unknown as BrowserView | null, state: null as unknown as ViewState | null }
  }

  async function ensureBaseCSS(tabId: string, view: BrowserView) {
    const s = views.get(tabId)
    if (!s || s.baseCssKey) return
    const css = `
      html, body { overflow: hidden !important; }
      *::-webkit-scrollbar { display: none !important; }
      html { transform-origin: 0 0 !important; will-change: transform !important; }
      body { margin: 0 !important; background: transparent !important; }
    `
    try { s.baseCssKey = await view.webContents.insertCSS(css) } catch {}
  }

  async function applySubpixel(view: BrowserView, tx: number, ty: number) {
    const js = `
      (function () {
        const el = document.documentElement;
        const t = 'translate3d(${tx}px, ${ty}px, 0)';
        if (el.style.transform !== t) el.style.transform = t;
      })();
    `
    try { await view.webContents.executeJavaScript(js) } catch {}
  }

  async function ensureDebugger(view: BrowserView, state: ViewState) {
    if (state.dbgAttached) return
    try { view.webContents.debugger.attach('1.3'); state.dbgAttached = true } catch {}
  }
  async function clearEmulation(view: BrowserView, state: ViewState) {
    if (!state.dbgAttached) return
    try { await view.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride', {}) } catch {}
    state.extraScale = 1
  }
  async function applyEmulation(view: BrowserView, state: ViewState) {
    if (!state.dbgAttached || !state.lastIntRect) return
    const { w, h } = state.lastIntRect
    const s = state.extraScale
    const emuWidth  = Math.max(1, Math.floor(w / s))
    const emuHeight = Math.max(1, Math.floor(h / s))
    try {
      await view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: emuWidth,
        height: emuHeight,
        deviceScaleFactor: 0,
        scale: s,
        mobile: false,
        screenWidth: emuWidth,
        screenHeight: emuHeight,
        positionX: 0,
        positionY: 0,
        dontSetVisibleSize: false,
      })
    } catch {}
  }

  function attach(win: BrowserWindow, view: BrowserView) { try { win.addBrowserView(view) } catch {} }
  function detach(win: BrowserWindow, view: BrowserView) { try { win.removeBrowserView(view) } catch {} }

  // ---- IPC ----

  ipcMain.handle('overlay:create-tab', async (_e, payload?: { url?: string }) => {
    const win = getWindow()
    if (!win) return { ok: false }
    const tabId = randomUUID()
    const view = new BrowserView({
      webPreferences: {
        devTools: true,
        contextIsolation: true,
        nodeIntegration: false,
        plugins: false,
        backgroundThrottling: false,
      },
    })

    // Lock Chromium's own zoom (pinch) and reset page zoom
    try {
      view.webContents.setZoomFactor(1)
      // Hard-lock pinch/visual zoom (trackpad gesture)
      view.webContents.setVisualZoomLevelLimits(1, 1)
    } catch {}

    // 🔧 Your DevTools toggle — kept
    view.webContents.on('before-input-event', (event, input) => {
      const mod = input.control || input.meta
      const isToggle = (input.key?.toLowerCase() === 'i' && mod && input.shift) || input.key === 'F12'
      if (isToggle) {
        event.preventDefault()
        if (view.webContents.isDevToolsOpened()) view.webContents.closeDevTools()
        else view.webContents.openDevTools({ mode: 'detach' })
        return
      }

      // Block keyboard zoom (Cmd/Ctrl +, -, 0)
      if (mod) {
        const key = (input.key || '').toLowerCase()
        if (key === '=' || key === '+' || key === '-' || key === '_' || key === '0') {
          event.preventDefault()
          // Forward to renderer as “app zoom” (your existing pattern)
          if (key === '=' || key === '+') {
            currentZoom = clamp(currentZoom * 1.1, MIN_EFFECTIVE_ZOOM, CHROME_MAX)
          } else if (key === '-' || key === '_') {
            currentZoom = clamp(currentZoom / 1.1, MIN_EFFECTIVE_ZOOM, CHROME_MAX)
          } else if (key === '0') {
            currentZoom = 1
          }
          win.webContents.send('overlay:zoom-from-page', { factor: currentZoom })
          return
        }
      }

      // Block Ctrl/⌘ + trackpad wheel zoom (Chromium synthesizes wheel+ctrl for pinch-to-zoom)
      if (input.type === 'mouseWheel' && (input.control || input.meta)) {
        event.preventDefault()
        return
      }
    })

    // Re-apply CSS/emulation on navigation so styles persist
    view.webContents.on('dom-ready', () => {
      const s = views.get(tabId)
      if (!s) return
      s.baseCssKey = null
      ensureBaseCSS(tabId, view)
      if (s.mode === 'emu') {
        ensureDebugger(view, s).then(() => applyEmulation(view, s)).catch(() => {})
      }
    })

    views.set(tabId, {
      view,
      lastIntRect: null,
      frac: { fx: 0, fy: 0 },
      baseCssKey: null,
      dbgAttached: false,
      extraScale: 1,

      // smoothing / mode
      mode: 'native',
      lastAppliedZoom: undefined,
      lastZoomAt: 0,
    })
    attach(win, view)

    try { await view.webContents.loadURL(payload?.url || 'https://google.com/') } catch {}
    return { ok: true, tabId }
  })

  ipcMain.handle('overlay:get-zoom', async () => currentZoom)

  ipcMain.handle('overlay:show', async (_e, { tabId, rect }: { tabId: string; rect: Rect }) => {
    const win = getWindow()
    const { view, state } = resolve(tabId)
    if (!win || !view || !state) return
    const bx = Math.floor(rect.x), by = Math.floor(rect.y)
    const bw = Math.ceil(rect.width), bh = Math.ceil(rect.height)
    state.lastIntRect = { x: bx, y: by, w: bw, h: bh }
    state.frac = { fx: rect.x - bx, fy: rect.y - by }
    attach(win, view)
    view.setBounds({ x: bx, y: by, width: bw, height: bh })
    await ensureBaseCSS(tabId, view)
    await applySubpixel(view, -state.frac.fx, -state.frac.fy)
    if (state.extraScale < 1) {
      await ensureDebugger(view, state)
      await applyEmulation(view, state)
    }
  })

  ipcMain.handle('overlay:set-bounds', async (_e, { tabId, rect }: { tabId: string; rect: Rect }) => {
    const { view, state } = resolve(tabId)
    if (!view || !state) return
    const bx = Math.floor(rect.x), by = Math.floor(rect.y)
    const bw = Math.ceil(rect.width), bh = Math.ceil(rect.height)
    const changed = !state.lastIntRect ||
      bx !== state.lastIntRect.x || by !== state.lastIntRect.y ||
      bw !== state.lastIntRect.w || bh !== state.lastIntRect.h
    if (changed) {
      state.lastIntRect = { x: bx, y: by, w: bw, h: bh }
      try { view.setBounds({ x: bx, y: by, width: bw, height: bh }) } catch {}
      if (state.extraScale < 1) {
        await ensureDebugger(view, state)
        await applyEmulation(view, state)
      }
    }
    state.frac = { fx: rect.x - bx, fy: rect.y - by }
    await applySubpixel(view, -state.frac.fx, -state.frac.fy)
  })

  ipcMain.handle('overlay:set-zoom', async (_e, { tabId, factor }: { tabId: string; factor: number }) => {
    const { view, state } = resolve(tabId)
    if (!view || !state) return

    // throttle
    const now = Date.now()
    if (state.lastZoomAt && now - state.lastZoomAt < ZOOM_MIN_INTERVAL_MS) return
    state.lastZoomAt = now

    // apply ratio, clamp & quantize
    let target = clamp((factor || 1) * ZOOM_RATIO, MIN_EFFECTIVE_ZOOM, CHROME_MAX)
    target = Math.round(target / ZOOM_QUANTUM) * ZOOM_QUANTUM

    // deadband vs last applied
    if (state.lastAppliedZoom && Math.abs(target - state.lastAppliedZoom) < ZOOM_EPS * Math.max(1, state.lastAppliedZoom)) {
      return
    }

    // decide mode with hysteresis around CHROME_MIN
    const wantNative = state.mode === 'emu'
      ? target >= (CHROME_MIN + MODE_HYST)
      : target >= CHROME_MIN

    if (wantNative) {
      // switch from emulation if needed
      if (state.mode !== 'native') {
        state.mode = 'native'
        state.extraScale = 1
        await clearEmulation(view, state)
      }
      try { await view.webContents.setZoomFactor(target) } catch {}
      state.lastAppliedZoom = target
      currentZoom = target
    } else {
      // emulation path below CHROME_MIN
      const extra = target / CHROME_MIN
      const extraQ = Math.max(0.01, Math.round(extra / ZOOM_QUANTUM) * ZOOM_QUANTUM)

      if (state.mode !== 'emu') {
        state.mode = 'emu'
        try { await view.webContents.setZoomFactor(CHROME_MIN) } catch {}
        await ensureDebugger(view, state)
      }

      if (Math.abs((state.extraScale ?? 1) - extraQ) >= ZOOM_EPS * Math.max(1, state.extraScale ?? 1)) {
        state.extraScale = extraQ
        await applyEmulation(view, state)
      }

      state.lastAppliedZoom = target
      currentZoom = target
    }

    await ensureBaseCSS(tabId, view)
    await applySubpixel(view, -state.frac.fx, -state.frac.fy)
  })

  ipcMain.handle('overlay:hide', async (_e, { tabId }: { tabId: string }) => {
    const win = getWindow()
    const { view } = resolve(tabId)
    if (!win || !view) return
    detach(win, view)
  })

    ipcMain.handle('overlay:destroy', async (_e, { tabId }: { tabId: string }) => {
    const win = getWindow()
    const { view, state } = resolve(tabId)
    if (win && view) {
      try { if (state?.dbgAttached) { try { await view.webContents.debugger.detach() } catch {} } }
      finally { detach(win, view) }
    }
    views.delete(tabId)
  })


  ipcMain.handle('overlay:focus', async (_e, p?: { tabId?: string }) => {
    const { view } = resolve(p?.tabId ?? null)
    if (view) try { view.webContents.focus() } catch {}
  })
  ipcMain.handle('overlay:blur', async () => {
    const win = getWindow()
    if (win) try { win.webContents.focus() } catch {}
  })
}
