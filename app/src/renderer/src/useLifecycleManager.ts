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

type Tracked = {
  readonly tabId: string
  shapeId: TLShapeId
  life: LifecycleState
  lastInteractionAt: number
  lastLifecycleSent: LifecycleState | null
  lastPlacementSent: PlacementState | null
}

export function useLifecycleManager(
  inputs: Inputs,
  outputs: Outputs,
  limits: Limits,
): void {
  const st = useRef<{
    byTab: Map<string, Tracked>
    byShape: Map<TLShapeId, string>
    tickingLifecycle: boolean
  }>({
    byTab: new Map<string, Tracked>(),
    byShape: new Map<TLShapeId, string>(),
    tickingLifecycle: false,
  })

  useEffect(() => {
    const onActivity = (event: Event): void => {
      const { tabId } = (event as CustomEvent<{ tabId: string }>).detail
      if (!tabId) return

      const visibleShapes = inputs.getVisibleShapes()
      const actualLife = inputs.getLifecycleState(tabId) ?? 'live'
      let tracked = st.current.byTab.get(tabId)
      if (!tracked) {
        const now = inputs.now()
        for (const geom of visibleShapes) {
          const info = inputs.getTabInfo(geom.id)
          if (!info || info.tabId !== tabId) continue
          tracked = {
            tabId,
            shapeId: geom.id,
            life: actualLife,
            lastInteractionAt: now,
            lastLifecycleSent: null,
            lastPlacementSent: null,
          }
          st.current.byTab.set(tabId, tracked)
          st.current.byShape.set(geom.id, tabId)
          break
        }
        if (!tracked) return
      }

      tracked.life = actualLife
      tracked.life = 'live'
      tracked.lastInteractionAt = inputs.now()
      if (actualLife !== 'live' || tracked.lastLifecycleSent !== 'live') {
        outputs.setLifecycle(tracked.shapeId, 'live')
        tracked.lastLifecycleSent = 'live'
      }

      const isVisible = visibleShapes.some((geom) => {
        if (geom.id !== tracked.shapeId) return false
        return geom.overlap > 0
      })
      if (isVisible && tracked.lastPlacementSent !== 'active') {
        outputs.setPlacement(tracked.shapeId, 'active', false)
        tracked.lastPlacementSent = 'active'
      }
    }

    window.addEventListener('paper:tab-activity', onActivity as EventListener)
    return () => window.removeEventListener('paper:tab-activity', onActivity as EventListener)
  }, [inputs, outputs])

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (st.current.tickingLifecycle) return
      st.current.tickingLifecycle = true

      try {
        const now = inputs.now()

        for (const geom of inputs.getVisibleShapes()) {
          const info = inputs.getTabInfo(geom.id)
          if (!info) continue

          st.current.byShape.set(geom.id, info.tabId)
          const tracked = st.current.byTab.get(info.tabId)
          if (tracked) {
            tracked.shapeId = geom.id
            tracked.life = inputs.getLifecycleState(info.tabId) ?? tracked.life
            continue
          }

          st.current.byTab.set(info.tabId, {
            tabId: info.tabId,
            shapeId: geom.id,
            life: inputs.getLifecycleState(info.tabId) ?? 'live',
            lastInteractionAt: now,
            lastLifecycleSent: null,
            lastPlacementSent: null,
          })
        }

        for (const [shapeId, tabId] of st.current.byShape) {
          const tracked = st.current.byTab.get(tabId)
          if (!tracked) continue
          const last = inputs.getLastInteractionMs(shapeId)
          if (typeof last === 'number' && last > tracked.lastInteractionAt) {
            tracked.lastInteractionAt = last
            tracked.life = 'live'
          }
        }

        for (const tracked of st.current.byTab.values()) {
          tracked.life = inputs.getLifecycleState(tracked.tabId) ?? tracked.life
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
      } finally {
        st.current.tickingLifecycle = false
      }
    }, 1000)

    return () => window.clearInterval(interval)
  }, [inputs, outputs, limits])

  useEffect(() => {
    const interval = window.setInterval(() => {
      const visibleTabs = new Set<string>()
      for (const geom of inputs.getVisibleShapes()) {
        const info = inputs.getTabInfo(geom.id)
        if (!info) continue

        st.current.byShape.set(geom.id, info.tabId)
        const tracked = st.current.byTab.get(info.tabId)
        if (tracked) {
          tracked.shapeId = geom.id
          tracked.life = inputs.getLifecycleState(info.tabId) ?? tracked.life
        } else {
          st.current.byTab.set(info.tabId, {
            tabId: info.tabId,
            shapeId: geom.id,
            life: inputs.getLifecycleState(info.tabId) ?? 'live',
            lastInteractionAt: inputs.now(),
            lastLifecycleSent: null,
            lastPlacementSent: null,
          })
        }

        if (geom.overlap > 0) {
          visibleTabs.add(info.tabId)
        }
      }

      for (const tracked of st.current.byTab.values()) {
        const nextPlacement: PlacementState =
          tracked.life === 'live' && visibleTabs.has(tracked.tabId)
            ? 'active'
            : 'background'

        if (tracked.lastPlacementSent === nextPlacement) continue
        outputs.setPlacement(tracked.shapeId, nextPlacement, false)
        tracked.lastPlacementSent = nextPlacement
      }
    }, 500)

    return () => window.clearInterval(interval)
  }, [inputs, outputs])
}
