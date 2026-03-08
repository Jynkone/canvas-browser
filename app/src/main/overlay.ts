import { app, BrowserWindow, ipcMain, Menu, desktopCapturer, dialog, WebContents, sharedTexture, shell } from 'electron'
import type { Input, SystemMemoryInfo } from 'electron'
import { writeFileSync, readFileSync, existsSync } from 'fs'
import type { OverlayNotice, Flags, BoundsPayload } from '../../src/types/overlay'
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SharedTextureStream } from './sharedTextureStream'


type ViewState = {
  view: BrowserWindow
  lastBounds: { w: number; h: number }
  lastFrame?: string
  frameStream: SharedTextureStream
  navState: {
    currentUrl: string
    canGoBack: boolean
    canGoForward: boolean
    title: string
  }
}

const THUMBS_DIR: string = path.join(app.getPath('userData'), 'thumbs');

function ensureThumbsDir(): void {
  if (!fs.existsSync(THUMBS_DIR)) {
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
  }
}

function deleteThumbFile(thumbPath?: string): void {
  if (!thumbPath) return
  try {
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath)
  } catch { }
}

function cleanupThumbState(): void {
  ensureThumbsDir()

  for (const state of Object.values(browserState)) {
    if (!state.thumbPath) continue
    if (fs.existsSync(state.thumbPath)) continue
    state.thumbPath = undefined
    state.hasScreenshot = false
  }

  const referenced = new Set(
    Object.values(browserState)
      .map((state) => state.thumbPath)
      .filter((thumbPath): thumbPath is string => typeof thumbPath === 'string' && thumbPath.length > 0)
      .map((thumbPath) => path.resolve(thumbPath))
  )

  for (const entry of fs.readdirSync(THUMBS_DIR)) {
    const fullPath = path.resolve(path.join(THUMBS_DIR, entry))
    if (referenced.has(fullPath)) continue
    deleteThumbFile(fullPath)
  }
}

type Ok<T = {}> = { ok: true } & T
type Err = { ok: false; error: string }
type CreateTabResponse = Ok<{ tabId: string }> | Err
type SimpleResponse = Ok | Err
type GetNavStateResponse = (Ok & ViewState['navState'] & { isLoading: boolean }) | Err
type PressureLevel = 'normal' | 'elevated' | 'critical'

const MAX_VIEWS = 50
const destroying = new Set<string>()

type LifecycleKind = 'live' | 'frozen' | 'discarded';

interface PersistedTabState {
  currentUrl: string;
  lastInteraction: number;
  lifecycle?: LifecycleKind;
  hasScreenshot?: boolean;
  thumbPath?: string;
}

