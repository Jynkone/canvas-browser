import { useEffect, useRef } from 'react'
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  TLBaseShape,
  TLResizeInfo,
  resizeBox
} from 'tldraw'
import { NavigationBar, NAV_BAR_HEIGHT } from '../components/NavigationBar'

const MIN_W = 300
const MIN_H = 225 + NAV_BAR_HEIGHT

class BrowserGrabGeometry extends Rectangle2d {
  constructor(config: { x: number; y: number; width: number; height: number; isFilled: boolean }) {
    super(config)
  }
}

export type BrowserShape = TLBaseShape<
  'browser-shape',
  { w: number; h: number; url: string }
>

export const browserTabSuspendRegistry = new Map<string, { current: boolean }>()

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const
  override isAspectRatioLocked = () => false
  override canResize = () => true

  override indicator(shape: BrowserShape) {
    return <rect x={0} y={0} width={shape.props.w} height={shape.props.h} />
  }

  override getDefaultProps(): BrowserShape['props'] {
    return { w: 1000, h: 600 + NAV_BAR_HEIGHT, url: 'https://google.com' }
  }

  override onResize(shape: BrowserShape, info: TLResizeInfo<BrowserShape>) {
    const r = resizeBox(shape, info)
    return {
      ...r,
      props: {
        ...r.props,
        w: Math.max(MIN_W, r.props.w),
        h: Math.max(MIN_H, r.props.h),
      },
    }
  }

  override getGeometry(shape: BrowserShape) {
    return new BrowserGrabGeometry({
      x: 0,
      y: 0,
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    })
  }

  override component(shape: BrowserShape) {
    const api = window.overlay
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const tabIdRef = useRef<string | null>(null)
    const creatingRef = useRef(false)

    const contentH = shape.props.h - NAV_BAR_HEIGHT

    // ── 1. CREATE TAB ──────────────────────────────────────────────────────
    useEffect(() => {
      if (!api || tabIdRef.current || creatingRef.current) return
      creatingRef.current = true
      let alive = true

        ; (async () => {
          try {
            console.log('[BrowserShape] Creating tab:', shape.id)
            const res = await api.createTab({ url: shape.props.url, shapeId: shape.id })

            if (!alive) {
              if (res.ok) void api.destroy({ tabId: res.tabId })
              return
            }
            if (!res.ok) {
              console.error('[BrowserShape] createTab failed:', res.error)
              creatingRef.current = false
              return
            }

            tabIdRef.current = res.tabId
            console.log('[BrowserShape] Tab created:', res.tabId)

            // Tell the OSR window its real pixel dimensions immediately
            await api.setBounds({
              tabId: res.tabId,
              rect: {
                x: 0,
                y: 0,
                width: Math.max(1, Math.round(shape.props.w)),
                height: Math.max(1, Math.round(contentH)),
              },
            })
          } catch (err) {
            console.error('[BrowserShape] create error:', err)
            creatingRef.current = false
          }
        })()

      return () => {
        alive = false
        creatingRef.current = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, shape.id])

    // ── 2. SYNC BOUNDS on resize ───────────────────────────────────────────
    useEffect(() => {
      const tabId = tabIdRef.current
      if (!api || !tabId) return
      void api.setBounds({
        tabId,
        rect: {
          x: 0,
          y: 0,
          width: Math.max(1, Math.round(shape.props.w)),
          height: Math.max(1, Math.round(contentH)),
        },
      })
    }, [api, shape.props.w, contentH])

    // ── 3. PAINT FRAMES ────────────────────────────────────────────────────
    const frameCountRef = useRef(0)

    useEffect(() => {
      if (!api) return
      const canvas = canvasRef.current
      if (!canvas) return

      // Prefer bitmaprenderer; fall back to 2d
      const bitmapCtx = canvas.getContext('bitmaprenderer') as ImageBitmapRenderingContext | null
      const ctx2d = bitmapCtx ? null : (canvas.getContext('2d') as CanvasRenderingContext2D | null)

      if (!bitmapCtx && !ctx2d) {
        console.error('[BrowserShape] No canvas context available')
        return
      }

      const offFrame = api.onFrame(async (data: {
        tabId: string
        pixels: Buffer
        width: number
        height: number
      }) => {
        if (data.tabId !== tabIdRef.current) return

        frameCountRef.current++
        if (frameCountRef.current === 1) {
          console.log('[BrowserShape] 🟢 First frame! tab:', data.tabId, data.width, 'x', data.height)
        }

        try {
          // pixels is a Node Buffer of RGBA bytes decoded by the C++ bridge
          // We need a plain ArrayBuffer for ImageData
          let rawBuffer: ArrayBuffer
          if ((data.pixels as unknown as { buffer: ArrayBuffer }).buffer instanceof ArrayBuffer) {
            rawBuffer = (data.pixels as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number }).buffer
          } else {
            // Fallback: copy into a new ArrayBuffer
            const arr = new Uint8Array(data.width * data.height * 4)
            arr.set(data.pixels as unknown as Uint8Array)
            rawBuffer = arr.buffer
          }

          const rgba = new Uint8ClampedArray(rawBuffer)
          const imageData = new ImageData(rgba, data.width, data.height)

          if (bitmapCtx) {
            const bitmap = await createImageBitmap(imageData)
            bitmapCtx.transferFromImageBitmap(bitmap)
          } else if (ctx2d) {
            ctx2d.putImageData(imageData, 0, 0)
          }
        } catch (err) {
          console.error('[BrowserShape] Frame paint error:', err)
        }
      })

      return () => {
        offFrame()
        frameCountRef.current = 0
      }
    }, [api])

    // ── 4. DESTROY on unmount ──────────────────────────────────────────────
    useEffect(() => {
      return () => {
        const tabId = tabIdRef.current
        if (api && tabId) {
          console.log('[BrowserShape] Destroying tab:', tabId)
          void api.destroy({ tabId })
          tabIdRef.current = null
        }
      }
    }, [api])

    // ── RENDER ────────────────────────────────────────────────────────────
    return (
      <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'auto' }}>
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            background: '#fff',
          }}
        >
          <div style={{ flexShrink: 0, zIndex: 2 }}>
            <NavigationBar
              navState={{ currentUrl: shape.props.url, canGoBack: false, canGoForward: false, title: '' }}
              isLoading={false}
              onUrlChange={(url) => {
                const tabId = tabIdRef.current
                if (tabId) api?.navigate({ tabId, url })
              }}
              onBack={() => { const t = tabIdRef.current; if (t) api?.goBack({ tabId: t }) }}
              onForward={() => { const t = tabIdRef.current; if (t) api?.goForward({ tabId: t }) }}
              onReload={() => { const t = tabIdRef.current; if (t) api?.reload({ tabId: t }) }}
              fitMode={false}
              onToggleFit={() => { }}
            />
          </div>

          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            <canvas
              ref={canvasRef}
              width={Math.max(1, Math.round(shape.props.w))}
              height={Math.max(1, Math.round(contentH))}
              style={{ display: 'block', width: '100%', height: '100%' }}
            />
          </div>
        </div>
      </HTMLContainer>
    )
  }
}