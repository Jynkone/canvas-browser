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
export interface CreateTabPayload {
  url?: string
}

export interface TabIdPayload {
  tabId: string
}

export interface BoundsPayload {
  tabId: string
  /** screen-space rect for the WebContentsView */
  rect: Rect
}

export interface ZoomPayload {
  tabId: string
  /** TLDraw zoom factor (1 = 100%) */
  factor: number
}

export interface NavigatePayload {
  tabId: string
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
  capture(payload: TabIdPayload): Promise<CaptureResult>

  // navigation
  navigate(payload: NavigatePayload): Promise<SimpleResult>
  goBack(payload: TabIdPayload): Promise<SimpleResult>
  goForward(payload: TabIdPayload): Promise<SimpleResult>
  reload(payload: TabIdPayload): Promise<SimpleResult>
  getNavigationState(payload: TabIdPayload): Promise<NavigationStateResult>
}
