import { useEffect, useRef } from 'react'
import type { BrowserShape } from './BrowserShapeUtil'
import type { Editor } from 'tldraw'
import { createShapeId, type TLShapeId } from 'tldraw'

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

    const onPointerMove = (e: PointerEvent): void => {
      cursorRef.current = { x: e.clientX, y: e.clientY }
    }

    const passiveOpts: AddEventListenerOptions = { passive: true }
    window.addEventListener('pointermove', onPointerMove, passiveOpts)

    return () => {
      window.removeEventListener('pointermove', onPointerMove, passiveOpts)
    }
  }, [])

  // Hotkey handling: New Tab (Ctrl/Cmd+T), Group (Ctrl/Cmd+G), Ungroup (Shift+Ctrl/Cmd+G)
  useEffect(() => {
    const captureOpts: AddEventListenerOptions = { capture: true }

    const createBrowserAtCursor = (editor: Editor): void => {
      const { x: sx, y: sy } = cursorRef.current
      const pagePt = editor.screenToPage({ x: sx, y: sy })
      const x = pagePt.x - BROWSER_W / 2
      const y = pagePt.y - BROWSER_H / 2

      const shapeId: TLShapeId = createShapeId()

      editor.createShape<BrowserShape>({
        id: shapeId,
        type: 'browser-shape',
        x,
        y,
        props: { w: BROWSER_W, h: BROWSER_H, url: 'https://google.com', tabId: '' },
      })
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const isMod = e.ctrlKey || e.metaKey
      if (!isMod || e.repeat) return

      // Don’t trigger hotkeys while typing
      const ae = document.activeElement as HTMLElement | null
      const tag = (ae?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || ae?.isContentEditable) return

      const editor = editorRef.current
      if (!editor) return

      const key = e.key.toLowerCase()

      // New Tab: Ctrl/Cmd + T (throttled)
      if (key === 't' && !e.shiftKey && !e.altKey) {
        const now = performance.now()
        if (now - lastTriggerAtRef.current < 200) return
        lastTriggerAtRef.current = now

        e.preventDefault()
        e.stopPropagation()
        createBrowserAtCursor(editor)
        return
      }

      // Group: Ctrl/Cmd + G
      if (key === 'g' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        const ids = editor.getSelectedShapeIds()
        if (ids.length >= 2) {
          editor.groupShapes(ids)
        }
        return
      }

      // Ungroup: Shift + Ctrl/Cmd + G
      if (key === 'g' && e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        const ids = editor.getSelectedShapeIds()
        if (ids.length > 0) {
          editor.ungroupShapes(ids)
        }
        return
      }
    }

    window.addEventListener('keydown', onKeyDown, captureOpts)
    return () => window.removeEventListener('keydown', onKeyDown, captureOpts)
  }, [BROWSER_W, BROWSER_H, editorRef])

  // Handle popup → create a new BrowserShape near the opener (robust + correct anchor match)
  useEffect(() => {
    const api = window.overlay
    if (!api?.onPopupRequest) return

    type PopupEvt = { url: string; openerTabId?: string; parentTabId?: string }

    const off = api.onPopupRequest((evt: PopupEvt) => {
      const ed = editorRef.current
      if (!ed) return

      const openerTabId = evt.openerTabId ?? evt.parentTabId ?? ''
      const { url } = evt

      const GAP = 16
      const STEP = 24
      const RANGE = 240
      const w = BROWSER_W
      const h = BROWSER_H

      const all = ed.getCurrentPageShapes()
      const browsers = all.filter((s): s is BrowserShape => s.type === 'browser-shape')
      const vp = ed.getViewportPageBounds()

      // Anchor: opener tab (by props.tabId OR shape.id) → selected → none
      const byOpener = openerTabId
        ? browsers.find(s => s.props.tabId === openerTabId || s.id === openerTabId)
        : undefined
      const selected = byOpener
        ? undefined
        : ed.getSelectedShapes().find((s): s is BrowserShape => s.type === 'browser-shape')
      const anchor = byOpener ?? selected

      const inVp = (x: number, y: number): boolean =>
        x >= vp.minX + GAP && y >= vp.minY + GAP && x + w <= vp.maxX - GAP && y + h <= vp.maxY - GAP

      // AABB overlap vs ALL shapes — include the anchor too so we never place on top of it
      const overlapsAny = (x: number, y: number): boolean => {
        const ax1 = x, ay1 = y, ax2 = x + w, ay2 = y + h
        for (const s of all) {
          const b = ed.getShapePageBounds(s.id)
          if (!b) continue
          const bx1 = b.x, by1 = b.y, bx2 = b.x + b.w, by2 = b.y + b.h
          const separated = ax2 <= bx1 || bx2 <= ax1 || ay2 <= by1 || by2 <= ay1
          if (!separated) return true
        }
        return false
      }

      // Slide-scan along a side from a base point
      const scanSide = (baseX: number, baseY: number, orient: 'v' | 'h'): { x: number; y: number } | null => {
        if (!inVp(baseX, baseY)) return null
        const maxSteps = Math.ceil(RANGE / STEP)
        for (let k = 0; k <= maxSteps; k++) {
          const offs = k === 0 ? [0] : [k * STEP, -k * STEP]
          for (const off of offs) {
            const x = orient === 'v' ? baseX : baseX + off
            const y = orient === 'v' ? baseY + off : baseY
            if (!inVp(x, y)) continue
            if (!overlapsAny(x, y)) return { x, y }
          }
        }
        return null
      }

      // Try around a given rect (R→L→B→T), each with sliding
      const placeAround = (ax: number, ay: number, aw: number, ah: number): { x: number; y: number } | null => {
        const r = scanSide(ax + aw + GAP, ay, 'v'); if (r) return r   // right
        const l = scanSide(ax - GAP - w,  ay, 'v'); if (l) return l   // left
        const b = scanSide(ax, ay + ah + GAP, 'h'); if (b) return b   // below
        const t = scanSide(ax, ay - GAP - h,  'h'); if (t) return t   // above
        return null
      }

      let x: number
      let y: number

      if (anchor) {
        // 1) Sides around the anchor
        const near = placeAround(anchor.x, anchor.y, anchor.props.w, anchor.props.h)
        if (near) {
          ({ x, y } = near)
        } else {
          // 2) Corner “cells” around the anchor
          const corners: Array<{ ax: number; ay: number; aw: number; ah: number }> = [
            { ax: anchor.x - GAP - w,              ay: anchor.y - GAP - h,              aw: w, ah: h }, // TL
            { ax: anchor.x + anchor.props.w + GAP, ay: anchor.y - GAP - h,              aw: w, ah: h }, // TR
            { ax: anchor.x - GAP - w,              ay: anchor.y + anchor.props.h + GAP, aw: w, ah: h }, // BL
            { ax: anchor.x + anchor.props.w + GAP, ay: anchor.y + anchor.props.h + GAP, aw: w, ah: h }, // BR
          ]

          let placed: { x: number; y: number } | null = null

          // 2a) Try each corner cell directly
          for (const c of corners) {
            if (inVp(c.ax, c.ay) && !overlapsAny(c.ax, c.ay)) { placed = { x: c.ax, y: c.ay }; break }
          }

          // 2b) Try sides around each corner cell (with sliding)
          if (!placed) {
            for (const c of corners) {
              const p = placeAround(c.ax, c.ay, c.aw, c.ah)
              if (p) { placed = p; break }
            }
          }

          if (placed) {
            ({ x, y } = placed)
          } else {
            // 3) Clamp *away* from the anchor and ensure no overlap
            const clampCandidates: Array<{ x: number; y: number }> = [
              { x: Math.min(Math.max(anchor.x + anchor.props.w + GAP, vp.minX + GAP), vp.maxX - w - GAP), y: anchor.y }, // right-clamped
              { x: Math.min(Math.max(anchor.x - GAP - w,           vp.minX + GAP), vp.maxX - w - GAP),     y: anchor.y }, // left-clamped
              { x: anchor.x, y: Math.min(Math.max(anchor.y + anchor.props.h + GAP, vp.minY + GAP), vp.maxY - h - GAP) }, // below-clamped
              { x: anchor.x, y: Math.min(Math.max(anchor.y - GAP - h,              vp.minY + GAP), vp.maxY - h - GAP) }, // above-clamped
            ]
            const safe = clampCandidates.find(p => inVp(p.x, p.y) && !overlapsAny(p.x, p.y))
            if (safe) {
              ({ x, y } = safe)
            } else {
              // 4) Small ring scan as absolute fallback (still avoids anchor)
              let found: { x: number; y: number } | null = null
              const max = Math.ceil(RANGE / STEP)
              outer: for (let r = 1; r <= max; r++) {
                const d = r * STEP
                const ring = [
                  { x: anchor.x + d, y: anchor.y },
                  { x: anchor.x - d, y: anchor.y },
                  { x: anchor.x,     y: anchor.y + d },
                  { x: anchor.x,     y: anchor.y - d },
                ]
                for (const p of ring) {
                  if (inVp(p.x, p.y) && !overlapsAny(p.x, p.y)) { found = p; break outer }
                }
              }
              if (found) {
                ({ x, y } = found)
              } else {
                // 5) Center-ish but still avoid overlap
                const c = ed.screenToPage({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
                const centers = [
                  { x: c.x - w / 2,         y: c.y - h / 2 },
                  { x: c.x - w / 2 + 24,    y: c.y - h / 2 + 24 },
                ]
                const free = centers.find(p => inVp(p.x, p.y) && !overlapsAny(p.x, p.y))
                if (free) ({ x, y } = free)
                else {
                  // final clamp (cannot overlap due to overlapsAny guard above)
                  x = Math.min(Math.max(anchor.x, vp.minX + GAP), vp.maxX - w - GAP)
                  y = Math.min(Math.max(anchor.y, vp.minY + GAP), vp.maxY - h - GAP)
                }
              }
            }
          }
        }
      } else {
        // No anchor → center-ish, avoid overlaps
        const c = ed.screenToPage({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
        const centers = [
          { x: c.x - w / 2,      y: c.y - h / 2 },
          { x: c.x - w / 2 + 24, y: c.y - h / 2 + 24 },
        ]
        const pick = centers.find(p => inVp(p.x, p.y) && !overlapsAny(p.x, p.y)) ?? centers[0]
        x = pick.x
        y = pick.y
      }

      // Create shape with a valid tldraw id and ACK with child id so main can clear sticky lock
      const childTabId: TLShapeId = createShapeId()

      ed.createShape<BrowserShape>({
        id: childTabId,
        type: 'browser-shape',
        x,
        y,
        props: { w, h, url, tabId: '' },
      })

      if (openerTabId && api.popupAck) {
        void api.popupAck({ openerTabId, url, childTabId })
      }
    })

    return off
  }, [BROWSER_W, BROWSER_H, editorRef])

  return null
}
