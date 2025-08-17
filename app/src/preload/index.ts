// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'

// 1) Versions bridge
contextBridge.exposeInMainWorld('electron', {
  process: { versions: process.versions }
})

// 2) Your existing overlay bridge (example shape)
contextBridge.exposeInMainWorld('overlay', {
  createTab: (payload: { url?: string }) =>
    ipcRenderer.invoke('overlay:create-tab', payload),
  show: (payload: { tabId: string; rect: { x: number; y: number; width: number; height: number } }) =>
    ipcRenderer.invoke('overlay:show', payload),
  hide: (payload: { tabId: string }) =>
    ipcRenderer.invoke('overlay:hide', payload),
  destroy: (payload: { tabId: string }) =>
    ipcRenderer.invoke('overlay:destroy', payload),
  setBounds: (payload: { tabId: string; rect: { x: number; y: number; width: number; height: number }; dpr?: number }) =>
    ipcRenderer.invoke('overlay:set-bounds', payload),
  setZoom: (payload: { tabId: string; factor: number }) =>
    ipcRenderer.invoke('overlay:set-zoom', payload),
  capture: (payload: { tabId: string }) =>
    ipcRenderer.invoke('overlay:capture', payload),
  focus: (payload?: { tabId?: string }) =>
    ipcRenderer.invoke('overlay:focus', payload),
  blur: () => ipcRenderer.invoke('overlay:blur'),
})
