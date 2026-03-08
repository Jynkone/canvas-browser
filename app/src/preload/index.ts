// nodeIntegration: true, contextIsolation: false
// No contextBridge — assign directly to window.
import { ipcRenderer } from 'electron'
ipcRenderer.setMaxListeners(0)
import type { IpcRendererEvent } from 'electron'
import type {
  OverlayAPI,
  PopupAckPayload,
  PopupRequestPayload,
  OverlayNotice,
  FreezePayload,
  ThawPayload,
  SnapshotRequest,
  SnapshotResult,
  CreateTabPayload,
  CreateTabResponse,
  DestroyTabPayload,
  SendInputPayload,
  BoundsPayload,
  NavigatePayload,
  SimpleResult,
  TabIdPayload,
  NavigationStateResult,
  SetLifecyclePayload,
  PersistedStateResult,
  SharedTextureFrame,
} from '../types/overlay'

declare global {
  interface Window {
    electron: { process: { versions: NodeJS.ProcessVersions } }
    overlay: OverlayAPI
  }
}

const frameCallbacks = new Map<string, (frame: SharedTextureFrame, tabId: string) => void>()

const st = (require('electron') as any).sharedTexture
if (st) {
  st.setSharedTextureReceiver((frame: any, tabId: string) => {
    const cb = frameCallbacks.get(tabId)
    if (!cb) {
      try { frame?.importedSharedTexture?.release?.() } catch { }
      return
    }
    cb(frame, tabId)
  })
} else {
  console.warn('[preload] sharedTexture not available')
}

// ---- Overlay API -----------------------------------------------------------
const overlay: OverlayAPI = {
  createTab: (payload: CreateTabPayload): Promise<CreateTabResponse> => ipcRenderer.invoke('overlay:create-tab', payload),
  show: (payload: TabIdPayload): Promise<void> => ipcRenderer.invoke('overlay:show', payload),
  hide: (payload: TabIdPayload): Promise<void> => ipcRenderer.invoke('overlay:hide', payload),
  destroy: (payload: DestroyTabPayload): Promise<void> => ipcRenderer.invoke('overlay:destroy', payload),

  sendInput: (payload: SendInputPayload): Promise<void> => ipcRenderer.invoke('overlay:send-input', payload),
  setBounds: (payload: BoundsPayload | BoundsPayload[]): Promise<void> => ipcRenderer.invoke('overlay:set-bounds', payload),

  navigate: (payload: NavigatePayload): Promise<SimpleResult> => ipcRenderer.invoke('overlay:navigate', payload),
  goBack: (payload: TabIdPayload): Promise<SimpleResult> => ipcRenderer.invoke('overlay:go-back', payload),
  goForward: (payload: TabIdPayload): Promise<SimpleResult> => ipcRenderer.invoke('overlay:go-forward', payload),
  reload: (payload: TabIdPayload): Promise<SimpleResult> => ipcRenderer.invoke('overlay:reload', payload),
  getNavigationState: (payload: TabIdPayload): Promise<NavigationStateResult> => ipcRenderer.invoke('overlay:get-navigation-state', payload),

  freeze: (payload: FreezePayload): Promise<void> => ipcRenderer.invoke('overlay:freeze', payload),
  thaw: (payload: ThawPayload): Promise<void> => ipcRenderer.invoke('overlay:thaw', payload),
  snapshot: (request: SnapshotRequest): Promise<SnapshotResult> => ipcRenderer.invoke('overlay:snapshot', request),

  setLifecycle: (payload: SetLifecyclePayload): Promise<SimpleResult> => ipcRenderer.invoke('overlay:set-lifecycle', payload),
  getPersistedState: (): Promise<PersistedStateResult> => ipcRenderer.invoke('overlay:get-persisted-state'),

  saveThumb: (payload: { tabId: string; url: string; dataUrlWebp: string }) =>
    ipcRenderer.invoke('overlay:save-thumb', payload),

  onUrlUpdate: (callback) => {
    const ch = 'overlay-url-updated'
    const h = (_e: IpcRendererEvent, data: { tabId: string; url?: string }) => callback(data)
    ipcRenderer.on(ch, h)
    return () => ipcRenderer.removeListener(ch, h)
  },

  onNavFinished: (cb) => {
    const ch = 'overlay-nav-finished'
    const h = (_e: IpcRendererEvent, data: { tabId: string; at: number }) => cb(data)
    ipcRenderer.on(ch, h)
    return () => ipcRenderer.off(ch, h)
  },

  onPopupRequest: (callback) => {
    const ch = 'overlay-popup-request'
    const h = (_e: IpcRendererEvent, data: PopupRequestPayload) => callback(data)
    ipcRenderer.on(ch, h)
    return () => ipcRenderer.removeListener(ch, h)
  },

  popupAck: (payload: PopupAckPayload) => ipcRenderer.invoke('overlay:popup-ack', payload),

  onNotice: (cb: (n: OverlayNotice) => void) => {
    const ch = 'overlay-notice'
    const h = (_e: IpcRendererEvent, n: OverlayNotice) => cb(n)
    ipcRenderer.on(ch, h)
    return () => ipcRenderer.removeListener(ch, h)
  },

  onPressure: (cb) => {
    const ch = 'overlay-pressure'
    const h = (_e: IpcRendererEvent, p: { level: 'normal' | 'elevated' | 'critical'; freeMB: number; totalMB: number }) => cb(p)
    ipcRenderer.on(ch, h)
    return () => ipcRenderer.removeListener(ch, h)
  },

  onFrame: (tabId, callback) => {
    frameCallbacks.set(tabId, callback)
    return () => {
      if (frameCallbacks.get(tabId) === callback) {
        frameCallbacks.delete(tabId)
      }
    }
  },

  decodeGPUFrame: async (_handle: Uint8Array): Promise<ImageBitmap | null> => {
    console.warn('[preload] decodeGPUFrame is a no-op')
    return null
  },
} satisfies OverlayAPI

window.electron = { process: { versions: process.versions } }
window.overlay = overlay
