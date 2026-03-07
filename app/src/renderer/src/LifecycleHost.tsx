/*import { useEffect, useMemo, useRef } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { useLifecycleManager } from './useLifecycleManager'
import type { OverlayAPI } from '../../types/overlay'
import { NAV_BAR_HEIGHT } from './components/NavigationBar'
import { browserTabSuspendRegistry } from './Utils/BrowserShapeUtil'

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
const PLACEMENT_EVENT = 'paper:placement-changed' as const

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

    if (tag === 'discarded') {
      await window.overlay.createTab({ shapeId: tabId, restore: true })
    } else if (tag === 'frozen') {
      await window.overlay.thaw({ tabId })
    }
    await window.overlay.show({ tabId })
    window.__activeTabs!.add(tabId)
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
          if (s.type !== 'browser-shape') continue

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
        const cam = ed?.getCamera()
        return {
          x: cam?.x ?? 0,
          y: cam?.y ?? 0,
          zoom: getZoom(ed)
        }
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



  /*const outputs = useMemo(() => {
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
            window.dispatchEvent(new CustomEvent(PLACEMENT_EVENT, { detail: { tabId, placement: 'active' } }))
          })()
          return
        }
        const wasActive = window.__activeTabs!.has(tabId);
        (async () => {
          if (needThumb && wasActive) {
            const bounds = ed.getShapePageBounds(shapeId)
            if (bounds) {
              const zoom = ed.getCamera().z || 1
              const dpr = window.devicePixelRatio || 1
              const shapeType = ed.getShape(shapeId)
              const shapeW = (shapeType as any)?.props?.w ?? bounds.w
              const widthPx = Math.round(shapeW * zoom * dpr)
              await snapshot(tabId, widthPx)
            }
          }
          await window.overlay.hide({ tabId })
          window.__activeTabs!.delete(tabId)
          window.dispatchEvent(new CustomEvent(PLACEMENT_EVENT, { detail: { tabId, placement: 'background' } }))
        })()
      },
    }
  }, [editorRef, snapshot])

  const MIN = 60_000
  const limits = useMemo(
    () => ({
      hotCapOverview: 8,
      tinyPxFloor: 48_000,
      freezeHiddenMs: 3 * MIN,
      discardFrozenMs: 9 * MIN,
    }),
    []
  )
  useLifecycleManager(inputs, outputs, limits)

  // BATCH LAYOUT SYNC ENGINE
  useEffect(() => {
    let raf = 0
    let previousActiveTabs = new Set<string>()
    const lastSent = new Map<string, { x: number; y: number; w: number; h: number }>()
    const lastZoomSent = new Map<string, number>()
    const ZOOM_EPS = 0.0125

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const ed = editorRef.current
      if (!ed) return

      const activeTabs = window.__activeTabs
      if (!activeTabs || activeTabs.size === 0) {
        previousActiveTabs.clear()
        return
      }

      const newlyActive = new Set<string>()
      for (const tabId of activeTabs) {
        if (!previousActiveTabs.has(tabId)) newlyActive.add(tabId)
      }
      previousActiveTabs = new Set(activeTabs)

      const batch: Array<{ tabId: string; rect: { x: number; y: number; width: number; height: number }; shapeSize: { w: number; h: number }; zIndex: string }> = []
      const zoomBatch: { tabId: string; factor: number }[] = []

      // Fixed: safely grab correct camera zoom
      const zoom = ed.getCamera().z

      for (const tabId of activeTabs) {
        const shapeId = tabToShape.current.get(tabId)
        if (!shapeId) continue

        // Abort layout calculations if the shape is currently in "Fit" mode or suspended
        if (browserTabSuspendRegistry.get(shapeId)?.current) continue
        if (window.__tabState?.get(tabId) !== 'live') continue

        const shape = ed.getShape(shapeId)
        if (!shape || shape.type !== 'browser-shape') continue

        const shapeProps = (shape as any).props
        const shapeSize = { w: shapeProps?.w ?? 800, h: shapeProps?.h ?? 600 }

        const screenPos = ed.pageToScreen({ x: shape.x || 0, y: shape.y || 0 })

        const x = Math.round(screenPos.x) || 0
        const y = Math.round(screenPos.y + NAV_BAR_HEIGHT * zoom) || 0
        let w = Math.round(shapeSize.w * zoom) || 1
        let h = Math.round((shapeSize.h - NAV_BAR_HEIGHT) * zoom) || 1

        if (w <= 0) w = 1
        if (h <= 0) h = 1

        if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(w) || Number.isNaN(h)) {
          console.warn('[LifecycleHost] Skipping NaN bounds for tab:', tabId)
          continue
        }

        const rect = { x, y, width: w, height: h }
        const force = newlyActive.has(tabId)
        const last = lastSent.get(tabId)

        // Calculate absolute deltas
        const deltaX = last ? rect.x - last.x : rect.x;
        const deltaY = last ? rect.y - last.y : rect.y;
        const deltaW = last ? rect.width - last.w : rect.width;
        const deltaH = last ? rect.height - last.h : rect.height;

        const isMoved = !last || deltaX !== 0 || deltaY !== 0 || deltaW !== 0 || deltaH !== 0;

        if (force || isMoved) {
          lastSent.set(tabId, { x: rect.x, y: rect.y, w: rect.width, h: rect.height })

          // Inject Tldraw's native z-index string into the batch so the main process knows stacking order
          batch.push({ tabId, rect, shapeSize, zIndex: shape.index })

          // Layout monitoring output
          console.log(`[IPC Layout Sync] Tab: ${tabId}`, {
            trigger: force ? 'NEW_ACTIVE' : (Math.abs(zoom - (lastZoomSent.get(tabId) ?? -1)) > ZOOM_EPS ? 'CAMERA_ZOOM' : 'SHAPE_MOVE_OR_PAN'),
            delta: last ? { x: deltaX, y: deltaY, w: deltaW, h: deltaH } : 'INITIAL',
            zIndex: shape.index,
            zoom: zoom,
            bounds: rect
          });
        }

        if (force || Math.abs(zoom - (lastZoomSent.get(tabId) ?? -1)) > ZOOM_EPS) {
          lastZoomSent.set(tabId, zoom)
          zoomBatch.push({ tabId, factor: zoom })
        }
      }

      if (batch.length > 0) {
        void window.overlay.setBounds(batch)
      }
      if (zoomBatch.length > 0) {
        void window.overlay.setZoom(zoomBatch)
      }
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [editorRef])

  return null
}
*/