import { useEffect, useRef, useState  } from 'react'
import type { Editor, TLShapeId, TLParentId } from 'tldraw'
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

export type BrowserShape = TLBaseShape<
  'browser-shape',
  { w: number; h: number; url: string }
>

const DRAG_GUTTER = 60 // invisible move hit area (no longer affects visuals/geometry)
const MIN_W = 300
// Geometry is tight now; don't bake gutters into visual min height.
const MIN_H = 225 + NAV_BAR_HEIGHT

type Rect = { x: number; y: number; width: number; height: number }
type NavState = { currentUrl: string; canGoBack: boolean; canGoForward: boolean; title: string }


function isAncestorSelected(editor: Editor, shapeId: TLShapeId): boolean {
  // editor.getSelectedShapeIds() already returns TLShapeId[]
  const selected = new Set<TLShapeId>(editor.getSelectedShapeIds())

  if (selected.has(shapeId)) return false

  // parentId is TLParentId | null
  let parentId: TLParentId | null = editor.getShape(shapeId)?.parentId ?? null

  while (parentId) {
    // TLParentId and TLShapeId are both branded strings; at runtime they're strings.
    // We narrow once here to compare with the selected TLShapeIds.
    const parentShapeId = parentId as unknown as TLShapeId

    if (selected.has(parentShapeId)) return true

    const parent = editor.getShape(parentShapeId)
    parentId = parent?.parentId ?? null
  }
  return false
}


export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const
  override isAspectRatioLocked = () => false
  override canResize = () => true
override hideResizeHandles = (shape: BrowserShape): boolean => {
  return isAncestorSelected(this.editor, shape.id as TLShapeId)
}

override indicator(shape: BrowserShape) {
  if (isAncestorSelected(this.editor, shape.id as TLShapeId)) return null
  return <rect x={0} y={0} width={shape.props.w} height={shape.props.h} />
}



  override getDefaultProps(): BrowserShape['props'] {
    return { w: 1200, h: 600 + NAV_BAR_HEIGHT, url: 'https://google.com' }
  }


  
  override onResize(shape: BrowserShape, info: TLResizeInfo<BrowserShape>) {
    const r = resizeBox(shape, info)
    const w = Math.max(MIN_W, r.props.w)
    const h = Math.max(MIN_H, r.props.h)
    return { ...r, props: { ...r.props, w, h } }
  }
