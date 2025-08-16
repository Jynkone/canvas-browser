export {}

type Rect = { x: number; y: number; width: number; height: number }

declare global {
  interface Window {
    overlay: {
      createTab(url: string): Promise<string>
      closeTab(tabId: string): Promise<void>

      show(tabId: string, rect: Rect): Promise<void>
      show(payload: { tabId: string; rect: Rect }): Promise<void>

      setBounds(payload: { tabId: string; rect: Rect }): Promise<void>

      setZoom(factor: number): Promise<void>
      setZoom(payload: { tabId: string; factor: number }): Promise<void>

      hide(payload?: { tabId?: string }): Promise<void>
      focus(payload?: { tabId?: string }): Promise<void>
      blur(): Promise<void>
    }
  }
}
