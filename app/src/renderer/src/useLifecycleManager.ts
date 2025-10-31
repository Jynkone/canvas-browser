import { useEffect, useRef } from 'react'
import type { TLShapeId } from 'tldraw'

/* ====================== Types ====================== */

export type LifecycleState = 'hot' | 'warm' | 'frozen'

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
  readonly snapshot: (tabId: TabId, maxWidth?: number) => Promise<string | null>

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
}

/* ====================== Local constants ====================== */

/** Strict overview pivot: below/equal this, we DO NOT swap by visibility while panning. */
const OVERVIEW_ZOOM_CUTOFF = 0.30 // 30%
/** Polling cadence for reconciliation (~33 FPS) */
const TICK_MS = 30
/** Motion idleness thresholds */
const PAN_IDLE_MS = 60
const ZOOM_IDLE_MS = 90
const ZOOM_EPS = 0.0005

/* ====================== Internal state ====================== */

type HotRec = { readonly tabId: TabId; readonly shapeId: TLShapeId; readonly createdAt: number }
type WarmRec = { readonly tabId: TabId; readonly shapeId: TLShapeId; readonly createdAt: number }
type HiddenInfo = { hiddenSince: number }

export function useLifecycleManager(inputs: Inputs, outputs: Outputs, limits: Limits): void {
  const st = useRef<{
    hot: Map<TabId, HotRec>
    warm: Map<TabId, WarmRec>
    frozen: Set<TabId>
    hidden: Map<TabId, HiddenInfo>
    byShape: Map<TLShapeId, TabId>
    // motion tracking
    lastPanSig: number
    lastPanTs: number
    wasPanIdle: boolean
    lastZoom: number
    lastZoomTs: number
    ticking: boolean
    // overview pan lock
    lockedHot: Set<TabId>
    // MRU tracking (last seen interaction timestamps per tab)
    lastInteractionByTab: Map<TabId, number>
  }>({
    hot: new Map(),
    warm: new Map(),
    frozen: new Set(),
    hidden: new Map(),
    byShape: new Map(),
    lastPanSig: 0,
    lastPanTs: 0,
    wasPanIdle: true,
    lastZoom: 1,
    lastZoomTs: 0,
    ticking: false,
    lockedHot: new Set<TabId>(),
    lastInteractionByTab: new Map<TabId, number>(),
  })

  useEffect(() => {
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
    const shapeIdForTab = (tabId: TabId): TLShapeId | undefined => {
      for (const [sid, tid] of st.current.byShape) {
        if (tid === tabId) return sid
      }
      return undefined
    }

    const promoteToHot = (shapeId: TLShapeId, tabId: TabId): void => {
  // Preserve createdAt if this tab was warm/hot before
  const existingWarm = st.current.warm.get(tabId)
  const existingHot = st.current.hot.get(tabId)
  const createdAt = existingWarm?.createdAt ?? existingHot?.createdAt ?? inputs.now()
  
  st.current.warm.delete(tabId)
  st.current.frozen.delete(tabId)
  st.current.hot.set(tabId, { tabId, shapeId, createdAt })
  setLife(shapeId, 'hot')
  void inputs.thaw(tabId)
  void inputs.show(tabId)
  st.current.hidden.delete(tabId)
}

    const demoteToWarm = (shapeId: TLShapeId, tabId: TabId): void => {
  if (!st.current.hot.has(tabId)) return

  const hotRec = st.current.hot.get(tabId)!
  st.current.hot.delete(tabId)
  st.current.warm.set(tabId, {
    tabId,
    shapeId,
    createdAt: hotRec.createdAt,  // ← Preserve birth time
  })

  const thumbs: Map<string, { url: string; dataUrlWebp: string }> | undefined =
    (window as unknown as {
      __tabThumbs?: Map<string, { url: string; dataUrlWebp: string }>
    }).__tabThumbs

  const hasThumb: boolean =
    !!thumbs &&
    thumbs.has(tabId) &&
    typeof thumbs.get(tabId)?.dataUrlWebp === 'string'

  // If no local thumb, take one NOW (before hide)
  void (async () => {
    try {
      if (!hasThumb) {
        // width to match your nav-finished capture
        await inputs.snapshot(tabId, 896)
      }
      await inputs.hide(tabId)
      st.current.hidden.set(tabId, { hiddenSince: inputs.now() })
    } catch {
      /* noop */
    }
  })()

  setLife(shapeId, 'warm')
}


    const freezeWarm = (tabId: TabId): void => {
      const rec = st.current.warm.get(tabId)
      if (!rec) return
      st.current.warm.delete(tabId)
      st.current.frozen.add(tabId)
      setLife(rec.shapeId, 'frozen')
      void inputs.freeze(tabId)
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

    /** Build locked HOT = elevated ∪ top-N MRU (by lastInteraction), across all tracked shapes */
    const rebuildLockedHot = (): void => {
      const next = new Set<TabId>()
      // 1) elevated (across ALL tracked shapes)
      for (const [shapeId, tabId] of st.current.byShape) {
        const flags = inputs.getFlags(shapeId)
        if (isElevated(flags)) next.add(tabId)
      }
      // 2) non-elevated top-N MRU
      const nonElev: Array<{ tabId: TabId; shapeId: TLShapeId; last: number }> = []
      for (const [shapeId, tabId] of st.current.byShape) {
        const flags = inputs.getFlags(shapeId)
        if (isElevated(flags)) continue
        const last = inputs.getLastInteractionMs(shapeId) ?? 0
        nonElev.push({ tabId, shapeId, last })
      }
      nonElev.sort((a, b) => b.last - a.last)
      const toTake = Math.max(0, limits.hotCapOverview - next.size)
      for (let i = 0, taken = 0; i < nonElev.length && taken < toTake; i++) {
        const tid = nonElev[i]!.tabId
        if (next.has(tid)) continue
        next.add(tid)
        taken++
      }
      st.current.lockedHot = next
    }

    /** Enforce the locked set: keep locked (or elevated) HOT, everyone else non-elevated → WARM */
    const enforceLockedHot = (): void => {
      // Demote any non-elevated HOT not in locked set
      for (const [tid, rec] of st.current.hot) {
        // If it's locked or elevated, keep hot
        const flags = inputs.getFlags(rec.shapeId)
        if (st.current.lockedHot.has(tid) || isElevated(flags)) continue
        demoteToWarm(rec.shapeId, tid)
      }
      // Promote all locked that are not hot yet
      for (const tid of st.current.lockedHot) {
        if (st.current.hot.has(tid)) continue
        const sid = shapeIdForTab(tid)
        if (!sid) continue
        promoteToHot(sid, tid)
      }
    }

const runInteractionTimers = (nowMs: number): void => {
  for (const [tid, wr] of st.current.warm) {
    const shapeId = wr.shapeId
    const last = inputs.getLastInteractionMs(shapeId)

    // 👇 ONLY real interaction keeps it alive
    if (typeof last === 'number' && last > 0) {
      const idleFor = nowMs - last
      if (idleFor >= limits.freezeHiddenMs) {
        freezeWarm(tid)
      }
      continue
    }

    // 👇 NO real interaction ever → age from creation time
    const idleFor = nowMs - wr.createdAt
    if (idleFor >= limits.freezeHiddenMs) {
      freezeWarm(tid)
    }
  }
}


    /** Track interaction changes and refresh lock if an MRU bump happened */
    const maybeRefreshLockOnInteraction = (inOverviewAndPanning: boolean): void => {
      if (!inOverviewAndPanning) return
      let changed = false
      for (const [shapeId, tabId] of st.current.byShape) {
        const last = inputs.getLastInteractionMs(shapeId) ?? 0
        const prev = st.current.lastInteractionByTab.get(tabId) ?? 0
        if (last !== prev) {
          changed = true
        }
        st.current.lastInteractionByTab.set(tabId, last)
      }
      if (changed) {
        rebuildLockedHot()
      }
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
          // keep MRU cache up-to-date
          st.current.lastInteractionByTab.set(info.tabId, lastInteraction)
        }
        const visibleSet = new Set<TabId>(visible.map(v => v.tabId))

        // Detect pan state transition
        const panBecameActive = st.current.wasPanIdle && !panIdle
        const isOverviewAndPanning = overviewMode && !panIdle
        st.current.wasPanIdle = panIdle

        /* ---------- NOTHING mutational during zoom motion ---------- */
        if (!zoomIdle) {
          runInteractionTimers(now)
          // Do not promote, do not demote (even off-screen), do not run timers.
          return
        }

        /* ---------- OVERVIEW (≤ 30%) + PANNING: LOCKED HOT ---------- */
        if (isOverviewAndPanning) {
          if (panBecameActive) {
            // Latch the lock when panning starts in overview
            rebuildLockedHot()
          } else {
            // If any MRU changed, rebuild the lock so interaction can reshuffle while panning
            maybeRefreshLockOnInteraction(true)
          }
          // Enforce the lock: no visibility-based swapping here
          enforceLockedHot()
          runInteractionTimers(now)
          // Skip timers during active pan to minimize work
          return
        }

        /* ---------- DETAIL (> 30%) + PANNING: fast follow visibility ---------- */
        if (!panIdle) {
          // Instant off-screen demote for non-elevated hots
          for (const [tid, rec] of st.current.hot) {
            if (visibleSet.has(tid)) continue
            const flags = inputs.getFlags(rec.shapeId)
            if (isElevated(flags)) continue
            demoteToWarm(rec.shapeId, tid)
          }

          // Allow at most one safe promotion per tick
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

          runInteractionTimers(now)
          return
        }

        /* ---------- FULL IDLE reconcile (no zoom, no pan) ---------- */

        // 1) Elevated tabs always hot (visible or not)
        const desiredHot = new Set<TabId>()
        // Use all tracked shapes to keep elevated hot even if not visible
        for (const [shapeId, tabId] of st.current.byShape) {
          const flags = inputs.getFlags(shapeId)
          if (isElevated(flags)) desiredHot.add(tabId)
        }

        // 2) Non-elevated selection
        if (overviewMode) {
          // STRICT overview: fill with top-N MRU across all tracked shapes (not just visible)
          const nonElev: Array<{ tabId: TabId; shapeId: TLShapeId; last: number }> = []
          for (const [shapeId, tabId] of st.current.byShape) {
            if (desiredHot.has(tabId)) continue // already elevated
            const flags = inputs.getFlags(shapeId)
            if (isElevated(flags)) continue
            const last = inputs.getLastInteractionMs(shapeId) ?? 0
            if (last > 0) nonElev.push({ tabId, shapeId, last })
          }
          nonElev.sort((a, b) => b.last - a.last)
          for (let i = 0; i < nonElev.length && desiredHot.size < limits.hotCapOverview; i++) {
            const tid = nonElev[i]!.tabId
            if (!desiredHot.has(tid)) desiredHot.add(tid)
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
        // For overview idle, promote both visible and offscreen desired (since they're MRU/elevated picks)
        const promoteList: Array<{ tabId: TabId; shapeId: TLShapeId }> = []
        if (overviewMode) {
          for (const tid of desiredHot) {
            if (st.current.hot.has(tid)) continue
            const sid = shapeIdForTab(tid)
            if (sid) promoteList.push({ tabId: tid, shapeId: sid })
          }
        } else {
          for (let i = 0; i < visible.length; i++) {
            const v = visible[i]!
            if (!desiredHot.has(v.tabId)) continue
            if (!st.current.hot.has(v.tabId)) promoteList.push({ tabId: v.tabId, shapeId: v.shapeId })
          }
        }
        for (let i = 0; i < promoteList.length; i++) {
          const p = promoteList[i]!
          promoteToHot(p.shapeId, p.tabId)
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
