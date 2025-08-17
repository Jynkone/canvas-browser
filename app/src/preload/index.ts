import { contextBridge, ipcRenderer } from 'electron'
import type { OverlayAPI } from '../types/overlay'

// 1) Versions bridge
contextBridge.exposeInMainWorld('electron', {
  process: { versions: process.versions }
})

// 2) Overlay bridge (typed via OverlayAPI)
const overlay: OverlayAPI = {
  createTab: (payload) => ipcRenderer.invoke('overlay:create-tab', payload),
  show: (payload) => ipcRenderer.invoke('overlay:show', payload),
  hide: (payload) => ipcRenderer.invoke('overlay:hide', payload),
  destroy: (payload) => ipcRenderer.invoke('overlay:destroy', payload),
  setBounds: (payload) => ipcRenderer.invoke('overlay:set-bounds', payload),
  setZoom: (payload) => ipcRenderer.invoke('overlay:set-zoom', payload),
  capture: (payload) => ipcRenderer.invoke('overlay:capture', payload),
  focus: (payload) => ipcRenderer.invoke('overlay:focus', payload),
  blur: () => ipcRenderer.invoke('overlay:blur'),
}

contextBridge.exposeInMainWorld('overlay', overlay)
