import { useEffect, useRef } from 'react'
import type { TLShapeId } from 'tldraw'

export type LifecycleState = 'live' | 'frozen' | 'discarded'
export type PlacementState = 'active' | 'background'

export interface ShapeGeom { readonly id: TLShapeId; readonly w: number; readonly h: number; readonly overlap: number }
export interface TabInfo { readonly tabId: string; readonly url: string }

export interface Inputs {
  readonly getVisibleShapes: () => ReadonlyArray<ShapeGeom>
  readonly getCamera: () => { zoom: number }
  readonly getTabInfo: (shapeId: TLShapeId) => TabInfo | null
  readonly now: () => number
  readonly getLastInteractionMs: (shapeId: TLShapeId) => number | undefined
  readonly hasThumb: (shapeId: TLShapeId) => boolean
}

export interface Outputs {
  readonly setLifecycle: (shapeId: TLShapeId, state: LifecycleState) => void
  readonly setPlacement: (shapeId: TLShapeId, placement: PlacementState, needThumb: boolean) => void
}

export interface Limits {
  readonly hotCapOverview: number
  readonly tinyPxFloor: number
  readonly freezeHiddenMs: number      // live → frozen
  readonly discardFrozenMs: number     // frozen → discarded
}

const OVERVIEW_ZOOM_CUTOFF = 0.3
const ZOOM_SETTLE_MS = 90
const PAN_SETTLE_MS = 60

type Life = 'live' | 'frozen' | 'discarded'
type Tracked = {
  readonly tabId: string
  shapeId: TLShapeId
  life: Life
  lastInteractionAt: number
  lastLifecycleSent: Life | null
  lastPlacementSent: PlacementState | null
}

export function useLifecycleManager(inputs: Inputs, outputs: Outputs, limits: Limits): void {
  const st = useRef<{
    byTab: Map<string, Tracked>
    byShape: Map<TLShapeId, string>
    lastZoom: number
    lastZoomAt: number
    lastVisSig: string
    lastPanAt: number
  }>({
    byTab: new Map(),
    byShape: new Map(),
    lastZoom: 1,
    lastZoomAt: 0,
    lastVisSig: '',
    lastPanAt: 0,
  })

  // ---- 1. life timers ----
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = inputs.now()

      // interaction → wake
      for (const [shapeId, tabId] of st.current.byShape) {
        const tracked = st.current.byTab.get(tabId)
        if (!tracked) continue
        const last = inputs.getLastInteractionMs(shapeId)
        if (typeof last === 'number' && last > tracked.lastInteractionAt) {
          tracked.lastInteractionAt = last
          if (tracked.life !== 'live') tracked.life = 'live'
        }
      }

      // age down
      for (const tracked of st.current.byTab.values()) {
        const idle = now - tracked.lastInteractionAt
        if (tracked.life === 'live') {
          if (idle >= limits.freezeHiddenMs) {
            tracked.life = 'frozen'
          }
        } else if (tracked.life === 'frozen') {
          if (idle >= limits.freezeHiddenMs + limits.discardFrozenMs) {
            tracked.life = 'discarded'
          }
        }

        if (tracked.life !== tracked.lastLifecycleSent) {
          outputs.setLifecycle(tracked.shapeId, tracked.life)
          tracked.lastLifecycleSent = tracked.life
        }
      }
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [inputs, outputs, limits])

  // ---- 2. camera / placement ----
  useEffect(() => {
    let raf = 0
    const loop = (): void => {
      raf = requestAnimationFrame(loop)

      const now = inputs.now()
      const { zoom } = inputs.getCamera()
      const vis = inputs.getVisibleShapes()

      // track zoom changes
      if (Math.abs(zoom - st.current.lastZoom) > 0.0005) {
        st.current.lastZoom = zoom
        st.current.lastZoomAt = now
      }

      // discover visible tabs
      const sig: Array<string> = []
      const visibleTabs: Array<{ tabId: string; shapeId: TLShapeId; px: number }> = []
      for (const g of vis) {
        const ov = g.overlap < 0 ? 0 : g.overlap > 1 ? 1 : g.overlap
        const px = g.w * g.h * ov
        if (px < limits.tinyPxFloor) continue
        const info = inputs.getTabInfo(g.id)
        if (!info) continue

        sig.push(info.tabId)
        visibleTabs.push({ tabId: info.tabId, shapeId: g.id, px })
        st.current.byShape.set(g.id, info.tabId)

        const existing = st.current.byTab.get(info.tabId)
        if (!existing) {
          st.current.byTab.set(info.tabId, {
            tabId: info.tabId,
            shapeId: g.id,
            life: 'live',
            lastInteractionAt: now,
            lastLifecycleSent: null,
            lastPlacementSent: null,
          })
        } else {
          existing.shapeId = g.id
        }
      }

      const visSig = sig.sort().join('|')
      if (visSig !== st.current.lastVisSig) {
        st.current.lastVisSig = visSig
        st.current.lastPanAt = now
      }

      // wait for camera to settle
      if (now - st.current.lastZoomAt < ZOOM_SETTLE_MS) return
      if (now - st.current.lastPanAt < PAN_SETTLE_MS) return

      // placement only for live tabs
      const liveTabs = Array.from(st.current.byTab.values()).filter((t) => t.life === 'live')
      if (liveTabs.length === 0) return

      if (zoom >= OVERVIEW_ZOOM_CUTOFF) {
        // detail → actual visibility
        const visSet = new Set<string>(visibleTabs.map((v) => v.tabId))
        for (const t of liveTabs) {
          const placement: PlacementState = visSet.has(t.tabId) ? 'active' : 'background'
          if (placement !== t.lastPlacementSent) {
            const needThumb = placement === 'background' && !inputs.hasThumb(t.shapeId)
            outputs.setPlacement(t.shapeId, placement, needThumb)
            t.lastPlacementSent = placement
          } else if (placement === 'background') {
            const needThumb = !inputs.hasThumb(t.shapeId)
            if (needThumb) outputs.setPlacement(t.shapeId, placement, true)
          }
        }
      } else {
        // overview → NEW RULE:
        // if total live ≤ cap → everybody active
        if (liveTabs.length <= limits.hotCapOverview) {
          for (const t of liveTabs) {
            if (t.lastPlacementSent !== 'active') {
              outputs.setPlacement(t.shapeId, 'active', false)
              t.lastPlacementSent = 'active'
            }
          }
        } else {
          // else fall back to top-N by interaction
          const sorted = liveTabs.slice().sort((a, b) => b.lastInteractionAt - a.lastInteractionAt)
          const keep = new Set<string>(sorted.slice(0, limits.hotCapOverview).map((t) => t.tabId))
          for (const t of liveTabs) {
            const placement: PlacementState = keep.has(t.tabId) ? 'active' : 'background'
            if (placement !== t.lastPlacementSent) {
              const needThumb = placement === 'background' && !inputs.hasThumb(t.shapeId)
              outputs.setPlacement(t.shapeId, placement, needThumb)
              t.lastPlacementSent = placement
            } else if (placement === 'background') {
              const needThumb = !inputs.hasThumb(t.shapeId)
              if (needThumb) outputs.setPlacement(t.shapeId, placement, true)
            }
          }
        }
      }
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [inputs, outputs, limits])
}