function buildBrowserUserAgent(): string {
  const chromeVersion = process.versions.chrome || '120.0.0.0'
  const platformToken =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'linux'
        ? 'X11; Linux x86_64'
        : 'Windows NT 10.0; Win64; x64'
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

const BROWSER_USER_AGENT = buildBrowserUserAgent()
app.userAgentFallback = BROWSER_USER_AGENT

const browserState: Record<string, PersistedTabState> = {};

const STATE_FILE = path.join(app.getPath('userData'), 'browser-state.json')
if (existsSync(STATE_FILE)) {
  try {
    Object.assign(browserState, JSON.parse(readFileSync(STATE_FILE, 'utf8')))
  } catch (e) {
    console.error('[overlay] Failed to read browser state:', e)
  }
}
cleanupThumbState()

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

function upsertBrowserState(
  tabId: string,
  patch: Partial<PersistedTabState> & Pick<PersistedTabState, 'currentUrl'>
): void {
  const prev = browserState[tabId]
  browserState[tabId] = {
    currentUrl: patch.currentUrl,
    lastInteraction: patch.lastInteraction ?? prev?.lastInteraction ?? Date.now(),
    lifecycle: patch.lifecycle ?? prev?.lifecycle ?? 'live',
    hasScreenshot: patch.hasScreenshot ?? prev?.hasScreenshot ?? false,
    thumbPath: patch.thumbPath ?? prev?.thumbPath,
  }
}

export function setupOverlayIPC(getWindow: () => BrowserWindow | null): void {
  const views = new Map<string, ViewState>()

  const closeAllOverlayViews = (): void => {
    for (const [tabId, state] of views) {
      try { state.frameStream.close() } catch { }
      try {
        if (!state.view.isDestroyed()) {
          state.view.destroy()
        }
      } catch { }
      views.delete(tabId)
    }
  }

  app.once('before-quit', closeAllOverlayViews)

  function readSystemMemoryMB(): { freeMB: number; totalMB: number } | null {
    try {
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

    const snapshot = (): Flags => {
      try {
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
          downloads: false,
          pinned: false,
          capturing: false,
        }
      } catch {
        return DEAD_FLAGS
      }
    }

    const send = (flags: Flags): void => {
      try {
        sendNotice({ kind: 'flags', tabId, flags })
      } catch { }
    }

    const emit = (): void => send(snapshot())

    try { wc.on('audio-state-changed', () => emit()) } catch { }
    try { wc.on('devtools-opened', () => emit()) } catch { }
    try { wc.on('devtools-closed', () => emit()) } catch { }
    try { wc.on('did-navigate-in-page', () => emit()) } catch { }
    try { wc.on('did-navigate', () => emit()) } catch { }

    try {
      const ses = wc.session
      try { ses.setMaxListeners?.(0) } catch { }
      if (ses && ses.listenerCount('will-download') === 0) {
        ses.on('will-download', (_e, item, sourceWc) => {
          try {
            if (!sourceWc || sourceWc.id !== wc.id) return
            const f = snapshot()
            send({ ...f, downloads: true })
            item.once('done', () => emit())
          } catch { }
        })
      }
    } catch { }

    emit()

    try {
      wc.once('destroyed', () => {
        try { wc.removeAllListeners('audio-state-changed') } catch { }
        try { wc.removeAllListeners('devtools-opened') } catch { }
        try { wc.removeAllListeners('devtools-closed') } catch { }
        try { wc.removeAllListeners('did-navigate-in-page') } catch { }
        try { wc.removeAllListeners('did-navigate') } catch { }
        try { send(DEAD_FLAGS) } catch { }
      })
    } catch { }
  }

  const S = {
    resolve(id?: string | null) {
      if (id && views.has(id)) {
        const s = views.get(id)!
        return { view: s.view, state: s }
      }
      return { view: null as BrowserWindow | null, state: null as ViewState | null }
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
    if (!url || typeof url !== 'string') return true
    try {
      const urlLower = url.toLowerCase()
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
      const authPatterns = [
        '/oauth/', '/oauth2/', '/auth/', '/login/oauth/', '/api/auth/',
        '/sso/', '/saml/', 'oauth2/authorize', 'oauth/authorize',
        '/signin-', '/login?', '/authenticate'
      ]
      const parsedUrl = new URL(url)
      if (authDomains.includes(parsedUrl.hostname)) return true
      if (authPatterns.some(pattern => urlLower.includes(pattern))) return true
      if (parsedUrl.searchParams.has('client_id') ||
        parsedUrl.searchParams.has('oauth') ||
        parsedUrl.searchParams.has('auth') ||
        parsedUrl.searchParams.has('response_type') ||
        parsedUrl.searchParams.has('scope')) return true
      if (features && typeof features === 'string') {
        const widthMatch = features.match(/width=(\d+)/)
        const heightMatch = features.match(/height=(\d+)/)
        if (widthMatch && heightMatch) {
          const width = parseInt(widthMatch[1])
          const height = parseInt(heightMatch[1])
          if (width < 600 && height < 600) return true
          if (width < 400 || height < 400) return true
        }
      }
      return false
    } catch (error) {
      console.warn('[popup-detection] Error parsing URL:', url, error)
      return true
    }
  }

  function getPopupWindowBounds(features: string): { width: number; height: number } {
    const widthMatch = features.match(/width=(\d+)/i)
    const heightMatch = features.match(/height=(\d+)/i)
    const width = widthMatch ? parseInt(widthMatch[1], 10) : 520
    const height = heightMatch ? parseInt(heightMatch[1], 10) : 720
    return {
      width: Math.max(420, Math.min(width, 900)),
      height: Math.max(560, Math.min(height, 1000)),
    }
  }

  function isGoogleAuthUrl(rawUrl: string): boolean {
    if (!rawUrl || typeof rawUrl !== 'string') return false
    try {
      const parsed = new URL(rawUrl)
      const hostname = parsed.hostname.toLowerCase()
      const pathname = parsed.pathname.toLowerCase()
      if (hostname === 'accounts.google.com') return true
      if (hostname.endsWith('.accounts.google.com')) return true
      if (hostname === 'signin.google.com') return true
      if (hostname.endsWith('.googleusercontent.com') && pathname.includes('/o/oauth2/')) return true
      if (!hostname.endsWith('.google.com') && !hostname.endsWith('.googleusercontent.com')) return false
      return pathname.includes('/o/oauth2/') ||
        pathname.includes('/signin/oauth/') ||
        parsed.searchParams.has('client_id') ||
        parsed.searchParams.has('scope') ||
        parsed.searchParams.has('response_type')
    } catch {
      return false
    }
  }

  type PopupKey = `${string}|${string}`;

  enum PopupState {
    None = 0,
    Requested = 3,
    Materialized = 4
  }

  const popupStates = new Map<PopupKey, PopupState>();
  const MAX_POPUPS_PER_KEY = 3

  type PopupBucket = {
    requested: number
    materialized: number
    childIds: Set<string>
  }

  const popupBuckets = new Map<PopupKey, PopupBucket>()
  const pk = (openerTabId: string, url: string): PopupKey => `${openerTabId}|${url}`
  const activeCount = (b: PopupBucket): number =>
    b.childIds.size + Math.max(0, b.requested - b.materialized)

  function tryRequest(openerTabId: string, url: string): boolean {
    const k = pk(openerTabId, url)
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

  function clearForOpener(openerTabId: string): void {
    for (const k of popupStates.keys()) {
      if (k.startsWith(`${openerTabId}|`)) popupStates.delete(k);
    }
  }

  function emitCanvasPopup(openerTabId: string, url: string): void {
    const win = getWindow();
    const eventId = `${openerTabId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    win?.webContents.send('overlay-popup-request', {
      eventId,
      url,
      parentTabId: openerTabId,
    } as { eventId: string; url: string; parentTabId: string });
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
    tick()
  }

  function openFromContextMenu(openerTabId: string, url: string): void {
    if (!tryRequest(openerTabId, url)) {
      console.log('[context-open] 🔁 Suppressed duplicate (sticky)')
      return
    }
    console.log('[context-open] 🎯 Emitting canvas popup (sticky)')
    emitCanvasPopup(openerTabId, url)
  }

  const keyByChild = new Map<string, PopupKey>()

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

  function wireAuthPopup(child: BrowserWindow, openerWc: WebContents, openerId: string, initialUrl: string): void {
    if (!shouldStayAsPopup(initialUrl, '')) return

    let finished = false
    const childWc = child.webContents

    const finalize = (nextUrl: string): void => {
      if (finished || shouldStayAsPopup(nextUrl, '')) return
      finished = true
      try { markMaterialized(openerId, nextUrl) } catch { }
      try { if (!child.isDestroyed()) child.close() } catch { }
      try {
        if (!openerWc.isDestroyed()) {
          openerWc.focus()
          openerWc.reload()
        }
      } catch { }
    }

    try { childWc.setUserAgent(BROWSER_USER_AGENT) } catch { }
    try { child.show() } catch { }
    try {
      child.once('ready-to-show', () => {
        try { if (!child.isDestroyed()) child.show() } catch { }
      })
    } catch { }
    try {
      child.on('closed', () => {
        if (finished) return
        try { if (!openerWc.isDestroyed()) openerWc.focus() } catch { }
      })
    } catch { }
    childWc.on('will-redirect', (_e, url) => { try { finalize(url) } catch { } })
    childWc.on('did-navigate', (_e, url) => { try { finalize(url) } catch { } })
    childWc.on('did-navigate-in-page', (_e, url) => { try { finalize(url) } catch { } })
  }

  function openGoogleAuthExternally(url: string): void {
    void shell.openExternal(url).catch((error) => {
      console.error('[auth] Failed to open Google auth externally:', error)
    })
    sendNotice({ kind: 'external-auth', provider: 'google', url })
  }

  // -------------------- IPC handlers ---------------------------------------

  ipcMain.handle('overlay:create-tab', async (_e, payload?: { url?: string; shapeId?: string; restore?: boolean }): Promise<CreateTabResponse> => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return { ok: false, error: 'No window' }
    if (views.size >= MAX_VIEWS) {
      sendNotice({ kind: 'tab-limit', max: MAX_VIEWS })
      return { ok: false, error: `Too many tabs (${views.size}/${MAX_VIEWS})` }
    }

    const tabId = payload?.shapeId!
    let savedUrl = payload?.url || 'https://google.com/'

    if (payload?.restore === true) {
      const persisted: PersistedTabState | undefined = browserState[tabId];
      if (persisted?.currentUrl && persisted.currentUrl.length > 0) {
        savedUrl = persisted.currentUrl;
      }
    }

    if (views.has(tabId)) return { ok: true as const, tabId }

    let state: ViewState | undefined
    try {
      const view = new BrowserWindow({
        show: false,
        width: 1280,
        height: 720,
        webPreferences: {
          offscreen: { useSharedTexture: true },
          backgroundThrottling: false,
          contextIsolation: true,
          sandbox: true,
          devTools: true,
        },
      })

   
      view.webContents.startPainting()
      view.webContents.setFrameRate(60)
      const reassertZoom = (): void => {
        try { view.webContents.setZoomFactor(1) } catch { }
      }
      reassertZoom()
      try { view.webContents.setVisualZoomLevelLimits(1, 1) } catch { }
      wireFlagsFor(tabId, view.webContents)
      view.webContents.setUserAgent(BROWSER_USER_AGENT)

      const frameStream = new SharedTextureStream(async (importedSharedTexture) => {
        const win = getWindow()
        if (!win || win.isDestroyed()) return
        await sharedTexture.sendSharedTexture({
          frame: win.webContents.mainFrame,
          importedSharedTexture: importedSharedTexture as never,
        }, tabId)
      })

      // ── Paint handler: GPU → shared texture → renderer ──────────────────
      view.webContents.on('paint', async (e) => {
        const texture = (e as any).texture
        if (!texture) return
        const win = getWindow()
        if (!win || win.isDestroyed()) {
          texture.release()
          return
        }
        frameStream.enqueue(texture.textureInfo, () => texture.release())
      })

      // Permissions
      view.webContents.session.setPermissionRequestHandler(
        async (_wc, permission, callback, details) => {
          try {
            if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
              callback(true); return
            }
            if (permission === 'fullscreen') {
              callback(true); return
            }
            if (permission === 'media') {
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
              callback(res.response === 0); return
            }
            callback(false)
          } catch (err) {
            console.error('[overlay] Permission handler error:', err)
            callback(false)
          }
        }
      )

      view.webContents.session.setPermissionCheckHandler((_wc, permission) => {
        return permission === 'clipboard-read' ||
          permission === 'clipboard-sanitized-write' ||
          permission === 'fullscreen'
      })

      // DisplayMedia
      view.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 300, height: 200 },
            fetchWindowIcons: false,
          })
          const desktopSource = sources.find(s => s.id.startsWith('screen:'))
          const paperSource = sources.find(s => s.name.toLowerCase().includes('paper'))
          const choices: Electron.DesktopCapturerSource[] = []
          if (desktopSource) choices.push(desktopSource)
          if (paperSource) choices.push(paperSource)
          if (choices.length === 0) {
            try { getWindow()?.webContents.send('overlay-notice', { kind: 'screen-share-error', message: 'No Desktop or Paper sources found' } as const) } catch { }
            callback({}); return
          }
          const buttons = [...choices.map((s, i) => `${i + 1}: ${s.name}`), 'Cancel']
          const res = await dialog.showMessageBox({
            type: 'info', buttons, defaultId: 0,
            cancelId: buttons.length - 1,
            message: 'Share your screen or the Paper app',
            noLink: true,
          })
          if (res.response === buttons.length - 1) {
            try { getWindow()?.webContents.send('overlay-notice', { kind: 'media-denied', which: 'screen share' } as const) } catch { }
            callback({}); return
          }
          const idx = Math.max(0, Math.min(res.response, choices.length - 1))
          const source = choices[idx]
          const p: { video: Electron.DesktopCapturerSource; audio?: 'loopback' | 'loopbackWithMute' } = { video: source }
          if (process.platform === 'win32' && source.id.startsWith('screen:')) p.audio = 'loopback'
          callback(p)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[overlay] Screen sharing error:', err)
          try { getWindow()?.webContents.send('overlay-notice', { kind: 'screen-share-error', message: msg } as const) } catch { }
          callback({})
        }
      })

      state = {
        view,
        lastBounds: { w: 1280, h: 720 },
        frameStream,
        navState: { currentUrl: savedUrl, canGoBack: false, canGoForward: false, title: '' },
      }
      views.set(tabId, state)

      const emitNavHint = (tabId: string, url?: string): void => {
        const win = getWindow()
        if (!win || win.isDestroyed()) return
        try { win.webContents.send('overlay-url-updated', { tabId, url } satisfies { tabId: string; url?: string }) } catch { }
      }

      const emitNavFinished = (tabId: string): void => {
        const win = getWindow()
        if (!win || win.isDestroyed()) return
        try { win.webContents.send('overlay-nav-finished', { tabId, at: Date.now() } satisfies { tabId: string; at: number }) } catch { }
      }

      view.webContents.on('dom-ready', () => {
        reassertZoom()
        if (state) S.updateNav(state)
      })

      view.webContents.on('did-navigate', () => {
        reassertZoom()
        if (!state) return
        S.updateNav(state)
        const currentUrl: string = view.webContents.getURL()
        upsertBrowserState(tabId, {
          currentUrl,
          lastInteraction: Date.now(),
          lifecycle: 'live',
        })
        flushBrowserState()
        emitNavHint(tabId)
      })

      view.webContents.on('did-navigate-in-page', () => {
        reassertZoom()
        if (!state) return
        S.updateNav(state)
        const currentUrl: string = view.webContents.getURL()
        upsertBrowserState(tabId, {
          currentUrl,
          lastInteraction: Date.now(),
          lifecycle: 'live',
        })
        flushBrowserState()
        emitNavHint(tabId)
        emitNavFinished(tabId)
      })

      view.webContents.on('will-redirect', (_e, url: string, _isInPlace: boolean, isMainFrame: boolean) => {
        if (!state || !isMainFrame || view.webContents.isDestroyed()) return
        emitNavHint(tabId, url)
      })

      view.webContents.on('will-navigate', (event, url) => {
        if (!state || view.webContents.isDestroyed()) return
        if (!isGoogleAuthUrl(url)) return
        event.preventDefault()
        openGoogleAuthExternally(url)
      })

      view.webContents.on('page-title-updated', () => {
        if (state) S.updateNav(state)
        emitNavHint(tabId)
      })

      view.webContents.on('did-start-navigation', (_e, _url: string, _isInPlace: boolean, isMainFrame: boolean) => {
        if (!state || !isMainFrame || view.webContents.isDestroyed()) return
        emitNavHint(tabId)
      })

      view.webContents.on('render-process-gone', () => {
        sendNotice({ kind: 'tab-crashed', tabId })
        views.delete(tabId)
        clearForChild(tabId)
      })

      view.webContents.on('before-input-event', (event, input: Input) => {
        if (!state) return
        try {
          const mod = input.control || input.meta
          const key = (input.key || '').toLowerCase()
          if (mod && (key === '+' || key === '=' || key === '-' || key === '0')) {
            event.preventDefault()
            reassertZoom()
            return
          }
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
        } catch { }
      })

      view.webContents.setWindowOpenHandler((details) => {
        const { url, features, disposition } = details
        try {
          const isNewWindow = disposition === 'new-window' || disposition === 'foreground-tab'
          const hasFeatures = hasPopupFeatures(features)
          if (isNewWindow || hasFeatures) {
            const shouldStay = shouldStayAsPopup(url, features)
            if (shouldStay) {
              if (isGoogleAuthUrl(url)) {
                openGoogleAuthExternally(url)
                return { action: 'deny' }
              }
              const { width, height } = getPopupWindowBounds(features)
              return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                  show: true,
                  width,
                  height,
                  autoHideMenuBar: true,
                  fullscreenable: false,
                  title: 'Sign in',
                  webPreferences: {
                    backgroundThrottling: false,
                    contextIsolation: true,
                    sandbox: true,
                    devTools: true,
                  },
                },
              }
            }
            const openerTabId = tabId
            if (!tryRequest(openerTabId, url)) {
              sendNotice({ kind: 'popup-suppressed', url })
              return { action: 'deny' }
            }
            emitCanvasPopup(openerTabId, url)
            return { action: 'deny' }
          }
          return { action: 'allow' }
        } catch (error) {
          console.error('[popup-detection] Handler error:', error)
          return { action: 'allow' }
        }
      })

      view.webContents.on('did-create-window', (child, details) => {
        const openerWc = view.webContents
        const openerId = tabId
        if (!shouldStayAsPopup(details.url, '')) return
        wireAuthPopup(child, openerWc, openerId, details.url)
      })

      view.webContents.on('did-finish-load', () => {
        reassertZoom()
        if (!state || view.webContents.isDestroyed()) return
        emitNavHint(tabId)
        emitNavFinished(tabId)
      })

      view.webContents.on('did-stop-loading', () => {
        reassertZoom()
        if (!state || view.webContents.isDestroyed()) return
        emitNavHint(tabId)
        emitNavFinished(tabId)
      })

      ;(view.webContents as WebContents & {
        on: (event: 'cursor-changed', listener: (_event: Electron.Event, type: string) => void) => WebContents
      }).on('cursor-changed', (_event, type) => {
        sendNotice({ kind: 'cursor', tabId, cursor: type })
      })

      view.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
        if (!state || !isMainFrame || view.webContents.isDestroyed()) return
        emitNavHint(tabId)
        emitNavFinished(tabId)
      })

      view.webContents.on('context-menu', (_event, params) => {
        const { linkURL, hasImageContents, isEditable, selectionText, pageURL } = params
        const menuItems: Array<| { label: string; click: () => void; enabled?: boolean } | { type: 'separator' }> = []

        if (params.dictionarySuggestions && params.dictionarySuggestions.length > 0) {
          for (const suggestion of params.dictionarySuggestions) {
            menuItems.push({ label: suggestion, click: () => view.webContents.replaceMisspelling(suggestion) })
          }
          menuItems.push({ type: 'separator' })
        }
        if (params.misspelledWord) {
          menuItems.push({ label: 'Add to Dictionary', click: () => view.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) })
          menuItems.push({ type: 'separator' })
        }
        if (linkURL) {
          menuItems.push(
            { label: 'Open Link in New Canvas Shape', click: () => openFromContextMenu(tabId, linkURL) },
            { label: 'Open Link in New Popup', click: () => require('electron').shell.openExternal(linkURL) },
            { label: 'Copy Link Address', click: () => require('electron').clipboard.writeText(linkURL) },
            { type: 'separator' },
          )
        }
        if (hasImageContents) {
          menuItems.push(
            { label: 'Copy Image', click: () => view.webContents.copyImageAt(params.x, params.y) },
            { label: 'Save Image As...', click: () => view.webContents.downloadURL(params.srcURL) },
            { type: 'separator' },
          )
        }
        if (selectionText) {
          const shortText = selectionText.length > 20 ? `${selectionText.substring(0, 20)}...` : selectionText
          menuItems.push(
            { label: 'Copy', click: () => view.webContents.copy() },
            { label: `Search "${shortText}"`, click: () => openFromContextMenu(tabId, `https://www.google.com/search?q=${encodeURIComponent(selectionText)}`) },
            { type: 'separator' },
          )
        }
        if (isEditable) {
          menuItems.push(
            { label: 'Cut', click: () => view.webContents.cut(), enabled: !!selectionText },
            { label: 'Copy', click: () => view.webContents.copy(), enabled: !!selectionText },
            { label: 'Paste', click: () => view.webContents.paste() },
            { type: 'separator' },
          )
        }
        menuItems.push(
          { label: 'Back', click: () => { if (view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack() }, enabled: view.webContents.navigationHistory.canGoBack() },
          { label: 'Forward', click: () => { if (view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward() }, enabled: view.webContents.navigationHistory.canGoForward() },
          { label: 'Reload', click: () => view.webContents.reload() },
          { type: 'separator' },
          { label: 'Inspect Element', click: () => view.webContents.inspectElement(params.x, params.y) },
          { type: 'separator' },
          { label: 'Copy Page URL', click: () => require('electron').clipboard.writeText(pageURL) },
        )
        const typedMenu: Electron.MenuItemConstructorOptions[] = menuItems
        Menu.buildFromTemplate(typedMenu).popup({ window: getWindow()! })
      })

      void view.webContents.loadURL(savedUrl).catch(console.error)

      return { ok: true as const, tabId }
    } catch (err) {
      if (state) views.delete(tabId)
      throw err ?? new Error('Create failed')
    }
  })

  ipcMain.handle('overlay:popup-ack', (_e, { openerTabId, url, childTabId }: { openerTabId: string; url: string; childTabId?: string }) => {
    markMaterialized(openerTabId, url, childTabId)
  })

  ipcMain.handle('overlay:set-bounds', async (_e, payload: BoundsPayload | BoundsPayload[]) => {
    const list = Array.isArray(payload) ? payload : [payload]
    for (const { tabId, rect } of list) {
      const { state } = S.resolve(tabId)
      if (!state) continue
      const w = Math.max(1, Math.ceil(rect.width))
      const h = Math.max(1, Math.ceil(rect.height))
      if (state.lastBounds.w === w && state.lastBounds.h === h) continue
      state.lastBounds = { w, h }
      try { state.view.setContentSize(w, h) } catch { }
    }
  })

  ipcMain.handle('overlay:send-input', async (_e, { tabId, event }: { tabId: string; event: any }): Promise<void> => {
    const { state } = S.resolve(tabId)
    if (!state) return
    try {
      if (
        event?.type === 'mouseDown' ||
        event?.type === 'mouseEnter' ||
        event?.type === 'keyDown' ||
        event?.type === 'keyUp' ||
        event?.type === 'char'
      ) {
        state.view.webContents.focus()
      }
    } catch { }
    try { state.view.webContents.sendInputEvent(event) } catch { }
  })

  ipcMain.handle('overlay:show', async (_e, { tabId }: { tabId: string }): Promise<void> => {
    const { state } = S.resolve(tabId)
    if (!state) return
    try { state.view.webContents.setBackgroundThrottling(false) } catch { }
    try { state.view.webContents.startPainting() } catch { }
  })

  ipcMain.handle('overlay:hide', async (_e, { tabId }: { tabId: string }): Promise<void> => {
    const { state } = S.resolve(tabId)
    if (!state) return
    try { state.view.webContents.stopPainting() } catch { }
    try { state.view.webContents.setBackgroundThrottling(true) } catch { }
  })

  ipcMain.handle('overlay:set-lifecycle', (_event, payload: { tabId: string; lifecycle: LifecycleKind; hasScreenshot: boolean; }) => {
    const { tabId, lifecycle, hasScreenshot } = payload;
    upsertBrowserState(tabId, {
      currentUrl: browserState[tabId]?.currentUrl ?? 'about:blank',
      lastInteraction: Date.now(),
      lifecycle,
      hasScreenshot,
    });
    flushBrowserState();
    return { ok: true as const };
  })

  ipcMain.handle('overlay:get-persisted-state', () => {
    const tabs = Object.entries(browserState).map(([tabId, data]) => ({
      tabId,
      currentUrl: data.currentUrl,
      lastInteraction: data.lastInteraction,
      lifecycle: data.lifecycle ?? 'live',
      hasScreenshot: data.hasScreenshot ?? false,
      thumbPath: data.thumbPath ?? null,
    }));
    return { ok: true as const, tabs };
  })

  ipcMain.handle('overlay:save-thumb', async (_event, payload: { tabId: string; url: string; dataUrlWebp: string }): Promise<{ ok: true; thumbPath: string } | { ok: false }> => {
    try {
      ensureThumbsDir();
      const commaIdx = payload.dataUrlWebp.indexOf(',');
      if (commaIdx === -1) return { ok: false };
      const b64 = payload.dataUrlWebp.slice(commaIdx + 1);
      const buf = Buffer.from(b64, 'base64');
      const safeId = payload.tabId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `${safeId}.webp`;
      const fullPath = path.join(THUMBS_DIR, fileName);
      fs.writeFileSync(fullPath, buf);
      const prev = browserState[payload.tabId];
      if (prev?.thumbPath && prev.thumbPath !== fullPath) {
        deleteThumbFile(prev.thumbPath)
      }
      upsertBrowserState(payload.tabId, {
        currentUrl: prev?.currentUrl ?? payload.url,
        lastInteraction: Date.now(),
        lifecycle: prev?.lifecycle ?? 'frozen',
        hasScreenshot: true,
        thumbPath: fullPath,
      });
      flushBrowserState();
      return { ok: true, thumbPath: fullPath };
    } catch {
      return { ok: false };
    }
  })

  ipcMain.handle('overlay:navigate', async (_e, { tabId, url }: { tabId: string; url: string }): Promise<SimpleResponse> => {
    const { state } = S.resolve(tabId)
    if (!state) return { ok: false, error: 'No view' }
    const raw = url.trim()
    const target = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
    if (isGoogleAuthUrl(target)) {
      openGoogleAuthExternally(target)
      return { ok: true }
    }
    try {
      await state.view.webContents.loadURL(target)
      S.updateNav(state)
      upsertBrowserState(tabId, {
        currentUrl: state.view.webContents.getURL(),
        lastInteraction: Date.now(),
        lifecycle: 'live',
      })
      flushBrowserState()
      return { ok: true }
    } catch {
      return { ok: false, error: 'Navigate failed' }
    }
  })

  ipcMain.handle('overlay:freeze', async (_e, { tabId }: { tabId: string }): Promise<void> => {
    const { state } = S.resolve(tabId)
    if (!state) return
    try { state.view.webContents.stopPainting() } catch { }
    try { state.view.webContents.setBackgroundThrottling(true) } catch { }
    upsertBrowserState(tabId, {
      currentUrl: state.navState.currentUrl ?? 'about:blank',
      lastInteraction: Date.now(),
      lifecycle: 'frozen',
    })
    flushBrowserState()
  })

  ipcMain.handle('overlay:thaw', async (_e, { tabId }: { tabId: string }): Promise<void> => {
    const { state } = S.resolve(tabId)
    if (!state) return
    try { state.view.webContents.setBackgroundThrottling(false) } catch { }
    try { state.view.webContents.startPainting() } catch { }
    upsertBrowserState(tabId, {
      currentUrl: state.navState.currentUrl ?? 'about:blank',
      lastInteraction: Date.now(),
      lifecycle: 'live',
    })
    flushBrowserState()
  })

  ipcMain.handle('overlay:snapshot', async (_e, payload: { tabId: string }): Promise<{ ok: true; dataUrl: string; width: number; height: number } | { ok: false; error: string }> => {
    const { state } = S.resolve(payload?.tabId)
    if (!state) return { ok: false, error: 'no-view' }
    try {
      const image = await state.view.webContents.capturePage()
      const size = image.getSize()
      const dataUrl = image.toDataURL()
      state.lastFrame = dataUrl
      return { ok: true, dataUrl, width: size.width, height: size.height }
    } catch {
      if (state.lastFrame) return { ok: true, dataUrl: state.lastFrame, width: state.lastBounds.w, height: state.lastBounds.h }
      return { ok: false, error: 'not-ready' }
    }
  })

  ipcMain.handle('overlay:destroy', async (_e, { tabId, discard = false }: { tabId: string; discard?: boolean }): Promise<void> => {
    if (destroying.has(tabId)) { console.warn(`[overlay] destroy already in progress for ${tabId}`); return; }
    destroying.add(tabId);
    try {
      const resolved = S.resolve(tabId); const state = resolved?.state;
      if (!state) { console.warn(`[overlay] destroy: no state for ${tabId} (already removed)`); return; }

      console.log(`[overlay] Starting ${discard ? 'discard' : 'destroy'} for tabId: ${tabId}`);

      const view = state.view;
      const wc: WebContents | undefined = view?.webContents;

      try {
        views.delete(tabId);
        if (!discard) { clearForChild(tabId); clearForOpener?.(tabId); }
      } catch (e) { console.warn(`[overlay] Error clearing maps for ${tabId}:`, e); }

      try { state.frameStream.close() } catch { }

      if (!discard) {
        const thumbPath = browserState[tabId]?.thumbPath
        deleteThumbFile(thumbPath)
        try { delete browserState[tabId]; } catch (e) { console.warn(`[overlay] Error deleting persisted state for ${tabId}:`, e); }
      } else {
        upsertBrowserState(tabId, {
          currentUrl: browserState[tabId]?.currentUrl ?? state.navState.currentUrl ?? 'about:blank',
          lastInteraction: Date.now(),
          lifecycle: 'discarded',
        });
      }

      try { if (wc && !wc.isDestroyed()) { wc.stop(); wc.setAudioMuted(true); } } catch (e) { console.warn(`[overlay] Error stopping webcontents for ${tabId}:`, e); }

      try {
        if (wc && !wc.isDestroyed()) {
          if (wc.isDevToolsOpened?.()) wc.closeDevTools();
        }
      } catch (e) { console.warn(`[overlay] Error cleaning up devtools for ${tabId}:`, e); }

      try { if (wc && !wc.isDestroyed()) wc.removeAllListeners(); } catch (e) { console.warn(`[overlay] Error removing listeners for ${tabId}:`, e); }

      if (wc && !wc.isDestroyed()) {
        const done = new Promise<void>((resolve) => {
          let settled = false;
          const cleanup = (): void => { if (settled) return; settled = true; try { wc.off('destroyed', onDestroyed); } catch { } clearTimeout(to); resolve(); };
          const onDestroyed = (): void => { console.log(`[overlay] WebContents destroyed for ${tabId}`); cleanup(); };
          const to = setTimeout(() => {
            if (!wc.isDestroyed()) {
              try { (wc as WebContents & { destroy?: () => void }).destroy?.(); } catch (err) { console.warn(`[overlay] destroy() fallback failed for ${tabId}:`, err); }
            }
            cleanup();
          }, 1500);
          wc.once('destroyed', onDestroyed);
          try { wc.close(); }
          catch (closeErr) {
            try { (wc as WebContents & { destroy?: () => void }).destroy?.(); }
            catch (destroyErr) { console.error(`[overlay] Both close() and destroy() failed for ${tabId}:`, destroyErr); cleanup(); }
          }
        });
        try { await done; } catch (e) { console.error(`[overlay] Error in cleanup sequence for ${tabId}:`, e); }
      }

      try { flushBrowserState(); } catch (e) { console.warn('[overlay] Error flushing browser state:', e); }
      console.log(`[overlay] ${discard ? 'Discard' : 'Destroy'} completed for tabId: ${tabId}`);
    } finally {
      destroying.delete(tabId);
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

  ipcMain.handle('overlay:get-navigation-state', async (_e, payload: { tabId: string }): Promise<GetNavStateResponse | Err> => {
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
    return { ok: true, currentUrl, title, canGoBack, canGoForward, isLoading }
  })
}
