import { useEffect, useMemo, useRef } from 'react'
import { Tldraw, useEditor } from 'tldraw'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { BrowserShapeUtil } from './BrowserShapeUtil'
import type { BrowserShape } from './BrowserShapeUtil'

const BROWSER_W = 1000
const BROWSER_H = 660 // includes your nav bar height in BrowserShapeUtil

function WithHotkeys() {
  const editor = useEditor()
  const cursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const lastTriggerAtRef = useRef(0)

  // Track the latest cursor position in viewport (CSS) pixels
  useEffect(() => {
    // set a sensible initial position (center of window)
    cursorRef.current = { x: window.innerWidth / 2, y: window.innerHeight / 2 }

    const onPointerMove = (e: PointerEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY }
    }
    const onMouseMove = (e: MouseEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY }
    }

    // Pointer events first; fall back to mouse
    const pointerOpts: AddEventListenerOptions = { passive: true }
    const mouseOpts: AddEventListenerOptions = { passive: true }

    window.addEventListener('pointermove', onPointerMove, pointerOpts)
    window.addEventListener('mousemove', onMouseMove, mouseOpts)

    return () => {
      window.removeEventListener('pointermove', onPointerMove, pointerOpts)
      window.removeEventListener('mousemove', onMouseMove, mouseOpts)
    }
  }, [])

  useEffect(() => {
    const opts: AddEventListenerOptions = { capture: true }

    const onKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey
      if (!isMod) return
      if (e.repeat) return
      if (e.key.toLowerCase() !== 't') return

      // Don’t trigger while typing
      const ae = document.activeElement as HTMLElement | null
      const tag = (ae?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || ae?.isContentEditable) return

      // Debounce rapid hits
      const now = performance.now()
      if (now - lastTriggerAtRef.current < 200) return
      lastTriggerAtRef.current = now

      e.preventDefault()
      e.stopPropagation()

      // Convert current cursor (screen/viewport coords) to page coords
      const { x: sx, y: sy } = cursorRef.current
      const pagePt = editor.screenToPage({ x: sx, y: sy })

      // Center the shape on the cursor
      const x = pagePt.x - BROWSER_W / 2
      const y = pagePt.y - BROWSER_H / 2

      // ✅ Strongly typed shape creation (no `as any`)
      editor.createShape<BrowserShape>({
        type: 'browser-shape',
        x,
        y,
        props: {
          w: BROWSER_W,
          h: BROWSER_H,
          url: 'https://google.com',
          tabId: '',
        },
      })
    }

    // Capture so we beat the browser’s Ctrl+T default
    window.addEventListener('keydown', onKeyDown, opts)
    return () => window.removeEventListener('keydown', onKeyDown, opts)
  }, [editor])

  return null
}

export default function App() {
  const shapeUtils = useMemo(() => [BrowserShapeUtil], [])
  const assetUrls = useMemo(
    () => getAssetUrls({ baseUrl: import.meta.env.DEV ? '/tldraw-assets' : './tldraw-assets' }),
    []
  )
 
  return (
  <div style={{ width: '100vw', height: '100vh' }}>
    <Tldraw
      shapeUtils={shapeUtils}
      assetUrls={assetUrls}
      onMount={(editor) => {
        const initial = {
          type: 'browser-shape',
          x: 100,
          y: 100,
          props: {
            w: BROWSER_W,
            h: BROWSER_H,
            url: 'https://google.com',
            tabId: '',
          },
        } satisfies Parameters<typeof editor.createShape>[0]

        editor.createShape(initial)
      }}
    >
      <WithHotkeys />
    </Tldraw>
  </div>
)

}
