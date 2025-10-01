import { useEffect, useRef } from 'react'
import type { TLShapeId } from 'tldraw'

/* ====================== Types ====================== */

export type LifecycleState = 'hot' | 'warm' | 'frozen' | 'discarded'

export interface ShapeGeom {
  readonly id: TLShapeId
  readonly w: number
  readonly h: number
  /** 0..1 fraction of the shape’s area that is within the viewport */
  readonly overlap: number
}

export interface Flags {
  readonly audible: boolean
  readonly capturing: boolean
  readonly devtools: boolean
  readonly downloads: boolean
  readonly pinned: boolean
}

export type TabId = string

export interface TabInfo {
  readonly tabId: TabId
  readonly url: string
}

export interface Inputs {
  /** Visible shapes in the current viewport (with overlap 0..1) */
  readonly getVisibleShapes: () => ReadonlyArray<ShapeGeom>
  /** Camera info; only zoom is needed here */
  readonly getCamera: () => { zoom: number }
  /** Shape → tab mapping (null if not a browser shape) */
  readonly getTabInfo: (shapeId: TLShapeId) => TabInfo | null
  /** Current flags for a shape (audible, pinned, etc.) */
  readonly getFlags: (shapeId: TLShapeId) => Flags
  /** ms since epoch; monotonic enough for timers/MRU */
  readonly now: () => number
  /** last user interaction time for this shape (ms since epoch) */
  readonly getLastInteractionMs: (shapeId: TLShapeId) => number | undefined

  /** IPC to main – fire-and-forget (never await on hot path) */
  readonly show: (tabId: TabId) => Promise<void>
  readonly hide: (tabId: TabId) => Promise<void>
  readonly freeze: (tabId: TabId) => Promise<void>
  readonly thaw: (tabId: TabId) => Promise<void>
  readonly destroy: (tabId: TabId) => Promise<void>
}

export interface Outputs {
  readonly setLifecycle: (shapeId: TLShapeId, state: LifecycleState) => void
}

/** Tunables supplied by caller */
export interface Limits {
  /** Hot cap when zoom is in overview mode (≤ overviewCutoff), e.g., 6 */
  readonly hotCapOverview: number
  /** Minimum visible pixels to treat a shape as visible */
  readonly tinyPxFloor: number
  /** After being hidden for this long, warm → frozen */
  readonly freezeHiddenMs: number
  /** After being hidden for this long, frozen/warm → discarded */
  readonly discardHiddenMs: number
}

/* ====================== Local constants ====================== */

/** Strict overview pivot: below this, do NOT turn tabs on unless interacted */
const OVERVIEW_ZOOM_CUTOFF = 0.45
/** Polling cadence for reconciliation (~33 FPS) */
const TICK_MS = 30
/** Motion idleness thresholds */
const PAN_IDLE_MS = 60
const ZOOM_IDLE_MS = 90
const ZOOM_EPS = 0.0005

/* ====================== Internal state ====================== */

type HotRec = { readonly tabId: TabId; readonly shapeId: TLShapeId }
type WarmRec = { readonly tabId: TabId; readonly shapeId: TLShapeId; lastSeenVisibleAt: number }
type HiddenInfo = { hiddenSince: number }

