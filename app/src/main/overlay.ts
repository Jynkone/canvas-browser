// overlay.ts — lean & mean (no animations), Electron 37 supported APIs
// Uses WebContentsView + Views hierarchy. One global zoom = canvasZoom * 0.8.
// Consistent across sites: native zoom when >= 0.25, minimal emulation below 0.25.

import { BrowserWindow, WebContentsView, ipcMain, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'

type Rect = { x: number; y: number; width: number; height: number }

type ViewState = {
  view: WebContentsView
  lastBounds: { x: number; y: number; w: number; h: number } | null
  lastAppliedZoom?: number
}

// Type for WebContents with debugger API (avoiding interface extension issues)
type WebContentsWithDebugger = Electron.WebContents & {
  debugger: {
    attach(protocolVersion?: string): void
    isAttached(): boolean
    detach(): void
    sendCommand(method: string, commandParams?: any): Promise<any>
  }
  destroy(): void
}

const CHROME_MIN = 0.25
const CHROME_MAX = 5
const ZOOM_RATIO = 0.8 // breathing room
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// Raw canvas zoom from renderer; effective = canvasZoom * ZOOM_RATIO (no compounding)
let canvasZoom = 1

export function setupOverlayIPC(getWindow: () => BrowserWindow | null) {
  const views = new Map<string, ViewState>()

  const resolve = (id?: string | null) => {
    if (id && views.has(id)) {
      const s = views.get(id)!
      return { view: s.view, state: s }
    }
    return { view: null as unknown as WebContentsView | null, state: null as unknown as ViewState | null }
  }

  // Views API attach/detach
  const attach = (win: BrowserWindow, view: WebContentsView) => { try { win.contentView.addChildView(view) } catch {} }
  const detach = (win: BrowserWindow, view: WebContentsView) => { try { win.contentView.removeChildView(view) } catch {} }

  const currentEff = () => clamp((canvasZoom || 1) * ZOOM_RATIO, 0.05, CHROME_MAX)

  async function clearEmuIfAny(view: WebContentsView) {
    try {
      const wc = view.webContents as WebContentsWithDebugger
      if (wc.debugger.isAttached()) {
        await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride', {})
        wc.debugger.detach()
      }
    } catch {}
  }

  // Apply one effective zoom to a view (native >= 0.25; minimal emu below)
  async function setEff(view: WebContentsView, eff: number) {
    if (eff >= CHROME_MIN) {
      try { await view.webContents.setZoomFactor(eff) } catch {}
      await clearEmuIfAny(view)
      return
    }
    // eff < 0.25 → keep Chromium at 0.25 and emulate remaining scale
    try { await view.webContents.setZoomFactor(CHROME_MIN) } catch {}
    try {
      const wc = view.webContents as WebContentsWithDebugger
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      const scale = Math.max(0.05, Math.min(1, eff / CHROME_MIN))
      const b = view.getBounds()
      const emuW = Math.max(1, Math.floor(b.width / scale))
      const emuH = Math.max(1, Math.floor(b.height / scale))
      await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: emuW, height: emuH, deviceScaleFactor: 0, scale,
        mobile: false, screenWidth: emuW, screenHeight: emuH,
        positionX: 0, positionY: 0, dontSetVisibleSize: false,
      })
    } catch {}
  }

  // Reapply exact current effective zoom (no animations)
  async function reapplyNoAnim(view: WebContentsView, state: ViewState) {
    const eff = currentEff()
    await setEff(view, eff)
    state.lastAppliedZoom = eff
  }

  // ----------------------------- IPC -----------------------------

  ipcMain.handle('overlay:create-tab', async (_event: IpcMainInvokeEvent, payload?: { url?: string }) => {
    const win = getWindow()
    if (!win) return { ok: false }

    const tabId = randomUUID()
    const view = new WebContentsView({
      webPreferences: {
        devTools: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      }
    })

    // Lock user page-zoom (we control it centrally)
    try {
      view.webContents.setZoomFactor(1)
      view.webContents.setVisualZoomLevelLimits(1, 1)
    } catch {}

    const state: ViewState = { view, lastBounds: null, lastAppliedZoom: undefined }
    views.set(tabId, state)

    // Keep zoom consistent across navigations (reapply exact current eff, no compounding)
    const reapply = () => reapplyNoAnim(view, state)
    view.webContents.on('dom-ready', reapply)
    view.webContents.on('did-navigate', reapply)
    view.webContents.on('did-navigate-in-page', reapply)

    // Minimal key handling: DevTools toggle + block page zoom combos
    view.webContents.on('before-input-event', (event, input) => {
      const mod = input.control || input.meta
      const key = (input.key || '').toLowerCase()

      // DevTools
      if ((key === 'i' && mod && input.shift) || input.key === 'F12') {
        event.preventDefault()
        if (view.webContents.isDevToolsOpened()) view.webContents.closeDevTools()
        else view.webContents.openDevTools({ mode: 'detach' })
        return
      }

      // Block page zoom shortcuts; renderer owns canvasZoom
      if (mod && (key === '=' || key === '+' || key === '-' || key === '_' || key === '0')) {
        event.preventDefault()
        return
      }
      if (input.type === 'mouseWheel' && (input.control || input.meta)) {
        event.preventDefault()
      }
    })

    attach(win, view)

    // Apply current global zoom immediately (no animation)
    await reapplyNoAnim(view, state)

    try { await view.webContents.loadURL(payload?.url || 'https://google.com/') } catch {}
    return { ok: true, tabId }
  })

  ipcMain.handle('overlay:get-zoom', async () => canvasZoom)

  ipcMain.handle('overlay:show', async (_event: IpcMainInvokeEvent, { tabId, rect }: { tabId: string; rect: Rect }) => {
    const win = getWindow()
    const { view, state } = resolve(tabId)
    if (!win || !view || !state) return
    const x = Math.floor(rect.x), y = Math.floor(rect.y)
    const w = Math.ceil(rect.width), h = Math.ceil(rect.height)
    state.lastBounds = { x, y, w, h }
    attach(win, view)
    try { view.setBounds({ x, y, width: w, height: h }) } catch {}
    if (currentEff() < CHROME_MIN) await reapplyNoAnim(view, state) // emu needs bounds
  })

  ipcMain.handle('overlay:set-bounds', async (
    _event: IpcMainInvokeEvent, 
    { tabId, rect }: { tabId: string; rect: Rect }
  ) => {
    const { view, state } = resolve(tabId)
    if (!view || !state) return
    
    const x = Math.floor(rect.x), y = Math.floor(rect.y)
    const w = Math.ceil(rect.width), h = Math.ceil(rect.height)
    const b = state.lastBounds
    if (!b || x !== b.x || y !== b.y || w !== b.w || h !== b.h) {
      state.lastBounds = { x, y, w, h }
      try { view.setBounds({ x, y, width: w, height: h }) } catch {}
      if (currentEff() < CHROME_MIN) await reapplyNoAnim(view, state)
    }
  })

  // Renderer tells us the raw canvas zoom; compute effective once and push (no animation)
  ipcMain.handle('overlay:set-zoom', async (
    _event: IpcMainInvokeEvent, 
    { tabId, factor }: { tabId?: string; factor: number }
  ) => {
    canvasZoom = factor || 1
    const target = currentEff()

    if (tabId) {
      const { view, state } = resolve(tabId)
      if (!view || !state) return
      await setEff(view, target)
      state.lastAppliedZoom = target
    } else {
      for (const [, s] of views) {
        await setEff(s.view, target)
        s.lastAppliedZoom = target
      }
    }
  })

  ipcMain.handle('overlay:hide', async (_event: IpcMainInvokeEvent, { tabId }: { tabId: string }) => {
    const win = getWindow()
    const { view } = resolve(tabId)
    if (!win || !view) return
    detach(win, view)
  })

  ipcMain.handle('overlay:destroy', async (_event: IpcMainInvokeEvent, { tabId }: { tabId: string }) => {
    const win = getWindow()
    const { view } = resolve(tabId)
    if (win && view) {
      try {
        await clearEmuIfAny(view)
        detach(win, view)
        try { view.webContents.stop() } catch {}
        try { view.webContents.setAudioMuted(true) } catch {}
        // FIXED: Properly typed destroy method
        try { (view.webContents as WebContentsWithDebugger).destroy() } catch {}
      } finally {
        for (const [k, s] of views) if (s.view === view) { views.delete(k); break }
      }
    }
  })

  ipcMain.handle('overlay:capture', async (_event: IpcMainInvokeEvent, { tabId }: { tabId: string }) => {
    const { view } = resolve(tabId)
    if (!view) return { ok: false }
    try {
      const image = await view.webContents.capturePage()
      const png = image.toPNG({ scaleFactor: 1 })
      const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
      return { ok: true, dataUrl }
    } catch { return { ok: false } }
  })

  ipcMain.handle('overlay:focus', async (_event: IpcMainInvokeEvent, p?: { tabId?: string }) => {
    const { view } = resolve(p?.tabId ?? null)
    if (view) try { view.webContents.focus() } catch {}
  })
  
  ipcMain.handle('overlay:blur', async () => {
    const win = getWindow()
    if (win) try { win.webContents.focus() } catch {}
  })
}