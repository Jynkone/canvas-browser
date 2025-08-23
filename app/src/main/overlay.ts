import { BrowserWindow, WebContentsView, ipcMain, Menu  } from 'electron'
import type { Debugger as ElectronDebugger, Input } from 'electron'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

type Rect = { x: number; y: number; width: number; height: number }

type ViewState = {
  view: WebContentsView
  attached: boolean
  lastBounds: { x: number; y: number; w: number; h: number }
  lastAppliedZoom?: number
  lastAppliedZoomKey?: ZoomBucket
  lastAppliedEmu?: { w: number; h: number }
  pendingBucket?: ZoomBucket | null
  emuTimer?: ReturnType<typeof setTimeout> | null
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

type ZoomBucket = 5 | 10 | 15 | 20
const EPS = 1e-6

function effToBucketKey(eff: number): ZoomBucket {
  const pct = eff * 100
  const floor5 = Math.floor((pct + EPS) / 5) * 5   // [5,10) => 5, [10,15) => 10, etc.
  const clamped = Math.max(5, Math.min(20, floor5)) // 5..20 only; 25 handled by native
  return clamped as ZoomBucket
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

scheduleEmu(state: ViewState) {
  if (state.emuTimer) return
  state.emuTimer = setTimeout(() => {
    state.emuTimer = null
    const bucket = state.pendingBucket
    if (bucket == null) return
    state.pendingBucket = null
    // One single apply for this step, using the latest bounds
    S.setEff(state.view, bucket / 100, state)
    state.lastAppliedZoom = bucket / 100
  }, 0)
},


// add force?: boolean
setEff(view: WebContentsView, eff: number, state?: ViewState) {
  // Native (>= 25%): clear emulation once and use Chrome zoom
  if (eff >= CHROME_MIN) {
    if (state?.lastAppliedZoomKey !== undefined) {
      try { S.clearEmuIfAny(view) } catch {}
      state.lastAppliedZoomKey = undefined
      if (state) state.lastAppliedEmu = undefined
    }
    try { view.webContents.setZoomFactor(eff) } catch {}
    return
  }

  // ---- Emulation path (< 25%): exact 5 / 15 / 20 only ----
  const bucket = effToBucketKey(eff) // 5 | 15 | 20

  // Current view bounds
  let b: { width: number; height: number }
  try { b = view.getBounds() } catch { return }
  if (b.width <= 0 || b.height <= 0) return

  // Compute emu dims using the *bottom of the bucket* so it still fits at 5/15/20
  const bucketEff = bucket / 100                // 0.05, 0.15, 0.20
  const currentEff = Math.max(0.001, Math.min(eff, CHROME_MIN)) // defensive clamp
  const shrinkToBottom = Math.min(1, bucketEff / currentEff)    // <= 1

  // Future minimal bounds at the bottom of this bucket
  const targetW = Math.max(1, Math.floor(b.width  * shrinkToBottom))
  const targetH = Math.max(1, Math.floor(b.height * shrinkToBottom))

  // Emulation scale to achieve bucketEff while Chrome is held at CHROME_MIN
  const scale = bucketEff / CHROME_MIN          // e.g. 0.05 / 0.25 = 0.20 at 5%

  // FLOOR so rendered content never exceeds (future) bounds — 5% always fits
  const emuW = Math.max(1, Math.floor(targetW / scale))
  const emuH = Math.max(1, Math.floor(targetH / scale))

  // Skip if nothing changes (same bucket AND same emu dims)
  const sameBucket = state?.lastAppliedZoomKey === bucket
  const sameDims = state?.lastAppliedEmu?.w === emuW && state?.lastAppliedEmu?.h === emuH
  if (sameBucket && sameDims) return

  // Hold Chrome at its minimum native zoom while emulating below it
  try { view.webContents.setZoomFactor(CHROME_MIN) } catch {}

  try {
    const dbg: ElectronDebugger = view.webContents.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')

    void dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: emuW,
      height: emuH,
      // Use 1 for determinism (0 = auto DPR, can cause “shifts” on HiDPI)
      deviceScaleFactor: 1,
      scale,
      mobile: false,
      screenWidth:  emuW,
      screenHeight: emuH,
      positionX: 0,
      positionY: 0,
      dontSetVisibleSize: false,
    })

    if (state) {
      state.lastAppliedZoomKey = bucket
      state.lastAppliedEmu = { w: emuW, h: emuH }
    }
  } catch {}
},


