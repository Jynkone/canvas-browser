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
import { sessionStore, IDLE_EVICT_MS } from '../state/sessionStore'

export type BrowserShape = TLBaseShape<
  'browser-shape',
  { w: number; h: number; url: string; tabId: string }
>

const DRAG_GUTTER = 8 // outside drag gutters
const MIN_W = 1000
const MIN_H = 525 + NAV_BAR_HEIGHT + DRAG_GUTTER * 2

// Keep thresholds in sync with main hysteresis
const SHOW_AT = 0.24
const HIDE_AT = 0.26

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
    
    // NO MORE sessionStore position sync - TLDraw handles this
    
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

    // When non-null, we render the static screenshot instead of live view
    const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)

    // ---- helpers ----------------------------------------------------------
    const getHostRect = (): Rect | null => {
      const el = hostRef.current
      if (!el) return null
      const b = el.getBoundingClientRect()
      return {
        x: Math.floor(b.left),
        y: Math.floor(b.top),
        width: Math.ceil(b.width),
        height: Math.ceil(b.height),
      }
    }

    const syncOverlayNow = async (id: string): Promise<void> => {
      const rect = getHostRect()
      if (!api || !rect) return
      await api.show({ tabId: id, rect })
      await Promise.all([
        api.setBounds({ tabId: id, rect }),
        api.setZoom({ tabId: id, factor: editor.getZoomLevel() }),
      ])
    }

    // Check if tab should be frozen
    const session = sessionStore.get(shape.id)
    const isFrozen = session?.realization === 'frozen'
    const frozenScreenshot = session?.thumbDataUrl

    // ---- Hot/Cold Tab Management -------------------------------------------
    useEffect(() => {
      if (!api) return
      
      const isNewTab = !sessionStore.get(shape.id)
      
      // Register this tab in session store (NO position data)
      sessionStore.upsert(shape.id, {
        shapeId: shape.id,
        url: shape.props.url,
        lastActivityAt: Date.now(),
        lastFocusedAt: Date.now(),
        realization: 'attached'
      })

      // NEW TABS: Always force to hot and evict coldest if needed
      if (isNewTab) {
  // Just ensure this new tab is registered as hot
  sessionStore.setRealization(shape.id, 'attached')
  sessionStore.trackActivity(shape.id)
  
  // Only track rankings, don't enforce (let 30-minute rule handle evictions)
  sessionStore.trackHotN(3)
}

    }, [api, shape.id])

    // ---- Overlay lifecycle ------------------------------------------------
    useEffect(() => {
      let cancelled = false
      if (!api || tabIdRef.current || isFrozen) return
      
      ;(async () => {
        try {
          // Use saved URL from session store, not shape.props.url
          const savedSession = sessionStore.get(shape.id)
          const urlToLoad = savedSession?.url || shape.props.url
          
          const res = await api.createTab({ url: urlToLoad })
          if (!res.ok || cancelled) return
          const id = res.tabId
          tabIdRef.current = id

          // Prime placement/zoom immediately
// Prime placement/zoom immediately
await syncOverlayNow(id)

// Get initial navigation state
try {
  const navRes = await api.getNavigationState({ tabId: id })
  if (navRes.ok) {
    setNavState({
      currentUrl: navRes.currentUrl ?? 'about:blank',
      canGoBack: navRes.canGoBack ?? false,
      canGoForward: navRes.canGoForward ?? false,
      title: navRes.title ?? '',
    })
    setIsLoading(navRes.isLoading ?? false)
  }
} catch { /* ignore */ }

// If we start already zoomed out, capture once to avoid a pop
if (editor.getZoomLevel() < SHOW_AT) {
  try {
    const cap = await api.capture({ tabId: id })
    if (cap.ok && cap.dataUrl) setScreenshotUrl(cap.dataUrl)
  } catch { /* ignore */ }
}        } catch { /* ignore */ }
      })()
      return () => { cancelled = true }
    }, [api, editor, shape.props.url, isFrozen])

    // ---- Handle evictions when tabs become cold ---------------------------
    useEffect(() => {
      if (!api || !tabIdRef.current) return
      
      const checkEviction = () => {
        const currentSession = sessionStore.get(shape.id)
        if (currentSession?.realization === 'frozen' && tabIdRef.current) {
          // This tab was marked for eviction, destroy the browser view
          api.capture({ tabId: tabIdRef.current }).then(result => {
            if (result.ok) {
              sessionStore.setThumb(shape.id, { dataUrl: result.dataUrl })
              setScreenshotUrl(result.dataUrl)
            }
            if (tabIdRef.current) {
              api.destroy({ tabId: tabIdRef.current })
              tabIdRef.current = null
            }
          }).catch(() => {
            // Cleanup even if capture fails
            if (tabIdRef.current) {
              api.destroy({ tabId: tabIdRef.current })
              tabIdRef.current = null
            }
          })
        }
      }
      
      // Check immediately and set up interval
      checkEviction()
      const interval = setInterval(checkEviction, 1000)
      
      return () => clearInterval(interval)
    }, [api, shape.id])

    // ---- Auto-eviction after 30min inactivity ----------------------------
    useEffect(() => {
      if (!api || !tabIdRef.current) return
      
      const evictTimer = setTimeout(() => {
        const currentSession = sessionStore.get(shape.id)
        if (currentSession && Date.now() - currentSession.lastActivityAt > IDLE_EVICT_MS && tabIdRef.current) {
          // Capture final screenshot before eviction
          api.capture({ tabId: tabIdRef.current }).then(result => {
            if (result.ok) {
              sessionStore.setThumb(shape.id, { dataUrl: result.dataUrl })
            }
            if (tabIdRef.current) {
              api.destroy({ tabId: tabIdRef.current })
              tabIdRef.current = null
            }
            sessionStore.setRealization(shape.id, 'frozen')
          })
        }
      }, IDLE_EVICT_MS)
      
      return () => clearTimeout(evictTimer)
    }, [api, shape.id])

    // ---- Activity tracking ------------------------------------------------
    useEffect(() => {
      if (isFrozen) return

      const trackActivity = () => {
        sessionStore.trackActivity(shape.id, navState.currentUrl)
        sessionStore.trackHotN(3) // CHANGED: trackHotN instead of markHotN
      }
      
      const hostEl = hostRef.current
      if (hostEl) {
        hostEl.addEventListener('click', trackActivity)
        hostEl.addEventListener('keydown', trackActivity)
        return () => {
          hostEl.removeEventListener('click', trackActivity)
          hostEl.removeEventListener('keydown', trackActivity)
        }
      }
    }, [shape.id, navState.currentUrl, isFrozen])

    // Bounds + zoom follow loop (canvas → overlay), with failsafe to drop screenshot
    useEffect(() => {
      if (!api || isFrozen) return

      let raf = 0
      let shown = false
      let lastRect: Rect = { x: -1, y: -1, width: -1, height: -1 }
      let lastFactor = Number.NaN

      const loop = () => {
        raf = requestAnimationFrame(loop)

        const id = tabIdRef.current
        if (!id) return
        const rect = getHostRect()
        if (!rect) return

        if (!shown) {
          shown = true
          void api.show({ tabId: id, rect })
          lastRect = rect
        } else if (
          rect.x !== lastRect.x ||
          rect.y !== lastRect.y ||
          rect.width !== lastRect.width ||
          rect.height !== lastRect.height
        ) {
          void api.setBounds({ tabId: id, rect })
          lastRect = rect
        }

        const factor = editor.getZoomLevel()
        if (!Number.isFinite(lastFactor) || Math.abs(factor - lastFactor) > 1e-3) {
          void api.setZoom({ tabId: id, factor })
          lastFactor = factor

          // Failsafe: if the image is still up well above the hide band, pre-sync + drop it
          if (screenshotUrl && factor > (HIDE_AT + 0.02)) {
            void (async () => {
              await syncOverlayNow(id)
              setScreenshotUrl(null)
            })()
          }
        }
      }

      raf = requestAnimationFrame(loop)
      return () => cancelAnimationFrame(raf)
    }, [api, editor, screenshotUrl, isFrozen])

    // Imperceptible swap: keep screenshot visible until live view is reattached & synced
