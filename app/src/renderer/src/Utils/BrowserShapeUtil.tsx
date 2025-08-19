import { useEffect, useRef, useState } from 'react'
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  TLBaseShape,
  TLResizeInfo,
  resizeBox,
  useEditor,
} from 'tldraw'
import { NavigationBar, NAV_BAR_HEIGHT } from '../components/NavigationBar'

export type BrowserShape = TLBaseShape<
  'browser-shape',
  { w: number; h: number; url: string; tabId: string }
>

// ── sizing
const MIN_W = 900
const MIN_H = 525 + NAV_BAR_HEIGHT
const HIT_PAD_PX = 10
const MIN_STROKE_PX = 1

// ── fit math / animation
const DEFAULT_CANVAS_ZOOM = 0.6 as const
const FIT_OVERLAY_FACTOR = 1 / DEFAULT_CANVAS_ZOOM
const FIT_MS = 280 as const
const UNFIT_MS = 300 as const

type Rect = { x: number; y: number; width: number; height: number }
type NavState = { currentUrl: string; canGoBack: boolean; canGoForward: boolean; title: string }

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t)
const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3)
const easeInOutCubic = (t: number) =>
  (t = clamp01(t)) < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: Math.round(lerp(a.x, b.x, t)),
  y: Math.round(lerp(a.y, b.y, t)),
  width: Math.round(lerp(a.width, b.width, t)),
  height: Math.round(lerp(a.height, b.height, t)),
})

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const
  override isAspectRatioLocked = () => false
  override canResize = () => true
  override hideResizeHandles = () => false

  override getDefaultProps(): BrowserShape['props'] {
    return { w: 1200, h: 600 + NAV_BAR_HEIGHT, url: 'https://google.com', tabId: '' }
  }

  override onResize(shape: BrowserShape, info: TLResizeInfo<BrowserShape>) {
    const r = resizeBox(shape, info)
    const w = Math.max(MIN_W, r.props.w)
    const h = Math.max(MIN_H, r.props.h)
    return { ...r, props: { ...r.props, w, h } }
  }

  override getGeometry(shape: BrowserShape) {
    const z = this.editor.getZoomLevel()
    const pad = HIT_PAD_PX / Math.max(z, 0.001)
    return new Rectangle2d({
      x: -pad,
      y: -pad,
      width: shape.props.w + pad * 2,
      height: shape.props.h + pad * 2,
      isFilled: false,
    })
  }

  override indicator(shape: BrowserShape) {
    const z = this.editor.getZoomLevel()
    const sw = MIN_STROKE_PX / Math.max(z, 0.001)
    return <rect x={0} y={0} width={shape.props.w} height={shape.props.h} strokeWidth={sw} />
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
    const [fitMode, setFitMode] = useState<boolean>(false)
    const preFitCamRef = useRef<{ x: number; y: number; z: number } | null>(null)

    // single compact anim descriptor (read by rAF)
    const animRef = useRef<{
      running: boolean
      toFit: boolean
      start: number
      duration: number
      fromRect: Rect
      toRect: Rect
      fromFactor: number
      toFactor: number
      fromCam?: { x: number; y: number; z: number }
      toCam?: { x: number; y: number; z: number }
    } | null>(null)

    // ── create tab once
    useEffect(() => {
      let cancelled = false
      if (!api || tabIdRef.current) return
      ;(async () => {
        try {
          const res = await api.createTab({ url: shape.props.url })
          if (!cancelled && res.ok) tabIdRef.current = res.tabId
        } catch {}
      })()
      return () => { cancelled = true }
    }, [api, shape.props.url])

    // ── poll nav state
    useEffect(() => {
      if (!api) return
      let cancelled = false
      const tick = async () => {
        const id = tabIdRef.current; if (!id) return
        try {
          const res = await api.getNavigationState({ tabId: id })
          if (!cancelled && res.ok) {
            setNavState({
              currentUrl: res.currentUrl ?? 'about:blank',
              canGoBack: res.canGoBack ?? false,
              canGoForward: res.canGoForward ?? false,
              title: res.title ?? '',
            })
            setIsLoading(res.isLoading ?? false)
          }
        } catch {}
      }
      const h = window.setInterval(tick, 500)
      return () => { cancelled = true; window.clearInterval(h) }
    }, [api])

    // ── handlers
    const handleUrlChange = async (url: string): Promise<void> => {
      const id = tabIdRef.current; if (!api || !id) return
      setIsLoading(true); await api.navigate({ tabId: id, url })
    }
    const handleBack = async (): Promise<void> => {
      const id = tabIdRef.current; if (!api || !id || !navState.canGoBack) return
      setIsLoading(true); await api.goBack({ tabId: id })
    }
    const handleForward = async (): Promise<void> => {
      const id = tabIdRef.current; if (!api || !id || !navState.canGoForward) return
      setIsLoading(true); await api.goForward({ tabId: id })
    }
    const handleReload = async (): Promise<void> => {
      const id = tabIdRef.current; if (!api || !id) return
      setIsLoading(true); await api.reload({ tabId: id })
    }

    // ── rect helpers
    const getHostRect = (): Rect | null => {
      const el = hostRef.current; if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: Math.floor(b.left), y: Math.floor(b.top), width: Math.ceil(b.width), height: Math.ceil(b.height) }
    }
    const getFitRect = (): Rect => ({
      x: 0,
      y: NAV_BAR_HEIGHT, // ← KEY: leave space for navbar so it stays visible & clickable
      width: Math.floor(window.innerWidth),
      height: Math.max(0, Math.floor(window.innerHeight) - NAV_BAR_HEIGHT),
    })

    // ── rAF: follow/animate & sync zoom (respect navbar gap)
    useEffect(() => {
      if (!api) return
      let raf = 0
      let shown = false
      let lastRect: Rect = { x: -1, y: -1, width: -1, height: -1 }
      let lastFactor = -1

      const loop = () => {
        raf = requestAnimationFrame(loop)
        const id = tabIdRef.current; if (!id) return

        const now = performance.now()
        let rect: Rect
        let factor: number

        const anim = animRef.current
        if (anim && anim.running) {
          const raw = (now - anim.start) / anim.duration
          const t = anim.toFit ? easeOutCubic(raw) : easeInOutCubic(raw)
          if (raw >= 1) {
            rect = anim.toRect
            factor = anim.toFactor
            if (anim.toCam) editor.setCamera(anim.toCam)
            anim.running = false
            animRef.current = null
            setFitMode(anim.toFit)
          } else {
            rect = lerpRect(anim.fromRect, anim.toRect, t)
            factor = lerp(anim.fromFactor, anim.toFactor, t)
            if (anim.fromCam && anim.toCam) {
              editor.setCamera({
                x: lerp(anim.fromCam.x, anim.toCam.x, t),
                y: lerp(anim.fromCam.y, anim.toCam.y, t),
                z: lerp(anim.fromCam.z, anim.toCam.z, t),
              })
            }
          }
        } else {
          if (fitMode) { rect = getFitRect(); factor = FIT_OVERLAY_FACTOR }
          else {
            const host = getHostRect(); if (!host) return
            rect = host; factor = editor.getZoomLevel()
          }
        }

        if (!shown) { shown = true; void api.show({ tabId: id, rect }); lastRect = rect }
        else if (rect.x !== lastRect.x || rect.y !== lastRect.y || rect.width !== lastRect.width || rect.height !== lastRect.height) {
          void api.setBounds({ tabId: id, rect }); lastRect = rect
        }

        if (Math.abs(factor - lastFactor) > 1e-4) { void api.setZoom({ tabId: id, factor }); lastFactor = factor }
      }

      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    }, [api, editor, shape.props.w, shape.props.h, fitMode])

    // ── toggle fit (animated), ALWAYS leaves navbar visible
    const onToggleFit = (): void => {
      if (!api) return
      const id = tabIdRef.current
      const hostEl = hostRef.current
      if (!id || !hostEl) return

      const cam = editor.getCamera()

      if (!fitMode) {
        // enter fit
        preFitCamRef.current = cam
        const b = hostEl.getBoundingClientRect()
        const fromRect: Rect = { x: Math.floor(b.left), y: Math.floor(b.top), width: Math.ceil(b.width), height: Math.ceil(b.height) }
        const toRect = getFitRect()
        animRef.current = {
          running: true, toFit: true, start: performance.now(), duration: FIT_MS,
          fromRect, toRect, fromFactor: editor.getZoomLevel(), toFactor: FIT_OVERLAY_FACTOR,
        }
      } else {
        // exit fit
        const targetCam = preFitCamRef.current ?? { x: cam.x, y: cam.y, z: DEFAULT_CANVAS_ZOOM }
        const hb = hostEl.getBoundingClientRect()
        const fromRect = getFitRect()
        const toRect: Rect = { x: Math.floor(hb.left), y: Math.floor(hb.top), width: Math.ceil(hb.width), height: Math.ceil(hb.height) }
        animRef.current = {
          running: true, toFit: false, start: performance.now(), duration: UNFIT_MS,
          fromRect, toRect, fromFactor: FIT_OVERLAY_FACTOR, toFactor: targetCam.z,
          fromCam: cam, toCam: targetCam,
        }
      }
    }

    // ── ensure visible before interaction
    const onPointerDown = (): void => {
      const id = tabIdRef.current; if (!api || !id) return
      const el = hostRef.current; if (!el) return
      const b = el.getBoundingClientRect()
      const rect: Rect = { x: Math.floor(b.left), y: Math.floor(b.top), width: Math.ceil(b.width), height: Math.ceil(b.height) }
      void api.show({ tabId: id, rect })
    }

    // ── cleanup
    useEffect(() => {
      return () => {
        const id = tabIdRef.current
        if (!api || !id) return
        void api.destroy({ tabId: id })
      }
    }, [api])

    // while animating into fit, dock the wrapper so the bar pins to window top
    const isDocked = fitMode || (animRef.current?.running === true && animRef.current.toFit)

    return (
      <HTMLContainer
        style={{ width: shape.props.w, height: shape.props.h, position: 'relative', pointerEvents: 'auto', cursor: 'default' }}
      >
        <div
          style={{
            width: isDocked ? '100vw' : '100%',
            height: isDocked ? '100vh' : '100%',
            display: 'flex',
            flexDirection: 'column',
            position: isDocked ? ('fixed' as const) : ('relative' as const),
            top: isDocked ? 0 : undefined,
            left: isDocked ? 0 : undefined,
            zIndex: isDocked ? 2000 : 'auto',
          }}
        >
          <NavigationBar
            navState={navState}
            isLoading={isLoading}
            onUrlChange={handleUrlChange}
            onBack={handleBack}
            onForward={handleForward}
            onReload={handleReload}
            fitMode={fitMode}
            onToggleFit={onToggleFit}
          />
          {/* Click-through region; BrowserView handles input */}
          <div
            ref={hostRef}
            onPointerDown={onPointerDown}
            style={{ width: '100%', flex: 1, background: 'transparent', position: 'relative', pointerEvents: 'none' }}
          />
        </div>
      </HTMLContainer>
    )
  }
}
