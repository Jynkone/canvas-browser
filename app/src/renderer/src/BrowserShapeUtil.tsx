import { useCallback, useEffect, useRef, useState } from 'react'
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  TLBaseShape,
  TLResizeInfo,
  resizeBox,
  useEditor,
} from 'tldraw'
import { NavigationBar, NAV_BAR_HEIGHT } from './NavigationBar'

export type BrowserShape = TLBaseShape<'browser-shape', {
  w: number
  h: number
  url: string
  tabId: string
}>

// World-space minimum logical size (not zoomed)
const MIN_W = 900
const MIN_H = 525 + NAV_BAR_HEIGHT

// Screen-space affordances
const HIT_PAD_PX = 10      // extra grab halo in screen pixels
const MIN_STROKE_PX = 1    // min indicator stroke in screen pixels

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const

  override isAspectRatioLocked = () => false
  override canResize = () => true
  override hideResizeHandles = () => false

  override getDefaultProps(): BrowserShape['props'] {
    return { w: 1200, h: 600 + NAV_BAR_HEIGHT, url: 'https://google.com', tabId: '' }
  }

  override onResize(shape: BrowserShape, info: TLResizeInfo<BrowserShape>) {
    const partial = resizeBox(shape, info)
    const w = Math.max(MIN_W, partial.props.w)
    const h = Math.max(MIN_H, partial.props.h)
    return { ...partial, props: { ...partial.props, w, h } }
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
    const hostRef = useRef<HTMLDivElement>(null)
    const editor = useEditor()
    const tabIdRef = useRef<string>('')

    const [navState, setNavState] = useState({
      currentUrl: shape.props.url,
      canGoBack: false,
      canGoForward: false,
      title: ''
    })
    const [isLoading, setIsLoading] = useState(false)
    const [isGrabbing, setIsGrabbing] = useState(false)

    // Create the tab once
    useEffect(() => {
      let cancelled = false
      ;(async () => {
        if (cancelled || tabIdRef.current) return
        try {
          const res = await (window as any).overlay?.createTab({ url: shape.props.url })
          if (res?.ok && res?.tabId) tabIdRef.current = res.tabId
        } catch {}
      })()
      return () => { cancelled = true }
    }, [shape.props.url])

    // Update navigation state
    const updateNavState = useCallback(async () => {
      const id = tabIdRef.current
      if (!id) return

      try {
        const res = await (window as any).overlay?.getNavigationState({ tabId: id })
        if (res?.ok) {
          setNavState({
            currentUrl: res.currentUrl || 'about:blank',
            canGoBack: res.canGoBack || false,
            canGoForward: res.canGoForward || false,
            title: res.title || ''
          })
          setIsLoading(res.isLoading || false)
        }
      } catch {}
    }, [])

    // Poll for navigation updates
    useEffect(() => {
      const interval = setInterval(updateNavState, 500)
      return () => clearInterval(interval)
    }, [updateNavState])

    // Navigation handlers
    const handleUrlChange = useCallback(async (url: string) => {
      const id = tabIdRef.current
      if (!id) return
      
      setIsLoading(true)
      try {
        await (window as any).overlay?.navigate({ tabId: id, url })
      } catch {}
    }, [])

    const handleBack = useCallback(async () => {
      const id = tabIdRef.current
      if (!id || !navState.canGoBack) return
      
      setIsLoading(true)
      try {
        await (window as any).overlay?.goBack({ tabId: id })
      } catch {}
    }, [navState.canGoBack])

    const handleForward = useCallback(async () => {
      const id = tabIdRef.current
      if (!id || !navState.canGoForward) return
      
      setIsLoading(true)
      try {
        await (window as any).overlay?.goForward({ tabId: id })
      } catch {}
    }, [navState.canGoForward])

    const handleReload = useCallback(async () => {
      const id = tabIdRef.current
      if (!id) return
      
      setIsLoading(true)
      try {
        await (window as any).overlay?.reload({ tabId: id })
      } catch {}
    }, [])

    // Sync bounds & zoom (no extra smoothing = no jello)
    useEffect(() => {
      let raf = 0
      const lastRect = { x: -1, y: -1, width: -1, height: -1 }
      let lastZoom = -1
      let shown = false

      const tick = () => {
        raf = requestAnimationFrame(tick)
        const el = hostRef.current
        const id = tabIdRef.current
        if (!el || !id) return

        const dpr = window.devicePixelRatio || 1
        const b = el.getBoundingClientRect()

        // device-pixel aware alignment (CSS px)
        const rx = Math.round(b.x * dpr) / dpr
        const ry = Math.round(b.y * dpr) / dpr
        const rw = Math.round(b.width * dpr) / dpr
        const rh = Math.round(b.height * dpr) / dpr

        const rect = {
          x: Math.floor(rx),
          y: Math.floor(ry),
          width: Math.ceil(rw),
          height: Math.ceil(rh),
        }

        if (!shown) {
          shown = true
          ;(window as any).overlay?.show({ tabId: id, rect }).catch(() => {})
          Object.assign(lastRect, rect)
        } else {
          const moved =
            rect.x !== lastRect.x ||
            rect.y !== lastRect.y ||
            rect.width !== lastRect.width ||
            rect.height !== lastRect.height

          if (moved) {
            ;(window as any).overlay?.setBounds({ tabId: id, rect }).catch(() => {})
            Object.assign(lastRect, rect)
          }
        }

        // Follow editor zoom exactly
        const z = editor.getZoomLevel()
        if (Math.abs(z - lastZoom) > 0.0005) {
          ;(window as any).overlay?.setZoom({ tabId: id, factor: z }).catch(() => {})
          lastZoom = z
        }
      }

      tick()
      return () => cancelAnimationFrame(raf)
    }, [editor])

    // Cleanup
    useEffect(() => {
      return () => {
        const id = tabIdRef.current
        if (!id) return
        // Prefer destroy; fall back to hide if needed
        const o = (window as any).overlay
        if (o?.destroy) o.destroy({ tabId: id }).catch?.(() => {})
        else o?.hide?.({ tabId: id }).catch?.(() => {})
      }
    }, [])

    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          position: 'relative',
          pointerEvents: 'auto',
          cursor: isGrabbing ? 'grabbing' : 'grab',
        }}
        onPointerDown={() => setIsGrabbing(true)}
        onPointerUp={() => setIsGrabbing(false)}
        onPointerCancel={() => setIsGrabbing(false)}
        onPointerLeave={() => setIsGrabbing(false)}
      >
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative'
        }}>
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
            style={{
              width: '100%',
              flex: 1,
              background: 'transparent',
              position: 'relative',
              pointerEvents: 'none'
            }}
          />
        </div>
      </HTMLContainer>
    )
  }
}