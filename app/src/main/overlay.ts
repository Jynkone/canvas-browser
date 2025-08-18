import { BrowserWindow, WebContentsView, ipcMain, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import type { NavigationState } from '../types/overlay'

type Rect = { x: number; y: number; width: number; height: number }

type ViewState = {
  view: WebContentsView
  lastBounds: { x: number; y: number; w: number; h: number } | null
  lastAppliedZoom?: number
  navigationState: NavigationState
}

// Type guard to check if WebContents has debugger API
function hasDebuggerAPI(webContents: Electron.WebContents): webContents is Electron.WebContents & {
  debugger: {
    attach(protocolVersion?: string): void
    isAttached(): boolean
    detach(): void
    sendCommand(method: string, commandParams?: any): Promise<any>
  }
} {
  return webContents && typeof (webContents as any).debugger === 'object'
}

const CHROME_MIN = 0.25
const CHROME_MAX = 5
const ZOOM_RATIO = 0.8 // breathing room
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

// Raw canvas zoom from renderer; effective = canvasZoom * ZOOM_RATIO (no compounding)
let canvasZoom = 1

type CreateTabPayload = { url?: string }
type ShowPayload = { tabId: string; rect: Rect }
type SetBoundsPayload = { tabId: string; rect: Rect }
type SetZoomPayload = { tabId?: string; factor: number }
type TabIdPayload = { tabId: string }
type FocusPayload = { tabId?: string }
type NavigatePayload = { tabId: string; url: string }

// Result types
type CreateTabResult = { ok: boolean; tabId?: string }
type CaptureResult = { ok: boolean; dataUrl?: string }
type NavigationResult = { ok: boolean }
type NavigationStateResult = {
  ok: boolean
  currentUrl?: string
  canGoBack?: boolean
  canGoForward?: boolean
  title?: string
  isLoading?: boolean
}


// Validation functions
function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

function sanitizeUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return 'about:blank'
  
  // Add protocol if missing
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://') && !trimmed.startsWith('about:')) {
    return `https://${trimmed}`
  }
  
  return trimmed
}

