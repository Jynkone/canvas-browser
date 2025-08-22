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

const DRAG_GUTTER = 14 // outside drag gutters
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
    
useEffect(() => {
  if (!api || tabIdRef.current) return
  let cancelled = false

  ;(async () => {
    try {
      const res = await api.createTab({ url: shape.props.url, shapeId: shape.id })
      if (!res.ok || cancelled) return

      const id = res.tabId
      tabIdRef.current = id

    } catch {
      // creation failed → cleanup happens naturally
    }
  })()

  return () => {
    cancelled = true
  }
}, [api, shape.props.url, shape.id])

// 3. Navigation state polling (keep as-is)
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

useEffect(() => {
  if (!api) return

  let raf = 0
  let shown = false
  let lastRect: Rect = { x: -1, y: -1, width: -1, height: -1 }
  let lastFactor = -1

  const loop = (): void => {
    raf = requestAnimationFrame(loop)

    const id = tabIdRef.current
    if (!id) return

    const shapeRecord = editor.getShape<BrowserShape>(shape.id)
    if (!shapeRecord || shapeRecord.type !== 'browser-shape') return

    const pagePos = { x: shapeRecord.x, y: shapeRecord.y }
    const screenPos = editor.pageToScreen(pagePos)
    const zoom = editor.getZoomLevel()

    const rect: Rect = {
      x: screenPos.x,
      y: screenPos.y + (NAV_BAR_HEIGHT * zoom),
      width: shapeRecord.props.w * zoom,
      height: (shapeRecord.props.h - NAV_BAR_HEIGHT) * zoom,
    }

    const rectChanged: boolean = rect.x !== lastRect.x || rect.y !== lastRect.y || 
                                rect.width !== lastRect.width || rect.height !== lastRect.height

    if (!shown) {
      shown = true
      void api.show({ tabId: id, rect })
      void api.setZoom({ tabId: id, factor: zoom })
      lastRect = rect
      lastFactor = zoom
    } else if (rectChanged) {
      void api.setBounds({ tabId: id, rect })
      lastRect = rect
    } else {
      if (Math.abs(zoom - lastFactor) > 0.01) {
        void api.setZoom({ tabId: id, factor: zoom })
        lastFactor = zoom
      }
    }
  }

  raf = requestAnimationFrame(loop)
  return (): void => cancelAnimationFrame(raf)
}, [api, editor, shape.id])

// 5. Cleanup (keep as-is)
useEffect(() => {
  return () => {
    const id = tabIdRef.current
    if (!api || !id) return
    void api.destroy({ tabId: id })
    
  }
}, [api])

    // ---- Minimal fit toggle ------------------------------------------------
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
  const cx = s.x + s.props.w / 2
  const cy = s.y + s.props.h / 2
  const x = Math.round(cx - vw / 2)
  const y = Math.round(cy - vh / 2)
  editor.updateShapes([{ id: s.id, type: 'browser-shape', x, y, props: { w: vw, h: vh } }])
}

const zoomToShapeNow = (s: BrowserShape): void => {
  editor.zoomToBounds(new Box(s.x, s.y, s.props.w, s.props.h), { inset: 0 })
}

function startInputGuards(): () => void {
  const isInNav = (t: EventTarget | null): boolean =>
    t instanceof Element && !!t.closest('[data-nav-root="1"]')

  const onWheel = (e: WheelEvent) => { if (!isInNav(e.target)) { e.stopImmediatePropagation(); e.preventDefault() } }
  const onPointer = (e: PointerEvent) => { if (!isInNav(e.target)) e.stopImmediatePropagation() }
  const onKey = (e: KeyboardEvent) => {
    const ae = document.activeElement as Element | null
    if (isInNav(ae)) return
    if (e.key === ' ' || e.key === '+' || e.key === '-' || e.key === '=' || e.key === '_') {
      e.stopImmediatePropagation(); e.preventDefault()
    }
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
      if (fresh) {
        zoomToShapeNow(fresh)
        last = { vw, vh, w: fresh.props.w, h: fresh.props.h }
      } else {
        last = { vw, vh, w: s.props.w, h: s.props.h }
      }
    }
  }
  raf = requestAnimationFrame(step)

  const stopGuards = startInputGuards()
  fitStopRef.current = () => { cancelAnimationFrame(raf); stopGuards() }
  setFitMode(true)
}

const fitOff = (): void => {
  // stop guards / raf set during fitOn
  fitStopRef.current?.()
  fitStopRef.current = null

  // restore shape size (preserve center)
  const prev = preFitSizeRef.current
  const s = editor.getShape<BrowserShape>(shape.id)
  if (prev && s) {
    const cx = s.x + s.props.w / 2
    const cy = s.y + s.props.h / 2
    const x = Math.round(cx - prev.w / 2)
    const y = Math.round(cy - prev.h / 2)
    editor.updateShapes([{ id: s.id, type: 'browser-shape', x, y, props: { ...s.props, w: prev.w, h: prev.h } }])
  }

  // reset camera zoom to 60% (keep previous center if saved)
  const base = preFitCamRef.current ?? editor.getCamera()
  editor.setCamera({ ...base, z: 0.6 })

  preFitCamRef.current = null
  preFitSizeRef.current = null
  setFitMode(false)
}

const onToggleFit = (): void => { (fitMode ? fitOff : fitOn)() }
    // ---- Styles ------------------------------------------------------------
const contentStyle: React.CSSProperties = {
  position: 'absolute',
  top: NAV_BAR_HEIGHT, // start below navbar
  left: 0,
  right: 0,
  bottom: 0,
  overflow: 'hidden',
  zIndex: 0,
  background: 'transparent',
}

// ---- Render ------------------------------------------------------------
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

      <div style={contentStyle}>
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
      </div>
    </div>
  </HTMLContainer>
)
  }
}