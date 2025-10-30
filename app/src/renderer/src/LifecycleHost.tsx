import { useEffect, useMemo, useRef } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { useLifecycleManager } from './useLifecycleManager'
import type { OverlayAPI } from '../../types/overlay'

declare global {
  interface Window {
    overlay: OverlayAPI
    __tabState?: Map<string, 'hot' | 'warm' | 'frozen' | 'discarded'>
    __tabThumbs?: Map<string, { url: string; dataUrlWebp: string }>
  }
}

const TAB_ACTIVITY_EVENT = 'paper:tab-activity' as const
const NEW_TAB_EVENT = 'paper:new-tab' as const

type TabActivityDetail = Readonly<{ tabId: string }>
type NewTabDetail = Readonly<{ tabId: string; shapeId: TLShapeId }>



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

/* ------------------------------------------------------------------ */

if (!window.__tabState) window.__tabState = new Map()
if (!window.__tabThumbs) window.__tabThumbs = new Map()


export default function LifecycleHost({ editorRef }: Props) {
  // Selection-driven “last interaction” timestamps
  const lastInteraction = useRef<Map<TLShapeId, number>>(new Map())
  const tabToShape = useRef(new Map<string, TLShapeId>())

const bumpInteractionByShapeId = (shapeId: TLShapeId): void => {
  lastInteraction.current.set(shapeId, performance.now())
}

const bumpInteractionByTabId = (tabId: string): void => {
  const shapeId = tabToShape.current.get(tabId)
  if (shapeId) bumpInteractionByShapeId(shapeId)
}


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
        const rec = n as {
          kind: 'flags'
          tabId: string
          flags: { audible: boolean; capturing: boolean; devtools: boolean; downloads: boolean; pinned: boolean }
        }
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

      // Thumbnails: capture (main returns PNG), convert to WebP, store once
      snapshot: async (tabId: string, maxWidth = 640) => {
        const res = await window.overlay.snapshot({ tabId, maxWidth })
        if (!('ok' in res) || !res.ok) return null

        const webp = res.dataUrl
        // Tag with current URL to avoid duplicates
        const nav = await window.overlay.getNavigationState({ tabId })
        const currentUrl = ('ok' in nav && nav.ok) ? (nav.currentUrl ?? 'about:blank') : 'about:blank'
        window.__tabThumbs!.set(tabId, { url: currentUrl, dataUrlWebp: webp })
        return webp
      },
    }
  }, [editorRef])

  const outputs = useMemo(() => {
    return {
      setLifecycle: (shapeId: TLShapeId, state: 'hot' | 'warm' | 'frozen' | 'discarded') => {
        // Update per-tab state map for BrowserShapeUtil / UI
        const ed = editorRef.current
        if (ed) {
          const info = readTabInfoFromShape(ed, shapeId)
          if (info) {
            window.__tabState!.set(info.tabId, state)
            // If we demote and there is no thumbnail yet, capture once in background
            if ((state === 'warm' || state === 'frozen') && !window.__tabThumbs!.has(info.tabId)) {
              void inputs.snapshot(info.tabId, 640)
            }
          }
        }
      },
    }
  }, [editorRef, inputs])

  // Conservative but reasonable defaults
  const limits = useMemo(() => ({
    hotCapNormal: 6,      // >45%: in-view toggling; cap can be relaxed by the manager
    hotCapOverview: 6,    // ≤45%: keep exactly 6 HOT (policy)
    liveCap: 14,
    warmIdleMs: 15_000,
    freezeHiddenMs: 240_000,
    discardHiddenMs: 2_400_000,
    tinyPxFloor: 48_000,
  }), [])

  useEffect(() => {
  const onActivity = (e: Event): void => {
    const detail = (e as CustomEvent<TabActivityDetail>).detail
    if (detail?.tabId) bumpInteractionByTabId(detail.tabId)
  }

  const onNewTab = (e: Event): void => {
    const detail = (e as CustomEvent<NewTabDetail>).detail
    if (detail?.tabId && detail?.shapeId) {
      tabToShape.current.set(detail.tabId, detail.shapeId)
      bumpInteractionByShapeId(detail.shapeId) // creation counts as interaction
    }
  }

  window.addEventListener(TAB_ACTIVITY_EVENT, onActivity as EventListener, { capture: true })
  window.addEventListener(NEW_TAB_EVENT, onNewTab as EventListener, { capture: true })

  // Also bump on overlay events (clicking links / navigations)
  const api = window.overlay
  const offUrl = api.onUrlUpdate(({ tabId }) => { bumpInteractionByTabId(tabId) })
  const offNav = api.onNavFinished(({ tabId }) => { bumpInteractionByTabId(tabId) })

  return () => {
    window.removeEventListener(TAB_ACTIVITY_EVENT, onActivity as EventListener, { capture: true } as AddEventListenerOptions)
    window.removeEventListener(NEW_TAB_EVENT, onNewTab as EventListener, { capture: true } as AddEventListenerOptions)
    offUrl()
    offNav()
  }
}, [])


  // Snapshot strictly on nav-finished, and only if currently HOT
  useEffect(() => {
    const off = window.overlay.onNavFinished(async ({ tabId }: { tabId: string; at: number }) => {
      const isHot = window.__tabState!.get(tabId) === 'hot'
      if (!isHot) return

      const nav = await window.overlay.getNavigationState({ tabId })
      if (!('ok' in nav) || !nav.ok) return
      const currentUrl = nav.currentUrl ?? 'about:blank'

      const prev = window.__tabThumbs!.get(tabId)
      if (prev && prev.url === currentUrl) return

      // small delay so first stable paint is captured
      setTimeout(() => { void inputs.snapshot(tabId, 640) }, 80)
    })
    return () => off()
  }, [inputs])

  useLifecycleManager(inputs, outputs, limits)
  return null
}
