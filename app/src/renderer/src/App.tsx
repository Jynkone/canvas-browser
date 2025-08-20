import { useEffect, useMemo, useRef } from 'react'
import { Tldraw } from 'tldraw'
import type { Editor } from 'tldraw'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { BrowserShapeUtil } from './Utils/BrowserShapeUtil'
import type { BrowserShape } from './Utils/BrowserShapeUtil'
import WithHotkeys from './Utils/WithHotkeys'
import { useUiChromeManager } from './Utils/useUiChromeManager'
import { sessionStore } from './state/sessionStore'


const BROWSER_W = 1200
const BROWSER_H = 660
const ZOOM_HIDE = 0.65
const ZOOM_SHOW = 0.60
const DURATION_MS = 180
const SLIDE_PX = 16

export default function App() {
  const shapeUtils = useMemo(() => [BrowserShapeUtil], [])
  const assetUrls = useMemo(
    () => getAssetUrls({ baseUrl: import.meta.env.DEV ? '/tldraw-assets' : './tldraw-assets' }),
    []
  )

  const editorRef = useRef<Editor | null>(null)

  // slide-in/out manager now only needs the editor and cfg
  useUiChromeManager(editorRef, { DURATION_MS, SLIDE_PX, ZOOM_HIDE, ZOOM_SHOW })

  // Delete / Backspace fallback outside inputs
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const ed = editorRef.current; if (!ed) return
      const ae = document.activeElement as HTMLElement | null
      const tag = (ae?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || ae?.isContentEditable) return
      const selected = ed.getSelectedShapeIds()
      if (selected.length === 0) return
      e.preventDefault(); e.stopPropagation()
      ed.deleteShapes(selected)
      ed.focus()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Tldraw
        shapeUtils={shapeUtils}
        assetUrls={assetUrls}
        hideUi={false}
        onMount={(editor) => {
  window.__tldraw_editor = editor
  editorRef.current = editor

  // Initialize hot tabs from session store
  const hotTabs = sessionStore.getAllTabs()
    .filter(tab => tab.realization === 'attached')
    .slice(0, 3)

  if (hotTabs.length > 0) {
  // Recreate hot tabs from previous session with their SAVED URLs
  hotTabs.forEach(tab => {
    const shape = {
      type: 'browser-shape' as const,
      x: tab.x,
      y: tab.y,
      props: { 
        w: tab.w, 
        h: tab.h, 
        url: tab.url, // This is the saved URL from session
        tabId: '' 
      },
    }
    editor.createShape(shape as unknown as BrowserShape)
  })
} else {
  // No existing hot tabs, create default
  const initial = {
    type: 'browser-shape',
    x: 100,
    y: 100,
    props: { w: BROWSER_W, h: BROWSER_H, url: 'https://google.com', tabId: '' },
  } as const

  editor.createShape(initial as unknown as BrowserShape)
}

  editor.focus()

  // Start at 60% canvas zoom
  requestAnimationFrame(() => {
    const cam = editor.getCamera()
    editor.setCamera({ ...cam, z: 0.6 })
  })
}}

      >
        <WithHotkeys BROWSER_W={BROWSER_W} BROWSER_H={BROWSER_H} />
      </Tldraw>
    </div>
  )
}
