import { useEffect, useRef } from 'react'
import type { TLShapeId } from 'tldraw'

export type LifecycleState = 'live' | 'frozen' | 'discarded'
export type PlacementState = 'active' | 'background'

export interface ShapeGeom {
  readonly id: TLShapeId
  readonly w: number
  readonly h: number
  readonly overlap: number
}

export interface TabInfo {
  readonly tabId: string
  readonly url: string
}

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
  readonly freezeHiddenMs: number
  readonly discardFrozenMs: number
}

// Hysteresis to prevent flip/flop around 30%
const OVERVIEW_ENTER_ZOOM = 0.30   // detail -> overview when zoom <= 0.30
const OVERVIEW_EXIT_ZOOM  = 0.32   // overview -> detail when zoom > 0.32
const ZOOM_SETTLE_MS = 90
const PAN_SETTLE_MS = 60
const ZOOM_EPS = 0.0005
const MODE_SETTLE_MS = 150
const STARTUP_GRACE_MS = 500

type Life = 'live' | 'frozen' | 'discarded'

type Tracked = {
  readonly tabId: string
  shapeId: TLShapeId
  life: Life
  lastInteractionAt: number
  lastLifecycleSent: Life | null
  lastPlacementSent: PlacementState | null
  thumbRequestedForBg: boolean
  lastVisiblePx: number
}

