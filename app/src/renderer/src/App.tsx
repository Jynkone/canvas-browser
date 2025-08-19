import { useEffect, useMemo, useRef } from 'react'
import { Tldraw } from 'tldraw'
import type { Editor } from 'tldraw'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { BrowserShapeUtil } from './Utils/BrowserShapeUtil'
import type { BrowserShape } from './Utils/BrowserShapeUtil'
import WithHotkeys from './Utils/WithHotkeys'
import { useUiChromeManager } from './Utils/useUiChromeManager'

// ---- Shared constants here
const BROWSER_W = 1000
const BROWSER_H = 660
const ZOOM_HIDE = 0.80
const ZOOM_SHOW = 0.75
const DURATION_MS = 180
const SLIDE_PX = 16

export default function App() {
  const shapeUtils = useMemo(() => [BrowserShapeUtil], [])
  const assetUrls = useMemo(
    () => getAssetUrls({ baseUrl: import.meta.env.DEV ? '/tldraw-assets' : './tldraw-assets' }),
    []
  )

  const editorRef = useRef<Editor | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // slide-in/out manager now takes options from here
  const hideUiProp = useUiChromeManager(rootRef, editorRef, {
    DURATION_MS, SLIDE_PX, ZOOM_HIDE, ZOOM_SHOW,
  })

  // Delete/Backspace fallback
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const ed = editorRef.current
      if (!ed) return
      const ae = document.activeElement as HTMLElement | null
      const tag = (ae?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || ae?.isContentEditable) return
      const selected = ed.getSelectedShapeIds()
      if (selected.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      ed.deleteShapes(selected)
      ed.focus()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  return (
    <div ref={rootRef} style={{ width: '100vw', height: '100vh' }}>
      <Tldraw
        shapeUtils={shapeUtils}
        assetUrls={assetUrls}
        hideUi={hideUiProp}
        onMount={(editor) => {
  window.__tldraw_editor = editor
  editorRef.current = editor

  const initial = {
    type: 'browser-shape',
    x: 100,
    y: 100,
    props: { w: BROWSER_W, h: BROWSER_H, url: 'https://google.com', tabId: '' },
  } satisfies Parameters<typeof editor.createShape>[0]

  editor.createShape(initial as BrowserShape)
  editor.focus()

  // 👇 Start at 60% zoom (use 0.5 for 50%)
  requestAnimationFrame(() => {
    const cam = editor.getCamera()
    editor.setCamera({ ...cam, z: 0.6 }) // 0.6 = 60%, 0.5 = 50%
  })
}}

      >
        <WithHotkeys BROWSER_W={BROWSER_W} BROWSER_H={BROWSER_H} />
      </Tldraw>
    </div>
  )
}
