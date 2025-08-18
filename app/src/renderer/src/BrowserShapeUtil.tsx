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

export type BrowserShape = TLBaseShape<'browser-shape', {
  w: number
  h: number
  url: string
  tabId: string
}>

const NAV_BAR_HEIGHT = 44
// World-space minimum logical size (not zoomed)
const MIN_W = 900
const MIN_H = 525 + NAV_BAR_HEIGHT

// Screen-space affordances
const HIT_PAD_PX = 10      // extra grab halo in screen pixels
const MIN_STROKE_PX = 1    // min indicator stroke in screen pixels

// Navigation bar component
interface NavigationBarProps {
  navState: {
    currentUrl: string
    canGoBack: boolean
    canGoForward: boolean
    title: string
  }
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

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (!trimmed) return

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      onUrlChange(trimmed)
    } else if (trimmed.includes('.')) {
      onUrlChange(`https://${trimmed}`)
    } else {
      onUrlChange(`https://www.google.com/search?q=${encodeURIComponent(trimmed)}`)
    }
  }, [urlInput, onUrlChange])

  // --- Styles ---
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
    transition: 'transform 0.25s cubic-bezier(0.2, 0, 0, 1.2), background-color 0.25s ease',
    userSelect: 'none'
  }
  const disabledButton: React.CSSProperties = {
    ...baseButton,
    background: '#e0e0e0',
    color: '#999',
    cursor: 'not-allowed'
  }

  // --- Helper for buttons ---
  const makeButton = (
    key: string,
    label: string,
    handler: () => void,
    disabled?: boolean,
    title?: string
  ) => {
    const isActive = clicking === key
    return (
      <button
        type="button"
        onPointerDown={() => {
          if (!disabled) {
            setClicking(key)
            handler()
            setTimeout(() => setClicking(null), 250)
          }
        }}
        disabled={disabled}
        style={{
          ...(disabled ? disabledButton : baseButton),
          transform: isActive ? 'scale(0.8)' : 'scale(1.0)',
          background: isActive ? '#d0e4ff' : (disabled ? disabledButton.background : baseButton.background)
        }}
        title={title}
      >
        {label}
      </button>
    )
  }

  return (
    <div
      style={{
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
        fontFamily: 'system-ui, sans-serif',
        position: 'relative',
        pointerEvents: 'auto',
        zIndex: 1000
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {makeButton('back', '←', onBack, !navState.canGoBack, 'Go back')}
      {makeButton('forward', '→', onForward, !navState.canGoForward, 'Go forward')}
      {makeButton('reload', '↻', onReload, false, 'Reload')}

      <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex' }}>
        <input
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="Search or enter address"
          style={{
            flex: 1,
            height: '32px',
            padding: '0 12px',
            border: '1px solid #ced4da',
            borderRadius: '6px',
            outline: 'none',
            fontSize: '13px',
            fontFamily: 'system-ui, sans-serif',
            background: 'white',
            boxSizing: 'border-box',
            transition: 'all 0.25s ease',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
          onFocus={(e) => {
            e.currentTarget.select()
            e.currentTarget.style.borderColor = '#007bff'
            e.currentTarget.style.boxShadow = '0 0 6px rgba(0, 123, 255, 0.35)'
            e.currentTarget.style.background = '#ffffff'
            e.currentTarget.style.overflow = 'visible'
            e.currentTarget.style.textOverflow = 'clip'
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = '#ced4da'
            e.currentTarget.style.boxShadow = 'none'
            e.currentTarget.style.background = 'white'
            e.currentTarget.style.overflow = 'hidden'
            e.currentTarget.style.textOverflow = 'ellipsis'
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => {
            e.preventDefault()
            e.currentTarget.select()
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            e.currentTarget.select()
          }}
          onMouseEnter={(e) => {
            if (document.activeElement !== e.currentTarget) {
              e.currentTarget.style.borderColor = '#bbb'
              e.currentTarget.style.background = '#fefefe'
              e.currentTarget.style.boxShadow = '0 0 6px rgba(0,0,0,0.12)'
            }
          }}
          onMouseLeave={(e) => {
            if (document.activeElement !== e.currentTarget) {
              e.currentTarget.style.borderColor = '#ced4da'
              e.currentTarget.style.background = 'white'
              e.currentTarget.style.boxShadow = 'none'
            }
          }}
        />
      </form>

      {isLoading && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            height: '2px',
            width: '100%',
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              height: '100%',
              width: '30%',
              background: '#007bff',
              animation: 'loadingBar 1.1s linear infinite'
            }}
          />
        </div>
      )}

      <style>
        {`@keyframes loadingBar {
          0% { margin-left: -30%; }
          100% { margin-left: 100%; }
        }`}
      </style>
    </div>
  )
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

  // Make the hit-area bigger in screen pixels by inflating the geometry.
  // Indicator stays at the visual bounds (see indicator below).
  override getGeometry(shape: BrowserShape) {
    const { w, h } = shape.props
    const zoom = this.editor.getZoomLevel()
    const pad = HIT_PAD_PX / Math.max(zoom, 0.001) // px → world units
    return new Rectangle2d({
      x: -pad,
      y: -pad,
      width: w + pad * 2,
      height: h + pad * 2,
      isFilled: false,
    })
  }

  // Visual selection outline: scale stroke so it stays visible at low zoom.
  override indicator(shape: BrowserShape) {
    const { w, h } = shape.props
    const zoom = this.editor.getZoomLevel()
    const strokeWidth = MIN_STROKE_PX / Math.max(zoom, 0.001)
    return <rect x={0} y={0} width={w} height={h} strokeWidth={strokeWidth} />
  }

  override component(shape: BrowserShape) {
    const hostRef = useRef<HTMLDivElement>(null)
    const editor = useEditor()
    const tabIdRef = useRef<string>('')

    const [navState, setNavState] = useState({
      currentUrl: shape.props.url,
      canGoBack: false,
      canGoForward: false,
      title: ''
    })
    const [isLoading, setIsLoading] = useState(false)
    const [isGrabbing, setIsGrabbing] = useState(false)

    // Create the tab once
    useEffect(() => {
      let cancelled = false
      ;(async () => {
        if (cancelled || tabIdRef.current) return
        try {
          const res = await (window as any).overlay?.createTab({ url: shape.props.url })
          if (res?.ok && res?.tabId) tabIdRef.current = res.tabId
        } catch {}
      })()
      return () => { cancelled = true }
    }, [shape.props.url])

    // Update navigation state
    const updateNavState = useCallback(async () => {
      const id = tabIdRef.current
      if (!id) return

      try {
        const res = await (window as any).overlay?.getNavigationState({ tabId: id })
        if (res?.ok) {
          setNavState({
            currentUrl: res.currentUrl || 'about:blank',
            canGoBack: res.canGoBack || false,
            canGoForward: res.canGoForward || false,
            title: res.title || ''
          })
          setIsLoading(res.isLoading || false)
        }
      } catch {}
    }, [])

    // Poll for navigation updates
    useEffect(() => {
      const interval = setInterval(updateNavState, 500)
      return () => clearInterval(interval)
    }, [updateNavState])

    // Navigation handlers
    const handleUrlChange = useCallback(async (url: string) => {
      const id = tabIdRef.current
      if (!id) return
      
      setIsLoading(true)
      try {
        await (window as any).overlay?.navigate({ tabId: id, url })
      } catch {}
    }, [])

    const handleBack = useCallback(async () => {
      const id = tabIdRef.current
      if (!id || !navState.canGoBack) return
      
      setIsLoading(true)
      try {
        await (window as any).overlay?.goBack({ tabId: id })
      } catch {}
    }, [navState.canGoBack])

    const handleForward = useCallback(async () => {
      const id = tabIdRef.current
      if (!id || !navState.canGoForward) return
      
      setIsLoading(true)
      try {
        await (window as any).overlay?.goForward({ tabId: id })
      } catch {}
    }, [navState.canGoForward])

    const handleReload = useCallback(async () => {
      const id = tabIdRef.current
      if (!id) return
      
      setIsLoading(true)
      try {
        await (window as any).overlay?.reload({ tabId: id })
      } catch {}
    }, [])

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
          ;(window as any).overlay?.show({ tabId: id, rect }).catch(() => {})
          Object.assign(lastRect, rect)
        } else {
          const moved =
            rect.x !== lastRect.x ||
            rect.y !== lastRect.y ||
            rect.width !== lastRect.width ||
            rect.height !== lastRect.height

          if (moved) {
            ;(window as any).overlay?.setBounds({ tabId: id, rect }).catch(() => {})
            Object.assign(lastRect, rect)
          }
        }

        // Follow editor zoom exactly
        const z = editor.getZoomLevel()
        if (Math.abs(z - lastZoom) > 0.0005) {
          ;(window as any).overlay?.setZoom({ tabId: id, factor: z }).catch(() => {})
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
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative'
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
              pointerEvents: 'none'
            }}
          />
        </div>
      </HTMLContainer>
    )
  }
}
