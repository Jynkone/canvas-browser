import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron' // ← add this
import type {
  OverlayAPI,
  PopupAckPayload,
  PopupRequestPayload,
  OverlayNotice,
  FreezePayload,
  ThawPayload,
  SnapshotRequest,
  SnapshotResult,
} from '../types/overlay'

// 1) Versions bridge
contextBridge.exposeInMainWorld('electron', {
  process: { versions: process.versions },
})

// 2) Overlay bridge (typed via OverlayAPI)
const overlay: OverlayAPI = {
  createTab: (payload) => ipcRenderer.invoke('overlay:create-tab', payload),
  show: (payload) => ipcRenderer.invoke('overlay:show', payload),
  hide: (payload) => ipcRenderer.invoke('overlay:hide', payload),
  destroy: (payload) => ipcRenderer.invoke('overlay:destroy', payload),
  setBounds: (payload) => ipcRenderer.invoke('overlay:set-bounds', payload),
  setZoom: (payload) => ipcRenderer.invoke('overlay:set-zoom', payload),

  // focus / capture (optional)
  focus: (payload) => ipcRenderer.invoke('overlay:focus', payload),
  blur: () => ipcRenderer.invoke('overlay:blur'),

  // navigation
  navigate: (payload) => ipcRenderer.invoke('overlay:navigate', payload),
  goBack: (payload) => ipcRenderer.invoke('overlay:go-back', payload),
  goForward: (payload) => ipcRenderer.invoke('overlay:go-forward', payload),
  reload: (payload) => ipcRenderer.invoke('overlay:reload', payload),
  getNavigationState: (payload) => ipcRenderer.invoke('overlay:get-navigation-state', payload),

  freeze: (payload: FreezePayload) => ipcRenderer.invoke('overlay:freeze', payload),
  thaw: (payload: ThawPayload) => ipcRenderer.invoke('overlay:thaw', payload),
  snapshot: (request: SnapshotRequest): Promise<SnapshotResult> =>
    ipcRenderer.invoke('overlay:snapshot', request),

  setLifecycle: (payload) =>
    ipcRenderer.invoke('overlay:set-lifecycle', payload),

  getPersistedState: () =>
    ipcRenderer.invoke('overlay:get-persisted-state'),

  saveThumb: (payload: {
    tabId: string;
    url: string;
    dataUrlWebp: string;
  }) => ipcRenderer.invoke('overlay:save-thumb', payload),


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

} satisfies OverlayAPI

contextBridge.exposeInMainWorld('overlay', overlay)
