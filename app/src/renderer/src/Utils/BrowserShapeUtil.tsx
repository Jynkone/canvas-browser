// src/renderer/src/Utils/BrowserShapeUtil.tsx
import { useEffect, useRef, useState } from 'react'
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  TLBaseShape,
  TLResizeInfo,
  resizeBox,
  useEditor,
  Box,
} from 'tldraw'
import { NavigationBar, NAV_BAR_HEIGHT } from '../components/NavigationBar'
import { sessionStore } from './SessionStore'

export type BrowserShape = TLBaseShape<
  'browser-shape',
  { w: number; h: number; url: string; tabId: string }
>

const DRAG_GUTTER = 8
const MIN_W = 1000
const MIN_H = 525 + NAV_BAR_HEIGHT + DRAG_GUTTER * 2

// Live-capture policy
const CAPTURE_INTERVAL_MS = 15_000
const IDLE_EVICT_MS = 30 * 60_000

type Rect = { x: number; y: number; width: number; height: number }
type NavState = { currentUrl: string; canGoBack: boolean; canGoForward: boolean; title: string }

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const

  override isAspectRatioLocked = () => false
  override canResize = () => true
  override hideResizeHandles = () => false

  override getDefaultProps(): BrowserShape['props'] {
    return { w: 1200, h: 600 + NAV_BAR_HEIGHT + DRAG_GUTTER * 2, url: 'https://google.com', tabId: '' }
  }

  override onResize(shape: BrowserShape, info: TLResizeInfo<BrowserShape>) {
    const r = resizeBox(shape, info)
    const w = Math.max(MIN_W, r.props.w)
    const h = Math.max(MIN_H, r.props.h)
    return { ...r, props: { ...r.props, w, h } }
  }

  override getGeometry(shape: BrowserShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: false })
  }

  override indicator(shape: BrowserShape) {
    return <rect x={0} y={0} width={shape.props.w} height={shape.props.h} />
  }

  override component(shape: BrowserShape) {
    const editor = useEditor()
    const api = window.overlay

    const hostRef = useRef<HTMLDivElement | null>(null)
    const tabIdRef = useRef<string | null>(null)

    const [navState, setNavState] = useState<NavState>({
      currentUrl: shape.props.url,
      canGoBack: false,
      canGoForward: false,
      title: '',
    })
    const [isLoading, setIsLoading] = useState<boolean>(false)

    // Session ready barrier (App decides hot-3 then calls markReady)
    const [ready, setReady] = useState<boolean>(sessionStore.isReady())
    useEffect(() => sessionStore.onReady(() => setReady(true)), [])

    // Frozen flag from session realization
    const [frozen, setFrozen] = useState<boolean>(() => {
      const rec = sessionStore.get(shape.id)
      return (rec?.realization ?? 'attached') === 'frozen'
    })
    useEffect(() => {
      if (!ready) return
      const rec = sessionStore.get(shape.id)
      setFrozen((rec?.realization ?? 'attached') === 'frozen')
    }, [ready, shape.id])

    // Ensure a record exists (no change to realization here)
    useEffect(() => {
      if (!sessionStore.get(shape.id)) {
        sessionStore.ensure(shape.id, {
          url: shape.props.url,
          w: shape.props.w,
          h: shape.props.h,
          x: shape.x,
          y: shape.y,
        })
        sessionStore.save()
      }
    }, [shape.id, shape.props.url, shape.props.w, shape.props.h, shape.x, shape.y])

    // Keep bounds in session
    useEffect(() => {
      sessionStore.setBounds(shape.id, shape.x, shape.y, shape.props.w, shape.props.h)
      sessionStore.save()
    }, [shape.id, shape.x, shape.y, shape.props.w, shape.props.h])

    // Track LRU & activity
    useEffect(() => {
      const el = hostRef.current
      const onFocusDown = () => { sessionStore.focus(shape.id); sessionStore.save() }
      const onActivity = () => { sessionStore.bumpActivity(shape.id) }
      el?.addEventListener('pointerdown', onFocusDown, { capture: true })
      el?.addEventListener('pointerup', onActivity, { capture: true })
      el?.addEventListener('keydown', onActivity as unknown as EventListener, { capture: true })
      return () => {
        el?.removeEventListener('pointerdown', onFocusDown, { capture: true } as AddEventListenerOptions)
        el?.removeEventListener('pointerup', onActivity, { capture: true } as AddEventListenerOptions)
        el?.removeEventListener('keydown', onActivity as unknown as EventListener, { capture: true } as AddEventListenerOptions)
      }
    }, [shape.id])

    // ======================
    // Fit / Unfit (baseline)
    // ======================
    const [fitMode, setFitMode] = useState<boolean>(false)
    const preFitCamRef = useRef<{ x: number; y: number; z: number } | null>(null)
    const preFitSizeRef = useRef<{ w: number; h: number } | null>(null)
    const fitStopRef = useRef<(() => void) | null>(null)

    const getViewportPx = (): { vw: number; vh: number } => {
      const vb = editor.getViewportScreenBounds()
      return { vw: Math.max(1, Math.round(vb.width)), vh: Math.max(1, Math.round(vb.height)) }
    }
    const fitShapeToViewport = (s: BrowserShape, vw: number, vh: number): void => {
      if (s.props.w === vw && s.props.h === vh) return
      const cx = s.x + s.props.w / 2, cy = s.y + s.props.h / 2
      editor.updateShapes([{ id: s.id, type: 'browser-shape', x: Math.round(cx - vw / 2), y: Math.round(cy - vh / 2), props: { ...s.props, w: vw, h: vh } }])
    }
    const zoomToShapeNow = (s: BrowserShape): void => {
      editor.zoomToBounds(new Box(s.x, s.y, s.props.w, s.props.h), { inset: 0 })
    }
    function startInputGuards(): () => void {
      const isInNav = (t: EventTarget | null): boolean => t instanceof Element && !!t.closest('[data-nav-root="1"]')
      const onWheel = (e: WheelEvent) => { if (!isInNav(e.target)) { e.stopImmediatePropagation(); e.preventDefault() } }
      const onPointer = (e: PointerEvent) => { if (!isInNav(e.target)) e.stopImmediatePropagation() }
      const onKey = (e: KeyboardEvent) => {
        const ae = document.activeElement as Element | null
        if (isInNav(ae)) return
        if ([' ', '+', '-', '=', '_'].includes(e.key)) { e.stopImmediatePropagation(); e.preventDefault() }
      }
      window.addEventListener('wheel', onWheel, { capture: true, passive: false })
      window.addEventListener('pointerdown', onPointer, { capture: true })
      window.addEventListener('keydown', onKey, { capture: true })
      return () => {
        window.removeEventListener('wheel', onWheel, { capture: true } as AddEventListenerOptions)
        window.removeEventListener('pointerdown', onPointer, { capture: true } as AddEventListenerOptions)
        window.removeEventListener('keydown', onKey, { capture: true } as AddEventListenerOptions)
      }
    }
    const runFitOnce = (): void => {
      if (!preFitCamRef.current) preFitCamRef.current = editor.getCamera()
      if (!preFitSizeRef.current) preFitSizeRef.current = { w: shape.props.w, h: shape.props.h }
      const s0 = editor.getShape<BrowserShape>(shape.id); if (!s0) return
      const { vw, vh } = getViewportPx()
      fitShapeToViewport(s0, vw, vh)
      const s1 = editor.getShape<BrowserShape>(shape.id); if (s1) zoomToShapeNow(s1)
    }
    const fitOn = (): void => {
      runFitOnce()
      let raf = 0
      let last = { vw: -1, vh: -1, w: -1, h: -1 }
      const step = () => {
        raf = requestAnimationFrame(step)
        const s = editor.getShape<BrowserShape>(shape.id); if (!s) return
        const { vw, vh } = getViewportPx()
        const vpChanged = vw !== last.vw || vh !== last.vh
        const sizeChanged = s.props.w !== last.w || s.props.h !== last.h
        if (vpChanged) fitShapeToViewport(s, vw, vh)
        if (vpChanged || sizeChanged) {
          const fresh = editor.getShape<BrowserShape>(shape.id)
          if (fresh) { zoomToShapeNow(fresh); last = { vw, vh, w: fresh.props.w, h: fresh.props.h } }
          else { last = { vw, vh, w: s.props.w, h: s.props.h } }
        }
      }
      raf = requestAnimationFrame(step)
      const stopGuards = startInputGuards()
      fitStopRef.current = () => { cancelAnimationFrame(raf); stopGuards() }
      setFitMode(true)
    }
    const fitOff = (): void => {
      fitStopRef.current?.(); fitStopRef.current = null
      const prev = preFitSizeRef.current
      const s = editor.getShape<BrowserShape>(shape.id)
      if (prev && s) {
        const cx = s.x + s.props.w / 2, cy = s.y + s.props.h / 2
        editor.updateShapes([{
          id: s.id, type: 'browser-shape',
          x: Math.round(cx - prev.w / 2), y: Math.round(cy - prev.h / 2),
          props: { ...s.props, w: prev.w, h: prev.h },
        }])
      }
      const base = preFitCamRef.current ?? editor.getCamera()
      editor.setCamera({ ...base, z: 0.6 })
      preFitCamRef.current = null; preFitSizeRef.current = null; setFitMode(false)
    }
    const onToggleFit = (): void => { (fitMode ? fitOff : fitOn)() }

    // ===========================
    // Overlay lifecycle (follow)
    // ===========================
    // create view only when ready & not frozen
    useEffect(() => {
      if (!api || !ready || tabIdRef.current || frozen) return
      let cancelled = false
      ;(async () => {
        try {
          const res = await api.createTab({ url: shape.props.url })
          if (!cancelled && res.ok) tabIdRef.current = res.tabId
        } catch {}
      })()
      return () => { cancelled = true }
    }, [api, ready, shape.props.url, frozen])

    // follow position & zoom while attached
    useEffect(() => {
      if (!api || !ready || frozen) return
      let raf = 0
      let shown = false
      let lastRect: Rect = { x: -1, y: -1, width: -1, height: -1 }
      let lastFactor = Number.NaN
      const loop = () => {
        raf = requestAnimationFrame(loop)
        const id = tabIdRef.current; if (!id) return
        const el = hostRef.current; if (!el) return
        const b = el.getBoundingClientRect()
        const rect: Rect = { x: Math.floor(b.left), y: Math.floor(b.top), width: Math.ceil(b.width), height: Math.ceil(b.height) }
        if (!shown) { shown = true; void api.show({ tabId: id, rect }); lastRect = rect }
        else if (rect.x !== lastRect.x || rect.y !== lastRect.y || rect.width !== lastRect.width || rect.height !== lastRect.height) {
          void api.setBounds({ tabId: id, rect }); lastRect = rect
        }
        const factor = editor.getZoomLevel()
        if (!Number.isFinite(lastFactor) || Math.abs(factor - lastFactor) > 1e-3) { void api.setZoom({ tabId: id, factor }); lastFactor = factor }
      }
      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    }, [api, editor, ready, frozen])

    // nav polling while attached; capture when navigation settles
    const prevLoadingRef = useRef<boolean>(false)
    useEffect(() => {
      if (!api || !ready || frozen) return
      let cancelled = false
      const tick = async () => {
        const id = tabIdRef.current; if (!id) return
        try {
          const res = await api.getNavigationState({ tabId: id })
          if (!cancelled && res.ok) {
            const loading = res.isLoading ?? false
            setNavState({
              currentUrl: res.currentUrl ?? 'about:blank',
              canGoBack: res.canGoBack ?? false,
              canGoForward: res.canGoForward ?? false,
              title: res.title ?? '',
            })
            setIsLoading(loading)
            sessionStore.setUrlTitle(shape.id, res.currentUrl ?? 'about:blank', res.title ?? '')
            sessionStore.bumpActivity(shape.id)

            // capture once right after load finishes
            if (prevLoadingRef.current && !loading) {
              try {
                const cap = await api.capture({ tabId: id, shapeId: shape.id })
                if (cap.ok) {
                  if (cap.filePath) sessionStore.setThumbPath(shape.id, cap.filePath)
                  else if (cap.dataUrl) sessionStore.setThumbDataUrl(shape.id, cap.dataUrl)
                  sessionStore.setLastCaptured(shape.id, Date.now())
                  sessionStore.save()
                }
              } catch {}
            }
            prevLoadingRef.current = loading
          }
        } catch {}
      }
      const h = window.setInterval(tick, 500)
      return () => { cancelled = true; window.clearInterval(h) }
    }, [api, ready, frozen, shape.id])

    // periodic live capture + idle eviction while ATTACHED
    useEffect(() => {
      if (!api || !ready || frozen) return
      const h = window.setInterval(async () => {
        const rec = sessionStore.get(shape.id); if (!rec) return
        const id = tabIdRef.current; if (!id) return
        const now = Date.now()

        // idle eviction (30 min)
        if (now - rec.lastActivityAt >= IDLE_EVICT_MS) {
          try {
            const cap = await api.capture({ tabId: id, shapeId: shape.id })
            if (cap.ok) {
              if (cap.filePath) sessionStore.setThumbPath(shape.id, cap.filePath)
              else if (cap.dataUrl) sessionStore.setThumbDataUrl(shape.id, cap.dataUrl)
              sessionStore.setLastCaptured(shape.id, now)
              sessionStore.setRealization(shape.id, 'frozen')
              sessionStore.save()
            }
          } finally {
            try { await api.destroy({ tabId: id }) } catch {}
            tabIdRef.current = null
            setFrozen(true)
          }
          return
        }

        // periodic refresh
        if (!rec.lastCapturedAt || (now - rec.lastCapturedAt) >= CAPTURE_INTERVAL_MS) {
          try {
            const cap = await api.capture({ tabId: id, shapeId: shape.id })
            if (cap.ok) {
              if (cap.filePath) sessionStore.setThumbPath(shape.id, cap.filePath)
              else if (cap.dataUrl) sessionStore.setThumbDataUrl(shape.id, cap.dataUrl)
              sessionStore.setLastCaptured(shape.id, now)
              sessionStore.save()
            }
          } catch {}
        }
      }, 1500)
      return () => window.clearInterval(h)
    }, [api, ready, frozen, shape.id])

    // capture on unmount (best effort)
    useEffect(() => {
      return () => {
        const id = tabIdRef.current
        if (!api || !id) return
        ;(async () => {
          try {
            const cap = await api.capture({ tabId: id, shapeId: shape.id })
            if (cap.ok) {
              if (cap.filePath) sessionStore.setThumbPath(shape.id, cap.filePath)
              else if (cap.dataUrl) sessionStore.setThumbDataUrl(shape.id, cap.dataUrl)
              sessionStore.setLastCaptured(shape.id, Date.now())
              sessionStore.save()
            }
          } finally {
            try { await api.destroy({ tabId: id }) } catch {}
          }
        })()
      }
    }, [api, shape.id])

    const hydrate = async (): Promise<void> => {
      if (!api || tabIdRef.current || !ready || !frozen) return
      const rec = sessionStore.get(shape.id)
      const url = rec?.url ?? shape.props.url
      try {
        const res = await api.createTab({ url })
        if (res?.ok) {
          tabIdRef.current = res.tabId
          setFrozen(false)
          sessionStore.setRealization(shape.id, 'attached')
          sessionStore.focus(shape.id)
          sessionStore.save()
          prevLoadingRef.current = true // next nav poll will capture after settle
        }
      } catch {}
    }

    const thumbSrc = (() => {
      const rec = sessionStore.get(shape.id); if (!rec) return undefined
      return rec.thumbDataUrl ?? (rec.thumbPath ? `file://${rec.thumbPath}` : undefined)
    })()

    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          position: 'relative',
          pointerEvents: 'auto',
          cursor: 'default',
        }}
      >
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <NavigationBar
            navState={navState}
            isLoading={isLoading}
            onUrlChange={async (url) => {
              if (frozen) { await hydrate(); return }
              const id = tabIdRef.current; if (api && id) { setIsLoading(true); await api.navigate({ tabId: id, url }) }
            }}
            onBack={async () => {
              if (frozen) { await hydrate(); return }
              const id = tabIdRef.current; if (api && id && navState.canGoBack) { setIsLoading(true); await api.goBack({ tabId: id }) }
            }}
            onForward={async () => {
              if (frozen) { await hydrate(); return }
              const id = tabIdRef.current; if (api && id && navState.canGoForward) { setIsLoading(true); await api.goForward({ tabId: id }) }
            }}
            onReload={async () => {
              if (frozen) { await hydrate(); return }
              const id = tabIdRef.current; if (api && id) { setIsLoading(true); await api.reload({ tabId: id }) }
            }}
            fitMode={fitMode}
            onToggleFit={onToggleFit}
          />

          <div
            ref={hostRef}
            style={{
              position: 'absolute',
              top: NAV_BAR_HEIGHT,
              left: DRAG_GUTTER,
              right: DRAG_GUTTER,
              bottom: DRAG_GUTTER,
              pointerEvents: frozen ? 'auto' : 'none',
              background: 'transparent',
              borderRadius: 8,
              overflow: 'hidden',
            }}
            onPointerDown={(e) => { if (frozen && e.button === 0) { e.stopPropagation(); void hydrate() } }}
            onDoubleClick={() => { if (frozen) void hydrate() }}
          >
            {frozen && (
              <div style={{ position: 'absolute', inset: 0 }}>
                {thumbSrc && (
                  <img
                    src={thumbSrc}
                    alt={navState.title || 'Frozen tab'}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      filter: 'grayscale(0.6) blur(0.35px)',
                      opacity: 0.92,
                    }}
                  />
                )}
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.18)' }} />
                <div
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 8px',
                    borderRadius: 999,
                    background: 'rgba(255,255,255,0.9)',
                    color: '#2b8a3e',
                    font: '500 12px system-ui',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M5 21c4.418 0 8-3.582 8-8V5h8v8c0 6.627-5.373 12-12 12H5v-4z" />
                  </svg>
                  Frozen — click to wake
                </div>
              </div>
            )}
          </div>
        </div>
      </HTMLContainer>
    )
  }
}
