import { useMemo, useRef, useEffect } from 'react'
import { Tldraw } from 'tldraw'
import type { Editor, TLCameraMoveOptions } from 'tldraw'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { BrowserShapeUtil } from './Utils/BrowserShapeUtil'
import type { BrowserShape } from './Utils/BrowserShapeUtil'
import WithHotkeys from './Utils/WithHotkeys'
import { useUiChromeManager } from './Utils/useUiChromeManager'
import { Toaster, toast } from 'react-hot-toast'
import type { OverlayNotice } from '../../types/overlay'

const BROWSER_W = 1200
const BROWSER_H = 660
const ZOOM_HIDE = 0.65
const ZOOM_SHOW = 0.6
const DURATION_MS = 180
const SLIDE_PX = 16

// identify browser shapes without using `any`
function isBrowserShapeLike(s: unknown): s is { type: string } {
  return typeof s === 'object' && s !== null && 'type' in s && typeof (s as { type: unknown }).type === 'string'
}

type Bounds = { x: number; y: number; w: number; h: number }
type EditorWithFit = Editor & {
  zoomToFit?: (opts?: TLCameraMoveOptions) => Editor
  getContentBounds?: () => Bounds | null
  zoomToBounds?: (
    b: Bounds,
    opts?: { inset?: number; targetZoom?: number } & TLCameraMoveOptions
  ) => Editor
}

function isUsableBounds(b: unknown): b is Bounds {
  if (typeof b !== 'object' || b === null) return false
  const bb = b as Partial<Bounds>
  return (
    typeof bb.x === 'number' &&
    typeof bb.y === 'number' &&
    typeof bb.w === 'number' &&
    typeof bb.h === 'number' &&
    Number.isFinite(bb.w) &&
    Number.isFinite(bb.h) &&
    bb.w > 0 &&
    bb.h > 0
  )
}

// Perform “Back to content” but clamp zoom above INITIAL_MIN_ZOOM
function backToContentSafe(editor: Editor): void {
  const ed = editor as EditorWithFit

  if (typeof ed.zoomToFit === 'function') {
    ed.zoomToFit({ animation: { duration: 200 } })
  } else if (
    typeof ed.getContentBounds === 'function' &&
    typeof ed.zoomToBounds === 'function'
  ) {
    const b = ed.getContentBounds()
    if (isUsableBounds(b)) {
      ed.zoomToBounds(b, { inset: 64, animation: { duration: 200 } })
    }
  } else {
    const cam = editor.getCamera()
    editor.setCamera({ x: cam.x, y: cam.y, z: 0.5 }, { immediate: true })
  }

  // Final clamp: make sure we are *well above* the HIDE_AT threshold (0.26)
  const cam = editor.getCamera()
  const SAFE_MIN = 0.4
  if (cam.z < SAFE_MIN) {
    editor.setCamera({ x: cam.x, y: cam.y, z: SAFE_MIN }, { immediate: true })
  }
}

export default function App() {
  const shapeUtils = useMemo(() => [BrowserShapeUtil], [])
  const assetUrls = useMemo(
    () => getAssetUrls({ baseUrl: import.meta.env.DEV ? '/tldraw-assets' : './tldraw-assets' }),
    []
  )

  const editorRef = useRef<Editor | null>(null)

  // UI chrome behavior
  useUiChromeManager(editorRef, { DURATION_MS, SLIDE_PX, ZOOM_HIDE, ZOOM_SHOW })

  useEffect(() => {
  const api = window.overlay
  if (!api?.onNotice) return

  const off = api.onNotice((n: OverlayNotice) => {
    switch (n.kind) {
      case 'tab-limit':
        toast.error(`Tab limit reached (${n.max}).`)
        break
      case 'popup-suppressed':
        toast('Max browser windows from links reached.')
        break
      case 'tab-crashed':
        toast.error('This tab crashed and was closed.')
        break
      case 'nav-error':
        toast.error(`Navigation failed (${n.code}): ${n.description}`)
        break
      case 'screen-share-error':
        toast.error(`Screen share error: ${n.message}`)
        break
      case 'media-denied':
        toast('Permission denied.')
        break
    }
  })

  return off
}, [])


  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Toaster position="bottom-center" />
      <Tldraw
        shapeUtils={shapeUtils}
        assetUrls={assetUrls}
        hideUi={false}
        persistenceKey="paper-canvas"
        onMount={(editor) => {
          editorRef.current = editor

          // Ensure at least one browser tab exists on fresh canvases
          const hasBrowserShape = editor
            .getCurrentPageShapes()
            .some((s) => isBrowserShapeLike(s) && s.type === 'browser-shape')

          if (!hasBrowserShape) {
            const initial: Omit<BrowserShape, 'id' | 'index' | 'typeName'> & { type: 'browser-shape' } = {
              type: 'browser-shape',
              x: 100,
              y: 100,
              rotation: 0,
              isLocked: false,
              opacity: 1,
              parentId: editor.getCurrentPageId(),
              meta: {},
              props: {
                w: BROWSER_W,
                h: BROWSER_H,
                url: 'https://google.com',
                tabId: '',
              },
            }
            editor.createShape(initial as unknown as BrowserShape)
          }

          // Run back-to-content and clamp zoom so we start live (not screenshot mode)
          requestAnimationFrame(() => backToContentSafe(editor))
        }}
      >
        <WithHotkeys BROWSER_W={BROWSER_W} BROWSER_H={BROWSER_H} editorRef={editorRef} />
      </Tldraw>
    </div>
  )
}
