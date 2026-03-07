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
    return { ...r, props: { ...r.props, w: Math.max(MIN_W, r.props.w), h: Math.max(MIN_H, r.props.h) } }
  }

  override getGeometry(shape: BrowserShape) {
    return new BrowserGrabGeometry({ x: 0, y: 0, width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override component(shape: BrowserShape) {
    const api = window.overlay
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const tabIdRef = useRef<string | null>(null)

    const navState = { currentUrl: shape.props.url, canGoBack: false, canGoForward: false, title: '' }

    // 1. CREATE THE OFFSCREEN TAB
    useEffect(() => {
      if (!api || tabIdRef.current) return
      let cancelled = false;

      (async () => {
        try {
          console.log('[DEBUG] Requesting OSR tab creation for:', shape.props.url);
          // Your Main Process MUST be creating this with webPreferences: { offscreen: true }
          const res = await api.createTab({ url: shape.props.url, shapeId: shape.id })
          if (!res.ok || cancelled) return

          tabIdRef.current = res.tabId
          console.log('[DEBUG] OSR Tab created. ID:', res.tabId);
        } catch (err) {
          console.error('[DEBUG] Failed to create tab:', err)
        }
      })()

      return () => { cancelled = true }
    }, [api, shape.props.url, shape.id])

    // Add this ref at the top of your component function with the other refs
    // 1. Add this ref at the top of your component with your other refs
    const frameCountRef = useRef(0);

    // 2. Replace your "CATCH AND PAINT" effect with this:
    useEffect(() => {
      if (!api) return;

      const canvas = canvasRef.current;
      if (!canvas) {
        console.error('[React] Canvas ref is missing');
        return;
      }

      const ctx = canvas.getContext('bitmaprenderer');
      if (!ctx) {
        console.error('[React] bitmaprenderer context not supported!');
        return;
      }

      const offFrame = api.onFrame(async ({ tabId, handle }) => {
        // Only process frames for THIS specific tab instance
        if (tabId !== tabIdRef.current) return;

        frameCountRef.current++;

        // Log the first frame, and then every 100th frame to prove it's alive
        if (frameCountRef.current === 1) {
          console.log('[React] 🟢 FIRST frame arrived for tab:', tabId);
        } else if (frameCountRef.current % 100 === 0) {
          console.log(`[React] Frame #${frameCountRef.current} received for ${tabId}`);
        }

        try {
          // Attempt to turn the GPU handle into a usable bitmap
          const bitmap = await api.decodeGPUFrame(handle);

          if (bitmap) {
            // Blast the bitmap onto the canvas
            ctx.transferFromImageBitmap(bitmap);
          } else {
            // If this fires, your C++ bridge (texture_bridge.node) is returning null
            if (frameCountRef.current % 60 === 0) {
              console.warn('[React] decodeGPUFrame returned NULL at frame:', frameCountRef.current);
            }
          }
        } catch (err) {
          console.error('[React] Frame processing error:', err);
        }
      });

      return () => {
        offFrame();
        frameCountRef.current = 0;
      };
    }, [api]);    // 3. CLEANUP
    useEffect(() => {
      return () => {
        if (api && tabIdRef.current) void api.destroy({ tabId: tabIdRef.current });
      };
    }, [api]);

    return (
      <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'auto' }}>
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#fff' }}>

          <div style={{ position: 'relative', zIndex: 2, background: '#f1f1f1' }}>
            <NavigationBar
              navState={navState}
              isLoading={false}
              onUrlChange={(url) => api?.navigate({ tabId: tabIdRef.current!, url })}
              onBack={() => api?.goBack({ tabId: tabIdRef.current! })}
              onForward={() => api?.goForward({ tabId: tabIdRef.current! })}
              onReload={() => api?.reload({ tabId: tabIdRef.current! })}
              fitMode={false}
              onToggleFit={() => { }}
            />
          </div>

          {/* THE CANVAS: This is where the image stream paints */}
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            <canvas
              ref={canvasRef}
              width={shape.props.w}
              height={shape.props.h - NAV_BAR_HEIGHT}
              style={{ display: 'block', width: '100%', height: '100%', objectFit: 'fill' }}
            />
          </div>

        </div>
      </HTMLContainer>
    )
  }
}