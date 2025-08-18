import React, { useEffect, useRef, useState, useCallback } from 'react'
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  TLBaseShape,
  TLResizeInfo,
  resizeBox,
  useEditor,
} from 'tldraw'
import type { NavigationState } from  '../../types/overlay'

export type BrowserShape = TLBaseShape<'browser-shape', {
  w: number
  h: number
  url: string
  tabId: string
}>

// Navigation bar height in pixels
const NAV_BAR_HEIGHT = 44

// World-space minimum logical size (accounting for nav bar)
const MIN_W = 840
const MIN_H = 525 + NAV_BAR_HEIGHT // Ensure minimum content area plus nav bar

// Type guard to check if window.overlay exists and has required methods
function hasOverlayAPI(win: Window): win is Window & { overlay: NonNullable<Window['overlay']> } {
  return typeof win.overlay === 'object' && 
         win.overlay !== null &&
         typeof win.overlay.createTab === 'function' &&
         typeof win.overlay.show === 'function' &&
         typeof win.overlay.setBounds === 'function' &&
         typeof win.overlay.setZoom === 'function' &&
         typeof win.overlay.destroy === 'function' &&
         typeof win.overlay.navigate === 'function' &&
         typeof win.overlay.goBack === 'function' &&
         typeof win.overlay.goForward === 'function' &&
         typeof win.overlay.reload === 'function' &&
         typeof win.overlay.getNavigationState === 'function'
}

// Navigation bar component
interface NavigationBarProps {
  tabId: string
  navState: NavigationState
  onUrlChange: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
}

