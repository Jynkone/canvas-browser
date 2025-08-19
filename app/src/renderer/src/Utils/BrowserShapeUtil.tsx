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
  {
    w: number
    h: number
    url: string
    tabId: string
  }
>

// World-space minimum logical size (not zoomed)
const MIN_W = 900
const MIN_H = 525 + NAV_BAR_HEIGHT

// Screen-space affordances
const HIT_PAD_PX = 10      // extra grab halo in screen pixels
const MIN_STROKE_PX = 1    // min indicator stroke in screen pixels

type NavState = {
  currentUrl: string
  canGoBack: boolean
  canGoForward: boolean
  title: string
}

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const

  override isAspectRatioLocked = () => false
  override canResize = () => true
  override hideResizeHandles = () => false

  override getDefaultProps(): BrowserShape['props'] {
    return { w: 1200, h: 600 + NAV_BAR_HEIGHT, url: 'https://google.com', tabId: '' }
  }

  override onResize(shape: BrowserShape, info: TLResizeInfo<BrowserShape>) {
    const resized = resizeBox(shape, info)
    const w = Math.max(MIN_W, resized.props.w)
    const h = Math.max(MIN_H, resized.props.h)
    return { ...resized, props: { ...resized.props, w, h } }
  }

  // Make the hit-area bigger in screen pixels by inflating the geometry.
  // Indicator stays at the visual bounds (see indicator below).
  override getGeometry(shape: BrowserShape) {
    const { w, h } = shape.props
    const zoom = this.editor.getZoomLevel()
    const pad = HIT_PAD_PX / Math.max(zoom, 0.001) // px → world units
    return new Rectangle2d({
      x: -pad,
      y: -pad,
      width: w + pad * 2,
      height: h + pad * 2,
      isFilled: false,
    })
  }

  // Visual selection outline: scale stroke so it stays visible at low zoom.
  override indicator(shape: BrowserShape) {
    const { w, h } = shape.props
    const zoom = this.editor.getZoomLevel()
    const strokeWidth = MIN_STROKE_PX / Math.max(zoom, 0.001)
    return <rect x={0} y={0} width={w} height={h} strokeWidth={strokeWidth} />
  }

  override component(shape: BrowserShape) {
    const editor = useEditor()
    const hostRef = useRef<HTMLDivElement | null>(null)
    const tabIdRef = useRef<string | null>(null)

    const overlay = window.overlay

    const [navState, setNavState] = useState<NavState>({
      currentUrl: shape.props.url,
      canGoBack: false,
      canGoForward: false,
      title: '',
    })
    const [isLoading, setIsLoading] = useState(false)
    const [isGrabbing, setIsGrabbing] = useState(false)

    // Create the tab once for this component instance
    useEffect(() => {
      let cancelled = false
      if (!overlay) return
      if (tabIdRef.current) return

      ;(async () => {
        try {
          const res = await overlay.createTab({ url: shape.props.url })
          if (!cancelled && res.ok) {
            tabIdRef.current = res.tabId
          }
        } catch {
          // ignore (fail-soft)
        }
      })()

      return () => {
        cancelled = true
      }
    }, [overlay, shape.props.url])

    // Update navigation state (polled)
    useEffect(() => {
      if (!overlay) return
      let cancelled = false
      const tick = async () => {
        const id = tabIdRef.current
        if (!id) return
        try {
          const res = await overlay.getNavigationState({ tabId: id })
          if (!cancelled && res.ok) {
            setNavState({
                   currentUrl: res.currentUrl ?? 'about:blank',
                   canGoBack: res.canGoBack ?? false,
                   canGoForward: res.canGoForward ?? false,  
                   title: res.title ?? '',
            })
            setIsLoading(res.isLoading)
          }
        } catch {
          // ignore
        }
      }
      const handle = window.setInterval(tick, 500)
      return () => {
        cancelled = true
        window.clearInterval(handle)
      }
    }, [overlay])

    // Navigation handlers (typed SimpleResult but we ignore failures)
    const handleUrlChange = async (url: string) => {
      const id = tabIdRef.current
      if (!overlay || !id) return
      setIsLoading(true)
      try { await overlay.navigate({ tabId: id, url }) } catch {}
    }

    const handleBack = async () => {
      const id = tabIdRef.current
      if (!overlay || !id || !navState.canGoBack) return
      setIsLoading(true)
      try { await overlay.goBack({ tabId: id }) } catch {}
    }

    const handleForward = async () => {
      const id = tabIdRef.current
      if (!overlay || !id || !navState.canGoForward) return
      setIsLoading(true)
      try { await overlay.goForward({ tabId: id }) } catch {}
    }

    const handleReload = async () => {
      const id = tabIdRef.current
      if (!overlay || !id) return
      setIsLoading(true)
      try { await overlay.reload({ tabId: id }) } catch {}
    }

    // rAF: follow host element's rect (CSS px) and editor zoom exactly
    useEffect(() => {
      if (!overlay) return
      let raf = 0
      let shown = false
      const lastRect = { x: -1, y: -1, width: -1, height: -1 }
      let lastZoom = -1

      const currentRect = () => {
        const el = hostRef.current
        if (!el) return null
        const dpr = window.devicePixelRatio || 1
        const b = el.getBoundingClientRect()

        const rx = Math.round(b.left * dpr) / dpr
        const ry = Math.round(b.top * dpr) / dpr
        const rw = Math.round(b.width * dpr) / dpr
        const rh = Math.round(b.height * dpr) / dpr

        const rect = {
          x: Math.floor(rx),
          y: Math.floor(ry),
          width: Math.ceil(rw),
          height: Math.ceil(rh),
        }
        return rect
      }

      const loop = () => {
        raf = requestAnimationFrame(loop)
        const id = tabIdRef.current
        const el = hostRef.current
        if (!overlay || !id || !el) return

        const rect = currentRect()
        if (!rect) return

        if (!shown) {
          shown = true
          overlay.show({ tabId: id, rect }).catch(() => {})
          lastRect.x = rect.x
          lastRect.y = rect.y
          lastRect.width = rect.width
          lastRect.height = rect.height
        } else {
          const moved =
            rect.x !== lastRect.x ||
            rect.y !== lastRect.y ||
            rect.width !== lastRect.width ||
            rect.height !== lastRect.height

          if (moved) {
            overlay.setBounds({ tabId: id, rect }).catch(() => {})
            lastRect.x = rect.x
            lastRect.y = rect.y
            lastRect.width = rect.width
            lastRect.height = rect.height
          }
        }

        const z = editor.getZoomLevel()
        if (Math.abs(z - lastZoom) > 0.0005) {
          overlay.setZoom({ tabId: id, factor: z }).catch(() => {})
          lastZoom = z
        }
      }

      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    }, [overlay, editor, shape.props.w, shape.props.h])

    // Ensure visible before interaction (helps if tab is hidden)
    const onPointerDown = () => {
      const id = tabIdRef.current
      if (!overlay || !id) return
      const el = hostRef.current
      if (!el) return
      const b = el.getBoundingClientRect()
      const rect = { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.width), height: Math.ceil(b.height) }
      overlay.show({ tabId: id, rect }).catch(() => {})
    }

    // Cleanup: destroy the tab when this shape unmounts
    useEffect(() => {
      return () => {
        const id = tabIdRef.current
        if (!overlay || !id) return
        overlay.destroy({ tabId: id }).catch(() => {})
      }
    }, [overlay])

    // Render
    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          position: 'relative',
          pointerEvents: 'auto',
          cursor: isGrabbing ? 'grabbing' : 'grab',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}
          onPointerDown={() => setIsGrabbing(true)}
          onPointerUp={() => setIsGrabbing(false)}
          onPointerCancel={() => setIsGrabbing(false)}
          onPointerLeave={() => setIsGrabbing(false)}
        >
          <NavigationBar
            navState={navState}
            isLoading={isLoading}
            onUrlChange={handleUrlChange}
            onBack={handleBack}
            onForward={handleForward}
            onReload={handleReload}
          />
          <div
            ref={hostRef}
            onPointerDown={onPointerDown}
            style={{
              width: '100%',
              flex: 1,
              background: 'transparent',
              position: 'relative',
              pointerEvents: 'none', // overlay handles interaction
            }}
          />
        </div>
      </HTMLContainer>
    )
  }
}