export function setupOverlayIPC(getWindow: () => BrowserWindow | null): void {
  const views = new Map<string, ViewState>()

  const resolve = (id?: string | null): { view: WebContentsView | null; state: ViewState | null } => {
    if (id && views.has(id)) {
      const s = views.get(id)!
      return { view: s.view, state: s }
    }
    return { view: null, state: null }
  }

  // Views API attach/detach with error handling
  const attach = (win: BrowserWindow, view: WebContentsView): void => {
    try {
      win.contentView.addChildView(view)
    } catch (error) {
      console.error('[overlay] Failed to attach view:', error)
    }
  }

  const detach = (win: BrowserWindow, view: WebContentsView): void => {
    try {
      win.contentView.removeChildView(view)
    } catch (error) {
      console.error('[overlay] Failed to detach view:', error)
    }
  }

  const currentEff = (): number => clamp((canvasZoom || 1) * ZOOM_RATIO, 0.05, CHROME_MAX)

  async function clearEmuIfAny(view: WebContentsView): Promise<void> {
  try {
    const wc = view.webContents
    if (wc.isDestroyed()) return
    if (!hasDebuggerAPI(wc)) return

    if (wc.debugger.isAttached()) {
      try {
        await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride', {})
      } catch (err: any) {
        const msg = String(err?.message || err)
        // Swallow the common navigation race
        if (!msg.includes('target closed')) {
          console.error('[overlay] Failed to clear emulation:', err)
        }
      } finally {
        try { wc.debugger.detach() } catch {}
      }
    }
  } catch (error) {
    console.error('[overlay] clearEmuIfAny outer error:', error)
  }
}


  // Apply one effective zoom to a view (native >= 0.25; minimal emu below)
  async function setEff(view: WebContentsView, eff: number): Promise<void> {
  const wc = view.webContents
  if (wc.isDestroyed()) return

  // ≥ native minimum: no emulation
  if (eff >= CHROME_MIN) {
    try {
      await wc.setZoomFactor(eff)
      await clearEmuIfAny(view)
    } catch (error) {
      console.error('[overlay] Failed to set zoom factor:', error)
    }
    return
  }

  // < native minimum: use device-metrics emulation
  try {
    await wc.setZoomFactor(CHROME_MIN)
  } catch (error) {
    console.error('[overlay] Failed to set minimum zoom factor:', error)
    return
  }

  // one-shot sender with optional retry on "target closed"
  const apply = async (): Promise<void> => {
    if (wc.isDestroyed()) return
    if (!hasDebuggerAPI(wc)) {
      console.warn('[overlay] Cannot use emulation: WebContents lacks debugger API')
      return
    }
    if (!wc.debugger.isAttached()) {
      try { wc.debugger.attach('1.3') } catch (e) {
        const msg = String((e as any)?.message || e)
        if (!msg.includes('Already attached')) {
          console.error('[overlay] debugger.attach failed:', e)
          return
        }
      }
    }

    const scale = Math.max(0.05, Math.min(1, eff / CHROME_MIN))
    const b = view.getBounds()
    const emuW = Math.max(1, Math.floor(b.width / scale))
    const emuH = Math.max(1, Math.floor(b.height / scale))

    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: emuW,
      height: emuH,
      deviceScaleFactor: 0,
      scale,
      mobile: false,
      screenWidth: emuW,
      screenHeight: emuH,
      positionX: 0,
      positionY: 0,
      dontSetVisibleSize: false,
    })
  }

  try {
    await apply()
  } catch (err: any) {
    const msg = String(err?.message || err)
    if (msg.includes('target closed')) {
      // target died during nav; try once more
      try { await apply() } catch (err2) {
        if (!String((err2 as any)?.message || err2).includes('target closed')) {
          console.error('[overlay] Emulation retry failed:', err2)
        }
      }
    } else {
      console.error('[overlay] Failed to set device emulation:', err)
    }
  }
}


  // Reapply exact current effective zoom (no animations)
  async function reapplyNoAnim(view: WebContentsView, state: ViewState): Promise<void> {
    const eff = currentEff()
    await setEff(view, eff)
    state.lastAppliedZoom = eff
  }

  // Update navigation state for a view
    function updateNavigationState(view: WebContentsView, state: ViewState): void {
    try {
      const wc = view.webContents
      state.navigationState = {
        currentUrl: wc.getURL() || 'about:blank',
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        title: wc.getTitle() || ''
      }
    } catch (error) {
      console.error('[overlay] Failed to update navigation state:', error)
    }
  }

  // Validation functions for payloads
  function isValidCreateTabPayload(payload: unknown): payload is CreateTabPayload {
    return payload === undefined || payload === null || 
           (typeof payload === 'object' && payload !== null && 
            (payload as any).url === undefined || typeof (payload as any).url === 'string')
  }

  function isValidShowPayload(payload: unknown): payload is ShowPayload {
    return typeof payload === 'object' && payload !== null &&
           typeof (payload as any).tabId === 'string' &&
           typeof (payload as any).rect === 'object' && (payload as any).rect !== null &&
           typeof (payload as any).rect.x === 'number' &&
           typeof (payload as any).rect.y === 'number' &&
           typeof (payload as any).rect.width === 'number' &&
           typeof (payload as any).rect.height === 'number'
  }

  function isValidSetBoundsPayload(payload: unknown): payload is SetBoundsPayload {
    return isValidShowPayload(payload) // Same validation as ShowPayload
  }

  function isValidSetZoomPayload(payload: unknown): payload is SetZoomPayload {
    return typeof payload === 'object' && payload !== null &&
           typeof (payload as any).factor === 'number' &&
           ((payload as any).tabId === undefined || typeof (payload as any).tabId === 'string')
  }

  function isValidTabIdPayload(payload: unknown): payload is TabIdPayload {
    return typeof payload === 'object' && payload !== null &&
           typeof (payload as any).tabId === 'string'
  }

  function isValidFocusPayload(payload: unknown): payload is FocusPayload {
    return payload === undefined || payload === null ||
           (typeof payload === 'object' && payload !== null &&
            ((payload as any).tabId === undefined || typeof (payload as any).tabId === 'string'))
  }

  function isValidNavigatePayload(payload: unknown): payload is NavigatePayload {
    return typeof payload === 'object' && payload !== null &&
           typeof (payload as any).tabId === 'string' &&
           typeof (payload as any).url === 'string'
  }

  // ----------------------------- IPC -----------------------------

  ipcMain.handle('overlay:create-tab', async (_event: IpcMainInvokeEvent, payload?: unknown): Promise<CreateTabResult> => {
    if (!isValidCreateTabPayload(payload)) {
      console.error('[overlay] Invalid create-tab payload:', payload)
      return { ok: false }
    }

    const win = getWindow()
    if (!win) {
      console.error('[overlay] No window available for create-tab')
      return { ok: false }
    }

    const tabId = randomUUID()
    let view: WebContentsView

    try {
      view = new WebContentsView({
        webPreferences: {
          devTools: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        }
      })
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    } catch (error) {
      console.error('[overlay] Failed to create WebContentsView:', error)
      return { ok: false }
    }

    // Lock user page-zoom (we control it centrally)
    try {
      view.webContents.setZoomFactor(1)
      view.webContents.setVisualZoomLevelLimits(1, 1)
    } catch (error) {
      console.error('[overlay] Failed to set zoom limits:', error)
    }

    const initialUrl = sanitizeUrl(payload?.url || 'https://google.com/')
    const state: ViewState = { 
      view, 
      lastBounds: null, 
      lastAppliedZoom: undefined,
      navigationState: {
        currentUrl: initialUrl,
        canGoBack: false,
        canGoForward: false,
        title: ''
      }
    }
    views.set(tabId, state)

    // Keep zoom consistent across navigations (reapply exact current eff, no compounding)
    const reapply = (): void => {
      reapplyNoAnim(view, state).catch(error => {
        console.error('[overlay] Failed to reapply zoom:', error)
      })
    }

    // Navigation event listeners
    const updateNavState = (): void => {
      updateNavigationState(view, state)
    }

    view.webContents.on('dom-ready', () => {
      reapply()
      updateNavState()
    })
    view.webContents.on('did-navigate', () => {
      reapply()
      updateNavState()
    })
    view.webContents.on('did-navigate-in-page', () => {
      reapply()
      updateNavState()
    })
    view.webContents.on('page-title-updated', updateNavState)

    // Minimal key handling: DevTools toggle + block page zoom combos
    // Enhanced key handling: DevTools toggle, navigation shortcuts, block page zoom combos
    view.webContents.on('before-input-event', (event, input) => {
      const mod = input.control || input.meta
      const key = (input.key || '').toLowerCase()

      if (mod && (key === 't' || key === 'w' || key === 'n' || key === 'q')) {
  event.preventDefault()
  return
}
if (mod && input.shift && key === 'n') {
  event.preventDefault()
  return
}
if (input.key === 'Tab' && (input.control || input.meta)) {
  event.preventDefault()
  return
}
      // DevTools toggle
      if ((key === 'i' && mod && input.shift) || input.key === 'F12') {
        event.preventDefault()
        try {
          if (view.webContents.isDevToolsOpened()) {
            view.webContents.closeDevTools()
          } else {
            view.webContents.openDevTools({ mode: 'detach' })
          }
        } catch (error) {
          console.error('[overlay] Failed to toggle DevTools:', error)
        }
        return
      }

      // Navigation shortcuts
      if (input.alt && key === 'arrowleft') {
        event.preventDefault()
        try {
          if (view.webContents.navigationHistory.canGoBack()) {
            view.webContents.navigationHistory.goBack()
          }
        } catch (error) {
          console.error('[overlay] Failed to go back:', error)
        }
        return
      }

      if (input.alt && key === 'arrowright') {
        event.preventDefault()
        try {
          if (view.webContents.navigationHistory.canGoForward()) {
            view.webContents.navigationHistory.goForward()
          }
        } catch (error) {
          console.error('[overlay] Failed to go forward:', error)
        }
        return
      }

      // Reload shortcuts
      if ((mod && key === 'r') || input.key === 'F5') {
        event.preventDefault()
        try {
          view.webContents.reload()
        } catch (error) {
          console.error('[overlay] Failed to reload:', error)
        }
        return
      }

      // Hard reload
      if (mod && input.shift && key === 'r') {
        event.preventDefault()
        try {
          view.webContents.reloadIgnoringCache()
        } catch (error) {
          console.error('[overlay] Failed to hard reload:', error)
        }
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

    try {
      await view.webContents.loadURL(initialUrl)
    } catch (error) {
      console.error('[overlay] Failed to load URL:', error)
    }

    return { ok: true, tabId }
  })

  ipcMain.handle('overlay:get-zoom', async (): Promise<number> => canvasZoom)

  ipcMain.handle('overlay:show', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<void> => {
    if (!isValidShowPayload(payload)) {
      console.error('[overlay] Invalid show payload:', payload)
      return
    }

    const win = getWindow()
    const { view, state } = resolve(payload.tabId)
    if (!win || !view || !state) {
      console.error('[overlay] Invalid window, view, or state for show')
      return
    }

    const x = Math.floor(payload.rect.x)
    const y = Math.floor(payload.rect.y)
    const w = Math.ceil(payload.rect.width)
    const h = Math.ceil(payload.rect.height)
    
    state.lastBounds = { x, y, w, h }
    attach(win, view)
    
    try {
      view.setBounds({ x, y, width: w, height: h })
    } catch (error) {
      console.error('[overlay] Failed to set bounds:', error)
    }

    if (currentEff() < CHROME_MIN) {
      await reapplyNoAnim(view, state) // emu needs bounds
    }
  })

  ipcMain.handle('overlay:set-bounds', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<void> => {
    if (!isValidSetBoundsPayload(payload)) {
      console.error('[overlay] Invalid set-bounds payload:', payload)
      return
    }

    const { view, state } = resolve(payload.tabId)
    if (!view || !state) {
      console.error('[overlay] Invalid view or state for set-bounds')
      return
    }
    
    const x = Math.floor(payload.rect.x)
    const y = Math.floor(payload.rect.y)
    const w = Math.ceil(payload.rect.width)
    const h = Math.ceil(payload.rect.height)
    const b = state.lastBounds
    
    if (!b || x !== b.x || y !== b.y || w !== b.w || h !== b.h) {
      state.lastBounds = { x, y, w, h }
      try {
        view.setBounds({ x, y, width: w, height: h })
      } catch (error) {
        console.error('[overlay] Failed to set bounds:', error)
      }
      
      if (currentEff() < CHROME_MIN) {
        await reapplyNoAnim(view, state)
      }
    }
  })

  // Renderer tells us the raw canvas zoom; compute effective once and push (no animation)
  ipcMain.handle('overlay:set-zoom', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<void> => {
    if (!isValidSetZoomPayload(payload)) {
      console.error('[overlay] Invalid set-zoom payload:', payload)
      return
    }

    canvasZoom = payload.factor || 1
    const target = currentEff()

    if (payload.tabId) {
      const { view, state } = resolve(payload.tabId)
      if (!view || !state) {
        console.error('[overlay] Invalid view or state for set-zoom')
        return
      }
      await setEff(view, target)
      state.lastAppliedZoom = target
    } else {
      for (const [, s] of views) {
        await setEff(s.view, target)
        s.lastAppliedZoom = target
      }
    }
  })

  ipcMain.handle('overlay:hide', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<void> => {
    if (!isValidTabIdPayload(payload)) {
      console.error('[overlay] Invalid hide payload:', payload)
      return
    }

    const win = getWindow()
    const { view } = resolve(payload.tabId)
    if (!win || !view) {
      console.error('[overlay] Invalid window or view for hide')
      return
    }
    detach(win, view)
  })

  ipcMain.handle('overlay:get-suggestions', async (_e, payload: unknown) => {
  try {
    if (!payload || typeof (payload as any).q !== 'string') return { ok: false as const }
    const q = (payload as any).q.trim()
    if (!q) return { ok: true as const, suggestions: [] }

    // Google suggest (Chrome client). Returns: [query, [suggestions...], …]
    const url = `https://suggestqueries.google.com/complete/search?client=chrome&hl=en&q=${encodeURIComponent(q)}`
    const res = await fetch(url, {
      // UA helps keep the response in the expected format
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120 Safari/537.36' }
    })
    if (!res.ok) return { ok: true as const, suggestions: [] }

    const data = await res.json() as [string, string[]]
    const suggestions = Array.isArray(data?.[1]) ? data[1].slice(0, 8) : []
    return { ok: true as const, suggestions }
  } catch {
    return { ok: true as const, suggestions: [] }
  }
})


  ipcMain.handle('overlay:destroy', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<void> => {
    // Destroy must work no matter what - be permissive with validation
    let tabId: string
    if (typeof payload === 'object' && payload !== null && typeof (payload as any).tabId === 'string') {
      tabId = (payload as any).tabId
    } else {
      console.error('[overlay] Invalid destroy payload, but attempting cleanup anyway:', payload)
      // Try to clean up all views if we can't identify specific one
      for (const [id, state] of views) {
        try {
          const win = getWindow()
          if (win && state.view) {
            await clearEmuIfAny(state.view)
            detach(win, state.view)
            try { state.view.webContents.stop() } catch {}
            try { state.view.webContents.setAudioMuted(true) } catch {}
            try { (state.view.webContents as any).destroy() } catch {}
          }
        } catch {}
        views.delete(id)
      }
      return
    }

    const win = getWindow()
    const { view } = resolve(tabId)
    
    // Clean up this specific view
    if (view) {
      try {
        await clearEmuIfAny(view)
        if (win) detach(win, view)
        
        try {
          view.webContents.stop()
        } catch (error) {
          console.error('[overlay] Failed to stop web contents:', error)
        }
        
        try {
          view.webContents.setAudioMuted(true)
        } catch (error) {
          console.error('[overlay] Failed to mute audio:', error)
        }
        
        // Force destroy using type assertion since this must work
        try {
          (view.webContents as any).destroy()
        } catch (error) {
          console.error('[overlay] Failed to destroy web contents:', error)
        }
      } catch (error) {
        console.error('[overlay] Error during view cleanup:', error)
      } finally {
        // Always remove from views map
        for (const [k, s] of views) {
          if (s.view === view) {
            views.delete(k)
            break
          }
        }
      }
    } else {
      // View not found but still try to clean up by tabId
      views.delete(tabId)
    }
  })

  ipcMain.handle('overlay:capture', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<CaptureResult> => {
    if (!isValidTabIdPayload(payload)) {
      console.error('[overlay] Invalid capture payload:', payload)
      return { ok: false }
    }

    const { view } = resolve(payload.tabId)
    if (!view) {
      console.error('[overlay] Invalid view for capture')
      return { ok: false }
    }
    
    try {
      const image = await view.webContents.capturePage()
      const png = image.toPNG({ scaleFactor: 1 })
      const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
      return { ok: true, dataUrl }
    } catch (error) {
      console.error('[overlay] Failed to capture page:', error)
      return { ok: false }
    }
  })

  ipcMain.handle('overlay:focus', async (_event: IpcMainInvokeEvent, payload?: unknown): Promise<void> => {
    if (!isValidFocusPayload(payload)) {
      console.error('[overlay] Invalid focus payload:', payload)
      return
    }

    const { view } = resolve(payload?.tabId ?? null)
    if (view) {
      try {
        view.webContents.focus()
      } catch (error) {
        console.error('[overlay] Failed to focus web contents:', error)
      }
    }
  })
  
  ipcMain.handle('overlay:blur', async (): Promise<void> => {
    const win = getWindow()
    if (win) {
      try {
        win.webContents.focus()
      } catch (error) {
        console.error('[overlay] Failed to focus main window:', error)
      }
    }
  })

  // Navigation IPC handlers
  ipcMain.handle('overlay:navigate', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<NavigationResult> => {
    if (!isValidNavigatePayload(payload)) {
      console.error('[overlay] Invalid navigate payload:', payload)
      return { ok: false }
    }

    const { view, state } = resolve(payload.tabId)
    if (!view || !state) {
      console.error('[overlay] Invalid view or state for navigate')
      return { ok: false }
    }

    const sanitizedUrl = sanitizeUrl(payload.url)
    if (!isValidUrl(sanitizedUrl)) {
      console.error('[overlay] Invalid URL for navigate:', sanitizedUrl)
      return { ok: false }
    }

    try {
      await view.webContents.loadURL(sanitizedUrl)
      // Navigation state will be updated via event listeners
      return { ok: true }
    } catch (error) {
      console.error('[overlay] Failed to navigate:', error)
      return { ok: false }
    }
  })

  ipcMain.handle('overlay:go-back', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<NavigationResult> => {
    if (!isValidTabIdPayload(payload)) {
      console.error('[overlay] Invalid go-back payload:', payload)
      return { ok: false }
    }

    const { view, state } = resolve(payload.tabId)
    if (!view || !state) {
      console.error('[overlay] Invalid view or state for go-back')
      return { ok: false }
    }

    if (!state.navigationState.canGoBack) {
      return { ok: false }
    }

    try {
      view.webContents.navigationHistory.goBack()
      return { ok: true }
    } catch (error) {
      console.error('[overlay] Failed to go back:', error)
      return { ok: false }
    }
  })

ipcMain.handle('overlay:go-forward', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<NavigationResult> => {
    if (!isValidTabIdPayload(payload)) {
      console.error('[overlay] Invalid go-forward payload:', payload)
      return { ok: false }
    }

    const { view, state } = resolve(payload.tabId)
    if (!view || !state) {
      console.error('[overlay] Invalid view or state for go-forward')
      return { ok: false }
    }

    if (!state.navigationState.canGoForward) {
      return { ok: false }
    }

    try {
      view.webContents.navigationHistory.goForward()
      return { ok: true }
    } catch (error) {
      console.error('[overlay] Failed to go forward:', error)
      return { ok: false }
    }
  })
  ipcMain.handle('overlay:reload', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<NavigationResult> => {
    if (!isValidTabIdPayload(payload)) {
      console.error('[overlay] Invalid reload payload:', payload)
      return { ok: false }
    }

    const { view } = resolve(payload.tabId)
    if (!view) {
      console.error('[overlay] Invalid view for reload')
      return { ok: false }
    }

    try {
      view.webContents.reload()
      return { ok: true }
    } catch (error) {
      console.error('[overlay] Failed to reload:', error)
      return { ok: false }
    }
  })

  ipcMain.handle('overlay:get-navigation-state', async (_event: IpcMainInvokeEvent, payload: unknown): Promise<NavigationStateResult> => {
    if (!isValidTabIdPayload(payload)) {
      console.error('[overlay] Invalid get-navigation-state payload:', payload)
      return { ok: false }
    }

    const { state } = resolve(payload.tabId)
    if (!state) {
      console.error('[overlay] Invalid state for get-navigation-state')
      return { ok: false }
    }

    return {
      ok: true,
      currentUrl: state.navigationState.currentUrl,
      canGoBack: state.navigationState.canGoBack,
      canGoForward: state.navigationState.canGoForward,
      title: state.navigationState.title,

      isLoading: (() => {
    try {
      return state.view.webContents.isLoading()
    } catch {
      return false
    }
  })(),

    }
  })
}