// Event-driven URL tracking and screenshot mode
useEffect(() => {
  if (!api || isFrozen) return
  let mounted = true

  // Listen for URL updates from overlay
  const handleUrlUpdate = (_event: any, data: { tabId: string; url?: string; screenshot?: string }) => {
    const currentTabId = tabIdRef.current
    if (!mounted || !currentTabId || data.tabId !== currentTabId) return

    // Update navigation state if URL provided
    if (data.url) {
      setNavState(prev => ({
        ...prev,
        currentUrl: data.url!
      }))
      // Save URL to sessionStore immediately
      sessionStore.trackActivity(shape.id, data.url)
    }

    // Save screenshot if provided
    if (data.screenshot) {
      sessionStore.setThumb(shape.id, { dataUrl: data.screenshot })
    }
  }

  // Listen for screenshot mode changes
  const handleScreenshotMode = async (data: { tabId: string; screenshot: string | null; bounds?: any }) => {
    const id = tabIdRef.current
    if (!mounted || !id || id !== data.tabId) return

    // Entering screenshot mode
    if (typeof data.screenshot === 'string') {
      setScreenshotUrl(data.screenshot)
      return
    }

    // Leaving screenshot mode: pre-sync live view under the image, then drop it next frame
    try {
      await syncOverlayNow(id)
    } finally {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (mounted) setScreenshotUrl(null)
        })
      )
    }
  }

  // Set up event listeners
  const offUrlUpdate = api.onUrlUpdate(handleUrlUpdate)
const offScreenshot = api.onScreenshotMode(handleScreenshotMode)

