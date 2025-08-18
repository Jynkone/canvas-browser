// Shared overlay API contract
export interface OverlayAPI {
  createTab(payload?: { url?: string }): Promise<{ ok: boolean; tabId?: string }>
  show(payload: { tabId: string; rect: { x: number; y: number; width: number; height: number } }): Promise<void>
  hide(payload: { tabId: string }): Promise<void>
  destroy(payload: { tabId: string }): Promise<void>
  setBounds(payload: {
    tabId: string
    rect: { x: number; y: number; width: number; height: number }
  }): Promise<void>
  setZoom(payload: { tabId?: string; factor: number }): Promise<void>
  capture(payload: { tabId: string }): Promise<{ ok: boolean; dataUrl?: string }>
  focus(payload?: { tabId?: string }): Promise<void>
  blur(): Promise<void>
}