const NavigationBar: React.FC<NavigationBarProps> = ({
  tabId,
  navState,
  onUrlChange,
  onBack,
  onForward,
  onReload
}) => {
  const [urlInput, setUrlInput] = useState(navState.currentUrl)
  
  // Update input when navigation state changes
  useEffect(() => {
    setUrlInput(navState.currentUrl)
  }, [navState.currentUrl])

  const handleUrlSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (trimmed && trimmed !== navState.currentUrl) {
      // Add protocol if missing
      const url = trimmed.startsWith('http://') || trimmed.startsWith('https://') 
        ? trimmed 
        : `https://${trimmed}`
      onUrlChange(url)
    }
  }, [urlInput, navState.currentUrl, onUrlChange])

  const handleUrlInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setUrlInput(e.target.value)
  }, [])

  const buttonStyle: React.CSSProperties = {
    width: '32px',
    height: '32px',
    border: 'none',
    borderRadius: '4px',
    background: '#f0f0f0',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '14px',
    color: '#333'
  }

  const disabledButtonStyle: React.CSSProperties = {
    ...buttonStyle,
    background: '#e0e0e0',
    color: '#999',
    cursor: 'not-allowed'
  }

  return (
    <div style={{
      height: `${NAV_BAR_HEIGHT}px`,
      width: '100%',
      background: 'linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%)',
      border: '1px solid #dee2e6',
      borderBottom: '1px solid #adb5bd',
      borderRadius: '6px 6px 0 0',
      display: 'flex',
      alignItems: 'center',
      padding: '0 8px',
      gap: '6px',
      boxSizing: 'border-box',
      fontSize: '13px',
      fontFamily: 'system-ui, -apple-system, sans-serif'
    }}>
      <button
        type="button"
        onClick={onBack}
        disabled={!navState.canGoBack}
        style={navState.canGoBack ? buttonStyle : disabledButtonStyle}
        title="Go back"
      >
        ←
      </button>
      
      <button
        type="button"
        onClick={onForward}
        disabled={!navState.canGoForward}
        style={navState.canGoForward ? buttonStyle : disabledButtonStyle}
        title="Go forward"
      >
        →
      </button>
      
      <button
        type="button"
        onClick={onReload}
        style={buttonStyle}
        title="Reload"
      >
        ↻
      </button>
      
      <form onSubmit={handleUrlSubmit} style={{ flex: 1, display: 'flex' }}>
        <input
          type="text"
          value={urlInput}
          onChange={handleUrlInputChange}
          placeholder="Enter URL or search term..."
          style={{
            flex: 1,
            height: '32px',
            padding: '0 12px',
            border: '1px solid #ced4da',
            borderRadius: '16px',
            outline: 'none',
            fontSize: '13px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            background: 'white',
            boxSizing: 'border-box'
          }}
          onFocus={(e) => e.target.select()}
        />
      </form>
    </div>
  )
}

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const

  override isAspectRatioLocked = (): boolean => false
  override canResize = (): boolean => true
  override hideResizeHandles = (): boolean => false

  override getDefaultProps(): BrowserShape['props'] {
    return { w: 1000, h: 650 + NAV_BAR_HEIGHT, url: 'https://google.com', tabId: '' }
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
    const [navState, setNavState] = useState<NavigationState>({
      currentUrl: shape.props.url,
      canGoBack: false,
      canGoForward: false,
      title: ''
    })

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
            // Get initial navigation state
            updateNavigationState()
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

    // Navigation state updater
    const updateNavigationState = useCallback(async (): Promise<void> => {
      const id = tabIdRef.current
      if (!id || !hasOverlayAPI(window)) return

      try {
        const res = await window.overlay.getNavigationState({ tabId: id })
        if (res.ok && res.currentUrl !== undefined) {
          setNavState({
            currentUrl: res.currentUrl,
            canGoBack: res.canGoBack ?? false,
            canGoForward: res.canGoForward ?? false,
            title: res.title ?? ''
          })
        }
      } catch (error) {
        console.error('[BrowserShape] Failed to get navigation state:', error)
      }
    }, [])

    // Poll for navigation state updates
    useEffect(() => {
      const interval = setInterval(updateNavigationState, 500)
      return () => clearInterval(interval)
    }, [updateNavigationState])

    // Navigation handlers
    const handleUrlChange = useCallback(async (url: string): Promise<void> => {
      const id = tabIdRef.current
      if (!id || !hasOverlayAPI(window)) return

      try {
        const res = await window.overlay.navigate({ tabId: id, url })
        if (res.ok) {
          // Update will come through polling
        } else {
          console.error('[BrowserShape] Failed to navigate:', res)
        }
      } catch (error) {
        console.error('[BrowserShape] Error navigating:', error)
      }
    }, [])

    const handleBack = useCallback(async (): Promise<void> => {
      const id = tabIdRef.current
      if (!id || !hasOverlayAPI(window) || !navState.canGoBack) return

      try {
        const res = await window.overlay.goBack({ tabId: id })
        if (!res.ok) {
          console.error('[BrowserShape] Failed to go back:', res)
        }
      } catch (error) {
        console.error('[BrowserShape] Error going back:', error)
      }
    }, [navState.canGoBack])

    const handleForward = useCallback(async (): Promise<void> => {
      const id = tabIdRef.current
      if (!id || !hasOverlayAPI(window) || !navState.canGoForward) return

      try {
        const res = await window.overlay.goForward({ tabId: id })
        if (!res.ok) {
          console.error('[BrowserShape] Failed to go forward:', res)
        }
      } catch (error) {
        console.error('[BrowserShape] Error going forward:', error)
      }
    }, [navState.canGoForward])

    const handleReload = useCallback(async (): Promise<void> => {
      const id = tabIdRef.current
      if (!id || !hasOverlayAPI(window)) return

      try {
        const res = await window.overlay.reload({ tabId: id })
        if (!res.ok) {
          console.error('[BrowserShape] Failed to reload:', res)
        }
      } catch (error) {
        console.error('[BrowserShape] Error reloading:', error)
      }
    }, [])

    // Sync bounds & zoom with proper error handling (accounting for nav bar)
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

        // device-pixel aware alignment (CSS px) - account for nav bar
        const rx = Math.round(b.x * dpr) / dpr
        const ry = Math.round((b.y + NAV_BAR_HEIGHT) * dpr) / dpr // Offset by nav bar height
        const rw = Math.round(b.width * dpr) / dpr
        const rh = Math.round((b.height - NAV_BAR_HEIGHT) * dpr) / dpr // Reduce height by nav bar

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
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <NavigationBar
            tabId={tabIdRef.current}
            navState={navState}
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
            }}
          />
        </div>
      </HTMLContainer>
    )
  }
}