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

  return null
}