export function useLifecycleManager(inputs: Inputs, outputs: Outputs, limits: Limits): void {
  const st = useRef<{
    hot: Map<TabId, HotRec>
    warm: Map<TabId, WarmRec>
    frozen: Set<TabId>
    discarded: Set<TabId>
    hidden: Map<TabId, HiddenInfo>
    byShape: Map<TLShapeId, TabId>
    // motion tracking
    lastPanSig: number
    lastPanTs: number
    lastZoom: number
    lastZoomTs: number
    ticking: boolean
  }>({
    hot: new Map(),
    warm: new Map(),
    frozen: new Set(),
    discarded: new Set(),
    hidden: new Map(),
    byShape: new Map(),
    lastPanSig: 0,
    lastPanTs: 0,
    lastZoom: 1,
    lastZoomTs: 0,
    ticking: false,
  })

  useEffect(() => {
    /* ---------- helpers ---------- */

    const isElevated = (f: Flags): boolean =>
      f.audible || f.capturing || f.devtools || f.downloads || f.pinned

    const visiblePixels = (g: ShapeGeom): number => {
      const ov = g.overlap <= 0 ? 0 : g.overlap >= 1 ? 1 : g.overlap
      return g.w * g.h * ov
    }

    const setLife = (shapeId: TLShapeId, state: LifecycleState): void => {
      outputs.setLifecycle(shapeId, state)
    }

    const trackShapeTab = (shapeId: TLShapeId, tabId: TabId): void => {
      st.current.byShape.set(shapeId, tabId)
    }

    const untrackShapeTab = (tabId: TabId): void => {
      for (const [sid, tid] of st.current.byShape) {
        if (tid === tabId) st.current.byShape.delete(sid)
      }
    }

    const promoteToHot = (shapeId: TLShapeId, tabId: TabId): void => {
      st.current.warm.delete(tabId)
      st.current.frozen.delete(tabId)
      st.current.discarded.delete(tabId)
      st.current.hot.set(tabId, { tabId, shapeId })
      setLife(shapeId, 'hot')
      void inputs.thaw(tabId)
      void inputs.show(tabId)
      st.current.hidden.delete(tabId)
    }

    const demoteToWarm = (shapeId: TLShapeId, tabId: TabId): void => {
      if (!st.current.hot.has(tabId)) return
      st.current.hot.delete(tabId)
      st.current.warm.set(tabId, { tabId, shapeId, lastSeenVisibleAt: inputs.now() })
      setLife(shapeId, 'warm')
      void inputs.hide(tabId)
      st.current.hidden.set(tabId, { hiddenSince: inputs.now() })
    }

    const freezeWarm = (tabId: TabId): void => {
      const rec = st.current.warm.get(tabId)
      if (!rec) return
      st.current.warm.delete(tabId)
      st.current.frozen.add(tabId)
      setLife(rec.shapeId, 'frozen')
      void inputs.freeze(tabId)
    }

    const discardAny = (tabId: TabId): void => {
      const hot = st.current.hot.get(tabId)
      const warm = st.current.warm.get(tabId)
      const shapeId: TLShapeId | undefined = hot?.shapeId ?? warm?.shapeId
      st.current.hot.delete(tabId)
      st.current.warm.delete(tabId)
      st.current.frozen.delete(tabId)
      st.current.discarded.add(tabId)
      if (shapeId) setLife(shapeId, 'discarded')
      void inputs.hide(tabId)
      void inputs.destroy(tabId)
      st.current.hidden.delete(tabId)
      untrackShapeTab(tabId)
    }

    const panSignature = (geoms: ReadonlyArray<ShapeGeom>): number => {
      // Deterministic signature that shifts when the viewport pans
      let acc = 0
      for (let i = 0; i < geoms.length; i++) {
        const g = geoms[i]!
        // tiny stable hash of id
        let h = 0
        const s = String(g.id)
        for (let j = 0; j < s.length; j++) h = ((h << 5) - h + s.charCodeAt(j) | 0) >>> 0
        acc += (h % 9973) * g.overlap
      }
      return acc
    }

    /* ---------- main reconcile ---------- */

    const tick = (): void => {
      if (st.current.ticking) return
      st.current.ticking = true
      try {
        const now = inputs.now()
        const zoom = inputs.getCamera().zoom

        // Zoom motion tracking
        if (Math.abs(zoom - st.current.lastZoom) > ZOOM_EPS) {
          st.current.lastZoom = zoom
          st.current.lastZoomTs = now
        }

        // Build visible list + pan signature
        const geoms = inputs.getVisibleShapes()
        const sig = panSignature(geoms)
        if (sig !== st.current.lastPanSig) {
          st.current.lastPanSig = sig
          st.current.lastPanTs = now
        }

        const panIdle = (now - st.current.lastPanTs) >= PAN_IDLE_MS
        const zoomIdle = (now - st.current.lastZoomTs) >= ZOOM_IDLE_MS
        const overviewMode = zoom <= OVERVIEW_ZOOM_CUTOFF

        const visible: Array<{ shapeId: TLShapeId; tabId: TabId; flags: Flags; px: number; lastInteraction: number }> = []
        for (let i = 0; i < geoms.length; i++) {
          const g = geoms[i]!
          const px = visiblePixels(g)
          if (px < limits.tinyPxFloor) continue
          const info = inputs.getTabInfo(g.id); if (!info) continue
          const flags = inputs.getFlags(g.id)
          const lastInteraction = inputs.getLastInteractionMs(g.id) ?? 0
          visible.push({ shapeId: g.id, tabId: info.tabId, flags, px, lastInteraction })
          trackShapeTab(g.id, info.tabId)
        }
        const visibleSet = new Set<TabId>(visible.map(v => v.tabId))

        /* ---------- NOTHING mutational during zoom ---------- */
        if (!zoomIdle) {
          // Do not promote, do not demote (even off-screen), do not run timers.
          return
        }

        /* ---------- PANNING-ONLY fast path (zoom idle, pan active) ---------- */
        if (!panIdle) {
          // Instant off-screen demote for non-elevated hots (Goal 1)
          for (const [tid, rec] of st.current.hot) {
            if (visibleSet.has(tid)) continue
            const flags = inputs.getFlags(rec.shapeId)
            if (isElevated(flags)) continue
            demoteToWarm(rec.shapeId, tid)
          }

          if (overviewMode) {
            // Below 45%: never turn on during pan
            // (elevated remain hot due to guard above)
          } else {
            // ≥ 45%: allow at most one safe promotion per tick to keep UX snappy
            const strongPx = limits.tinyPxFloor * 8
            let chosen: { shapeId: TLShapeId; tabId: TabId } | null = null
            const ordered = [...visible]
              .filter(v => !st.current.hot.has(v.tabId))
              .sort((a, b) => (b.px - a.px))
            for (let i = 0; i < ordered.length; i++) {
              const v = ordered[i]!
              if (isElevated(v.flags) || v.px >= strongPx) {
                chosen = { shapeId: v.shapeId, tabId: v.tabId }
                break
              }
            }
            if (chosen) promoteToHot(chosen.shapeId, chosen.tabId)
          }

          // Skip timers during active pan to minimize work
          return
        }

        /* ---------- FULL IDLE reconcile (no zoom, no pan) ---------- */

        // 1) Elevated tabs always hot (visible or not)
        const desiredHot = new Set<TabId>()
        for (let i = 0; i < visible.length; i++) {
          const v = visible[i]!
          if (isElevated(v.flags)) desiredHot.add(v.tabId)
        }
        for (const [tid, rec] of st.current.hot) {
          const flags = inputs.getFlags(rec.shapeId)
          if (isElevated(flags)) desiredHot.add(tid)
        }

        // 2) Non-elevated selection
        if (overviewMode) {
          // STRICT: only interacted tabs may turn hot (MRU>0), cap to hotCapOverview
          const nonElevInteracted = visible
            .filter(v => !isElevated(v.flags) && v.lastInteraction > 0)
            .sort((a, b) => (b.lastInteraction - a.lastInteraction))
          const take = Math.max(0, limits.hotCapOverview - desiredHot.size)
          for (let i = 0; i < nonElevInteracted.length && i < take; i++) {
            desiredHot.add(nonElevInteracted[i]!.tabId)
          }
        } else {
          // Normal zoom: all visible non-elevated are hot
          for (let i = 0; i < visible.length; i++) {
            const v = visible[i]!
            if (!isElevated(v.flags)) desiredHot.add(v.tabId)
          }
        }

        // Demote any non-elevated hots not desired
        for (const [tid, rec] of st.current.hot) {
          if (desiredHot.has(tid)) continue
          const flags = inputs.getFlags(rec.shapeId)
          if (isElevated(flags)) continue
          demoteToWarm(rec.shapeId, tid)
        }

        // Promote desired that aren’t hot yet
        for (let i = 0; i < visible.length; i++) {
          const v = visible[i]!
          if (!desiredHot.has(v.tabId)) continue
          if (!st.current.hot.has(v.tabId)) {
            promoteToHot(v.shapeId, v.tabId)
          }
        }

        /* ---------- Hidden timers (freeze / discard) ---------- */
        // Only run timers when fully idle to minimize interference with interactions
        for (const [tid, wr] of st.current.warm) {
          if (visibleSet.has(tid)) {
            st.current.hidden.delete(tid)
            st.current.warm.set(tid, { ...wr, lastSeenVisibleAt: now })
          } else if (!st.current.hidden.has(tid)) {
            st.current.hidden.set(tid, { hiddenSince: now })
          }
        }
        for (const [tid, info] of st.current.hidden) {
          const hiddenFor = now - info.hiddenSince
          if (hiddenFor >= limits.discardHiddenMs) {
            discardAny(tid)
          } else if (hiddenFor >= limits.freezeHiddenMs && !st.current.frozen.has(tid)) {
            freezeWarm(tid)
          }
        }
      } finally {
        st.current.ticking = false
      }
    }

    const iv = window.setInterval(tick, TICK_MS)
    return () => window.clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs, outputs, limits])
}
