import { BrowserWindow, WebContentsView, ipcMain, Menu, desktopCapturer, dialog, WebContents } from 'electron'
import type { Debugger as ElectronDebugger, Input, SystemMemoryInfo } from 'electron'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { OverlayNotice, Flags } from '../../src/types/overlay'
import sharp from 'sharp';

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
  lastCaptureAt?: number
}


type Ok<T = {}> = { ok: true } & T
type Err = { ok: false; error: string }
type CreateTabResponse = Ok<{ tabId: string }> | Err
type SimpleResponse = Ok | Err
type GetNavStateResponse = (Ok & ViewState['navState'] & { isLoading: boolean }) | Err
type PressureLevel = 'normal' | 'elevated' | 'critical'



const CHROME_MIN = 0.25
const CHROME_MAX = 5
const ZOOM_RATIO = 1
const MAX_VIEWS = 32
const BORDER = 3

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const destroying = new Set<string>() // prevent re-entrant destroy(tabId)

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

function chooseDownscale(state: ViewState | null): number {
  if (!state) return 0.30;

  const raw = (state as { lastAppliedZoomKey?: number | string }).lastAppliedZoomKey;
  if (raw == null) return 0.30;

  const n = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(n) || n <= 0) return 0.30;
  const known: Record<number, number> = {10: 0.10, 15: 0.15, 20: 0.20, 25: 0.25, 30: 0.30 };
  if (known[n]) return known[n];

  const scaled = n / 100;
  if (scaled > 0 && scaled <= 1) return scaled;

  return 0.30;
}



