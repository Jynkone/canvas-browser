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
import type { NavigationState } from '../../types/overlay'

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
function hasOverlayAPI(
  win: Window
): win is Window & { overlay: NonNullable<Window['overlay']> } {
  const anyWin = win as any
  if (typeof anyWin.overlay !== 'object' || anyWin.overlay === null) return false
  const o = anyWin.overlay
  if (typeof o.createTab !== 'function') return false
  if (typeof o.show !== 'function') return false
  if (typeof o.setBounds !== 'function') return false
  if (typeof o.setZoom !== 'function') return false
  if (typeof o.destroy !== 'function') return false
  if (typeof o.navigate !== 'function') return false
  if (typeof o.goBack !== 'function') return false
  if (typeof o.goForward !== 'function') return false
  if (typeof o.reload !== 'function') return false
  if (typeof o.getNavigationState !== 'function') return false
  return true
}

// Navigation bar component
interface NavigationBarProps {
  navState: NavigationState
  isLoading: boolean
  onUrlChange: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
}
const NavigationBar: React.FC<NavigationBarProps> = ({
  navState,
  isLoading,
  onUrlChange,
  onBack,
  onForward,
  onReload
}) => {
  const [urlInput, setUrlInput] = useState(navState.currentUrl)
  const [clicking, setClicking] = useState<string | null>(null)

  useEffect(() => {
    setUrlInput(navState.currentUrl)
  }, [navState.currentUrl])

  const isLikelyUrl = (text: string): boolean => {
    if (/^[a-zA-Z]+:\/\//.test(text)) return true
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return true
    return false
  }

  const navigateFromInput = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return
    if (isLikelyUrl(trimmed)) {
      const url = /^[a-zA-Z]+:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
      onUrlChange(url)
    } else {
      onUrlChange(`https://www.google.com/search?q=${encodeURIComponent(trimmed)}`)
    }
  }

  const handleUrlSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    navigateFromInput(urlInput)
  }, [urlInput])

  const handleUrlInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setUrlInput(e.target.value)
  }, [])

  // Button styles (with bounce)
  const baseButton: React.CSSProperties = {
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
    color: '#333',
    zIndex: 1000,
    position: 'relative',
    transition: 'transform 0.15s ease'
  }
  const disabledButton: React.CSSProperties = {
    ...baseButton, background: '#e0e0e0', color: '#999', cursor: 'not-allowed'
  }
  const makeButton = (key: string, label: string, handler: () => void, disabled?: boolean, title?: string) => (
    <button
      type="button"
      onPointerDown={() => { if (!disabled) { setClicking(key); handler(); setTimeout(() => setClicking(null), 200) } }}
      disabled={disabled}
      style={{ ...(disabled ? disabledButton : baseButton), transform: clicking === key ? 'scale(0.9)' : 'scale(1.0)' }}
      title={title}
    >
      {label}
    </button>
  )

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
      fontFamily: 'system-ui, -apple-system, sans-serif',
      position: 'relative',
      zIndex: 1000,
      pointerEvents: 'auto'
    }}>
      {makeButton('back', '←', onBack, !navState.canGoBack, 'Go back')}
      {makeButton('forward', '→', onForward, !navState.canGoForward, 'Go forward')}
      {makeButton('reload', '↻', onReload, false, 'Reload')}

      <form onSubmit={handleUrlSubmit} style={{ flex: 1, display: 'flex', zIndex: 1000, position: 'relative' }}>
        <input
          type="text"
          value={urlInput}
          onChange={handleUrlInputChange}
          placeholder="Search or enter address"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
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
            boxSizing: 'border-box',
            zIndex: 1000,
            position: 'relative'
          }}
          onFocus={(e) => e.target.select()}
        />
      </form>

      {/* Loading bar */}
      {isLoading && (
        <div style={{ position: 'absolute', bottom: 0, left: 0, height: '2px', width: '100%', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: '30%', background: '#007bff', animation: 'loadingAnim 1.1s linear infinite' }} />
        </div>
      )}

      <style>
        {`@keyframes loadingAnim { 0% { margin-left: -30%; } 100% { margin-left: 100%; } }`}
      </style>
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

    const [isLoading, setIsLoading] = useState(false)
    const lastUrlRef = useRef<string>(shape.props.url)

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
            void updateNavigationState()
          } else {
            console.error('[BrowserShape] Failed to create tab:', res)
          }
        } catch (error) {
          if (!cancelled) {
            console.error('[BrowserShape] Error creating tab:', error)
          }
        }
      }

      void createTab()
      return () => { cancelled = true }
    }, [shape.props.url])

    // Navigation state updater (real isLoading support)
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

          if (typeof (res as any).isLoading === 'boolean') {
            setIsLoading(Boolean((res as any).isLoading))
          } else {
            // Fallback heuristic if main doesn't provide isLoading
            if (lastUrlRef.current !== res.currentUrl) {
              lastUrlRef.current = res.currentUrl
              setIsLoading(true)
            } else if (res.title && res.title.length > 0) {
              setIsLoading(false)
            }
          }
        }
      } catch (error) {
        console.error('[BrowserShape] Failed to get navigation state:', error)
      }
    }, [])

    // Poll for navigation state updates
    useEffect(() => {
      const interval = setInterval(() => { void updateNavigationState() }, 500)
      return () => clearInterval(interval)
    }, [updateNavigationState])

    // Navigation handlers (optimistically set isLoading)
    const handleUrlChange = useCallback(async (url: string): Promise<void> => {
      const id = tabIdRef.current
      if (!id || !hasOverlayAPI(window)) return
      try {
        setIsLoading(true)
        const res = await window.overlay.navigate({ tabId: id, url })
        if (!res.ok) console.error('[BrowserShape] Failed to navigate:', res)
      } catch (error) {
        console.error('[BrowserShape] Error navigating:', error)
      }
    }, [])

    const handleBack = useCallback(async (): Promise<void> => {
      const id = tabIdRef.current
      if (!id || !hasOverlayAPI(window) || !navState.canGoBack) return
      try {
        setIsLoading(true)
        const res = await window.overlay.goBack({ tabId: id })
        if (!res.ok) console.error('[BrowserShape] Failed to go back:', res)
      } catch (error) {
        console.error('[BrowserShape] Error going back:', error)
      }
    }, [navState.canGoBack])

    const handleForward = useCallback(async (): Promise<void> => {
      const id = tabIdRef.current
      if (!id || !hasOverlayAPI(window) || !navState.canGoForward) return
      try {
        setIsLoading(true)
        const res = await window.overlay.goForward({ tabId: id })
        if (!res.ok) console.error('[BrowserShape] Failed to go forward:', res)
      } catch (error) {
        console.error('[BrowserShape] Error going forward:', error)
      }
    }, [navState.canGoForward])

    const handleReload = useCallback(async (): Promise<void> => {
      const id = tabIdRef.current
      if (!id || !hasOverlayAPI(window)) return
      try {
        setIsLoading(true)
        const res = await window.overlay.reload({ tabId: id })
        if (!res.ok) console.error('[BrowserShape] Failed to reload:', res)
      } catch (error) {
        console.error('[BrowserShape] Error reloading:', error)
      }
    }, [])

    // Sync bounds & zoom with proper error handling (FIXED positioning)
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

        if (hasOverlayAPI(window)) {
          if (typeof window.overlay.destroy === 'function') {
            window.overlay.destroy({ tabId: id }).catch((error) => {
              console.error('[BrowserShape] Failed to destroy tab:', error)
              if (typeof window.overlay.hide === 'function') {
                window.overlay.hide({ tabId: id }).catch((hideError) => {
                  console.error('[BrowserShape] Failed to hide tab as fallback:', hideError)
                })
              }
            })
          } else if (typeof window.overlay.hide === 'function') {
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
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          position: 'relative',
          pointerEvents: 'auto'
        }}
      >
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          pointerEvents: 'auto'
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
              pointerEvents: 'none' // Let the WebContentsView handle events
            }}
          />
        </div>
      </HTMLContainer>
    )
  }
}
