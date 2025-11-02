// Shared overlay API contract (renderer-visible, via preload)

export type Rect = { x: number; y: number; width: number; height: number }

// --- Results (discriminated unions)
export type TabResult =
  | { ok: true; tabId: string }
  | { ok: false; error: string }

export type SimpleResult =
  | { ok: true }
  | { ok: false; error: string }

export interface NavigationState {
  currentUrl: string
  canGoBack: boolean
  canGoForward: boolean
  title: string
}

export type Flags = {
  audible: boolean
  capturing: boolean
  devtools: boolean
  downloads: boolean
  pinned: boolean
}



export type NavigationStateResult =
  | ({ ok: true } & NavigationState & { isLoading: boolean })
  | { ok: false; error: string }

export type CaptureResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string }

// 👇👇 THIS is the lifecycle we’re using everywhere now
export type LifecycleState = 'live' | 'frozen' | 'discarded'

// --- payloads

// create has two shapes now: normal + restore
export type CreateTabPayload =
  | { shapeId: string; url: string }
  | { shapeId: string; restore: true }

// for most calls (show/hide/goBack/...) this stays simple
export interface TabIdPayload {
  tabId: string
}

// destroy is the only one that can carry discard: true
export type DestroyTabPayload =
  | { tabId: string }
  | { tabId: string; discard: true }

export interface BoundsPayload {
  tabId: string
  rect: Rect
  shapeSize?: { w: number; h: number }
}

/** TLDraw zoom (1 = 100%). If omitted, applies globally (supported by main). */
export interface ZoomPayload {
  tabId?: string
  factor: number
}

export interface NavigatePayload {
  tabId: string
  url: string
}

// --- Popup contracts
export interface PopupRequestPayload {
  eventId: string
  url: string
  openerTabId?: string
  parentTabId?: string
}

export interface FreezePayload {
  tabId: string
}
export interface ThawPayload {
  tabId: string
}

export interface SnapshotRequest {
  tabId: string
  maxWidth?: number
}

export interface SetLifecyclePayload {
  tabId: string
  lifecycle: LifecycleState
  hasScreenshot: boolean
}

export interface PersistedTabInfo {
  tabId: string
  currentUrl: string
  lastInteraction: number
  lifecycle: LifecycleState
  hasScreenshot: boolean
  thumbPath: string | null
}

export type PersistedStateResult =
  | { ok: true; tabs: PersistedTabInfo[] }
  | { ok: false; error: string }

export type SnapshotResult =
  | { ok: true; dataUrl: string; width: number; height: number }
  | { ok: false; error: string }

export type OverlayNotice =
  | { kind: 'tab-limit'; max: number }
  | { kind: 'popup-suppressed'; url: string }
  | { kind: 'tab-crashed'; tabId: string }
  | { kind: 'nav-error'; tabId: string; code: number; description: string; url?: string }
  | { kind: 'screen-share-error'; message: string }
  | { kind: 'media-denied'; which: string }
  | { kind: 'pressure'; level: 'normal' | 'elevated' | 'critical'; availableMB: number }
  | { kind: 'flags'; tabId: string; flags: Flags }

export interface PopupAckPayload {
  openerTabId: string
  url: string
  childTabId?: string
}

// --- API surface
export interface OverlayAPI {
  // lifecycle / placement
  createTab(payload: CreateTabPayload): Promise<TabResult>
  show(payload: BoundsPayload | TabIdPayload): Promise<void>
  hide(payload: TabIdPayload): Promise<void>
  // 👇 this is the important change
  destroy(payload: DestroyTabPayload): Promise<void>
  setBounds(payload: BoundsPayload): Promise<void>
  setZoom(payload: ZoomPayload): Promise<void>

  // focus / capture (optional)
  focus(payload?: Partial<TabIdPayload>): Promise<void>
  blur(): Promise<void>

  // events
  onUrlUpdate(callback: (data: { tabId: string; url?: string }) => void): () => void
  onPressure(cb: (p: { level: 'normal' | 'elevated' | 'critical'; freeMB: number; totalMB: number }) => void): () => void

  onPopupRequest(callback: (data: PopupRequestPayload) => void): () => void
  popupAck(payload: PopupAckPayload): void

  freeze(payload: FreezePayload): Promise<void>
  thaw(payload: ThawPayload): Promise<void>
  snapshot(request: SnapshotRequest): Promise<SnapshotResult>

  navigate(payload: NavigatePayload): Promise<SimpleResult>
  onNotice(cb: (n: OverlayNotice) => void): () => void
  goBack(payload: TabIdPayload): Promise<SimpleResult>
  goForward(payload: TabIdPayload): Promise<SimpleResult>
  reload(payload: TabIdPayload): Promise<SimpleResult>
  getNavigationState(payload: TabIdPayload): Promise<NavigationStateResult>
  onNavFinished(cb: (n: { tabId: string; at: number }) => void): () => void

  setLifecycle(payload: SetLifecyclePayload): Promise<SimpleResult>
  getPersistedState(): Promise<PersistedStateResult>

  saveThumb(payload: { tabId: string; url: string; dataUrlWebp: string }): Promise<{ ok: true; thumbPath: string } | { ok: false }>
}

// electron augmentation stays the same …
import 'electron'
declare module 'electron' {
  interface WebContents {
    on(event: 'media-started-playing', listener: (event: Electron.Event) => void): this
    on(event: 'media-paused', listener: (event: Electron.Event) => void): this
    on(event: 'devtools-opened', listener: (event: Electron.Event) => void): this
    on(event: 'devtools-closed', listener: (event: Electron.Event) => void): this
    on(event: 'did-navigate-in-page', listener: (event: Electron.Event, url: string, isMainFrame: boolean, frameProcessId: number, frameRoutingId: number) => void): this
    on(event: 'did-navigate', listener: (event: Electron.Event, url: string, httpResponseCode: number, httpStatusText: string) => void): this
  }
  interface Session {
    on(event: 'will-download', listener: (event: Electron.Event, item: Electron.DownloadItem, webContents: Electron.WebContents) => void): this
    listenerCount(eventName: string): number
    setMaxListeners(n: number): this
  }
}