override getGeometry(shape: BrowserShape) {
  // Tight geometry == real box; keeps resize handles at true corners.
  const { w, h } = shape.props
  return new Rectangle2d({
    x: 0,
    y: 0,
    width: w,
    height: h,
    isFilled: true,
  })
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
    
  useEffect(() => {
  if (!api || tabIdRef.current) return
  let cancelled = false

  ;(async () => {
    try {
      const res = await api.createTab({ url: shape.props.url, shapeId: shape.id })
      if (!res.ok || cancelled) return

      const id = res.tabId
      tabIdRef.current = id

    } catch {
      // creation failed → cleanup happens naturally
    }
  })()

  return () => {
    cancelled = true
  }
}, [api, shape.props.url, shape.id])

// 3. Navigation state (push-based, no polling)
useEffect(() => {
  if (!api) return

  let alive = true

  const sync = async () => {
    const id = tabIdRef.current
    if (!id) return
    try {
      const res = await api.getNavigationState({ tabId: id })
      if (!alive || !res.ok) return
      setNavState({
        currentUrl: res.currentUrl ?? 'about:blank',
        canGoBack: res.canGoBack ?? false,
        canGoForward: res.canGoForward ?? false,
        title: res.title ?? '',
      })
      setIsLoading(res.isLoading ?? false)
    } catch {
      /* noop */
    }
  }

  // initial load
  void sync()

  // live updates from main
  const off = api.onUrlUpdate(({ tabId }: { tabId: string; url?: string }) => {
    if (tabId === tabIdRef.current) void sync()
  })

  return () => {
    alive = false
    if (off) off()
  }
}, [api])

useEffect(() => {
  if (!api) return

  let raf = 0
  let shown = false
  let lastRect: Rect = { x: -1, y: -1, width: -1, height: -1 }
  let lastFactor = -1
  const ZOOM_EPS = 0.0125 // ~1.25%

  const loop = (): void => {
    raf = requestAnimationFrame(loop)

    const id = tabIdRef.current
    if (!id) return

    const shapeRecord = editor.getShape<BrowserShape>(shape.id)
    if (!shapeRecord || shapeRecord.type !== 'browser-shape') return

    const pb = editor.getShapePageBounds(shapeRecord.id)
    if (!pb) return

    const zoom = editor.getZoomLevel()
  // Geometry is tight; no gutter offset in page->screen mapping.
  const screenPos = editor.pageToScreen({ x: pb.x, y: pb.y })
    const shapeSize = { w: shapeRecord.props.w, h: shapeRecord.props.h }

    const rect: Rect = {
      x: Math.round(screenPos.x),
      y: Math.round(screenPos.y + NAV_BAR_HEIGHT * zoom),
      width: Math.round(shapeSize.w * zoom),
      height: Math.round((shapeSize.h - NAV_BAR_HEIGHT) * zoom),
    }

    const positionChanged = rect.x !== lastRect.x || rect.y !== lastRect.y
    const sizeChanged = rect.width !== lastRect.width || rect.height !== lastRect.height
    const zoomChanged = Math.abs(zoom - lastFactor) > ZOOM_EPS

    if (!shown) {
      shown = true
      void api.show({ tabId: id, rect, shapeSize })
      void api.setBounds({ tabId: id, rect, shapeSize })
      void api.setZoom({ tabId: id, factor: zoom })
      lastRect = rect
      lastFactor = zoom
      return
    }

    if (!positionChanged && !sizeChanged && !zoomChanged) return

    if (zoomChanged) {
      // update bounds if also moved/resized
      if (positionChanged || sizeChanged) {
        void api.setBounds({ tabId: id, rect, shapeSize })
      }
      void api.setZoom({ tabId: id, factor: zoom })
      lastFactor = zoom
      lastRect = rect
      return
    }

    // only move/resize
    void api.setBounds({ tabId: id, rect, shapeSize })
    lastRect = rect
  }

  raf = requestAnimationFrame(loop)
  return () => cancelAnimationFrame(raf)
}, [api, editor, shape.id])

// 5. Cleanup (keep as-is)
useEffect(() => {
  return () => {
    const id = tabIdRef.current
    if (!api || !id) return
    void api.destroy({ tabId: id })
    
  }
}, [api])

    // ---- Minimal fit toggle ------------------------------------------------
// --- Fit state ---
const [fitMode, setFitMode] = useState(false)
const preFitCamRef = useRef<{ x: number; y: number; z: number } | null>(null)
type PreFitState = { parentId: string; x: number; y: number; w: number; h: number }
const preFitStateRef = useRef<PreFitState | null>(null)
const fitStopRef = useRef<(() => void) | null>(null)

const BLEED = 2 // expand a bit so neighbors don’t peek

const getViewportPx = (): { vw: number; vh: number } => {
  const vb = editor.getViewportScreenBounds()
  return { vw: Math.max(1, Math.round(vb.width)), vh: Math.max(1, Math.round(vb.height)) }
}

/** Use page bounds directly (geometry is tight; no gutter deflation). */
const fitShapeToViewport = (s: BrowserShape, vw: number, vh: number): void => {
  const pb = editor.getShapePageBounds(s.id)
  if (!pb) return

  const ax = pb.x
  const ay = pb.y
  const aw = Math.max(1, pb.w)
  const ah = Math.max(1, pb.h)

  const targetW = vw + BLEED
  const targetH = vh + BLEED
  const cx = ax + aw / 2
  const cy = ay + ah / 2
  const x = Math.round(cx - targetW / 2)
  const y = Math.round(cy - targetH / 2)

  editor.updateShapes([
    { id: s.id, type: 'browser-shape', x, y, props: { ...s.props, w: targetW, h: targetH } },
  ])
}

/** Zoom to the true box (no gutter deflation). */
const zoomToShapeNow = (s: BrowserShape): void => {
  const pb = editor.getShapePageBounds(s.id)
  if (!pb) return
  editor.zoomToBounds(new Box(pb.x, pb.y, pb.w, pb.h), { inset: 0 })
}

function startInputGuards(): () => void {
  const isInNav = (t: EventTarget | null): boolean =>
    t instanceof Element && !!t.closest('[data-nav-root="1"]')

  const onWheel = (e: WheelEvent) => {
    if (!isInNav(e.target)) { e.stopImmediatePropagation(); e.preventDefault() }
  }
  const onPointer = (e: PointerEvent) => { if (!isInNav(e.target)) e.stopImmediatePropagation() }
  const onKey = (e: KeyboardEvent) => {
    const ae = document.activeElement as Element | null
    if (isInNav(ae)) return
    if (e.key === ' ' || e.key === '+' || e.key === '-' || e.key === '=' || e.key === '_') {
      e.stopImmediatePropagation(); e.preventDefault()
    }
  }

  window.addEventListener('wheel', onWheel, { capture: true, passive: false })
  window.addEventListener('pointerdown', onPointer, { capture: true })
  window.addEventListener('keydown', onKey, { capture: true })

  return () => {
    window.removeEventListener('wheel', onWheel, { capture: true } as AddEventListenerOptions)
    window.removeEventListener('pointerdown', onPointer, { capture: true } as AddEventListenerOptions)
    window.removeEventListener('keydown', onKey, { capture: true } as AddEventListenerOptions)
  }
}

const runFitOnce = (): void => {
  if (!preFitCamRef.current) preFitCamRef.current = editor.getCamera()

  const s0 = editor.getShape<BrowserShape>(shape.id)
  if (!s0) return

  // snapshot local placement
  if (!preFitStateRef.current) {
    preFitStateRef.current = {
      parentId: (s0.parentId as string) ?? '',
      x: s0.x,
      y: s0.y,
      w: s0.props.w,
      h: s0.props.h,
    }
  }

  editor.bringToFront([s0.id])

  const { vw, vh } = getViewportPx()
  fitShapeToViewport(s0, vw, vh)
  zoomToShapeNow(s0)
}

const fitOn = (): void => {
  runFitOnce()

  // ⬇️ NEW: clear selection as we enter fit mode
editor.selectNone()

  let raf = 0
  let last = { vw: -1, vh: -1 }

  const step = () => {
    raf = requestAnimationFrame(step)

    // ⬇️ NEW: keep clearing if anything re-selects during fit
    if (editor.getSelectedShapeIds().length > 0) {
      editor.selectNone()
    }

    const s = editor.getShape<BrowserShape>(shape.id); if (!s) return
    const { vw, vh } = getViewportPx()
    if (vw !== last.vw || vh !== last.vh) {
      fitShapeToViewport(s, vw, vh)
      zoomToShapeNow(s)
      last = { vw, vh }
    }
  }

  raf = requestAnimationFrame(step)
  const stopGuards = startInputGuards()
  fitStopRef.current = () => { cancelAnimationFrame(raf); stopGuards() }
  setFitMode(true)
}

const fitOff = (): void => {
  fitStopRef.current?.()
  fitStopRef.current = null

  const saved = preFitStateRef.current
  const s = editor.getShape<BrowserShape>(shape.id)

  if (saved && s) {
    if ((s.parentId as string) === saved.parentId) {
      // restore exact local placement
      editor.updateShapes([
        { id: s.id, type: 'browser-shape', x: saved.x, y: saved.y, props: { ...s.props, w: saved.w, h: saved.h } },
      ])
    } else {
      // fallback: restore around page center (tight bounds)
      const pb = editor.getShapePageBounds(s.id)
      if (pb) {
        const cx = pb.x + pb.w / 2
        const cy = pb.y + pb.h / 2
        const x = Math.round(cx - saved.w / 2)
        const y = Math.round(cy - saved.h / 2)

        editor.updateShapes([
          { id: s.id, type: 'browser-shape', x, y, props: { ...s.props, w: saved.w, h: saved.h } },
        ])
      }
    }
  }

  // reset camera zoom to 60% (keep last center)
  const base = preFitCamRef.current ?? editor.getCamera()
  editor.setCamera({ ...base, z: 0.6 })

  preFitCamRef.current = null
  preFitStateRef.current = null
  setFitMode(false)
}

const onToggleFit = (): void => { (fitMode ? fitOff : fitOn)() }



// ---- Render ------------------------------------------------------------
const BORDER = 3 // keep tldraw blue outline visible without shrinking content

type DragState = {
  pointerId: number
  startPage: { x: number; y: number }
  targetId: TLShapeId
}
const dragRef = useRef<DragState | null>(null)

/** Topmost group ancestor id (or null if none). */
const getTopGroupAncestorId = (ed: Editor, id: TLShapeId): TLShapeId | null => {
  let parentId: TLParentId | null = ed.getShape(id)?.parentId ?? null
  let topGroupId: TLShapeId | null = null
  while (parentId) {
    const parentShapeId = parentId as unknown as TLShapeId
    const parent = ed.getShape(parentShapeId)
    if (parent?.type === 'group') topGroupId = parentShapeId
    parentId = parent?.parentId ?? null
  }
  return topGroupId
}

/** Runtime guard for shapes that expose x/y (groups & normal shapes). */
const hasXY = (s: unknown): s is { x: number; y: number } => {
  return !!s &&
    typeof (s as { x?: unknown }).x === 'number' &&
    typeof (s as { y?: unknown }).y === 'number'
}

const gutterDown = (e: React.PointerEvent<HTMLDivElement>): void => {
  const selectedIds = editor.getSelectedShapeIds()
  const isMultiSelect = selectedIds.length > 1
  if (isMultiSelect) {
    // Let tldraw handle multi-selection movement
    return
  }

  // Prefer moving the topmost group if this shape lives in one
  const selfId = shape.id as TLShapeId
  const groupId = getTopGroupAncestorId(editor, selfId)
  const targetId = groupId ?? selfId

  const target = editor.getShape(targetId)
  if (!hasXY(target)) return

  // Select the movement target and bring it to front
  editor.select(targetId)
  editor.bringToFront([targetId])

  const start = editor.screenToPage({ x: e.clientX, y: e.clientY })
  dragRef.current = {
    pointerId: e.pointerId,
    startPage: start,
    targetId,
  }

  e.currentTarget.setPointerCapture(e.pointerId)
  e.preventDefault()
  e.stopPropagation()
}

const gutterMove = (e: React.PointerEvent<HTMLDivElement>): void => {
  const st = dragRef.current
  if (!st) return

  const now = editor.screenToPage({ x: e.clientX, y: e.clientY })
  const dx = now.x - st.startPage.x
  const dy = now.y - st.startPage.y
  if (dx === 0 && dy === 0) return

  const target = editor.getShape(st.targetId)
  if (!target || !hasXY(target)) return

  // Move the correct thing:
  // - if target is a group → move the group (children follow)
  // - else                → move the single browser-shape
  if (target.type === 'group') {
    editor.updateShapes([
      { id: st.targetId, type: 'group', x: target.x + dx, y: target.y + dy },
    ])
  } else {
    editor.updateShapes([
      {
        id: st.targetId,
        type: 'browser-shape',
        x: target.x + dx,
        y: target.y + dy,
        props: { ...shape.props },
      },
    ])
  }

  // Advance baseline so we apply incremental deltas (smooth drag)
  st.startPage = now

  e.preventDefault()
  e.stopPropagation()
}

const gutterEnd = (e: React.PointerEvent<HTMLDivElement>): void => {
  const st = dragRef.current
  if (st) {
    try { e.currentTarget.releasePointerCapture(st.pointerId) } catch {}
  }
  dragRef.current = null
}


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
      {/* Navbar gets priority: raise this shape on hover/press so it beats neighbors */}
      <div
        data-nav-root="1"
        onPointerEnter={() => {
          // bring to front, but only select if not inside a selected group
          if (!isAncestorSelected(editor, shape.id as TLShapeId)) {
            editor.bringToFront([shape.id])
            editor.select(shape.id)
          }
        }}
        onPointerDown={(e) => {
          if (isAncestorSelected(editor, shape.id as TLShapeId)) {
            e.stopPropagation()
            return
          }
          editor.bringToFront([shape.id])
          editor.select(shape.id)
        }}
        style={{ position: 'relative', zIndex: 2, pointerEvents: 'auto' }}
      >
        <NavigationBar
          navState={navState}
          isLoading={isLoading}
          onUrlChange={async (url) => {
            const id = tabIdRef.current
            if (api && id) {
              setIsLoading(true)
              await api.navigate({ tabId: id, url })
            }
          }}
          onBack={async () => {
            const id = tabIdRef.current
            if (api && id && navState.canGoBack) {
              setIsLoading(true)
              await api.goBack({ tabId: id })
            }
          }}
          onForward={async () => {
            const id = tabIdRef.current
            if (api && id && navState.canGoForward) {
              setIsLoading(true)
              await api.goForward({ tabId: id })
            }
          }}
          onReload={async () => {
            const id = tabIdRef.current
            if (api && id) {
              setIsLoading(true)
              await api.reload({ tabId: id })
            }
          }}
          fitMode={fitMode}
          onToggleFit={onToggleFit}
        />
      </div>

      {/* Content area (below navbar) */}
      <div
        style={{
          position: 'absolute',
          top: NAV_BAR_HEIGHT,
          left: 0,
          right: 0,
          bottom: 0,
          overflow: 'visible', // allow outside gutters to spill out
          background: 'transparent',
        }}
      >
        {/* Live web content: inset by BORDER so the blue outline is never covered */}
        <div
          ref={hostRef}
          style={{
            position: 'absolute',
            top: BORDER,
            left: BORDER,
            right: BORDER,
            bottom: BORDER,
            pointerEvents: 'none', // OS plane below; we never rely on DOM here
          }}
        />
      </div>
    </div>

    {/* -------- Invisible OUTER drag gutters (effortless grabbing; no visuals) -------- */}
    {/* Place gutters under the navbar (zIndex: 1) so the nav always wins */}
<div
  onPointerDown={gutterDown}
  onPointerMove={gutterMove}
  onPointerUp={gutterEnd}
  onPointerCancel={gutterEnd}
  style={{
    position: 'absolute',
    top: -DRAG_GUTTER,
    left: -DRAG_GUTTER,
    right: -DRAG_GUTTER,
    height: DRAG_GUTTER,
    cursor: 'move',
    pointerEvents: 'auto',
    background: 'transparent',
    zIndex: 1,
  }}
/>

{/* Bottom gutter */}
<div
  onPointerDown={gutterDown}
  onPointerMove={gutterMove}
  onPointerUp={gutterEnd}
  onPointerCancel={gutterEnd}
  style={{
    position: 'absolute',
    bottom: -DRAG_GUTTER,
    left: -DRAG_GUTTER,
    right: -DRAG_GUTTER,
    height: DRAG_GUTTER,
    cursor: 'move',
    pointerEvents: 'auto',
    background: 'transparent',
    zIndex: 1,
  }}
/>

{/* Left gutter */}
<div
  onPointerDown={gutterDown}
  onPointerMove={gutterMove}
  onPointerUp={gutterEnd}
  onPointerCancel={gutterEnd}
  style={{
    position: 'absolute',
    top: -DRAG_GUTTER,
    bottom: -DRAG_GUTTER,
    left: -DRAG_GUTTER,
    width: DRAG_GUTTER,
    cursor: 'move',
    pointerEvents: 'auto',
    background: 'transparent',
    zIndex: 1,
  }}
/>

{/* Right gutter */}
<div
  onPointerDown={gutterDown}
  onPointerMove={gutterMove}
  onPointerUp={gutterEnd}
  onPointerCancel={gutterEnd}
  style={{
    position: 'absolute',
    top: -DRAG_GUTTER,
    bottom: -DRAG_GUTTER,
    right: -DRAG_GUTTER,
    width: DRAG_GUTTER,
    cursor: 'move',
    pointerEvents: 'auto',
    background: 'transparent',
    zIndex: 1,
  }}
/>
  </HTMLContainer>
)

  }
}
