import { useEffect, useMemo, useRef } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { useLifecycleManager } from './useLifecycleManager'
import type { OverlayAPI } from '../../types/overlay'

declare global {
  interface Window {
    overlay: OverlayAPI
    __tabState?: Map<string, 'live' | 'frozen' | 'discarded'>
    __tabThumbs?: Map<string, { url: string; dataUrlWebp: string }>
    __activeTabs?: Set<string>
  }
}

const TAB_ACTIVITY_EVENT = 'paper:tab-activity' as const
const NEW_TAB_EVENT = 'paper:new-tab' as const

type TabActivityDetail = Readonly<{ tabId: string }>
type NewTabDetail = Readonly<{ tabId: string; shapeId: TLShapeId }>

type Props = { editorRef: React.RefObject<Editor | null> }

type Bounds = { x: number; y: number; w: number; h: number }

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

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

if (!window.__tabState) window.__tabState = new Map()
if (!window.__tabThumbs) window.__tabThumbs = new Map()
if (!window.__activeTabs) window.__activeTabs = new Set()

export default function LifecycleHost({ editorRef }: Props) {
  const lastInteraction = useRef<Map<TLShapeId, number>>(new Map())
  const tabToShape = useRef(new Map<string, TLShapeId>())
  useEffect(() => {
    const off = window.overlay.onNotice((n) => {
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

  useEffect(() => {
    const api = window.overlay
    const onActivity = (e: Event): void => {
      const detail = (e as CustomEvent<TabActivityDetail>).detail
      const tabId = detail?.tabId
      if (!tabId) return
      bumpInteractionByTabId(tabId)
      const shapeId = tabToShape.current.get(tabId)
      if (shapeId) { void revive(shapeId) }
    }
    const onNewTab = (e: Event): void => {
      const detail = (e as CustomEvent<NewTabDetail>).detail
      if (detail?.tabId && detail?.shapeId) {
        tabToShape.current.set(detail.tabId, detail.shapeId)
        bumpInteractionByShapeId(detail.shapeId)
      }
    }
    window.addEventListener(TAB_ACTIVITY_EVENT, onActivity as EventListener, { capture: true })
    window.addEventListener(NEW_TAB_EVENT, onNewTab as EventListener, { capture: true })
    const offUrl = api.onUrlUpdate(({ tabId }) => bumpInteractionByTabId(tabId))
    const offNav = api.onNavFinished(({ tabId }) => bumpInteractionByTabId(tabId))
    return () => {
      window.removeEventListener(TAB_ACTIVITY_EVENT, onActivity as EventListener, { capture: true } as AddEventListenerOptions)
      window.removeEventListener(NEW_TAB_EVENT, onNewTab as EventListener, { capture: true } as AddEventListenerOptions)
      offUrl()
      offNav()
    }
  }, [])
  const flagsByTab = useRef(
    new Map<string, { audible: boolean; capturing: boolean; devtools: boolean; downloads: boolean; pinned: boolean }>()
  )
  const bumpInteractionByShapeId = (shapeId: TLShapeId): void => {
    lastInteraction.current.set(shapeId, performance.now())
  }
  const bumpInteractionByTabId = (tabId: string): void => {
    const shapeId = tabToShape.current.get(tabId)
    if (shapeId) bumpInteractionByShapeId(shapeId)
  }

  const revive = async (shapeId: TLShapeId): Promise<void> => {
    const ed = editorRef.current
    if (!ed) return
    const info = readTabInfoFromShape(ed, shapeId)
    if (!info) return
    const { tabId } = info
    const tag = window.__tabState?.get(tabId)
    if (tag === 'live') return
    if (tag === 'frozen') {
      await window.overlay.thaw({ tabId })
      await window.overlay.show({ tabId })
    } else if (tag === 'discarded') {
      await window.overlay.createTab({ shapeId, restore: true })
      await window.overlay.show({ tabId })
    } else {
      return
    }
    window.__tabState!.set(tabId, 'live')
    lastInteraction.current.set(shapeId, performance.now())
    tabToShape.current.set(tabId, shapeId)
    window.dispatchEvent(
      new CustomEvent('paper:tab-activity', { detail: { tabId } })
    )
  }

  const inputs = useMemo(() => {
    return {
      getVisibleShapes: (): ReadonlyArray<{ id: TLShapeId; w: number; h: number; overlap: number }> => {
        const ed = editorRef.current
        if (!ed) return []
        const vp = ed.getViewportPageBounds()
        const vpB: Bounds = { x: vp.minX, y: vp.minY, w: vp.maxX - vp.minX, h: vp.maxY - vp.minY }
        const out: Array<{ id: TLShapeId; w: number; h: number; overlap: number }> = []
        for (const s of ed.getCurrentPageShapes()) {
          const id = s.id as TLShapeId
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
      getTabInfo: (shapeId: TLShapeId) => {
        const ed = editorRef.current
        if (!ed) return null
        return readTabInfoFromShape(ed, shapeId)
      },
      now: () => performance.now(),
      getLastInteractionMs: (shapeId: TLShapeId) => lastInteraction.current.get(shapeId),
      hasThumb: (shapeId: TLShapeId): boolean => {
        const ed = editorRef.current
        if (!ed) return false
        const info = readTabInfoFromShape(ed, shapeId)
        if (!info) return false
        const t = window.__tabThumbs?.get(info.tabId)
        return !!t && typeof t.dataUrlWebp === 'string' && t.dataUrlWebp.length > 0
      },
    }
  }, [editorRef])

  const snapshot = useMemo(() => {
    return async (tabId: string, maxWidth = 896): Promise<void> => {
      try {
        const nav = await window.overlay.getNavigationState({ tabId })
        if (!('ok' in nav) || !nav.ok || nav.isLoading) return
        const currentUrl = nav.currentUrl ?? 'about:blank'
        const res = await window.overlay.snapshot({ tabId, maxWidth })
        if (!('ok' in res) || !res.ok || typeof res.dataUrl !== 'string' || res.dataUrl.length === 0) return
        const webp = res.dataUrl
        window.__tabThumbs?.set(tabId, { url: currentUrl, dataUrlWebp: webp })
        void window.overlay.saveThumb({ tabId, url: currentUrl, dataUrlWebp: webp }).catch(() => { })
      } catch {
        /* ignore */
      }
    }
  }, [])

  const outputs = useMemo(() => {
    return {
      setLifecycle: (shapeId, state): void => {
        const ed = editorRef.current
        if (!ed) return
        const info = readTabInfoFromShape(ed, shapeId)
        if (!info) return
        const { tabId } = info
        if (state === 'live') {
          return
        }
        if (state === 'frozen') {
          ; (async () => {
            await window.overlay.hide({ tabId })
            await window.overlay.freeze({ tabId })
            window.__activeTabs!.delete(tabId)
            window.__tabState!.set(tabId, 'frozen')
          })()
          return
        }
        ; (async () => {
          await window.overlay.destroy({ tabId, discard: true })
          window.__activeTabs!.delete(tabId)
          window.__tabState!.set(tabId, 'discarded')
        })()
      },

      setPlacement: (
        shapeId: TLShapeId,
        placement: 'active' | 'background',
        needThumb: boolean
      ): void => {
        const ed = editorRef.current
        if (!ed) return
        const info = readTabInfoFromShape(ed, shapeId)
        if (!info) return
        const { tabId } = info
        if (placement === 'active') {
          (async () => {
            await window.overlay.show({ tabId })
            window.__activeTabs!.add(tabId)
          })()
          return
        }
        const wasActive = window.__activeTabs!.has(tabId);
        (async () => {
          if (needThumb && wasActive) {
            const bounds = ed.getShapePageBounds(shapeId) // <- define it
            if (bounds) {
              const zoom = ed.getCamera().z || 1
              const dpr = window.devicePixelRatio || 1
              const widthPx = Math.round(bounds.w * zoom * dpr)
              await snapshot(tabId, widthPx)             // forwards to payload.maxWidth
            }
            // if bounds is null this frame, just skip snapshot
          }
          await window.overlay.hide({ tabId })
          window.__activeTabs!.delete(tabId)
        })()
      },
    }
  }, [editorRef, snapshot])

  const MIN = 60_000
  const limits = useMemo(
    () => ({
      hotCapOverview: 8,
      tinyPxFloor: 48_000,
      freezeHiddenMs: 0.2 * MIN,
      discardFrozenMs: 9 * MIN,
    }),
    []
  )
  useLifecycleManager(inputs, outputs, limits)
  return null
}
