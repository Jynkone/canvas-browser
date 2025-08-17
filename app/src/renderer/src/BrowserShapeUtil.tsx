import { useEffect, useRef } from 'react'
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  TLBaseShape,
  TLResizeInfo,
  resizeBox,
  useEditor,
} from 'tldraw'

export type BrowserShape = TLBaseShape<'browser-shape', {
  w: number
  h: number
  url: string
  tabId: string
}>

// World-space minimum logical size (not zoomed)
const MIN_W = 840
const MIN_H = 525

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const

  override isAspectRatioLocked = () => false
  override canResize = () => true
  override hideResizeHandles = () => false

  override getDefaultProps(): BrowserShape['props'] {
    return { w: 1200, h: 600,url: 'https://google.com', tabId: '' }
  }

  override onResize(shape: BrowserShape, info: TLResizeInfo<BrowserShape>) {
    const partial = resizeBox(shape, info)
    const w = Math.max(MIN_W, partial.props.w)
    const h = Math.max(MIN_H, partial.props.h)
    return { ...partial, props: { ...partial.props, w, h } }
  }

  override getGeometry(shape: BrowserShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: false })
  }

  // ✅ Add the missing indicator to satisfy ShapeUtil's abstract contract
  override indicator(shape: BrowserShape) {
    const { w, h } = shape.props
    return <rect x={0} y={0} width={w} height={h} />
  }

  override component(shape: BrowserShape) {
    const hostRef = useRef<HTMLDivElement>(null)
    const editor = useEditor()
    const tabIdRef = useRef<string>('')

    // Create the tab once
    useEffect(() => {
      let cancelled = false
      ;(async () => {
        if (cancelled || tabIdRef.current) return
        try {
          const res = await window.overlay.createTab({ url: shape.props.url })
          if (res?.tabId) tabIdRef.current = res.tabId
        } catch {}
      })()
      return () => { cancelled = true }
    }, [shape.props.url])

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
          window.overlay.show({ tabId: id, rect }).catch(() => {})
          Object.assign(lastRect, rect)
        } else {
          const moved =
            rect.x !== lastRect.x ||
            rect.y !== lastRect.y ||
            rect.width !== lastRect.width ||
            rect.height !== lastRect.height

          if (moved) {
            window.overlay.setBounds({ tabId: id, rect, dpr }).catch(() => {})
            Object.assign(lastRect, rect)
          }
        }

        // Follow editor zoom exactly
        const z = editor.getZoomLevel()
        if (Math.abs(z - lastZoom) > 0.0005) {
          window.overlay.setZoom({ tabId: id, factor: z }).catch(() => {})
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
      <HTMLContainer style={{ width: shape.props.w, height: shape.props.h }}>
        <div
          ref={hostRef}
          style={{
            width: '100%',
            height: '100%',
            background: 'transparent',
          }}
        />
      </HTMLContainer>
    )
  }
}
