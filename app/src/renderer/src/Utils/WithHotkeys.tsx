import { useEffect, useRef } from 'react'
import type { BrowserShape } from './BrowserShapeUtil'
import type { Editor } from 'tldraw'

interface WithHotkeysProps {
  BROWSER_W: number
  BROWSER_H: number
  editorRef: React.RefObject<Editor | null>
}

export default function WithHotkeys({ BROWSER_W, BROWSER_H, editorRef }: WithHotkeysProps) {
  const cursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const lastTriggerAtRef = useRef(0)

  // Track pointer position
  useEffect(() => {
    cursorRef.current = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const onPointerMove = (e: PointerEvent) => { cursorRef.current = { x: e.clientX, y: e.clientY } }
    const onMouseMove = (e: MouseEvent) => { cursorRef.current = { x: e.clientX, y: e.clientY } }
    const opts: AddEventListenerOptions = { passive: true }
    window.addEventListener('pointermove', onPointerMove, opts)
    window.addEventListener('mousemove', onMouseMove, opts)
    return () => {
      window.removeEventListener('pointermove', onPointerMove, opts)
      window.removeEventListener('mousemove', onMouseMove, opts)
    }
  }, [])

  // Hotkey handling
  useEffect(() => {
    const opts: AddEventListenerOptions = { capture: true }
    const onKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey
      if (!isMod || e.repeat || e.key.toLowerCase() !== 't') return

      const ae = document.activeElement as HTMLElement | null
      const tag = (ae?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || ae?.isContentEditable) return

      const now = performance.now()
      if (now - lastTriggerAtRef.current < 200) return
      lastTriggerAtRef.current = now

      e.preventDefault()
      e.stopPropagation()

      const editor = editorRef.current
      if (!editor) return

      const { x: sx, y: sy } = cursorRef.current
      const pagePt = editor.screenToPage({ x: sx, y: sy })
      const x = pagePt.x - BROWSER_W / 2
      const y = pagePt.y - BROWSER_H / 2

      editor.createShape<BrowserShape>({
        type: 'browser-shape',
        x,
        y,
        props: { w: BROWSER_W, h: BROWSER_H, url: 'https://google.com', tabId: '' },
      })
    }

    window.addEventListener('keydown', onKeyDown, opts)
    return () => window.removeEventListener('keydown', onKeyDown, opts)
  }, [BROWSER_W, BROWSER_H, editorRef])

useEffect(() => {
  if (!window.overlay?.onPopupRequest) return

  const off = window.overlay.onPopupRequest(({ url }: { url: string; parentTabId: string }) => {
    const editor = editorRef.current
    if (!editor) return

    // Try to use the currently selected browser-shape as opener
    const selected = editor
      .getSelectedShapes()
      .find((s): s is BrowserShape => s.type === 'browser-shape')

    const GAP = 16
    const w = BROWSER_W
    const h = BROWSER_H

    let x: number
    let y: number

    if (selected) {
      // place to the right of the selected shape
      x = selected.x + selected.props.w + GAP
      y = selected.y
    } else {
      // fallback: near viewport center
      const c = editor.screenToPage({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      x = c.x - w / 2 + 24
      y = c.y - h / 2 + 24
    }

    editor.createShape<BrowserShape>({
      type: 'browser-shape',
      x,
      y,
      props: { w, h, url, tabId: '' },
    })
  })

  return off
}, [BROWSER_W, BROWSER_H, editorRef])

  return null
}