export function useLifecycleManager(
  inputs: Inputs,
  outputs: Outputs,
  limits: Limits,
): void {
  const st = useRef<{
    byTab: Map<string, Tracked>
    byShape: Map<TLShapeId, string>
    lastZoom: number
    lastZoomAt: number
    lastPanSig: number
    lastPanAt: number
    tickingLifecycle: boolean
    mode: 'overview' | 'detail'
    modeChangedAt: number
    startedAt: number
  }>({
    byTab: new Map<string, Tracked>(),
    byShape: new Map<TLShapeId, string>(),
    lastZoom: 1,
    lastZoomAt: 0,
    lastPanSig: 0,
    lastPanAt: 0,
    tickingLifecycle: false,
    mode: 'detail',
    modeChangedAt: 0,
    startedAt: performance.now(),
  })

  /* =========================================================
   * 1. lifecycle timer: live → frozen → discarded
   * ======================================================= */
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (st.current.tickingLifecycle) return
      st.current.tickingLifecycle = true
      try {
        const now = inputs.now()
        // refresh interactions
        for (const [shapeId, tabId] of st.current.byShape) {
          const tracked = st.current.byTab.get(tabId)
          if (tracked == null) continue
          const last = inputs.getLastInteractionMs(shapeId)
          if (typeof last === 'number' && last > tracked.lastInteractionAt) {
            tracked.lastInteractionAt = last
            if (tracked.life !== 'live') {
              tracked.life = 'live'
            }
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
      } finally {
        st.current.tickingLifecycle = false
      }
    }, 1_000)
    return () => window.clearInterval(iv)
  }, [inputs, outputs, limits])

  /* =========================================================
   * 2. placement (detail behaves like old script)
   * ======================================================= */
  useEffect(() => {
    let raf = 0

    const loop = (): void => {
      raf = requestAnimationFrame(loop)

      const now = inputs.now()
      const { zoom } = inputs.getCamera()
      const geoms = inputs.getVisibleShapes()

      // zoom motion tracking
      if (Math.abs(zoom - st.current.lastZoom) > ZOOM_EPS) {
        st.current.lastZoom = zoom
        st.current.lastZoomAt = now
      }

      // -------- Stable mode with hysteresis --------
      let nextMode = st.current.mode
      if (st.current.mode === 'detail' && zoom <= OVERVIEW_ENTER_ZOOM) {
        nextMode = 'overview'
      } else if (st.current.mode === 'overview' && zoom > OVERVIEW_EXIT_ZOOM) {
        nextMode = 'detail'
      }
      if (nextMode !== st.current.mode) {
        st.current.mode = nextMode
        st.current.modeChangedAt = now
        // Don't do placement mutations on the same frame as a mode change
        return
      }
      // brief grace period after mode change to avoid churn
      if (now - st.current.modeChangedAt < MODE_SETTLE_MS) {
        return
      }

      // pan signature like old manager
      let sig = 0
      for (let i = 0; i < geoms.length; i++) {
        const g = geoms[i]!
        // simple signature
        sig = (sig + (g.id as string).length * g.overlap * 1000) | 0
      }
      if (sig !== st.current.lastPanSig) {
        st.current.lastPanSig = sig
        st.current.lastPanAt = now
      }

      // collect visible tabs with px
      const visibleTabs: Array<{ tabId: string; shapeId: TLShapeId; px: number }> = []
      for (const g of geoms) {
        const info = inputs.getTabInfo(g.id)
        if (info == null) continue
        const ov = g.overlap <= 0 ? 0 : g.overlap >= 1 ? 1 : g.overlap
        const px = g.w * g.h * ov
        st.current.byShape.set(g.id, info.tabId)
        const tracked = st.current.byTab.get(info.tabId)
        if (tracked == null) {
          st.current.byTab.set(info.tabId, {
            tabId: info.tabId,
            shapeId: g.id,
            life: 'live',
            lastInteractionAt: now,
            lastLifecycleSent: null,
            lastPlacementSent: null,
            thumbRequestedForBg: false,
            lastVisiblePx: px,
          })
        } else {
          tracked.shapeId = g.id
          tracked.lastVisiblePx = px
        }
        if (px >= limits.tinyPxFloor) {
          visibleTabs.push({ tabId: info.tabId, shapeId: g.id, px })
        }
      }

      const zoomIdle = now - st.current.lastZoomAt >= ZOOM_SETTLE_MS
      const panIdle = now - st.current.lastPanAt >= PAN_SETTLE_MS
      const overviewMode = st.current.mode === 'overview'

      // active live tabs
      const liveTabs = Array.from(st.current.byTab.values()).filter((t) => t.life === 'live')
      if (liveTabs.length === 0) return
      // allow first paint(s) after startup before demotions
      if (now - st.current.startedAt < STARTUP_GRACE_MS) {
        if (liveTabs.length <= limits.hotCapOverview) {
          for (const t of liveTabs) {
            if (t.lastPlacementSent !== 'active') {
              outputs.setPlacement(t.shapeId, 'active', false)
              t.lastPlacementSent = 'active'
              t.thumbRequestedForBg = false
            }
          }
        }
        return
      }

      /* -----------------------------------------------------
       * NOTHING mutational during zoom motion (old behaviour)
       * --------------------------------------------------- */
      if (!zoomIdle) {
        return
      }

      /* -----------------------------------------------------
       * DETAIL (> 30%) — replicate old behaviour
       * --------------------------------------------------- */
      if (!overviewMode) {
        // visible set (only hard-visible, no soft)
        const visibleSet = new Set<string>(visibleTabs.map((v) => v.tabId))

        // if we are panning in detail:
        if (!panIdle) {
          // 1) instant off-screen demote for all live tabs
          for (const t of liveTabs) {
            if (visibleSet.has(t.tabId)) continue
            if (t.lastPlacementSent !== 'background') {
              const needThumb = !inputs.hasThumb(t.shapeId)
              outputs.setPlacement(t.shapeId, 'background', needThumb)
              t.lastPlacementSent = 'background'
              t.thumbRequestedForBg = needThumb
            } else if (!t.thumbRequestedForBg) {
              const needThumb = !inputs.hasThumb(t.shapeId)
              if (needThumb) {
                outputs.setPlacement(t.shapeId, 'background', true)
                t.thumbRequestedForBg = true
              }
            }
          }

          // 2) allow at most one safe promotion per frame, highest px first
          const strongPx = limits.tinyPxFloor * 8
          const ordered = visibleTabs
            .filter((v) => {
              const tracked = st.current.byTab.get(v.tabId)
              return tracked == null ? true : tracked.lastPlacementSent !== 'active'
            })
            .sort((a, b) => b.px - a.px)

          let promoted = false
          for (const v of ordered) {
            if (promoted) break
            if (v.px < strongPx) break
            const tracked = st.current.byTab.get(v.tabId)
            if (tracked == null) continue
            outputs.setPlacement(v.shapeId, 'active', false)
            tracked.lastPlacementSent = 'active'
            tracked.thumbRequestedForBg = false
            promoted = true
          }

          return
        }

        // DETAIL idle (no pan): everyone visible = active, everyone else = background
        for (const t of liveTabs) {
          const isVis = visibleSet.has(t.tabId)
          const nextPlacement: PlacementState = isVis ? 'active' : 'background'
          if (nextPlacement !== t.lastPlacementSent) {
            if (nextPlacement === 'background') {
              const needThumb = !inputs.hasThumb(t.shapeId)
              outputs.setPlacement(t.shapeId, 'background', needThumb)
              t.lastPlacementSent = 'background'
              t.thumbRequestedForBg = needThumb
            } else {
              outputs.setPlacement(t.shapeId, 'active', false)
              t.lastPlacementSent = 'active'
              t.thumbRequestedForBg = false
            }
          } else if (nextPlacement === 'background' && !t.thumbRequestedForBg) {
            const needThumb = !inputs.hasThumb(t.shapeId)
            if (needThumb) {
              outputs.setPlacement(t.shapeId, 'background', true)
              t.thumbRequestedForBg = true
            }
          }
        }

        return
      }

      /* -----------------------------------------------------
       * OVERVIEW (≤ 30%) — cap-based by interaction recency
       * --------------------------------------------------- */
      if (!panIdle) return

      if (liveTabs.length <= limits.hotCapOverview) {
        for (const t of liveTabs) {
          if (t.lastPlacementSent !== 'active') {
            outputs.setPlacement(t.shapeId, 'active', false)
            t.lastPlacementSent = 'active'
            t.thumbRequestedForBg = false
          }
        }
        return
      }

      const sortedByInteraction = liveTabs
        .slice()
        .sort((a, b) => b.lastInteractionAt - a.lastInteractionAt)
      const keep = new Set<string>(sortedByInteraction.slice(0, limits.hotCapOverview).map((t) => t.tabId))

      for (const t of liveTabs) {
        const shouldBeActive = keep.has(t.tabId)
        const nextPlacement: PlacementState = shouldBeActive ? 'active' : 'background'
        if (nextPlacement !== t.lastPlacementSent) {
          if (nextPlacement === 'background') {
            const needThumb = !inputs.hasThumb(t.shapeId)
            outputs.setPlacement(t.shapeId, 'background', needThumb)
            t.lastPlacementSent = 'background'
            t.thumbRequestedForBg = needThumb
          } else {
            outputs.setPlacement(t.shapeId, 'active', false)
            t.lastPlacementSent = 'active'
            t.thumbRequestedForBg = false
          }
        } else if (nextPlacement === 'background' && !t.thumbRequestedForBg) {
          const needThumb = !inputs.hasThumb(t.shapeId)
          if (needThumb) {
            outputs.setPlacement(t.shapeId, 'background', true)
            t.thumbRequestedForBg = true
          }
        }
      }
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [inputs, outputs, limits])
}
