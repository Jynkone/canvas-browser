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

export type LifecycleState = 'hot' | 'warm' | 'frozen' | 'discarded'

export type NavigationStateResult =
  | ({ ok: true } & NavigationState & { /** surfaced from main via isLoading() */ isLoading: boolean })
  | { ok: false; error: string }

export type CaptureResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string }

// --- Payloads
/** Creating a tab is keyed to the TLDraw shape.id you pass in. */
export interface CreateTabPayload {
  /** Optional initial URL to load. */
  url?: string
  /** REQUIRED: the TLDraw BrowserShape's id (tldraw-style, e.g. "shape:..."). */
  shapeId: string
}

export interface TabIdPayload { tabId: string }

/** Screen-space rect for the WebContentsView; optional shapeSize for main’s heuristics. */
export interface BoundsPayload {
  tabId: string
  rect: Rect
  /** Optional logical size of the TL shape (helps main with zoom/fit choices). */
  shapeSize?: { w: number; h: number }
}

/** TLDraw zoom (1 = 100%). If omitted, applies globally (supported by main). */
export interface ZoomPayload {
  tabId?: string
  factor: number
}

export interface NavigatePayload { tabId: string; url: string }

// --- Popup contracts
export interface PopupRequestPayload {
  eventId: string
  url: string
  /** Some code paths emit openerTabId; others emit parentTabId. Support both. */
  openerTabId?: string
  parentTabId?: string
}

export interface FreezePayload { tabId: string }
export interface ThawPayload { tabId: string }

export interface SnapshotRequest { tabId: string; maxWidth?: number }
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
  /** The newly created BrowserShape id (TLShapeId) in the renderer, if available. */
  childTabId?: string
}

// --- API surface
export interface OverlayAPI {
  // lifecycle / placement
  createTab(payload: CreateTabPayload): Promise<TabResult>
  show(payload: BoundsPayload | TabIdPayload): Promise<void>
  hide(payload: TabIdPayload): Promise<void>
  destroy(payload: TabIdPayload): Promise<void>
  setBounds(payload: BoundsPayload): Promise<void>
  setZoom(payload: ZoomPayload): Promise<void>

  // focus / capture (optional)
  focus(payload?: Partial<TabIdPayload>): Promise<void>
  blur(): Promise<void>

  // events
  onUrlUpdate(callback: (data: { tabId: string; url?: string }) => void): () => void

  /** Emits when main wants the renderer to create a BrowserShape. */
  onPopupRequest(callback: (data: PopupRequestPayload) => void): () => void

  /** Renderer ACK that it materialized the shape for {openerTabId,url}. */
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
}

/* =========================================================================================
   Electron typings augmentation
   Reason: your Electron .d.ts may not declare these WebContents/Session event overloads.
   This adds them so calls like wc.on('media-started-playing', ...) type-check cleanly.
   Purely type-level; no runtime impact.
   ========================================================================================= */

import 'electron'

declare module 'electron' {
  interface WebContents {
    on(event: 'media-started-playing', listener: (event: Electron.Event) => void): this
    on(event: 'media-paused', listener: (event: Electron.Event) => void): this
    on(event: 'devtools-opened', listener: (event: Electron.Event) => void): this
    on(event: 'devtools-closed', listener: (event: Electron.Event) => void): this

    on(
      event: 'did-navigate-in-page',
      listener: (
        event: Electron.Event,
        url: string,
        isMainFrame: boolean,
        frameProcessId: number,
        frameRoutingId: number
      ) => void
    ): this

    on(
      event: 'did-navigate',
      listener: (
        event: Electron.Event,
        url: string,
        httpResponseCode: number,
        httpStatusText: string
      ) => void
    ): this
  }

  interface Session {
    on(
      event: 'will-download',
      listener: (
        event: Electron.Event,
        item: Electron.DownloadItem,
        webContents: Electron.WebContents
      ) => void
    ): this

    /** Present in Node's EventEmitter; declare to keep TS happy when you use it. */
    listenerCount(eventName: string): number
    setMaxListeners(n: number): this
  }
}
