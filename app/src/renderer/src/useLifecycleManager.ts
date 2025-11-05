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

type Life = 'live' | 'frozen' | 'discarded'

type Tracked = {
  readonly tabId: string
  shapeId: TLShapeId
  life: Life
  lastInteractionAt: number
  lastLifecycleSent: Life | null
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
  const onActivity = (e: Event): void => {
    const { tabId } = (e as CustomEvent<{ tabId: string }>).detail
    if (!tabId) return
    let tracked = st.current.byTab.get(tabId)
    // If not tracked yet, resolve the shape now and materialize a record.
    if (!tracked) {
      const now = inputs.now()
      const geoms = inputs.getVisibleShapes()
      for (const g of geoms) {
        const info = inputs.getTabInfo(g.id)
        if (!info || info.tabId !== tabId) continue
        tracked = {
          tabId,
          shapeId: g.id,
          life: 'live',
          lastInteractionAt: now,
          lastLifecycleSent: null,
          lastPlacementSent: null,
        }
        st.current.byTab.set(tabId, tracked)
        st.current.byShape.set(g.id, tabId)
        break
      }
      if (!tracked) return // still nothing to act on
    }
    const now = inputs.now()
    tracked.life = 'live'
    tracked.lastInteractionAt = now
    if (tracked.lastLifecycleSent !== 'live') {
      outputs.setLifecycle(tracked.shapeId, 'live')
      tracked.lastLifecycleSent = 'live'
    }
    if (tracked.lastPlacementSent !== 'active') {
      outputs.setPlacement(tracked.shapeId, 'active', false)
      tracked.lastPlacementSent = 'active'
    }
  }
  window.addEventListener('paper:tab-activity', onActivity as EventListener)
  return () => window.removeEventListener('paper:tab-activity', onActivity as EventListener)
}, [inputs, outputs])



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

