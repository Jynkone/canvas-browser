import { contextBridge, ipcRenderer } from 'electron'
import type {
  OverlayAPI,
  PopupAckPayload,
  PopupRequestPayload,
  OverlayNotice,
} from '../types/overlay'

// 1) Versions bridge
contextBridge.exposeInMainWorld('electron', {
  process: { versions: process.versions },
})

// 2) Overlay bridge (typed via OverlayAPI)
const overlay: OverlayAPI = {
  // lifecycle / placement
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

  // events
  onUrlUpdate: (callback) => {
    const handler = (_event: unknown, data: { tabId: string; url?: string }) => {
      callback(data)
    }
    ipcRenderer.on('overlay-url-updated', handler)
    return () => ipcRenderer.removeListener('overlay-url-updated', handler)
  },

  // UPDATED: forward main’s eventId/openerTabId/url
  onPopupRequest: (callback) => {
    const handler = (_event: unknown, data: PopupRequestPayload) => {
      callback(data)
    }
    ipcRenderer.on('overlay-popup-request', handler)
    return () => ipcRenderer.removeListener('overlay-popup-request', handler)
  },

  popupAck: (payload: PopupAckPayload) => ipcRenderer.invoke('overlay:popup-ack', payload),

    onNotice: (cb: (n: OverlayNotice) => void) => {
    const ch = 'overlay-notice'
    const h = (_e: Electron.IpcRendererEvent, n: OverlayNotice) => cb(n)
    ipcRenderer.on(ch, h)
    return () => ipcRenderer.removeListener(ch, h)
  },


} satisfies OverlayAPI

contextBridge.exposeInMainWorld('overlay', overlay)
