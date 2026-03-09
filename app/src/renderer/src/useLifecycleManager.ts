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
  readonly getCamera: () => { x: number; y: number; zoom: number }
  readonly getTabInfo: (shapeId: TLShapeId) => TabInfo | null
  readonly getLifecycleState: (tabId: string) => LifecycleState | undefined
  readonly now: () => number
  readonly getLastInteractionMs: (shapeId: TLShapeId) => number | undefined
}

export interface Outputs {
  readonly setLifecycle: (shapeId: TLShapeId, state: LifecycleState) => void
  readonly setPlacement: (shapeId: TLShapeId, placement: PlacementState, needThumb: boolean) => void
}

export interface Limits {
  readonly hotCapOverview: number   // max painting tabs when zoom < ZOOM_CAP_THRESHOLD
  readonly tinyPxFloor: number
  readonly freezeHiddenMs: number
  readonly discardFrozenMs: number
}

// Below this zoom level the paint cap kicks in — you're in "overview" mode.
// At or above it, all live viewport-visible tabs paint normally.
const ZOOM_CAP_THRESHOLD = 0.5

type Tracked = {
  readonly tabId: string
  shapeId: TLShapeId
  life: LifecycleState
  lastInteractionAt: number
  lastLifecycleSent: LifecycleState | null
  lastPlacementSent: PlacementState | null
}

export function useLifecycleManager(inputs: Inputs, outputs: Outputs, limits: Limits): void {
  const st = useRef<{
    byTab: Map<string, Tracked>
    byShape: Map<TLShapeId, string>
    ticking: boolean
  }>({
    byTab: new Map(),
    byShape: new Map(),
    ticking: false,
  })

  // ---- Activity event: bump interaction time and ensure tab is live --------

  useEffect(() => {
    const onActivity = (event: Event): void => {
      const { tabId } = (event as CustomEvent<{ tabId: string }>).detail ?? {}
      if (!tabId) return

      let tracked = st.current.byTab.get(tabId)
      if (!tracked) {
        for (const geom of inputs.getVisibleShapes()) {
          const info = inputs.getTabInfo(geom.id)
          if (!info || info.tabId !== tabId) continue
          tracked = { tabId, shapeId: geom.id, life: 'live', lastInteractionAt: inputs.now(), lastLifecycleSent: null, lastPlacementSent: null }
          st.current.byTab.set(tabId, tracked)
          st.current.byShape.set(geom.id, tabId)
          break
        }
        if (!tracked) return
      }

      tracked.life = 'live'
      tracked.lastInteractionAt = inputs.now()

      if (tracked.lastLifecycleSent !== 'live') {
        outputs.setLifecycle(tracked.shapeId, 'live')
        tracked.lastLifecycleSent = 'live'
      }
    }

    window.addEventListener('paper:tab-activity', onActivity as EventListener)
    return () => window.removeEventListener('paper:tab-activity', onActivity as EventListener)
  }, [inputs, outputs])

  // ---- Host confirmation: sync Manager state when Host confirms a change ---

  useEffect(() => {
    const onStateChange = (event: Event): void => {
      const { tabId, state } = (event as CustomEvent<{ tabId: string; state: LifecycleState }>).detail ?? {}
      if (!tabId || !state) return
      const tracked = st.current.byTab.get(tabId)
      if (!tracked) return
      tracked.life = state
      tracked.lastLifecycleSent = state
    }
    window.addEventListener('paper:tab-state-changed', onStateChange as EventListener)
    return () => window.removeEventListener('paper:tab-state-changed', onStateChange as EventListener)
  }, [])

  // ---- Single tick: sync state, age tabs, update placement -----------------

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (st.current.ticking) return
      st.current.ticking = true

      try {
        const now = inputs.now()
        const { zoom } = inputs.getCamera()
        const visibleTabs = new Set<string>()

        // Upsert all currently visible shapes into tracking
        for (const geom of inputs.getVisibleShapes()) {
          const info = inputs.getTabInfo(geom.id)
          if (!info) continue

          st.current.byShape.set(geom.id, info.tabId)
          const tracked = st.current.byTab.get(info.tabId)
          if (tracked) {
            tracked.shapeId = geom.id
            // do NOT overwrite tracked.life — Manager owns it after first insert
          } else {
            st.current.byTab.set(info.tabId, {
              tabId: info.tabId,
              shapeId: geom.id,
              life: inputs.getLifecycleState(info.tabId) ?? 'live',
              lastInteractionAt: now,
              lastLifecycleSent: null,
              lastPlacementSent: null,
            })
          }

          if (geom.overlap > 0) visibleTabs.add(info.tabId)
        }

        // Pull in any interaction bumps from Host
        for (const [shapeId, tabId] of st.current.byShape) {
          const tracked = st.current.byTab.get(tabId)
          if (!tracked) continue
          const last = inputs.getLastInteractionMs(shapeId)
          if (typeof last === 'number' && last > tracked.lastInteractionAt) {
            tracked.lastInteractionAt = last
            tracked.life = 'live'
          }
        }

        // Age tabs — lifecycle is zoom-independent, always runs
        for (const tracked of st.current.byTab.values()) {
          const idle = now - tracked.lastInteractionAt

          if (tracked.life === 'live' && idle >= limits.freezeHiddenMs) {
            tracked.life = 'frozen'
          } else if (tracked.life === 'frozen' && idle >= limits.freezeHiddenMs + limits.discardFrozenMs) {
            tracked.life = 'discarded'
          }

          if (tracked.life !== tracked.lastLifecycleSent) {
            outputs.setLifecycle(tracked.shapeId, tracked.life)
            tracked.lastLifecycleSent = tracked.life
          }
        }

        // ---- Paint cap: decide which live+visible tabs actually get to paint --
        //
        // Above ZOOM_FULL_THRESHOLD: normal — only viewport-visible tabs paint.
        // Below ZOOM_CAP_THRESHOLD:  overview mode — cap painting to the
        //   `hotCapOverview` most recently interacted live tabs. Everything else
        //   gets background (stopPainting) and just shows its last frame.
        //
        // The two thresholds are the same value (0.5) giving a clean cut.
        // If you want a gradual transition zone, set ZOOM_CAP_THRESHOLD < ZOOM_FULL_THRESHOLD.

        let allowedToPaint: Set<string>

        if (zoom < ZOOM_CAP_THRESHOLD) {
          // Overview mode: collect all live visible tabs, sort by recency, take top N
          const liveCandidates = Array.from(visibleTabs)
            .map((tabId) => st.current.byTab.get(tabId))
            .filter((t): t is Tracked => !!t && t.life === 'live')
            .sort((a, b) => b.lastInteractionAt - a.lastInteractionAt)
            .slice(0, limits.hotCapOverview)

          allowedToPaint = new Set(liveCandidates.map((t) => t.tabId))
        } else {
          // Normal mode: all live visible tabs paint
          allowedToPaint = new Set(
            Array.from(visibleTabs).filter((tabId) => {
              const t = st.current.byTab.get(tabId)
              return t && t.life === 'live'
            })
          )
        }

        // Emit placement changes
        for (const tracked of st.current.byTab.values()) {
          const nextPlacement: PlacementState = allowedToPaint.has(tracked.tabId) ? 'active' : 'background'
          if (tracked.lastPlacementSent !== nextPlacement) {
            outputs.setPlacement(tracked.shapeId, nextPlacement, false)
            tracked.lastPlacementSent = nextPlacement
          }
        }

      } finally {
        st.current.ticking = false
      }
    }, 500)

    return () => window.clearInterval(interval)
  }, [inputs, outputs, limits])
}