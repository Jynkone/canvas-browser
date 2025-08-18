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

const MIN_W = 900
const MIN_H = 525 + NAV_BAR_HEIGHT
const HIT_PAD_PX = 10
const MIN_STROKE_PX = 1

type NavState = {
  currentUrl: string
  canGoBack: boolean
  canGoForward: boolean
  title: string
}

enum TabState {
  CREATING = 'creating',
  READY = 'ready',
  ERROR = 'error',
  DESTROYED = 'destroyed',
}

interface TabManager {
  tabId: string | null
  state: TabState
  error: string | null
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
    const partial = resizeBox(shape, info)
    const w = Math.max(MIN_W, partial.props.w)
    const h = Math.max(MIN_H, partial.props.h)
    return { ...partial, props: { ...partial.props, w, h } }
  }

  override getGeometry(shape: BrowserShape) {
    const { w, h } = shape.props
    const zoom = this.editor.getZoomLevel()
    const pad = HIT_PAD_PX / Math.max(zoom, 0.001)
    return new Rectangle2d({ x: -pad, y: -pad, width: w + pad * 2, height: h + pad * 2, isFilled: false })
  }

  override indicator(shape: BrowserShape) {
    const { w, h } = shape.props
    const zoom = this.editor.getZoomLevel()
    const strokeWidth = MIN_STROKE_PX / Math.max(zoom, 0.001)
    return <rect x={0} y={0} width={w} height={h} strokeWidth={strokeWidth} />
  }

  override component(shape: BrowserShape) {
    const editor = useEditor()
    const hostRef = useRef<HTMLDivElement>(null)

    const [tabManager, setTabManager] = useState<TabManager>({
      tabId: null,
      state: TabState.CREATING,
      error: null,
    })
    const [navState, setNavState] = useState<NavState>({
      currentUrl: shape.props.url,
      canGoBack: false,
      canGoForward: false,
      title: '',
    })
    const [isLoading, setIsLoading] = useState(false)
    const [isGrabbing, setIsGrabbing] = useState(false)

    // ---- single-flight guards (kills StrictMode double-invoke too)
    const creatingRef = useRef(false)     // prevents concurrent create calls
    const createdOnceRef = useRef(false)  // ignore duplicate dev StrictMode mount

    // create tab exactly once per shape instance
    useEffect(() => {
      let cancelled = false

      const create = async () => {
        if (cancelled || createdOnceRef.current || creatingRef.current) return
        if (!window.overlay) {
          setTabManager({ tabId: null, state: TabState.ERROR, error: 'Overlay unavailable' })
          return
        }
        creatingRef.current = true
        try {
          const res = await window.overlay.createTab({ url: shape.props.url })
          if (cancelled) return
          if (res.ok && res.tabId) {
            createdOnceRef.current = true
            setTabManager({ tabId: res.tabId, state: TabState.READY, error: null })
          } else {
            setTabManager({ tabId: null, state: TabState.ERROR, error: res.error ?? 'Create failed' })
          }
        } catch (err) {
          if (!cancelled) {
            setTabManager({
              tabId: null,
              state: TabState.ERROR,
              error: err instanceof Error ? err.message : 'Create failed',
            })
          }
        } finally {
          creatingRef.current = false
        }
      }

      void create()
      return () => { cancelled = true }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shape.id, shape.props.url])

    // nav polling
    const updateNavState = useCallback(async () => {
      const id = tabManager.tabId
      if (!id || !window.overlay) return
      try {
        const res = await window.overlay.getNavigationState({ tabId: id })
        if (res.ok) {
          setNavState({
            currentUrl: res.currentUrl ?? 'about:blank',
            canGoBack: !!res.canGoBack,
            canGoForward: !!res.canGoForward,
            title: res.title ?? '',
          })
          setIsLoading(!!res.isLoading)
        }
      } catch {}
    }, [tabManager.tabId])

    useEffect(() => {
      const t = window.setInterval(updateNavState, 500)
      return () => window.clearInterval(t)
    }, [updateNavState])

    // toolbar
    const handleUrlChange = useCallback(async (url: string) => {
      const id = tabManager.tabId
      if (!id || !window.overlay) return
      setIsLoading(true)
      try { await window.overlay.navigate({ tabId: id, url }) } catch {}
    }, [tabManager.tabId])

    const handleBack = useCallback(async () => {
      const id = tabManager.tabId
      if (!id || !window.overlay || !navState.canGoBack) return
      setIsLoading(true)
      try { await window.overlay.goBack({ tabId: id }) } catch {}
    }, [tabManager.tabId, navState.canGoBack])

    const handleForward = useCallback(async () => {
      const id = tabManager.tabId
      if (!id || !window.overlay || !navState.canGoForward) return
      setIsLoading(true)
      try { await window.overlay.goForward({ tabId: id }) } catch {}
    }, [tabManager.tabId, navState.canGoForward])

    const handleReload = useCallback(async () => {
      const id = tabManager.tabId
      if (!id || !window.overlay) return
      setIsLoading(true)
      try { await window.overlay.reload({ tabId: id }) } catch {}
    }, [tabManager.tabId])

    // rAF bounds + zoom (same as your working version)
    useEffect(() => {
      if (tabManager.state !== TabState.READY || !tabManager.tabId || !window.overlay) return

      let raf = 0
      let lastZoom = -1
      const lastRect = { x: -1, y: -1, width: -1, height: -1 }
      let shown = false

      const tick = () => {
        raf = requestAnimationFrame(tick)
        const el = hostRef.current
        const id = tabManager.tabId!
        if (!el) return

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

        if (!shown) {
          shown = true
          window.overlay.show({ tabId: id, rect }).catch(() => {})
          Object.assign(lastRect, rect)
        } else {
          const moved = rect.x !== lastRect.x || rect.y !== lastRect.y || rect.width !== lastRect.width || rect.height !== lastRect.height
          if (moved) {
            window.overlay.setBounds({ tabId: id, rect }).catch(() => {})
            Object.assign(lastRect, rect)
          }
        }

        const z = editor.getZoomLevel()
        if (Math.abs(z - lastZoom) > 0.0005) {
          window.overlay.setZoom({ tabId: id, factor: z }).catch(() => {})
          lastZoom = z
        }
      }

      raf = requestAnimationFrame(tick)
      return () => cancelAnimationFrame(raf)
    }, [editor, tabManager.state, tabManager.tabId])

    // make visible on first pointer
    const onPointerDown = () => {
      const id = tabManager.tabId
      if (!id || !window.overlay) return
      const el = hostRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const rect = { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) }
      window.overlay.show({ tabId: id, rect }).catch(() => {})
    }

    // destroy tab on unmount
    useEffect(() => {
      return () => {
        const id = tabManager.tabId
        if (!id || !window.overlay) return
        window.overlay.destroy({ tabId: id }).catch(() => {
          window.overlay.hide({ tabId: id }).catch(() => {})
        })
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabManager.tabId])

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
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
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
            style={{ width: '100%', flex: 1, background: 'transparent', position: 'relative', pointerEvents: 'none' }}
            onPointerDown={onPointerDown}
          />
        </div>
      </HTMLContainer>
    )
  }
}