export function setupOverlayIPC(getWindow: () => BrowserWindow | null): void {
  const views = new Map<string, ViewState>()

  const setLifecycle = async (wc: WebContents, target: 'frozen' | 'active'): Promise<void> => {
    const dbg: ElectronDebugger = wc.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Page.setWebLifecycleState', { state: target });
  };

  function readSystemMemoryMB(): { freeMB: number; totalMB: number } | null {
    try {
      // Electron extends the global 'process' at runtime; use a safe, typed cast:
      const info = (process as unknown as { getSystemMemoryInfo?: () => SystemMemoryInfo }).getSystemMemoryInfo?.()
      if (!info) return null
      return {
        totalMB: Math.max(1, info.total),
        freeMB: Math.max(0, info.free),
      }
    } catch {
      return null
    }
  }

  function classifyPressure(freeMB: number, totalMB: number): PressureLevel {
    const freePct = freeMB / Math.max(1, totalMB)
    if (freeMB < 1024 || freePct < 0.10) return 'critical'
    if (freeMB < 2048 || freePct < 0.20) return 'elevated'
    return 'normal'
  }


  function wireFlagsFor(tabId: string, wc: Electron.WebContents): void {
    const DEAD_FLAGS: Flags = {
      audible: false,
      devtools: false,
      downloads: false,
      pinned: false,
      capturing: false,
    }

    // Safe flags snapshot: never touches a destroyed WC; never throws.
    const snapshot = (): Flags => {
      try {
        // Bail out if WC is gone
        // (typeof checks keep us safe across Electron versions / mocks)
        if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
          return DEAD_FLAGS
        }

        const audible =
          typeof wc.isCurrentlyAudible === 'function' ? wc.isCurrentlyAudible() : false
        const devtools =
          typeof wc.isDevToolsOpened === 'function' ? wc.isDevToolsOpened() : false

        return {
          audible,
          devtools,
          downloads: false, // flipped by will-download, then reset
          pinned: false,    // set elsewhere in your UI if you support it
          capturing: false, // wire in if you track per-tab capture state
        }
      } catch {
        // If anything throws, treat as dead.
        return DEAD_FLAGS
      }
    }

    const send = (flags: Flags): void => {
      try {
        sendNotice({ kind: 'flags', tabId, flags })
      } catch {
        // Never allow notice-send to crash the process
      }
    }

    const emit = (): void => send(snapshot())

    // --- Event-driven updates (cheap and safe)
    try { wc.on('audio-state-changed', () => emit()) } catch { }
    try { wc.on('did-navigate-in-page', () => emit()) } catch { }
    try { wc.on('did-navigate', () => emit()) } catch { }

    // --- Session 'will-download' -> flip downloads=true while this WC owns the item
    try {
      const ses = wc.session
      // Avoid listener leak warnings in long sessions
      try { ses.setMaxListeners?.(0) } catch { }

      // Only attach once per session
      if (ses && ses.listenerCount('will-download') === 0) {
        ses.on('will-download', (_e, item, sourceWc) => {
          try {
            if (!sourceWc || sourceWc.id !== wc.id) return
            const f = snapshot()
            send({ ...f, downloads: true })
            item.once('done', () => emit())
          } catch {
            // Ignore — treat as dead / no-op
          }
        })
      }
    } catch {
      // No session available; fine — downloads flag just won’t toggle via this path
    }

    // --- Light poller for properties without reliable events (devtools/pinned/capturing)
    // Emits ONLY on change and is fully try/catch wrapped.
    let last: Flags | null = null
    const POLL_MS = 250
    const poll = setInterval(() => {
      try {
        const now = snapshot()
        if (
          !last ||
          now.audible !== last.audible ||
          now.devtools !== last.devtools ||
          now.downloads !== last.downloads ||
          now.pinned !== last.pinned ||
          now.capturing !== last.capturing
        ) {
          last = now
          send(now)
        }
      } catch {
        // Never crash the process from a timer; treat as dead on next tick
        last = DEAD_FLAGS
      }
    }, POLL_MS)

    // Cleanup: clear poller and listeners once WC is destroyed
    try {
      wc.once('destroyed', () => {
        try { clearInterval(poll) } catch { }
        try { wc.removeAllListeners('audio-state-changed') } catch { }
        try { wc.removeAllListeners('did-navigate-in-page') } catch { }
        try { wc.removeAllListeners('did-navigate') } catch { }
        // Emit a final "dead" snapshot so renderer state settles immediately
        try { send(DEAD_FLAGS) } catch { }
      })
    } catch {
      // If we can’t attach the destroyed handler, at worst the poller will see DEAD_FLAGS on next tick
    }
  }


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
      try { win.contentView.addChildView(s.view); s.attached = true } catch { }
    },
    detach(win: BrowserWindow, s: ViewState) {
      if (!s.attached) return
      try { win.contentView.removeChildView(s.view); s.attached = false } catch { }
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
      } catch { }
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
          try { S.clearEmuIfAny(view) } catch { }
          state.lastAppliedZoomKey = undefined
          if (state) state.lastAppliedEmu = undefined
        }
        try { view.webContents.setZoomFactor(eff) } catch { }
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
      const targetW = Math.max(1, Math.floor(b.width * shrinkToBottom))
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
      try { view.webContents.setZoomFactor(CHROME_MIN) } catch { }

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
          screenWidth: emuW,
          screenHeight: emuH,
          positionX: 0,
          positionY: 0,
          dontSetVisibleSize: false,
        })

        if (state) {
          state.lastAppliedZoomKey = bucket
          state.lastAppliedEmu = { w: emuW, h: emuH }
        }
      } catch { }
    },


    reapply(state: ViewState) {
      try {
        const eff = S.currentEff()
        void S.setEff(state.view, eff, state)
        state.lastAppliedZoom = eff
      } catch { }
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
      } catch { }
    },


    roundRect(rect: Rect) {
      // rect is always a real Rect after Fix 1, but keep clamps & ints here
      const x = Math.floor(rect.x), y = Math.floor(rect.y)
      const w = Math.max(1, Math.ceil(rect.width)), h = Math.max(1, Math.ceil(rect.height))
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
    Requested = 3,   // was 1
    Materialized = 4 // was 2 (bump to keep ordering)
  }

  const popupStates = new Map<PopupKey, PopupState>();


  const MAX_POPUPS_PER_KEY = 3

  type PopupBucket = {
    requested: number          // times we allowed a request to go out
    materialized: number       // renderer ACKs received
    childIds: Set<string>      // live child tabIds for this key
  }

  const popupBuckets = new Map<PopupKey, PopupBucket>()

  const pk = (openerTabId: string, url: string): PopupKey => `${openerTabId}|${url}`

  const activeCount = (b: PopupBucket): number =>
    b.childIds.size + Math.max(0, b.requested - b.materialized) // live + pending

  /** First time? lock & return true; already seen? return false. */
  function tryRequest(openerTabId: string, url: string): boolean {
    const k = pk(openerTabId, url)

    // sweep stale children for this key (child tab destroyed)
    for (const [childId, key] of keyByChild) {
      if (key === k && !views.has(childId)) {
        keyByChild.delete(childId)
        const b0 = popupBuckets.get(k)
        if (b0) b0.childIds.delete(childId)
      }
    }

    const b = popupBuckets.get(k) ?? { requested: 0, materialized: 0, childIds: new Set() }
    if (activeCount(b) >= MAX_POPUPS_PER_KEY) return false

    b.requested += 1
    popupBuckets.set(k, b)
    return true
  }

  function markMaterialized(openerTabId: string, url: string, childTabId?: string): void {
    const key = pk(openerTabId, url)
    const bucket = popupBuckets.get(key) ?? { requested: 0, materialized: 0, childIds: new Set<string>() }
    bucket.materialized += 1
    if (childTabId) {
      bucket.childIds.add(childTabId)
      keyByChild.set(childTabId, key)
    }
    popupBuckets.set(key, bucket)
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

  const sendNotice = (n: OverlayNotice): void => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    try { win.webContents.send('overlay-notice', n) } catch { }
  }

  {
    let lastLevel: PressureLevel | null = null
    const TICK_MS = 3000

    const tick = (): void => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return

      const mem = readSystemMemoryMB()
      if (!mem) return

      const level = classifyPressure(mem.freeMB, mem.totalMB)
      if (level !== lastLevel) {
        try {
          win.webContents.send('overlay-pressure', {
            level,
            freeMB: mem.freeMB,
            totalMB: mem.totalMB,
          } as const)
        } catch { }
        lastLevel = level
      }
    }

    setInterval(tick, TICK_MS).unref?.()
    tick() // send one immediately so renderer has a baseline
  }



  function openFromContextMenu(openerTabId: string, url: string): void {
    if (!tryRequest(openerTabId, url)) {
      console.log('[context-open] 🔁 Suppressed duplicate (sticky)')
      return
    }
    console.log('[context-open] 🎯 Emitting canvas popup (sticky)')
    emitCanvasPopup(openerTabId, url)
  }

  const keyByChild = new Map<string, PopupKey>() // childTabId -> popup key

  function clearForChild(childTabId: string): void {
    const key = keyByChild.get(childTabId)
    if (!key) return
    keyByChild.delete(childTabId)

    const b = popupBuckets.get(key)
    if (!b) return
    b.childIds.delete(childTabId)

    if (activeCount(b) === 0) popupBuckets.delete(key)
    else popupBuckets.set(key, b)
  }





  // -------------------- IPC handlers ---------------------------------------
  ipcMain.handle('overlay:create-tab', async (_e, payload?: { url?: string; shapeId?: string }): Promise<CreateTabResponse> => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return { ok: false, error: 'No window' }
    if (views.size >= MAX_VIEWS) {
      sendNotice({ kind: 'tab-limit', max: MAX_VIEWS })
      return { ok: false, error: `Too many tabs (${views.size}/${MAX_VIEWS})` }
    }


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
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            backgroundThrottling: true,
          },
        })
        wireFlagsFor(tabId, view.webContents)

        // Auto-allow clipboard read & write for every tab, prompt only for media
        view.webContents.session.setPermissionRequestHandler(
          async (_wc, permission, callback, details) => {
            try {
              if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
                callback(true) // always allow clipboard
                return
              }

              if (permission === 'fullscreen') {
                callback(true) // always allow fullscreen
                return
              }

              if (permission === 'media') {
                // Only in media requests: safely check for mediaTypes
                const which =
                  (typeof (details as any).mediaTypes !== 'undefined' && Array.isArray((details as any).mediaTypes))
                    ? (details as any).mediaTypes.join(' & ')
                    : 'media devices'

                const res = await dialog.showMessageBox({
                  type: 'question',
                  buttons: ['Allow', 'Deny'],
                  defaultId: 1,
                  cancelId: 1,
                  message: `This site wants to access your ${which}.`,
                })

                callback(res.response === 0)
                return
              }

              // deny everything else
              callback(false)
            } catch (err) {
              console.error('[overlay] Permission handler error:', err)
              callback(false)
            }
          }
        )

        // Chromium's pre-check: say "yes" for clipboard AND fullscreen
        view.webContents.session.setPermissionCheckHandler((_wc, permission) => {
          return permission === 'clipboard-read' ||
            permission === 'clipboard-sanitized-write' ||
            permission === 'fullscreen'
        })
        // DisplayMedia handler: only Paper + Desktop
        view.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
          try {
            const sources = await desktopCapturer.getSources({
              types: ['screen', 'window'],
              thumbnailSize: { width: 300, height: 200 },
              fetchWindowIcons: false,
            })

            // Prefer a full desktop screen, also allow your app window ("Paper")
            const desktopSource = sources.find(s => s.id.startsWith('screen:'))
            const paperSource = sources.find(s => s.name.toLowerCase().includes('paper'))

            const choices: Electron.DesktopCapturerSource[] = []
            if (desktopSource) choices.push(desktopSource)
            if (paperSource) choices.push(paperSource)

            if (choices.length === 0) {
              // optional: notify renderer
              try {
                getWindow()?.webContents.send('overlay-notice', {
                  kind: 'screen-share-error',
                  message: 'No Desktop or Paper sources found',
                } as const)
              } catch { }
              callback({})
              return
            }

            // Add a Cancel button so we can signal denial clearly
            const buttons = [...choices.map((s, i) => `${i + 1}: ${s.name}`), 'Cancel']
            const res = await dialog.showMessageBox({
              type: 'info',
              buttons,
              defaultId: 0,
              cancelId: buttons.length - 1,
              message: 'Share your screen or the Paper app',
              noLink: true,
            })

            // User cancelled
            if (res.response === buttons.length - 1) {
              try {
                getWindow()?.webContents.send('overlay-notice', {
                  kind: 'media-denied',
                  which: 'screen share',
                } as const)
              } catch { }
              callback({})
              return
            }

            // Safe index & chosen source
            const idx = Math.max(0, Math.min(res.response, choices.length - 1))
            const source = choices[idx]

            const payload: {
              video: Electron.DesktopCapturerSource
              audio?: 'loopback' | 'loopbackWithMute'
            } = { video: source }

            // Only allow audio loopback for full screens on Windows
            if (process.platform === 'win32' && source.id.startsWith('screen:')) {
              payload.audio = 'loopback'
            }

            callback(payload)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error('[overlay] Screen sharing error:', err)
            try {
              getWindow()?.webContents.send('overlay-notice', {
                kind: 'screen-share-error',
                message: msg,
              } as const)
            } catch { }
            callback({})
          }
        })



        try {
          view.webContents.setZoomFactor(1)
          view.webContents.setVisualZoomLevelLimits(1, 1)
        } catch { }

        state = {
          view,
          attached: false,
          lastBounds: { x: 0, y: 0, w: 1, h: 1 },
          lastAppliedZoom: 1,
          navState: { currentUrl: savedUrl, canGoBack: false, canGoForward: false, title: '' },
        }
        views.set(tabId, state)

        const safeReapply = () => { if (!state) return; void S.reapply(state); S.updateNav(state) }

        const emitNavHint = (tabId: string, url?: string): void => {
          const win = getWindow()
          if (!win || win.isDestroyed()) return
          try {
            win.webContents.send(
              'overlay-url-updated',
              { tabId, url } satisfies { tabId: string; url?: string }
            )
          } catch { }
        }

        const emitNavFinished = (tabId: string): void => {
          const win = getWindow()
          if (!win || win.isDestroyed()) return
          try {
            win.webContents.send(
              'overlay-nav-finished',
              { tabId, at: Date.now() } satisfies { tabId: string; at: number }
            )
          } catch { }
        }


        view.webContents.on('dom-ready', safeReapply)

        view.webContents.on('did-navigate', () => {
          if (!state) return
          safeReapply()
          const currentUrl = view.webContents.getURL()
          browserState[tabId] = { currentUrl, lastInteraction: Date.now() }
          flushBrowserState()
          emitNavHint(tabId)
        })
        view.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')

        view.webContents.on('did-navigate-in-page', () => {
          if (!state) return
          safeReapply()
          const currentUrl = view.webContents.getURL()
          browserState[tabId] = { currentUrl, lastInteraction: Date.now() }
          flushBrowserState()
          emitNavHint(tabId)
          emitNavFinished(tabId)
        })

        view.webContents.on(
          'will-redirect',
          (_e, url: string, _isInPlace: boolean, isMainFrame: boolean) => {
            if (!state || !isMainFrame || view.webContents.isDestroyed()) return
            emitNavHint(tabId, url) // push hint so renderer refreshes via getNavigationState()
          }
        )

        view.webContents.on('page-title-updated', () => {
          if (state) S.updateNav(state)
          emitNavHint(tabId)              // ← add
        })

        view.webContents.on(
          'did-start-navigation',
          (_e, _url: string, _isInPlace: boolean, isMainFrame: boolean) => {
            if (!state || !isMainFrame || view.webContents.isDestroyed()) return
            emitNavHint(tabId) // tells renderer to pull; isLoading will be true
          }
        )

        view.webContents.on('render-process-gone', () => {
          try {
            const w = getWindow()
            if (w && !w.isDestroyed() && state) S.detach(w, state)
          } catch { }
          sendNotice({ kind: 'tab-crashed', tabId })
          views.delete(tabId)
          clearForChild(tabId) // ← add
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
          } catch { }
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
                sendNotice({ kind: 'popup-suppressed', url })
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

        view.webContents.on('did-create-window', (child, details) => {
          const childWc = child.webContents
          const openerWc = view.webContents
          const openerId = tabId // current tab id in this scope

          if (!shouldStayAsPopup(details.url, '')) return

          const maybeFinish = (nextUrl: string): void => {
            // When it no longer looks like an auth/login URL, we're done.
            if (!shouldStayAsPopup(nextUrl, '')) {
              try { child.close() } catch { }
              try {
                // Bounce focus and refresh opener so cookies/session apply immediately.
                openerWc.focus()
                openerWc.reload()
                markMaterialized(openerId, nextUrl)
              } catch { }
            }
          }

          // Then attach the popup lifecycle listeners that feed into maybeFinish
          childWc.on('will-redirect', (_e, url) => { try { maybeFinish(url) } catch { } })
          childWc.on('did-navigate', (_e, url) => { try { maybeFinish(url) } catch { } })
          childWc.on('did-navigate-in-page', (_e, url) => { try { maybeFinish(url) } catch { } })
        })

        view.webContents.on('did-start-navigation', (_e, _url, _inPlace, isMainFrame) => {
          if (!state || !isMainFrame || view.webContents.isDestroyed()) return
          emitNavHint(tabId)               // renderer will set isLoading(true) then sync
        })

        // did-finish-load
        view.webContents.on('did-finish-load', () => {
          if (!state || view.webContents.isDestroyed()) return
          emitNavHint(tabId)       // you already had this
          emitNavFinished(tabId)   // ADD: signal "you can snapshot now"
        })

        // did-stop-loading
        view.webContents.on('did-stop-loading', () => {
          if (!state || view.webContents.isDestroyed()) return
          emitNavHint(tabId)       // you already had this
          emitNavFinished(tabId)   // ADD
        })

        // did-fail-load (still tell UI + also finish so you can snapshot failure page if needed)
        view.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
          if (!state || !isMainFrame || view.webContents.isDestroyed()) return
          emitNavHint(tabId)
          emitNavFinished(tabId)   // ADD
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
        try { await view.webContents.loadURL(savedUrl) } catch { }

        return { ok: true as const, tabId }
      } catch (err) {
        if (state) {
          try { const w2 = getWindow(); if (w2 && !w2.isDestroyed()) S.detach(w2, state) } catch { }
          views.delete(tabId)
        }
        throw err ?? new Error('Create failed')
      }
    })
  })

  ipcMain.handle(
    'overlay:popup-ack',
    (_e, { openerTabId, url, childTabId }: { openerTabId: string; url: string; childTabId?: string }) => {
      markMaterialized(openerTabId, url, childTabId)
    }
  )



  ipcMain.handle('overlay:get-zoom', async (): Promise<number> => canvasZoom)

  ipcMain.handle(
    'overlay:show',
    async (_e, payload: { tabId: string; rect?: Rect }): Promise<void> => {
      const win = getWindow()
      const { state } = S.resolve(payload.tabId)
      if (!win || !state) return

      const baseRect: Rect =
        payload.rect ??
        (state.lastBounds
          ? { x: state.lastBounds.x, y: state.lastBounds.y, width: state.lastBounds.w, height: state.lastBounds.h }
          : { x: 0, y: 0, width: 1, height: 1 })

      const { x, y, w, h } = S.roundRect(baseRect)
      state.lastBounds = { x, y, w, h }

      S.attach(win, state)

      try {
        state.view.setBounds({
          x: x + BORDER,
          y: y + BORDER,
          width: w - 2 * BORDER,
          height: h - 2 * BORDER,
        })
      } catch {
        // optional: log
      }
    }
  )

  ipcMain.handle(
    'overlay:set-bounds',
    async (_e, { tabId, rect }: { tabId: string; rect: Rect }) => {
      const { state } = S.resolve(tabId)
      if (!state) return

      const { x, y, w, h } = S.roundRect(rect)
      const b = state.lastBounds

      if (!b || x !== b.x || y !== b.y || w !== b.w || h !== b.h) {
        state.lastBounds = { x, y, w, h }
        try {
          state.view.setBounds({
            x: x + BORDER,
            y: y + BORDER,
            width: w - 2 * BORDER,
            height: h - 2 * BORDER,
          });
        } catch { }
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

  ipcMain.handle('overlay:freeze', async (_e, { tabId }: { tabId: string }): Promise<void> => {
    const { state } = S.resolve(tabId);
    if (!state) return;
    await setLifecycle(state.view.webContents, 'frozen');
  });

  ipcMain.handle('overlay:thaw', async (_e, { tabId }: { tabId: string }): Promise<void> => {
    const { state } = S.resolve(tabId);
    if (!state) return;
    await setLifecycle(state.view.webContents, 'active');
  });

ipcMain.handle(
  'overlay:snapshot',
  async (
    _e,
    payload: { tabId: string; maxWidth?: number }
  ): Promise<
    | { ok: true; dataUrl: string; width: number; height: number }
    | {
        ok: false;
        error:
          | 'tab-destroying'
          | 'webcontents-destroyed'
          | 'snapshot-failed'
          | 'no-view';
      }
  > => {
    const tabId: string | undefined = payload?.tabId;
    if (!tabId) return { ok: false, error: 'no-view' };
    if (destroying.has(tabId)) return { ok: false, error: 'tab-destroying' };

    const { state } = S.resolve(tabId);
    const view = state?.view ?? null;
    const wc = view?.webContents ?? null;

    if (!state || !view || !wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      return { ok: false, error: 'webcontents-destroyed' };
    }

    try {
      const downscale: number = chooseDownscale(state);

      // 20 ms settle instead of double rAF
      await wc.executeJavaScript(
  "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 10))))"
);


      const img = await wc.capturePage();
      const src = img.getSize();
      const srcW: number = Math.max(1, src.width);
      const srcH: number = Math.max(1, src.height);

      const baseW: number = Math.max(1, Math.floor(srcW * downscale));
      const baseH: number = Math.max(1, Math.floor(srcH * downscale));

      const maxW: number = Math.max(64, Math.min(payload?.maxWidth ?? baseW, 4096));
      const clampScale: number = baseW > maxW ? maxW / baseW : 1;

      const targetW: number = Math.max(1, Math.floor(baseW * clampScale));
      const targetH: number = Math.max(1, Math.floor(baseH * clampScale));

      const input: Buffer = img.toPNG();

      const outBuf: Buffer = await sharp(input)
        .resize({
          width: targetW,
          height: targetH,
          fit: 'inside',
          withoutEnlargement: true,
          kernel: sharp.kernel.lanczos3,
        })
        // a touch stronger than 0.6 to reduce "soft" look after downscale
        .sharpen({ sigma: 0.22, m1: 1.4, m2: 0, x1: 2 })
        .webp({
          quality: 94,      // higher than 84 → fewer ringing/blurry edges
          effort: 4,
          nearLossless: false,
        })
        .toBuffer();

      const dataUrl: string = `data:image/webp;base64,${outBuf.toString('base64')}`;

      return { ok: true, dataUrl, width: targetW, height: targetH };
    } catch (err) {
      console.error('snapshot failed:', err);
      return { ok: false, error: 'snapshot-failed' };
    }
  }
);



  ipcMain.handle('overlay:destroy', async (_e, { tabId }: { tabId: string }): Promise<void> => {
    // Make it safe to call destroy multiple times
    if (destroying.has(tabId)) {
      console.warn(`[overlay] destroy already in progress for ${tabId}`)
      return
    }
    destroying.add(tabId)

    try {
      const resolved = S.resolve(tabId)
      const state = resolved?.state
      if (!state) {
        console.warn(`[overlay] destroy: no state for ${tabId} (already removed)`)
        return
      }

      console.log(`[overlay] Starting destroy for tabId: ${tabId}`)

      const win: BrowserWindow | null = getWindow() ?? null
      const view = state.view
      const wc: WebContents | undefined = view?.webContents

      // Remove from tracking first to prevent new work racing in
      try {
        views.delete(tabId)
        clearForChild(tabId)
        delete browserState[tabId]
        clearForOpener?.(tabId)
      } catch (e) {
        console.warn(`[overlay] Error clearing maps for ${tabId}:`, e)
      }

      // Stop activity early (only if wc exists)
      try {
        if (wc && !wc.isDestroyed()) {
          wc.stop()
          wc.setAudioMuted(true)
        }
      } catch (e) {
        console.warn(`[overlay] Error stopping webcontents for ${tabId}:`, e)
      }

      // Detach from window if attached
      try {
        if (win && !win.isDestroyed() && state.attached) {
          S.detach(win, state)
        }
      } catch (e) {
        console.warn(`[overlay] Error detaching view for ${tabId}:`, e)
      }

      // Clean up devtools/debugger
      try {
        if (wc && !wc.isDestroyed()) {
          if (typeof wc.isDevToolsOpened === 'function' && wc.isDevToolsOpened()) {
            wc.closeDevTools()
          }
          if (wc.debugger && typeof wc.debugger.isAttached === 'function' && wc.debugger.isAttached()) {
            // Clear any emulation overrides defensively, ignore failures
            try {
              await wc.debugger.sendCommand?.('Emulation.clearDeviceMetricsOverride', {})
            } catch { }
            try {
              wc.debugger.detach()
            } catch { }
          }
        }
      } catch (e) {
        console.warn(`[overlay] Error cleaning up debugger for ${tabId}:`, e)
      }

      // Remove listeners we added (best-effort)
      try {
        if (wc && !wc.isDestroyed()) {
          wc.removeAllListeners() // if you prefer, list specific events instead
        }
      } catch (e) {
        console.warn(`[overlay] Error removing listeners for ${tabId}:`, e)
      }

      // Close/destroy sequence (guarded, with timeout fallback)
      if (wc && !wc.isDestroyed()) {
        const done = new Promise<void>((resolve) => {
          let settled = false
          const cleanup = (): void => {
            if (settled) return
            settled = true
            try { wc.off('destroyed', onDestroyed) } catch { }
            clearTimeout(to)
            resolve()
          }
          const onDestroyed = (): void => {
            console.log(`[overlay] WebContents destroyed for ${tabId}`)
            cleanup()
          }
          const to = setTimeout(() => {
            // If we timed out but wc still isn’t destroyed, attempt hard destroy if available
            if (!wc.isDestroyed()) {
              try {
                // Cast without any: extend at runtime if method exists
                (wc as WebContents & { destroy?: () => void }).destroy?.()
                console.log(`[overlay] Called destroy() fallback for ${tabId} after timeout`)
              } catch (err) {
                console.warn(`[overlay] destroy() fallback failed for ${tabId}:`, err)
              }
            }
            cleanup()
          }, 1500) // 1.5s safety

          wc.once('destroyed', onDestroyed)

          try {
            wc.close()
            console.log(`[overlay] Called close() for ${tabId}`)
          } catch (closeErr) {
            console.warn(`[overlay] close() failed for ${tabId}, trying destroy():`, closeErr)
            try {
              (wc as WebContents & { destroy?: () => void }).destroy?.()
              console.log(`[overlay] Called destroy() for ${tabId}`)
            } catch (destroyErr) {
              console.error(`[overlay] Both close() and destroy() failed for ${tabId}:`, destroyErr)
              cleanup()
            }
          }
        })

        try {
          await done
        } catch (e) {
          console.error(`[overlay] Error in cleanup sequence for ${tabId}:`, e)
        }
      } else {
        // wc is already gone or never created — nothing to close
        console.log(`[overlay] No webContents for ${tabId}, destroy is a no-op`)
      }

      // Flush state to disk (best-effort)
      try {
        flushBrowserState()
      } catch (e) {
        console.warn('[overlay] Error flushing browser state:', e)
      }

      console.log(`[overlay] Destroy completed for tabId: ${tabId}`)
    } finally {
      destroying.delete(tabId)
    }
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

  ipcMain.handle(
    'overlay:get-navigation-state',
    async (
      _e,
      payload: { tabId: string }
    ): Promise<GetNavStateResponse | Err> => {
      const tabId = payload?.tabId
      const state = tabId ? views.get(tabId) : undefined
      if (!state) return { ok: false, error: 'No such tab' }

      const wc = state.view.webContents

      const safe = <T>(fn: () => T, fallback: T): T => {
        try { return fn() } catch { return fallback }
      }

      const currentUrl = safe(() => wc.getURL(), state.navState.currentUrl)
      const title = safe(() => wc.getTitle(), state.navState.title)
      const canGoBack = safe(() => wc.navigationHistory.canGoBack(), state.navState.canGoBack)
      const canGoForward = safe(() => wc.navigationHistory.canGoForward(), state.navState.canGoForward)
      const isLoading = safe(() => wc.isLoading(), false)

      return {
        ok: true,
        currentUrl,
        title,
        canGoBack,
        canGoForward,
        isLoading,
      }
    }
  )
}