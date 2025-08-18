import React, { useEffect, useRef } from 'react'
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

// Type guard to check if window.overlay exists and has required methods
function hasOverlayAPI(win: Window): win is Window & { overlay: NonNullable<Window['overlay']> } {
  return typeof win.overlay === 'object' && 
         win.overlay !== null &&
         typeof win.overlay.createTab === 'function' &&
         typeof win.overlay.show === 'function' &&
         typeof win.overlay.setBounds === 'function' &&
         typeof win.overlay.setZoom === 'function' &&
         typeof win.overlay.destroy === 'function'
}

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const

  override isAspectRatioLocked = (): boolean => false
  override canResize = (): boolean => true
  override hideResizeHandles = (): boolean => false

  override getDefaultProps(): BrowserShape['props'] {
    return { w: 1200, h: 600, url: 'https://google.com', tabId: '' }
  }

  override onResize(shape: BrowserShape, info: TLResizeInfo<BrowserShape>): Partial<BrowserShape> {
    const partial = resizeBox(shape, info)
    const w = Math.max(MIN_W, partial.props.w)
    const h = Math.max(MIN_H, partial.props.h)
    return { ...partial, props: { ...partial.props, w, h } }
  }

  override getGeometry(shape: BrowserShape): Rectangle2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: false })
  }

  override indicator(shape: BrowserShape): React.JSX.Element {
    const { w, h } = shape.props
    return <rect x={0} y={0} width={w} height={h} />
  }

  override component(shape: BrowserShape): React.JSX.Element {
    const hostRef = useRef<HTMLDivElement>(null)
    const editor = useEditor()
    const tabIdRef = useRef<string>('')

    // Create the tab once with proper error handling
    useEffect(() => {
      let cancelled = false

      const createTab = async (): Promise<void> => {
        if (cancelled || tabIdRef.current) return

        if (!hasOverlayAPI(window)) {
          console.error('[BrowserShape] window.overlay API not available')
          return
        }

        try {
          const res = await window.overlay.createTab({ url: shape.props.url })
          if (!cancelled && res?.ok && res.tabId) {
            tabIdRef.current = res.tabId
          } else {
            console.error('[BrowserShape] Failed to create tab:', res)
          }
        } catch (error) {
          if (!cancelled) {
            console.error('[BrowserShape] Error creating tab:', error)
          }
        }
      }

      createTab()
      
      return () => { 
        cancelled = true 
      }
    }, [shape.props.url])

    // Sync bounds & zoom with proper error handling
    useEffect(() => {
      let raf = 0
      const lastRect = { x: -1, y: -1, width: -1, height: -1 }
      let lastZoom = -1
      let shown = false

      const tick = (): void => {
        raf = requestAnimationFrame(tick)
        
        const el = hostRef.current
        const id = tabIdRef.current
        
        if (!el || !id) return
        
        if (!hasOverlayAPI(window)) {
          console.error('[BrowserShape] window.overlay API not available during sync')
          return
        }

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
          window.overlay.show({ tabId: id, rect }).catch((error) => {
            console.error('[BrowserShape] Failed to show overlay:', error)
          })
          Object.assign(lastRect, rect)
        } else {
          const moved =
            rect.x !== lastRect.x ||
            rect.y !== lastRect.y ||
            rect.width !== lastRect.width ||
            rect.height !== lastRect.height

          if (moved) {
            window.overlay.setBounds({ tabId: id, rect }).catch((error) => {
              console.error('[BrowserShape] Failed to set bounds:', error)
            })
            Object.assign(lastRect, rect)
          }
        }

        // Follow editor zoom exactly with error handling
        const z = editor.getZoomLevel()
        if (Math.abs(z - lastZoom) > 0.0005) {
          window.overlay.setZoom({ tabId: id, factor: z }).catch((error) => {
            console.error('[BrowserShape] Failed to set zoom:', error)
          })
          lastZoom = z
        }
      }

      tick()
      
      return () => {
        if (raf) {
          cancelAnimationFrame(raf)
        }
      }
    }, [editor])

    // Cleanup with comprehensive error handling
    useEffect(() => {
      return () => {
        const id = tabIdRef.current
        if (!id) return

        // Type-safe cleanup with fallbacks
        if (hasOverlayAPI(window)) {
          // Prefer destroy method
          if (typeof window.overlay.destroy === 'function') {
            window.overlay.destroy({ tabId: id }).catch((error) => {
              console.error('[BrowserShape] Failed to destroy tab:', error)
              // Fallback to hide if destroy fails
              if (typeof window.overlay.hide === 'function') {
                window.overlay.hide({ tabId: id }).catch((hideError) => {
                  console.error('[BrowserShape] Failed to hide tab as fallback:', hideError)
                })
              }
            })
          } else if (typeof window.overlay.hide === 'function') {
            // Fallback to hide if destroy doesn't exist
            window.overlay.hide({ tabId: id }).catch((error) => {
              console.error('[BrowserShape] Failed to hide tab:', error)
            })
          }
        } else {
          console.warn('[BrowserShape] window.overlay not available during cleanup')
        }
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