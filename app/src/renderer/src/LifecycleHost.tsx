import { useEffect, useMemo, useRef } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { useLifecycleManager } from './useLifecycleManager'

type Props = { editorRef: React.MutableRefObject<Editor | null> }

type Bounds = { x: number; y: number; w: number; h: number }

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

// Safe page bounds (structural type; tldraw doesn’t export TLBounds)
const getBounds = (ed: Editor, id: TLShapeId): Bounds | null => {
  const b = ed.getShapePageBounds(id)
  if (!b) return null
  return { x: b.x, y: b.y, w: b.w, h: b.h }
}

const intersect = (a: Bounds, b: Bounds): Bounds | null => {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const w = x2 - x1
  const h = y2 - y1
  if (w <= 0 || h <= 0) return null
  return { x: x1, y: y1, w, h }
}

function getZoom(ed: Editor | null): number {
  const z = ed?.getCamera().z
  return typeof z === 'number' ? z : 1
}

// Read url from shape; use shape.id as the tabId (no props.tabId required)
const readTabInfoFromShape = (
  ed: Editor,
  shapeId: TLShapeId
): { tabId: string; url: string } | null => {
  const raw = ed.getShape(shapeId)
  if (!isObj(raw)) return null
  if ((raw as { type?: unknown }).type !== 'browser-shape') return null
  const p = (raw as { props?: unknown }).props
  if (!isObj(p)) return null
  const url = (p as { url?: unknown }).url
  return { tabId: String(shapeId), url: typeof url === 'string' ? url : '' }
}

export default function LifecycleHost({ editorRef }: Props) {
  // Selection-driven “last interaction” timestamps
  const lastInteraction = useRef<Map<TLShapeId, number>>(new Map())

  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    let prev = JSON.stringify(ed.getSelectedShapeIds())
    const t = setInterval(() => {
      const ids = ed.getSelectedShapeIds()
      const sig = JSON.stringify(ids)
      if (sig !== prev) {
        const now = performance.now()
        for (const id of ids) lastInteraction.current.set(id, now)
        prev = sig
      }
    }, 150)
    return () => clearInterval(t)
  }, [editorRef])

  // cache of exempt flags per tabId (filled via overlay notices)
  const flagsByTab = useRef(
    new Map<string, { audible: boolean; capturing: boolean; devtools: boolean; downloads: boolean; pinned: boolean }>()
  )

  // Subscribe once to overlay .onNotice for {kind:'flags'}
  useEffect(() => {
    const off = window.overlay.onNotice(n => {
      if ((n as { kind?: unknown }).kind === 'flags') {
        const rec = n as { kind: 'flags'; tabId: string; flags: { audible: boolean; capturing: boolean; devtools: boolean; downloads: boolean; pinned: boolean } }
        flagsByTab.current.set(rec.tabId, rec.flags)
      }
    })
    return () => off()
  }, [])

  const inputs = useMemo(() => {
    return {
      // Visible shapes + fraction overlap with viewport (bounds-based; no props access)
      getVisibleShapes: (): ReadonlyArray<{ id: TLShapeId; w: number; h: number; overlap: number }> => {
        const ed = editorRef.current
        if (!ed) return []
        const vp = ed.getViewportPageBounds()
        const vpB: Bounds = { x: vp.minX, y: vp.minY, w: vp.maxX - vp.minX, h: vp.maxY - vp.minY }
        const out: Array<{ id: TLShapeId; w: number; h: number; overlap: number }> = []

        for (const s of ed.getCurrentPageShapes()) {
          const id = (s as { id?: unknown }).id as TLShapeId
          const b = getBounds(ed, id)
          if (!b) continue
          const ov = intersect(b, vpB)
          const frac = ov ? (ov.w * ov.h) / (b.w * b.h) : 0
          out.push({ id, w: b.w, h: b.h, overlap: Math.max(0, Math.min(1, frac)) })
        }
        return out
      },

      getCamera: () => {
        const ed = editorRef.current
        return { zoom: getZoom(ed) }
      },

      // shapeId -> tab info (only for your browser-shape)
      getTabInfo: (shapeId: TLShapeId) => {
        const ed = editorRef.current
        if (!ed) return null
        return readTabInfoFromShape(ed, shapeId)
      },

      // Treat “under cursor” as “selected”
      isShapeUnderCursor: (shapeId: TLShapeId) => {
        const ed = editorRef.current
        return ed ? ed.getSelectedShapeIds().includes(shapeId) : false
      },

      now: () => performance.now(),

      // Make unknown shapes “recent” so something becomes HOT on first pass
      getLastInteractionMs: (shapeId: TLShapeId) =>
        lastInteraction.current.get(shapeId),

      // Real flags from overlay notices; default to safe falsy
      getFlags: (shapeId: TLShapeId) => {
        const ed = editorRef.current
        if (!ed) return { audible: false, capturing: false, devtools: false, downloads: false, pinned: false }
        const info = readTabInfoFromShape(ed, shapeId)
        if (!info) return { audible: false, capturing: false, devtools: false, downloads: false, pinned: false }
        return flagsByTab.current.get(info.tabId) ?? { audible: false, capturing: false, devtools: false, downloads: false, pinned: false }
      },

      // Overlay controls (attach/detach & lifecycle)
      show: async (tabId: string) => { await window.overlay.show({ tabId }) },
      hide: async (tabId: string) => { await window.overlay.hide({ tabId }) },
      freeze: async (tabId: string) => { await window.overlay.freeze({ tabId }) },
      thaw: async (tabId: string) => { await window.overlay.thaw({ tabId }) },
      destroy: async (tabId: string) => { await window.overlay.destroy({ tabId }) },

      // Optional: thumbnails (safe no-op right now)
      snapshot: async (_tabId: string, _maxWidth?: number) => { /* no-op for now */ },
    }
  }, [editorRef])

  const outputs = useMemo(() => {
    return {
      setLifecycle: (_shapeId: TLShapeId, _state: 'hot' | 'warm' | 'frozen' | 'discarded') => {
        // Hook for UI chips / debug logs
        // console.debug('[lifecycle]', _shapeId, _state)
      },
    }
  }, [])

  // Conservative but reasonable defaults
  const limits = useMemo(() => ({
    hotCapNormal: 6,
    hotCapOverview: 6,
    liveCap: 14,
    warmIdleMs: 15_000,
    freezeHiddenMs: 240_000,
    discardHiddenMs: 2_400_000,
    tinyPxFloor: 48_000,
  }), [])

  useLifecycleManager(inputs, outputs, limits)
  return null
}
