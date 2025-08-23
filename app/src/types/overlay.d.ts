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
export interface CreateTabPayload { url?: string }
export interface TabIdPayload { tabId: string }
export interface BoundsPayload { tabId: string; rect: Rect } // screen-space rect
export interface ZoomPayload { tabId: string; factor: number } // TLDraw zoom (1 = 100%)
export interface NavigatePayload { tabId: string; url: string }

// --- Popup contracts (NEW)
export interface PopupRequestPayload {
  eventId: string
  openerTabId: string
  url: string
}

export interface PopupAckPayload {
  openerTabId: string
  url: string
}

// --- API surface
export interface OverlayAPI {
  // lifecycle / placement
  createTab(payload?: CreateTabPayload): Promise<TabResult>
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
  popupAck(payload: PopupAckPayload): Promise<void>

  // navigation
  navigate(payload: NavigatePayload): Promise<SimpleResult>
  goBack(payload: TabIdPayload): Promise<SimpleResult>
  goForward(payload: TabIdPayload): Promise<SimpleResult>
  reload(payload: TabIdPayload): Promise<SimpleResult>
  getNavigationState(payload: TabIdPayload): Promise<NavigationStateResult>
}
