import { useEffect, useRef } from 'react'
import {
  HTMLContainer,
  Rectangle2d,
  RecordProps,
  ShapeUtil,
  TLBaseShape,
  TLResizeInfo,
  T,
  resizeBox,
  useEditor,
} from 'tldraw'

export type BrowserShape = TLBaseShape<'browser-shape', {
  w: number
  h: number
  url: string
  tabId: string
}>

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const

  static override props: RecordProps<BrowserShape> = {
    w: T.number,
    h: T.number,
    url: T.string,
    tabId: T.string,
  }

  override isAspectRatioLocked = () => false
  override canResize = () => true
  override canBind(_opts: any) { return false }

  override getDefaultProps(): BrowserShape['props'] {
    return { w: 1000, h: 650, url: 'https://example.com', tabId: '' }
  }

  override onResize(shape: BrowserShape, info: TLResizeInfo<BrowserShape>) {
    return resizeBox(shape, info)
  }

  override getGeometry(shape: BrowserShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override indicator() { return null }

  override component(shape: BrowserShape) {
    const editor = useEditor()
    const probeRef = useRef<HTMLDivElement | null>(null)

    const lastBounds = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
    const tabIdRef = useRef<string>(shape.props.tabId)

    // If TL props change, keep local refs up-to-date
    useEffect(() => {
      if (shape.props.tabId && tabIdRef.current !== shape.props.tabId) {
        tabIdRef.current = shape.props.tabId
      }
    }, [shape.props.tabId])

    // Ensure a tab exists; write back tabId to shape and set initial bounds ASAP
    useEffect(() => {
      let mounted = true
      ;(async () => {
        if (!tabIdRef.current) {
          try {
            const id = await window.overlay.createTab(shape.props.url)
            if (!mounted) return
            tabIdRef.current = id
            editor.updateShapes([{ id: shape.id, type: shape.type, props: { tabId: id } }])
            // First paint: set bounds immediately
            const el = probeRef.current
            if (el) {
              const r = el.getBoundingClientRect()
              const rect = {
                x: Math.floor(r.left),
                y: Math.floor(r.top),
                width: Math.ceil(r.width),
                height: Math.ceil(r.height),
              }
              await window.overlay.show({ tabId: id, rect })
              lastBounds.current = rect
            }
          } catch (err) {
            console.error('[overlay] createTab failed', err)
          }
        }
      })()
      return () => { mounted = false }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shape.id, shape.type, shape.props.url])

    // RAF: keep bounds in sync; avoid zoom-factor tricks for now
    useEffect(() => {
      let raf = 0
      const tick = () => {
        raf = requestAnimationFrame(tick)
        const el = probeRef.current
        const tabId = tabIdRef.current
        if (!el || !tabId) return

        const r = el.getBoundingClientRect()
        const rect = {
          x: Math.floor(r.left),
          y: Math.floor(r.top),
          width: Math.ceil(r.width),
          height: Math.ceil(r.height),
        }

        const lb = lastBounds.current
        if (!lb || lb.x !== rect.x || lb.y !== rect.y || lb.width !== rect.width || lb.height !== rect.height) {
          window.overlay.setBounds({ tabId, rect }).catch(() => {})
          lastBounds.current = rect
        }

        // Always keep attached & at top; cheap no-op if already correct.
        window.overlay.show({ tabId, rect }).catch(() => {})
      }

      raf = requestAnimationFrame(tick)
      return () => {
        cancelAnimationFrame(raf)
        const id = tabIdRef.current
        if (id) {
          window.overlay.hide({ tabId: id }).catch(() => {})
          // Optional: fully close when the TL shape unmounts
          window.overlay.closeTab(id).catch(() => {})
        }
      }
    }, [])

    // Focus the browser content when user clicks the shape
    const onPointerDown = () => {
      const id = tabIdRef.current
      if (id) window.overlay.focus({ tabId: id }).catch(() => {})
    }

    const { w, h } = shape.props
    return (
      <HTMLContainer id={shape.id} style={{ width: w, height: h, pointerEvents: 'auto' }} onPointerDown={onPointerDown}>
        <div ref={probeRef} style={{ position: 'absolute', inset: 0 }} />
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', padding: 8 }}>
          <div style={{ height: 32, borderRadius: 6, border: '1px solid #333', background: '#141414' }} />
        </div>
      </HTMLContainer>
    )
  }
}
