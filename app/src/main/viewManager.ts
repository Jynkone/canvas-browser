import { BrowserWindow, WebContentsView } from 'electron'

const NAV_BAR_HEIGHT = 40

export function attachView(win: BrowserWindow, view: WebContentsView): void {
  win.contentView.addChildView(view)
  resizeView(win, view) // position it right away

  // keep it positioned when the window resizes
  win.on('resize', () => resizeView(win, view))
}

export function detachView(win: BrowserWindow, view: WebContentsView): void {
  try {
    win.contentView.removeChildView(view)
  } catch (err) {
    console.error('[viewManager] Failed to detach view:', err)
  }
}

function resizeView(win: BrowserWindow, view: WebContentsView): void {
  const cb = win.getContentBounds()
  view.setBounds({
    x: 0,
    y: NAV_BAR_HEIGHT,
    width: cb.width,
    height: cb.height - NAV_BAR_HEIGHT,
  })
}