reapply(state: ViewState) {
  try {
    const eff = S.currentEff()
    void S.setEff(state.view, eff, state)
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
  

function hasPopupFeatures(features: string): boolean {
  if (!features || typeof features !== 'string') return false
  
  const f = features.toLowerCase()
  return f.includes('width=') || 
         f.includes('height=') ||
         f.includes('menubar=no') ||
         f.includes('toolbar=no') ||
         f.includes('location=no') ||
         f.includes('status=no') ||
         f.includes('scrollbars=no') ||
         f.includes('resizable=no')
}

function shouldStayAsPopup(url: string, features: string): boolean {
  if (!url || typeof url !== 'string') return true // Safe fallback
  
  try {
    const urlLower = url.toLowerCase()
    
    // Auth/OAuth/Payment domains - comprehensive list
    const authDomains = [
      'accounts.google.com',
      'login.microsoftonline.com',
      'github.com/login',
      'api.github.com',
      'facebook.com/dialog',
      'www.facebook.com/dialog',
      'twitter.com/oauth',
      'api.twitter.com/oauth',
      'linkedin.com/oauth',
      'discord.com/oauth2',
      'slack.com/oauth',
      'paypal.com',
      'www.paypal.com',
      'checkout.stripe.com',
      'js.stripe.com',
      'checkout.com',
      'square.com',
      'braintreepayments.com'
    ]
    
    // Auth URL patterns
    const authPatterns = [
      '/oauth/',
      '/oauth2/',
      '/auth/',
      '/login/oauth/',
      '/api/auth/',
      '/sso/',
      '/saml/',
      'oauth2/authorize',
      'oauth/authorize',
      '/signin-',
      '/login?',
      '/authenticate'
    ]
    
    // Check exact domain matches
    const parsedUrl = new URL(url)
    if (authDomains.includes(parsedUrl.hostname)) return true
    
    // Check auth patterns in URL
    if (authPatterns.some(pattern => urlLower.includes(pattern))) return true
    
    // Check query parameters that indicate auth
    if (parsedUrl.searchParams.has('client_id') || 
        parsedUrl.searchParams.has('oauth') ||
        parsedUrl.searchParams.has('auth') ||
        parsedUrl.searchParams.has('response_type') ||
        parsedUrl.searchParams.has('scope')) return true
    
    // Small window size suggests legitimate popup
    if (features && typeof features === 'string') {
      const widthMatch = features.match(/width=(\d+)/)
      const heightMatch = features.match(/height=(\d+)/)
      
      if (widthMatch && heightMatch) {
        const width = parseInt(widthMatch[1])
        const height = parseInt(heightMatch[1])
        
        // Very small windows are likely auth popups
        if (width < 600 && height < 600) return true
        
        // Tiny windows are definitely popups
        if (width < 400 || height < 400) return true
      }
    }
    
    return false
  } catch (error) {
    console.warn('[popup-detection] Error parsing URL:', url, error)
    return true // Safe fallback - keep as popup if we can't parse
  }
}


type PopupKey = `${string}|${string}`; // `${openerTabId}|${url}`

enum PopupState {
  None = 0,
  Requested = 1,     // main sent event to renderer
  Materialized = 2,  // renderer confirmed it created a shape
}

const popupStates = new Map<PopupKey, PopupState>();

function pk(openerTabId: string, url: string): PopupKey {
  return `${openerTabId}|${url}`;
}

/** First time? lock & return true; already seen? return false. */
function tryRequest(openerTabId: string, url: string): boolean {
  const k = pk(openerTabId, url);
  const st = popupStates.get(k) ?? PopupState.None;
  if (st !== PopupState.None) return false;
  popupStates.set(k, PopupState.Requested);
  return true;
}

/** Renderer says the BrowserShape now exists for this pair. */
function markMaterialized(openerTabId: string, url: string): void {
  popupStates.set(pk(openerTabId, url), PopupState.Materialized);
}

/** Forget all locks for a given opener tab (call on destroy). */
function clearForOpener(openerTabId: string): void {
  for (const k of popupStates.keys()) {
    if (k.startsWith(`${openerTabId}|`)) popupStates.delete(k);
  }
}

/** Emit one popup event to the renderer. */
function emitCanvasPopup(openerTabId: string, url: string): void {
  const win = getWindow();
  const eventId = `${openerTabId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  win?.webContents.send('overlay-popup-request', {
    eventId,
    url,
    parentTabId: openerTabId, // ← match preload contract
  } as { eventId: string; url: string; parentTabId: string })
;
}

function openFromContextMenu(openerTabId: string, url: string): void {
  if (!tryRequest(openerTabId, url)) {
    console.log('[context-open] 🔁 Suppressed duplicate (sticky)')
    return
  }
  console.log('[context-open] 🎯 Emitting canvas popup (sticky)')
  emitCanvasPopup(openerTabId, url)
}


  // -------------------- IPC handlers ---------------------------------------
  ipcMain.handle('overlay:create-tab', async (_e, payload?: { url?: string; shapeId?: string }): Promise<CreateTabResponse> => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return { ok: false, error: 'No window' }
    if (views.size >= MAX_VIEWS) return { ok: false, error: `Too many tabs (${views.size})` }

    if (!startupRestoreComplete) {
      await initializeStartupRestore()
    }

    return enqueue<Ok<{ tabId: string }>>(async () => {
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
            spellcheck: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
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
        view.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

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

        // ADD THIS AFTER THE EXISTING EVENT LISTENERS
view.webContents.setWindowOpenHandler((details) => {
  const { url, features, disposition, referrer } = details

  console.log('[popup-detection]', {
    url,
    features,
    disposition,
    referrer: referrer?.url ?? 'none',
    timestamp: new Date().toISOString(),
  })

  try {
    const isNewWindow = disposition === 'new-window' || disposition === 'foreground-tab'
    const hasFeatures = hasPopupFeatures(features)

    if (isNewWindow || hasFeatures) {
      const shouldStay = shouldStayAsPopup(url, features)
      if (shouldStay) {
        console.log('[popup-detection] ✅ Allowing OS popup')
        return { action: 'allow' }
      }

      const openerTabId = tabId // must be the current tab's id in this scope
      if (!tryRequest(openerTabId, url)) {
        console.log('[popup-detection] 🔁 Suppressed duplicate (sticky)')
        return { action: 'deny' }
      }

      console.log('[popup-detection] 🎯 Emitting canvas popup (sticky)')
      emitCanvasPopup(openerTabId, url)
      return { action: 'deny' }
    }

    console.log('[popup-detection] ➡️ Normal navigation')
    return { action: 'allow' }
  } catch (error) {
    console.error('[popup-detection] Handler error:', error)
    return { action: 'allow' }
  }
})

view.webContents.on('context-menu', (_event, params) => {
  const { linkURL, hasImageContents, isEditable, selectionText, pageURL } = params

  const menuItems: Array<
    | { label: string; click: () => void; enabled?: boolean }
    | { type: 'separator' }
  > = []

    if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
    for (const suggestion of params.dictionarySuggestions) {
      menuItems.push({
        label: suggestion,
        click: () => view.webContents.replaceMisspelling(suggestion),
      })
    }
    menuItems.push({ type: 'separator' })
  }

  // Add "Add to Dictionary" if word is misspelled
  if (params.misspelledWord) {
    menuItems.push({
      label: 'Add to Dictionary',
      click: () => view.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    })
    menuItems.push({ type: 'separator' })
  }


  // Link context menu
  if (linkURL) {
    menuItems.push(
      {
        label: 'Open Link in New Canvas Shape',
        click: () => {
          console.log('[context-menu] Opening link in canvas shape:', linkURL)
          openFromContextMenu(tabId, linkURL)
        },
      },
      {
        label: 'Open Link in New Popup',
        click: () => {
          console.log('[context-menu] Opening link in popup:', linkURL)
          require('electron').shell.openExternal(linkURL)
        },
      },
      {
        label: 'Copy Link Address',
        click: () => {
          require('electron').clipboard.writeText(linkURL)
        },
      },
      { type: 'separator' },
    )
  }

  // Image context menu
  if (hasImageContents) {
    menuItems.push(
      {
        label: 'Copy Image',
        click: () => {
          view.webContents.copyImageAt(params.x, params.y)
        },
      },
      {
        label: 'Save Image As...',
        click: () => {
          view.webContents.downloadURL(params.srcURL)
        },
      },
      { type: 'separator' },
    )
  }

  // Text selection context menu
  if (selectionText) {
    const shortText =
      selectionText.length > 20 ? `${selectionText.substring(0, 20)}...` : selectionText

    menuItems.push(
      {
        label: 'Copy',
        click: () => {
          view.webContents.copy()
        },
      },
      {
        label: `Search "${shortText}"`,
        click: () => {
          const url = `https://www.google.com/search?q=${encodeURIComponent(selectionText)}`
          openFromContextMenu(tabId, url) // <- define & use inside handler
        },
      },
      { type: 'separator' },
    )
  }

  // Editable context menu
  if (isEditable) {
    menuItems.push(
      {
        label: 'Cut',
        click: () => view.webContents.cut(),
        enabled: !!selectionText,
      },
      {
        label: 'Copy',
        click: () => view.webContents.copy(),
        enabled: !!selectionText,
      },
      {
        label: 'Paste',
        click: () => view.webContents.paste(),
      },
      { type: 'separator' },
    )
  }

  // Page context menu
  menuItems.push(
    {
      label: 'Back',
      click: () => {
        if (view.webContents.navigationHistory.canGoBack()) {
          view.webContents.navigationHistory.goBack()
        }
      },
      enabled: view.webContents.navigationHistory.canGoBack(),
    },
    {
      label: 'Forward',
      click: () => {
        if (view.webContents.navigationHistory.canGoForward()) {
          view.webContents.navigationHistory.goForward()
        }
      },
      enabled: view.webContents.navigationHistory.canGoForward(),
    },
    {
      label: 'Reload',
      click: () => view.webContents.reload(),
    },
    { type: 'separator' },
    {
      label: 'Inspect Element',
      click: () => {
        view.webContents.inspectElement(params.x, params.y)
      },
    },
    { type: 'separator' },
    {
      label: 'Copy Page URL',
      click: () => {
        require('electron').clipboard.writeText(pageURL)
      },
    },
  )

  const typedMenu: Electron.MenuItemConstructorOptions[] = menuItems
