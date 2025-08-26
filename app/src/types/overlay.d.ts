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

export type OverlayNotice =
  | { kind: 'tab-limit'; max: number }
  | { kind: 'popup-suppressed'; url: string }
  | { kind: 'tab-crashed'; tabId: string }
  | { kind: 'nav-error'; tabId: string; code: number; description: string; url?: string }
  | { kind: 'screen-share-error'; message: string }
  | { kind: 'media-denied'; which: string }

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

  // navigation
  navigate(payload: NavigatePayload): Promise<SimpleResult>
  onNotice(cb: (n: OverlayNotice) => void): () => void
  goBack(payload: TabIdPayload): Promise<SimpleResult>
  goForward(payload: TabIdPayload): Promise<SimpleResult>
  reload(payload: TabIdPayload): Promise<SimpleResult>
  getNavigationState(payload: TabIdPayload): Promise<NavigationStateResult>
}
