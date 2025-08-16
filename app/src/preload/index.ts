import { contextBridge, ipcRenderer } from 'electron'

type Rect = { x: number; y: number; width: number; height: number }
const call = <T = unknown>(channel: string, ...args: any[]) =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

contextBridge.exposeInMainWorld('overlay', {
  createTab(url: string): Promise<string> { return call('overlay:create-tab', url) },
  closeTab(tabId: string): Promise<void> { return call('overlay:close-tab', tabId) },

  show(a: any, b?: Rect): Promise<void> {
    if (typeof a === 'string') return call('overlay:show', { tabId: a, rect: b! })
    return call('overlay:show', a)
  },

  hide(payload?: { tabId?: string }): Promise<void> { return call('overlay:hide', payload) },

  setBounds(a: any): Promise<void> {
    return call('overlay:set-bounds', typeof a?.tabId === 'string' ? a : { tabId: a.tabId, rect: a.rect })
  },

  setZoom(a: any): Promise<void> {
    return call('overlay:set-zoom', typeof a === 'number' ? { factor: a } : a)
  },

  focus(payload?: { tabId?: string }): Promise<void> { return call('overlay:focus', payload) },
  blur(): Promise<void> { return call('overlay:blur') },
})