useEffect(() => {
  const OVERLAP_VISIBLE = 0.25;

  let raf = 0;

  const loop = (): void => {
    raf = requestAnimationFrame(loop);

    const now = inputs.now();
    const { zoom } = inputs.getCamera();
    const geoms = inputs.getVisibleShapes();

    // --- zoom motion tracking ---
    if (Math.abs(zoom - st.current.lastZoom) > ZOOM_EPS) {
      st.current.lastZoom = zoom;
      st.current.lastZoomAt = now;
    }

    // --- mode with hysteresis ---
    let nextMode = st.current.mode;
    if (st.current.mode === "detail" && zoom <= OVERVIEW_ENTER_ZOOM) {
      nextMode = "overview";
    } else if (st.current.mode === "overview" && zoom > OVERVIEW_EXIT_ZOOM) {
      nextMode = "detail";
    }
    if (nextMode !== st.current.mode) {
      st.current.mode = nextMode;
      st.current.modeChangedAt = now;
      return; // no mutations on the same frame as a mode flip
    }
    if (now - st.current.modeChangedAt < MODE_SETTLE_MS) return;

    // --- pan signature (detect camera motion) ---
    let sig = 0;
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i]!;
      sig = (sig + (g.id as string).length * g.overlap * 1000) | 0;
    }
    if (sig !== st.current.lastPanSig) {
      st.current.lastPanSig = sig;
      st.current.lastPanAt = now;
    }

    // --- collect visible candidates (percentage-only) ---
    const visibleTabs: Array<{ tabId: string; shapeId: TLShapeId; overlap: number }> = [];
    for (const g of geoms) {
      const info = inputs.getTabInfo(g.id);
      if (!info) continue;

      const ov = g.overlap <= 0 ? 0 : g.overlap >= 1 ? 1 : g.overlap;

      // map shape -> tab and keep minimal tracking
      st.current.byShape.set(g.id, info.tabId);
      const tracked = st.current.byTab.get(info.tabId);
      if (!tracked) {
        st.current.byTab.set(info.tabId, {
          tabId: info.tabId,
          shapeId: g.id,
          life: "live",
          lastInteractionAt: now,
          lastLifecycleSent: null,
          lastPlacementSent: null,
        });
      } else {
        tracked.shapeId = g.id;
      }

      if (ov >= OVERLAP_VISIBLE) {
        visibleTabs.push({ tabId: info.tabId, shapeId: g.id, overlap: ov });
      }
    }

    // --- idleness flags ---
    const zoomIdle = now - st.current.lastZoomAt >= ZOOM_SETTLE_MS;
    const panIdle = now - st.current.lastPanAt >= PAN_SETTLE_MS;
    const overviewMode = st.current.mode === "overview";
    if (!zoomIdle) return;

    // --- live tabs only ---
    const liveTabs = Array.from(st.current.byTab.values()).filter((t) => t.life === "live");
    if (liveTabs.length === 0) return;

    /* =====================================================
     * DETAIL (> 30%) — percentage-only visibility
     * =================================================== */
    if (!overviewMode) {
      const visibleSet = new Set<string>(visibleTabs.map((v) => v.tabId));

      if (!panIdle) {
        // 1) instant off-screen demote for all live tabs
        for (const t of liveTabs) {
          if (visibleSet.has(t.tabId)) continue;
          // thumbnail only when transitioning active -> background, once
          const needThumb = t.lastPlacementSent === "active";
          if (t.lastPlacementSent !== "background") {
            outputs.setPlacement(t.shapeId, "background", needThumb);
            t.lastPlacementSent = "background";
          }
        }

        // 2) at most one promotion per frame, chosen by highest overlap%
        const ordered = visibleTabs
          .filter((v) => {
            const tracked = st.current.byTab.get(v.tabId);
            return tracked == null ? true : tracked.lastPlacementSent !== "active";
          })
          .sort((a, b) => b.overlap - a.overlap);

        const candidate = ordered[0];
        if (candidate) {
          const tracked = st.current.byTab.get(candidate.tabId);
          if (tracked && tracked.lastPlacementSent !== "active") {
            outputs.setPlacement(candidate.shapeId, "active", false);
            tracked.lastPlacementSent = "active";
          }
        }
        return;
      }

      // DETAIL idle: all visible are active; others background
      for (const t of liveTabs) {
        const isVis = visibleSet.has(t.tabId);
        const nextPlacement: PlacementState = isVis ? "active" : "background";
        if (nextPlacement === t.lastPlacementSent) continue;

        if (nextPlacement === "background") {
          const needThumb = t.lastPlacementSent === "active";
          outputs.setPlacement(t.shapeId, "background", needThumb);
          t.lastPlacementSent = "background";
        } else {
          outputs.setPlacement(t.shapeId, "active", false);
          t.lastPlacementSent = "active";
        }
      }
      return;
    }

    /* =====================================================
     * OVERVIEW (≤ 30%) — cap by interaction recency
     * =================================================== */
    if (!panIdle) return;

    if (liveTabs.length <= limits.hotCapOverview) {
      for (const t of liveTabs) {
        if (t.lastPlacementSent !== "active") {
          outputs.setPlacement(t.shapeId, "active", false);
          t.lastPlacementSent = "active";
        }
      }
      return;
    }

    const sortedByInteraction = liveTabs
      .slice()
      .sort((a, b) => b.lastInteractionAt - a.lastInteractionAt);

    const keep = new Set<string>(
      sortedByInteraction.slice(0, limits.hotCapOverview).map((t) => t.tabId)
    );

    for (const t of liveTabs) {
      const shouldBeActive = keep.has(t.tabId);
      const nextPlacement: PlacementState = shouldBeActive ? "active" : "background";
      if (nextPlacement === t.lastPlacementSent) continue;

      if (nextPlacement === "background") {
        // overview demotions do NOT snapshot (only snapshot on active->background in detail)
        outputs.setPlacement(t.shapeId, "background", false);
        t.lastPlacementSent = "background";
      } else {
        outputs.setPlacement(t.shapeId, "active", false);
        t.lastPlacementSent = "active";
      }
    }
  };

  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}, [inputs, outputs, limits]);


}