Menu.buildFromTemplate(typedMenu).popup({ window: getWindow()! })

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

ipcMain.handle(
  'overlay:popup-ack',
  (_e, { openerTabId, url }: { openerTabId: string; url: string }): void => {
    markMaterialized(openerTabId, url)
  }
)



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

ipcMain.handle(
  'overlay:set-bounds',
  async (_e, { tabId, rect }: { tabId: string; rect: Rect }) => {
    const { state } = S.resolve(tabId)
    if (!state) return

    const { x, y, w, h } = S.roundRect(rect)
    const b = state.lastBounds
    if (!b || x !== b.x || y !== b.y || w !== b.w || h !== b.h) {
      state.lastBounds = { x, y, w, h }
      try { state.view.setBounds({ x, y, width: w, height: h }) } catch {}
    }

    // If we’re under 25% and a bucket is pending, (re)schedule the single apply
    if (S.currentEff() < CHROME_MIN && state.pendingBucket != null) {
      S.scheduleEmu(state)
    }
  }
)


ipcMain.handle(
  'overlay:set-zoom',
  async (_e, { tabId, factor }: { tabId?: string; factor: number }): Promise<void> => {
    canvasZoom = factor || 1
    const eff = S.currentEff()

    const apply = (state: ViewState) => {
      if (eff >= CHROME_MIN) {
        // Native zoom: clear any pending emu and apply once
        state.pendingBucket = null
        if (state.emuTimer) { clearTimeout(state.emuTimer); state.emuTimer = null }
        S.setEff(state.view, eff, state)
        return
      }
      // Emulation path: compute bucket and coalesce
      const bucket = effToBucketKey(eff)
      if (state.lastAppliedZoomKey === bucket || state.pendingBucket === bucket) return
      state.pendingBucket = bucket
      S.scheduleEmu(state) // ← will apply once, using latest bounds
    }

    if (tabId) {
      const { state } = S.resolve(tabId)
      if (!state) return
      apply(state)
    } else {
      for (const [, s] of views) apply(s)
    }
  }
)

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

  ipcMain.handle(
  'overlay:navigate',
  async (_e, { tabId, url }: { tabId: string; url: string }): Promise<SimpleResponse> => {
    const { state } = S.resolve(tabId)
    if (!state) return { ok: false, error: 'No view' }

    // Normalize input (accepts bare hostnames)
    const raw = url.trim()
    const target =
      raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`

    try {
      await state.view.webContents.loadURL(target)

      // Refresh nav state & persist (uses your existing helpers/structures)
      S.updateNav(state)
      browserState[tabId] = {
        ...(browserState[tabId] ?? {}),
        currentUrl: state.view.webContents.getURL(),
        lastInteraction: Date.now(),
      }
      flushBrowserState()

      return { ok: true }
    } catch {
      return { ok: false, error: 'Navigate failed' }
    }
  }
)



ipcMain.handle('overlay:destroy', async (_e, { tabId }: { tabId: string }): Promise<void> => {
  const { state } = S.resolve(tabId)
  if (!state) return

  console.log(`[overlay] Starting destroy for tabId: ${tabId}`)

  const win = getWindow()
  const view = state.view
  const wc = view.webContents

  // Step 1: Remove from our tracking immediately to prevent further operations
  views.delete(tabId)
  delete browserState[tabId]
  clearForOpener?.(tabId)

  // Step 2: Stop all web activity immediately
  try {
    if (!wc.isDestroyed()) {
      wc.stop()
      wc.setAudioMuted(true)
    }
  } catch (e) {
    console.warn(`[overlay] Error stopping webcontents for ${tabId}:`, e)
  }

  // Step 3: Detach from parent window first (critical)
  try {
    if (win && !win.isDestroyed() && state.attached) {
      S.detach(win, state)
    }
  } catch (e) {
    console.warn(`[overlay] Error detaching view for ${tabId}:`, e)
  }

  // Step 4: Clean up debugger and dev tools
  try {
    if (!wc.isDestroyed()) {
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools()
      }
      if (wc.debugger.isAttached()) {
        wc.debugger.detach()
      }
    }
  } catch (e) {
    console.warn(`[overlay] Error cleaning up debugger for ${tabId}:`, e)
  }

  // Step 5: Remove all event listeners to prevent memory leaks
  try {
    if (!wc.isDestroyed()) {
      wc.removeAllListeners()
    }
  } catch (e) {
    console.warn(`[overlay] Error removing listeners for ${tabId}:`, e)
  }

  // Step 6: Proper WebContents cleanup sequence
  if (!wc.isDestroyed()) {
    try {
      // First try the documented close() method
      await new Promise<void>((resolve) => {
        let isResolved = false

        const cleanup = () => {
          if (isResolved) return
          isResolved = true
          
          try {
            wc.off('destroyed', onDestroyed)
          } catch {}
          
          resolve()
        }

        // Listen for the destroyed event
        const onDestroyed = () => {
          console.log(`[overlay] WebContents destroyed for ${tabId}`)
          cleanup()
        }
        
        wc.once('destroyed', onDestroyed)

        // Try close first (recommended approach)
        try {
          wc.close()
          console.log(`[overlay] Called close() for ${tabId}`)
        } catch (closeError) {
          console.warn(`[overlay] Close failed for ${tabId}, trying destroy:`, closeError)
          // Fallback to destroy if close fails
          try {
            (wc as any).destroy()
            console.log(`[overlay] Called destroy() for ${tabId}`)
          } catch (destroyError) {
            console.error(`[overlay] Both close() and destroy() failed for ${tabId}:`, destroyError)
            cleanup()
          }
        }
      })
    } catch (e) {
      console.error(`[overlay] Error in cleanup sequence for ${tabId}:`, e)
    }
  }

  // Step 7: Flush state to disk
  try {
    flushBrowserState()
  } catch (e) {
    console.warn(`[overlay] Error flushing browser state:`, e)
  }

  console.log(`[overlay] Destroy completed for tabId: ${tabId}`)
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