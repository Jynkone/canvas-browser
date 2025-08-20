import { useEffect, useRef } from 'react'
import type { BrowserShape } from './BrowserShapeUtil'
import { sessionStore } from '../state/sessionStore'

export default function WithHotkeys({
  BROWSER_W,
  BROWSER_H,
}: {
  BROWSER_W: number
  BROWSER_H: number
}) {
  const cursorRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const lastTriggerAtRef = useRef(0)

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

      const editor = window.__tldraw_editor
      if (!editor) return

      const { x: sx, y: sy } = cursorRef.current
      const pagePt = editor.screenToPage({ x: sx, y: sy })
      const x = pagePt.x - BROWSER_W / 2
      const y = pagePt.y - BROWSER_H / 2

      editor.createShape<BrowserShape>({
  type: 'browser-shape',
  x, y,
  props: { w: BROWSER_W, h: BROWSER_H, url: 'https://google.com', tabId: '' },
})

// Mark this new tab as hot immediately
requestAnimationFrame(() => {
  const newShapes = editor.getCurrentPageShapes().filter(s => s.type === 'browser-shape')
  const newestShape = newShapes[newShapes.length - 1]
  if (newestShape) {
    sessionStore.upsert(newestShape.id, {
  shapeId: newestShape.id,
  url: 'https://google.com',
  lastActivityAt: Date.now(),
  lastFocusedAt: Date.now(),
  realization: 'attached'
})

    sessionStore.trackHotN(3)
  }
})

    }

    window.addEventListener('keydown', onKeyDown, opts)
    return () => window.removeEventListener('keydown', onKeyDown, opts)
  }, [BROWSER_W, BROWSER_H])

  return null
}
