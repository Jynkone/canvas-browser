import { BrowserWindow, WebContents, ipcMain } from 'electron'
import { nanoid } from 'nanoid'

export type TabId = string

export class OsrTabs {
  private tabs = new Map<TabId, BrowserWindow>()

  constructor(private ui: WebContents) {
    this.registerIpc()
  }

  create(url: string, cssW: number, cssH: number): TabId {
    const id = nanoid()

    const win = new BrowserWindow({
      show: false,
      width: Math.max(1, Math.round(cssW)),
      height: Math.max(1, Math.round(cssH)),
      webPreferences: {
        offscreen: true,            // <- Offscreen Rendering
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })

    win.webContents.setFrameRate(60)

    // Paint frames -> send pixels to renderer
    win.webContents.on('paint', (_e, dirty, image) => {
      const sz = image.getSize()
      const pixels = image.getBitmap() // Buffer (BGRA)
      this.ui.send('osr:frame', { id, dirty, sz, pixels })
    })

    // Cursor feedback
    win.webContents.on('cursor-changed', (_e, type) => {
      this.ui.send('osr:cursor', { id, type })
    })

    win.on('closed', () => this.tabs.delete(id))

    void win.webContents.loadURL(url)
    this.tabs.set(id, win)
    return id
  }

  resize(id: TabId, cssW: number, cssH: number) {
    const win = this.tabs.get(id)
    if (!win) return
    win.setSize(Math.max(1, Math.round(cssW)), Math.max(1, Math.round(cssH)))
  }

  navigate(id: TabId, url: string) {
    const win = this.tabs.get(id)
    if (win) void win.webContents.loadURL(url)
  }

  sendInput(
    id: TabId,
    ev:
      | Electron.MouseInputEvent
      | Electron.MouseWheelInputEvent
      | Electron.KeyboardInputEvent
  ) {
    const win = this.tabs.get(id)
    if (!win) return
    win.webContents.focus()
    win.webContents.sendInputEvent(ev)
  }

  setZoomFactor(id: TabId, factor: number) {
    const win = this.tabs.get(id)
    if (win) win.webContents.setZoomFactor(factor)
  }

  destroy(id: TabId) {
    const win = this.tabs.get(id)
    if (win && !win.isDestroyed()) win.destroy()
    this.tabs.delete(id)
  }

  private registerIpc() {
    ipcMain.handle('osr:create', (_e, { url, width, height }) =>
      this.create(url, width, height)
    )
    ipcMain.handle('osr:resize', (_e, { id, width, height }) =>
      this.resize(id, width, height)
    )
    ipcMain.handle('osr:navigate', (_e, { id, url }) =>
      this.navigate(id, url)
    )
    ipcMain.handle('osr:input', (_e, { id, ev }) =>
      this.sendInput(id, ev)
    )
    ipcMain.handle('osr:zoom', (_e, { id, factor }) =>
      this.setZoomFactor(id, factor)
    )
    ipcMain.handle('osr:destroy', (_e, { id }) =>
      this.destroy(id)
    )
  }
}
