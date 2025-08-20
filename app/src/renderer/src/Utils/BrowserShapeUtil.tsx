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

export type BrowserShape = TLBaseShape<
  'browser-shape',
  { w: number; h: number; url: string; tabId: string }
>

const DRAG_GUTTER = 8 // px: leave this much on L/R/B as an easy grab area

// World-space minimum logical size (includes navbar and gutters)
const MIN_W = 1000
const MIN_H = 525 + NAV_BAR_HEIGHT + DRAG_GUTTER * 2

type Rect = { x: number; y: number; width: number; height: number }
type NavState = { currentUrl: string; canGoBack: boolean; canGoForward: boolean; title: string }

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const
  override isAspectRatioLocked = () => false
  override canResize = () => true
  override hideResizeHandles = () => false

  override getDefaultProps(): BrowserShape['props'] {
    // default size includes navbar + gutters
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

    // When non-null, we render the static screenshot instead of live view
    const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)

    // ---- helpers ----------------------------------------------------------
    const getHostRect = (): Rect | null => {
      const el = hostRef.current
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        x: Math.floor(b.left),
        y: Math.floor(b.top),
        width: Math.ceil(b.width),
        height: Math.ceil(b.height),
      }
    }

    const syncOverlayNow = async (id: string): Promise<void> => {
      const rect = getHostRect()
      if (!api || !rect) return
      await api.show({ tabId: id, rect })
      await Promise.all([
        api.setBounds({ tabId: id, rect }),
        api.setZoom({ tabId: id, factor: editor.getZoomLevel() }),
      ])
    }

    // ---- Overlay lifecycle ------------------------------------------------
    useEffect(() => {
      let cancelled = false
      if (!api || tabIdRef.current) return
      ;(async () => {
        try {
          const res = await api.createTab({ url: shape.props.url })
          if (!res.ok || cancelled) return
          const id = res.tabId
          tabIdRef.current = id

          // Prime placement/zoom immediately
          await syncOverlayNow(id)

          // Edge case: if we were already zoomed out (< 0.25),
          // capture immediately so we have a screenshot to show at once.
          if (editor.getZoomLevel() < 0.25) {
            try {
              const cap = await api.capture({ tabId: id })
              if (cap.ok && cap.dataUrl) setScreenshotUrl(cap.dataUrl)
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      })()
      return () => { cancelled = true }
    }, [api, editor, shape.props.url])

    // Navigation state polling
    useEffect(() => {
      if (!api) return
      let cancelled = false
      const tick = async () => {
        const id = tabIdRef.current
        if (!id) return
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
        } catch { /* noop */ }
      }
      const h = window.setInterval(tick, 500)
      return () => { cancelled = true; window.clearInterval(h) }
    }, [api])

    // Bounds + zoom follow loop (canvas → overlay)
    useEffect(() => {
      if (!api) return

      let raf = 0
      let shown = false
      let lastRect: Rect = { x: -1, y: -1, width: -1, height: -1 }
      let lastFactor = Number.NaN

      const loop = () => {
        raf = requestAnimationFrame(loop)

        const id = tabIdRef.current
        if (!id) return
        const rect = getHostRect()
        if (!rect) return

        if (!shown) {
          shown = true
          void api.show({ tabId: id, rect })
          lastRect = rect
        } else if (
          rect.x !== lastRect.x ||
          rect.y !== lastRect.y ||
          rect.width !== lastRect.width ||
          rect.height !== lastRect.height
        ) {
          void api.setBounds({ tabId: id, rect })
          lastRect = rect
        }

        const factor = editor.getZoomLevel()
        if (!Number.isFinite(lastFactor) || Math.abs(factor - lastFactor) > 1e-3) {
          void api.setZoom({ tabId: id, factor })
          lastFactor = factor
        }
      }

      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    }, [api, editor])

    // Imperceptible swap: keep screenshot visible until live view is reattached & synced
    useEffect(() => {
      if (!api) return
      let mounted = true

      const off = api.onScreenshotMode(async ({ tabId, screenshot }) => {
        const id = tabIdRef.current
        if (!mounted || !id || id !== tabId) return

        // Entering screenshot mode
        if (typeof screenshot === 'string') {
          setScreenshotUrl(screenshot)
          return
        }

        // Leaving screenshot mode: pre-sync live view under the image, then drop it
        try {
          await syncOverlayNow(id)
        } finally {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (mounted) setScreenshotUrl(null)
            })
          )
        }
      })

      return () => { mounted = false; off?.() }
    }, [api, editor])

    // Cleanup
    useEffect(() => {
      return () => {
        const id = tabIdRef.current
        if (!api || !id) return
        void api.destroy({ tabId: id })
        setScreenshotUrl(null)
      }
    }, [api])

    // ---- Minimal fit toggle (kept simple) ---------------------------------
    const [fitMode, setFitMode] = useState<boolean>(false)
    const onToggleFit = (): void => {
      const s = editor.getShape<BrowserShape>(shape.id)
      if (!s) return
      if (!fitMode) editor.zoomToBounds(new Box(s.x, s.y, s.props.w, s.props.h), { inset: 0 })
      setFitMode(!fitMode)
    }

    // ---- Styles -----------------------------------------------------------
    const contentStyle: React.CSSProperties = {
      position: 'absolute',
      top: NAV_BAR_HEIGHT,
      left: DRAG_GUTTER,
      right: DRAG_GUTTER,
      bottom: DRAG_GUTTER,
      overflow: 'hidden',
      zIndex: 0,
      background: 'transparent',
    }

    // ---- Render -----------------------------------------------------------
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
        {/* Column: navbar + content */}
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
          }}
        >
          <NavigationBar
            navState={navState}
            isLoading={isLoading}
            onUrlChange={async (url) => {
              const id = tabIdRef.current
              if (api && id) { setIsLoading(true); await api.navigate({ tabId: id, url }) }
            }}
            onBack={async () => {
              const id = tabIdRef.current
              if (api && id && navState.canGoBack) { setIsLoading(true); await api.goBack({ tabId: id }) }
            }}
            onForward={async () => {
              const id = tabIdRef.current
              if (api && id && navState.canGoForward) { setIsLoading(true); await api.goForward({ tabId: id }) }
            }}
            onReload={async () => {
              const id = tabIdRef.current
              if (api && id) { setIsLoading(true); await api.reload({ tabId: id }) }
            }}
            fitMode={fitMode}
            onToggleFit={onToggleFit}
          />

          {/* Content box (live overlay proxy + screenshot) */}
          <div style={contentStyle}>
            {/* Proxy element: its screen rect is used by main to place WebContentsView */}
            <div
              ref={hostRef}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                pointerEvents: 'none',
              }}
            />

            {/* Screenshot layer: fills the box exactly when active */}
            {screenshotUrl && (
              <img
                src={screenshotUrl}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  width: '100%',
                  height: '100%',
                  display: 'block',
                  objectFit: 'fill', // change to 'contain' for letterboxing
                  pointerEvents: 'none',
                  userSelect: 'none',
                  transition: 'none',
                  animation: 'none',
                  backfaceVisibility: 'hidden',
                  transform: 'translateZ(0)',
                }}
              />
            )}
          </div>
        </div>
      </HTMLContainer>
    )
  }
}
