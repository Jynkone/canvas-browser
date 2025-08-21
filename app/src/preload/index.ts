import { contextBridge, ipcRenderer } from 'electron'
import type { OverlayAPI } from '../types/overlay'

// 1) Versions bridge
contextBridge.exposeInMainWorld('electron', {
  process: { versions: process.versions }
})

// 2) Overlay bridge (typed via OverlayAPI) with navigation support
const overlay: OverlayAPI = {
  createTab: (payload) => ipcRenderer.invoke('overlay:create-tab', payload),
  show: (payload) => ipcRenderer.invoke('overlay:show', payload),
  hide: (payload) => ipcRenderer.invoke('overlay:hide', payload),
  destroy: (payload) => ipcRenderer.invoke('overlay:destroy', payload),
  setBounds: (payload) => ipcRenderer.invoke('overlay:set-bounds', payload),
  setZoom: (payload) => ipcRenderer.invoke('overlay:set-zoom', payload),
  focus: (payload) => ipcRenderer.invoke('overlay:focus', payload),
  blur: () => ipcRenderer.invoke('overlay:blur'),
  
  // Navigation methods
  navigate: (payload) => ipcRenderer.invoke('overlay:navigate', payload),
  goBack: (payload) => ipcRenderer.invoke('overlay:go-back', payload),
  goForward: (payload) => ipcRenderer.invoke('overlay:go-forward', payload),
  reload: (payload) => ipcRenderer.invoke('overlay:reload', payload),
  getNavigationState: (payload) => ipcRenderer.invoke('overlay:get-navigation-state', payload),


    onUrlUpdate: (callback) => {
    const handler = (_event: any, data: { tabId: string; url?: string }) => {
      callback(data)
    }
    ipcRenderer.on('overlay-url-updated', handler)
    return () => ipcRenderer.removeListener('overlay-url-updated', handler)
  }

}

contextBridge.exposeInMainWorld('overlay', overlay)