return () => { 
  mounted = false
  offUrlUpdate?.()
  offScreenshot?.()
}

}, [api, editor, isFrozen, shape.id])
    // Cleanup
    useEffect(() => {
      return () => {
        const id = tabIdRef.current
        if (api && id) {
          // Capture final state before cleanup
          api.capture({ tabId: id }).then(result => {
            if (result.ok) {
              sessionStore.setThumb(shape.id, { dataUrl: result.dataUrl })
            }
            api.destroy({ tabId: id })
            // Don't remove from sessionStore - keep for restoration
          }).catch(() => {
            // Cleanup even if capture fails
            if (id) api.destroy({ tabId: id })
          })
        }
      }
    }, [api, shape.id])

    // ---- Frozen tab reactivation ------------------------------------------
    const reactivateTab = (): void => {
  if (!api || !session) return
  
  // Use the saved URL from session, not the original shape URL
  const urlToLoad = session.url
  
  api.createTab({ url: urlToLoad }).then(result => {
    if (result.ok) {
      tabIdRef.current = result.tabId
      sessionStore.setRealization(shape.id, 'attached')
      sessionStore.trackActivity(shape.id, urlToLoad) // Track with the loaded URL
      sessionStore.trackHotN(3) // CHANGED: trackHotN instead of markHotN
      setScreenshotUrl(null)
    }
  }).catch(error => {
    console.warn('Failed to reactivate tab:', error)
  })
}


    // ---- Minimal fit toggle ------------------------------------------------
    const [fitMode, setFitMode] = useState<boolean>(false)
    const onToggleFit = (): void => {
      const s = editor.getShape<BrowserShape>(shape.id)
      if (!s) return
      if (!fitMode) editor.zoomToBounds(new Box(s.x, s.y, s.props.w, s.props.h), { inset: 0 })
      setFitMode(!fitMode)
    }

    // ---- Styles ------------------------------------------------------------
    const contentStyle: React.CSSProperties = {
      position: 'absolute',
      top: NAV_BAR_HEIGHT,
      left: DRAG_GUTTER,
      right: DRAG_GUTTER,
      bottom: DRAG_GUTTER,
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
              if (api && id && !isFrozen) { 
                setIsLoading(true) 
                await api.navigate({ tabId: id, url })
                sessionStore.trackActivity(shape.id, url)
              }
            }}
            onBack={async () => {
              const id = tabIdRef.current
              if (api && id && navState.canGoBack && !isFrozen) { 
                setIsLoading(true) 
                await api.goBack({ tabId: id })
                sessionStore.trackActivity(shape.id)
              }
            }}
            onForward={async () => {
              const id = tabIdRef.current
              if (api && id && navState.canGoForward && !isFrozen) { 
                setIsLoading(true) 
                await api.goForward({ tabId: id })
                sessionStore.trackActivity(shape.id)
              }
            }}
            onReload={async () => {
              const id = tabIdRef.current
              if (api && id && !isFrozen) { 
                setIsLoading(true) 
                await api.reload({ tabId: id })
                sessionStore.trackActivity(shape.id)
              }
            }}
            fitMode={fitMode}
            onToggleFit={onToggleFit}
          />

          {/* Content box (live overlay proxy + screenshot) */}
          <div style={contentStyle}>
            {/* Frozen state overlay */}
            {isFrozen && (
              <div 
                style={{
                  position: 'absolute',
                  top: 0, left: 0, right: 0, bottom: 0,
                  zIndex: 10,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: 'rgba(0,0,0,0.3)',
                }}
                onClick={reactivateTab}
              >
                <div style={{
                  background: 'rgba(255,255,255,0.9)',
                  padding: '8px 16px',
                  borderRadius: '4px',
                  fontSize: '14px',
                  fontWeight: 'bold'
                }}>
                  INACTIVE/FROZEN - Click to activate
                </div>
              </div>
            )}

            {/* Frozen screenshot background */}
            {isFrozen && frozenScreenshot && (
              <img
                src={frozenScreenshot}
                alt="Frozen tab"
                draggable={false}
                style={{
                  position: 'absolute',
                  top: 0, left: 0, right: 0, bottom: 0,
                  width: '100%', height: '100%',
                  objectFit: 'fill',
                  opacity: 0.7,
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
              />
            )}

            {/* Live overlay proxy (only if not frozen) */}
            {!isFrozen && (
              <div
                ref={hostRef}
                style={{
                  position: 'absolute',
                  top: 0, left: 0, right: 0, bottom: 0,
                  pointerEvents: 'none',
                }}
              />
            )}

            {/* Regular screenshot layer (only if not frozen) */}
            {!isFrozen && screenshotUrl && (
              <img
                src={screenshotUrl}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute',
                  top: 0, left: 0, right: 0, bottom: 0,
                  width: '100%', height: '100%',
                  display: 'block',
                  objectFit: 'fill',
                  pointerEvents: 'none',
                  userSelect: 'none',
                  transition: 'none',
                  animation: 'none',
                  backfaceVisibility: 'hidden',
                  transform: 'translateZ(0)',
                }}
              />
            )}
          </div>
        </div>
      </HTMLContainer>
    )
  }
}