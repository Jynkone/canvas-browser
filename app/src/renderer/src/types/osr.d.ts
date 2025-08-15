export {}

declare global {
  type FrameMessage = {
    id: string
    sz: { width: number; height: number }
    dirty: { x: number; y: number; width: number; height: number }
    pixels: Buffer
  }

  interface Window {
    osr: {
      create(url: string, width: number, height: number): Promise<string>
      resize(id: string, width: number, height: number): Promise<void>
      navigate(id: string, url: string): Promise<void>
      input(
        id: string,
        ev:
          | Electron.MouseInputEvent
          | Electron.MouseWheelInputEvent
          | Electron.KeyboardInputEvent
      ): Promise<void>
      zoom(id: string, factor: number): Promise<void>
      destroy(id: string): Promise<void>
      onFrame(cb: (msg: FrameMessage) => void): () => void
      onCursor(cb: (id: string, type: string) => void): () => void
    }
  }
}
