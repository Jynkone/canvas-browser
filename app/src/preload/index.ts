import { contextBridge, ipcRenderer } from 'electron'

// Types for frames coming from the main process (OSR)
export type FrameMessage = {
  id: string
  sz: { width: number; height: number }
  dirty: { x: number; y: number; width: number; height: number }
  pixels: Buffer // BGRA bytes (Electron sends Buffer fine over IPC)
}

type Unsub = () => void

const osr = {
  // Commands -> main
  create: (url: string, width: number, height: number) =>
    ipcRenderer.invoke('osr:create', { url, width, height }) as Promise<string>,

  resize: (id: string, width: number, height: number) =>
    ipcRenderer.invoke('osr:resize', { id, width, height }),

  navigate: (id: string, url: string) =>
    ipcRenderer.invoke('osr:navigate', { id, url }),

  input: (
    id: string,
    ev:
      | Electron.MouseInputEvent
      | Electron.MouseWheelInputEvent
      | Electron.KeyboardInputEvent
  ) => ipcRenderer.invoke('osr:input', { id, ev }),

  zoom: (id: string, factor: number) =>
    ipcRenderer.invoke('osr:zoom', { id, factor }),

  destroy: (id: string) =>
    ipcRenderer.invoke('osr:destroy', { id }),

  // Events <- main
  onFrame: (cb: (msg: FrameMessage) => void): Unsub => {
    const handler = (_: unknown, msg: FrameMessage) => cb(msg)
    ipcRenderer.on('osr:frame', handler)
    return () => ipcRenderer.removeListener('osr:frame', handler)
  },

  onCursor: (cb: (id: string, type: string) => void): Unsub => {
    const handler = (_: unknown, payload: { id: string; type: string }) =>
      cb(payload.id, payload.type)
    ipcRenderer.on('osr:cursor', handler)
    return () => ipcRenderer.removeListener('osr:cursor', handler)
  },
}

contextBridge.exposeInMainWorld('osr', osr)

declare global {
  interface Window {
    osr: typeof osr
  }
}
