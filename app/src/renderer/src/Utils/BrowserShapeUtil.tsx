import { useEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId, TLParentId } from 'tldraw'
import {
  HTMLContainer,
  Rectangle2d,
  ShapeUtil,
  TLBaseShape,
  TLResizeInfo,
  resizeBox,
  useEditor,
  useIsEditing,
  VecLike
} from 'tldraw'
import { NavigationBar, NAV_BAR_HEIGHT } from '../components/NavigationBar'

class BrowserGrabGeometry extends Rectangle2d {
  constructor(config: { x: number; y: number; width: number; height: number; isFilled: boolean }) {
    super(config)
  }

  override hitTestPoint(point: VecLike, margin = 0, _hitInside = false): boolean {
    const { bounds } = this
    const m = margin + DRAG_GUTTER
    return !(
      point.x < bounds.minX - m ||
      point.y < bounds.minY - m ||
      point.x > bounds.maxX + m ||
      point.y > bounds.maxY + m
    )
  }
}

export type BrowserShape = TLBaseShape<
  'browser-shape',
  { w: number; h: number; url: string }
>

const DRAG_GUTTER = 80
const MIN_W = 300
const MIN_H = 225 + NAV_BAR_HEIGHT
const CONTENT_BORDER = 3
const TAB_ACTIVITY_EVENT = 'paper:tab-activity' as const
const TAB_INTERACT_EVENT = 'paper:tab-interact' as const
const NEW_TAB_EVENT = 'paper:new-tab' as const
const TAB_STATE_EVENT = 'paper:tab-state-changed' as const
const RESTORE_READY_EVENT = 'paper:restore-ready' as const

type NavState = { currentUrl: string; canGoBack: boolean; canGoForward: boolean; title: string }
type TabLifecycleState = 'live' | 'frozen' | 'discarded'
type SavedFitBounds = { x: number; y: number; w: number; h: number }
type SavedCamera = { x: number; y: number; z: number }
type EditorWithViewport = Editor & {
  getViewportScreenBounds?: () => { width: number; height: number }
  zoomToBounds?: (
    bounds: { x: number; y: number; w: number; h: number },
    opts?: { inset?: number; animation?: { duration: number } }
  ) => Editor
}

const FIT_BLEED = 2

function isAncestorSelected(editor: Editor, shapeId: TLShapeId): boolean {
  const selected = new Set<TLShapeId>(editor.getSelectedShapeIds())
  if (selected.has(shapeId)) return false
  let parentId: TLParentId | null = editor.getShape(shapeId)?.parentId ?? null
  while (parentId) {
    const parentShapeId = parentId as unknown as TLShapeId
    if (selected.has(parentShapeId)) return true
    const parent = editor.getShape(parentShapeId)
    parentId = parent?.parentId ?? null
  }
  return false
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, max))
}

function getContentSize(shape: BrowserShape): { width: number; height: number } {
  return {
    width: Math.max(1, shape.props.w - CONTENT_BORDER * 2),
    height: Math.max(1, shape.props.h - NAV_BAR_HEIGHT - CONTENT_BORDER),
  }
}

function getMouseButton(button: number): 'left' | 'middle' | 'right' {
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return 'left'
}

function getKeyModifiers(e: KeyboardEvent): string[] {
  const modifiers: string[] = []
  if (e.shiftKey) modifiers.push('shift')
  if (e.ctrlKey) modifiers.push('control')
  if (e.altKey) modifiers.push('alt')
  if (e.metaKey) modifiers.push('meta')
  if (e.repeat) modifiers.push('isAutoRepeat')
  return modifiers
}

function toElectronKeyCode(e: KeyboardEvent): string | null {
  const special: Record<string, string> = {
    Backspace: 'Backspace',
    Tab: 'Tab',
    Enter: 'Enter',
    Escape: 'Escape',
    ' ': 'Space',
    Spacebar: 'Space',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    CapsLock: 'CapsLock',
    NumLock: 'NumLock',
    ScrollLock: 'ScrollLock',
    PrintScreen: 'PrintScreen',
    Pause: 'Pause',
    ContextMenu: 'Menu',
    Shift: 'Shift',
    Control: 'Control',
    Alt: 'Alt',
    Meta: 'Meta',
    F1: 'F1',
    F2: 'F2',
    F3: 'F3',
    F4: 'F4',
    F5: 'F5',
    F6: 'F6',
    F7: 'F7',
    F8: 'F8',
    F9: 'F9',
    F10: 'F10',
    F11: 'F11',
    F12: 'F12',
  }

  if (special[e.key]) return special[e.key]
  if (e.key.length === 1) {
    if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase()
    return e.key
  }
  return null
}

function getCharKeyCode(e: KeyboardEvent): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (e.key === 'Enter') return 'Enter'
  if (e.key === 'Tab') return 'Tab'
  if (e.key.length === 1) return e.key
  return null
}

function toCssCursor(cursor: string | undefined): string {
  if (!cursor) return 'default'
  const lower = cursor.toLowerCase()
  const map: Record<string, string> = {
    hand: 'pointer',
    ibeam: 'text',
    verticaltext: 'vertical-text',
    cross: 'crosshair',
    move: 'move',
    eastresize: 'e-resize',
    westresize: 'w-resize',
    northresize: 'n-resize',
    southresize: 's-resize',
    northsouthresize: 'ns-resize',
    eastwestresize: 'ew-resize',
    northwestsoutheastresize: 'nwse-resize',
    northeastsouthwestresize: 'nesw-resize',
    columnresize: 'col-resize',
    rowresize: 'row-resize',
    nodrop: 'no-drop',
    notallowed: 'not-allowed',
    progress: 'progress',
    wait: 'wait',
    help: 'help',
    cell: 'cell',
    none: 'default',
    pointer: 'pointer',
    text: 'text',
    default: 'default',
  }
  return map[lower] ?? lower
}

function toSurfacePoint(
  el: HTMLDivElement,
  surfaceSize: { width: number; height: number },
  clientX: number,
  clientY: number,
  fitMode: boolean
): { x: number; y: number } | null {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null

  const surfaceW = Math.max(1, surfaceSize.width)
  const surfaceH = Math.max(1, surfaceSize.height)

  let left = rect.left
  let top = rect.top
  let width = rect.width
  let height = rect.height

  if (fitMode) {
    const scale = Math.min(rect.width / surfaceW, rect.height / surfaceH)
    width = surfaceW * scale
    height = surfaceH * scale
    left = rect.left + (rect.width - width) / 2
    top = rect.top + (rect.height - height) / 2

    if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) {
      return null
    }
  }

  const relX = clamp((clientX - left) / Math.max(1, width), 0, 1)
  const relY = clamp((clientY - top) / Math.max(1, height), 0, 1)

  return {
    x: clamp(Math.round(relX * surfaceW), 0, surfaceW - 1),
    y: clamp(Math.round(relY * surfaceH), 0, surfaceH - 1),
  }
}

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static override type = 'browser-shape' as const
  override isAspectRatioLocked = () => false
  override canResize = () => true
  override canEdit = () => true

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
    const { w, h } = shape.props
    return new BrowserGrabGeometry({ x: 0, y: 0, width: w, height: h, isFilled: true })
  }

  override component(shape: BrowserShape) {
    const editor = useEditor()
    const api = window.overlay
    const isEditing = useIsEditing(shape.id as TLShapeId)
    const globalState = window as Window & {
      __tabState?: Map<string, TabLifecycleState>
      __tabRestoreInfo?: Map<string, { currentUrl: string; lifecycle: TabLifecycleState; thumbPath: string | null }>
    }

    const tabIdRef = useRef<string | null>(null)
    const lifecycleStateRef = useRef<TabLifecycleState>(globalState.__tabState?.get(String(shape.id)) ?? 'live')
    const [tabId, setTabId] = useState<string | null>(null)
    const [restoreReady, setRestoreReady] = useState<boolean>(window.__overlayRestoreReady ?? false)
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const getRestoreInfo = (): { currentUrl: string; lifecycle: TabLifecycleState; thumbPath: string | null } | undefined =>
      globalState.__tabRestoreInfo?.get(String(shape.id))

    const [navState, setNavState] = useState<NavState>({
      currentUrl: getRestoreInfo()?.currentUrl ?? shape.props.url,
      canGoBack: false,
      canGoForward: false,
      title: '',
    })
    const [isLoading, setIsLoading] = useState<boolean>(false)
    const [fitMode, setFitMode] = useState(false)
    const [browserCursor, setBrowserCursor] = useState<string>('default')
    const browserRootRef = useRef<HTMLDivElement | null>(null)
    const fitRestoreRef = useRef<SavedFitBounds | null>(null)
    const preFitCamRef = useRef<SavedCamera | null>(null)
    const fitStopRef = useRef<(() => void) | null>(null)

    const markActivity = (): void => {
      const id = tabIdRef.current
      if (lifecycleStateRef.current !== 'live' || !id) return
      window.dispatchEvent(new CustomEvent(TAB_ACTIVITY_EVENT, { detail: { tabId: id } }))
    }

    const reportInteraction = (): void => {
      window.dispatchEvent(new CustomEvent(TAB_INTERACT_EVENT, {
        detail: { shapeId: shape.id as TLShapeId },
      }))
    }

    const ensureLiveTab = async (): Promise<string | null> => {
      markActivity()

      if (lifecycleStateRef.current === 'live' && tabIdRef.current) {
        return tabIdRef.current
      }

      const startedAt = performance.now()
      while (performance.now() - startedAt < 3000) {
        if (lifecycleStateRef.current === 'live' && tabIdRef.current) {
          return tabIdRef.current
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16))
      }

      return tabIdRef.current
    }

    const updateShapeUrl = (url: string): void => {
      const current = editor.getShape(shape.id)
      if (!current) return
      const currentShape = current as BrowserShape
      if (currentShape.props.url === url) return
      editor.updateShapes([{
        id: shape.id,
        type: 'browser-shape',
        props: {
          ...currentShape.props,
          url,
        },
      }])
    }

    const drawStoredThumb = async (): Promise<void> => {
      const thumb = window.__tabThumbs?.get(String(shape.id))
      const canvas = canvasRef.current
      if (!thumb || !canvas) return
      const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
      if (!ctx) return

      const img = new Image()
      img.src = thumb.dataUrlWebp

      try {
        if (typeof img.decode === 'function') {
          await img.decode()
        } else {
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve()
            img.onerror = () => reject(new Error('thumb-load-failed'))
          })
        }
      } catch {
        return
      }

      const width = Math.max(1, img.naturalWidth || canvas.width || getContentSize(shape).width)
      const height = Math.max(1, img.naturalHeight || canvas.height || getContentSize(shape).height)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      ctx.drawImage(img, 0, 0, width, height)
    }

    const getViewportPx = (): { vw: number; vh: number } => {
      const vb = (editor as EditorWithViewport).getViewportScreenBounds?.()
      if (vb) {
        return {
          vw: Math.max(1, Math.round(vb.width)),
          vh: Math.max(1, Math.round(vb.height)),
        }
      }
      const pb = editor.getViewportPageBounds()
      return {
        vw: Math.max(1, Math.round(pb.maxX - pb.minX)),
        vh: Math.max(1, Math.round(pb.maxY - pb.minY)),
      }
    }

    const fitShapeToViewport = (currentShape: BrowserShape & { x: number; y: number }): void => {
      const pb = editor.getShapePageBounds(currentShape.id)
      if (!pb) return

      const { vw, vh } = getViewportPx()
      const targetW = Math.max(MIN_W, vw + FIT_BLEED)
      const targetH = Math.max(MIN_H, vh + FIT_BLEED)
      const cx = pb.x + pb.w / 2
      const cy = pb.y + pb.h / 2
      const x = Math.round(cx - targetW / 2)
      const y = Math.round(cy - targetH / 2)

      if (
        currentShape.x === x &&
        currentShape.y === y &&
        currentShape.props.w === targetW &&
        currentShape.props.h === targetH
      ) {
        return
      }

      editor.updateShapes([{
        id: currentShape.id,
        type: 'browser-shape',
        x,
        y,
        props: {
          ...currentShape.props,
          w: targetW,
          h: targetH,
        },
      }])
    }

    const zoomToShapeNow = (shapeId: TLShapeId): void => {
      const pb = editor.getShapePageBounds(shapeId)
      if (!pb) return
      ;(editor as EditorWithViewport).zoomToBounds?.({
        x: pb.x,
        y: pb.y,
        w: Math.max(1, pb.w),
        h: Math.max(1, pb.h),
      }, { inset: 0 })
    }

    const syncFitViewportOnce = (): void => {
      const current = editor.getShape(shape.id)
      if (!current) return
      const currentShape = current as BrowserShape & { x: number; y: number }
      fitShapeToViewport(currentShape)
      zoomToShapeNow(currentShape.id)
      editor.selectNone()
    }

    const startFitInputGuards = (): (() => void) => {
      const isInsideBrowser = (target: EventTarget | null): boolean => {
        if (!(target instanceof Node)) return false
        return !!browserRootRef.current?.contains(target)
      }

      const onWheel = (e: WheelEvent): void => {
        if (isInsideBrowser(e.target)) return
        e.stopImmediatePropagation()
        e.preventDefault()
      }

      const onPointer = (e: PointerEvent): void => {
        if (isInsideBrowser(e.target)) return
        e.stopImmediatePropagation()
      }

      const onKey = (e: KeyboardEvent): void => {
        const active = document.activeElement
        if (isInsideBrowser(active)) return
        if (e.key === ' ' || e.key === '+' || e.key === '-' || e.key === '=' || e.key === '_') {
          e.stopImmediatePropagation()
          e.preventDefault()
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

    // ---- Tab creation / destruction ----------------------------------------
    useEffect(() => {
      if (!restoreReady || !api || tabIdRef.current || lifecycleStateRef.current !== 'live') return
      let cancelled = false
        ; (async () => {
          try {
            const restoreInfo = getRestoreInfo()
            const res = restoreInfo
              ? await api.createTab({ shapeId: shape.id, restore: true })
              : await api.createTab({ url: shape.props.url, shapeId: shape.id })
            if (!res.ok || cancelled) return
            tabIdRef.current = res.tabId
            setTabId(res.tabId)
            window.dispatchEvent(new CustomEvent(NEW_TAB_EVENT, {
              detail: { tabId: res.tabId, shapeId: shape.id as TLShapeId },
            }))
          } catch { }
        })()
      return () => { cancelled = true }
    }, [api, restoreReady, shape.props.url, shape.id])

    useEffect(() => {
      if (restoreReady) {
        const persistedState = globalState.__tabState?.get(String(shape.id))
        const restoreInfo = getRestoreInfo()
        if (persistedState) lifecycleStateRef.current = persistedState
        if (restoreInfo?.currentUrl && restoreInfo.currentUrl !== shape.props.url) {
          updateShapeUrl(restoreInfo.currentUrl)
          setNavState((prev) => ({ ...prev, currentUrl: restoreInfo.currentUrl }))
        }
        if (persistedState && persistedState !== 'live') void drawStoredThumb()
        return
      }

      const onRestoreReady = (): void => {
        const persistedState = globalState.__tabState?.get(String(shape.id))
        const restoreInfo = getRestoreInfo()
        lifecycleStateRef.current = persistedState ?? 'live'
        if (restoreInfo?.currentUrl && restoreInfo.currentUrl !== shape.props.url) {
          updateShapeUrl(restoreInfo.currentUrl)
          setNavState((prev) => ({ ...prev, currentUrl: restoreInfo.currentUrl }))
        }
        if (persistedState && persistedState !== 'live') {
          void drawStoredThumb()
        }
        setRestoreReady(true)
      }

      window.addEventListener(RESTORE_READY_EVENT, onRestoreReady as EventListener, { once: true })
      return () => {
        window.removeEventListener(RESTORE_READY_EVENT, onRestoreReady as EventListener)
      }
    }, [drawStoredThumb, globalState.__tabState, restoreReady, shape.id])

    useEffect(() => {
      const onStateChange = (event: Event): void => {
        const detail = (event as CustomEvent<{ tabId: string; state: TabLifecycleState }>).detail
        if (detail?.tabId !== String(shape.id)) return
        lifecycleStateRef.current = detail.state
        if (detail.state === 'discarded') {
          tabIdRef.current = null
          setTabId(null)
          void drawStoredThumb()
          return
        }
        if (detail.state === 'frozen') {
          void drawStoredThumb()
        }
        if (detail.state === 'live' && !tabIdRef.current) {
          tabIdRef.current = String(shape.id)
          setTabId(String(shape.id))
        }
      }

      window.addEventListener(TAB_STATE_EVENT, onStateChange as EventListener)
      return () => window.removeEventListener(TAB_STATE_EVENT, onStateChange as EventListener)
    }, [shape.id])

    useEffect(() => {
      if (lifecycleStateRef.current === 'live') return
      void drawStoredThumb()
    }, [shape.id])

    useEffect(() => {
      return () => {
        const id = tabIdRef.current
        if (api && id) void api.destroy({ tabId: id })
      }
    }, [api])

    // ---- Frame rendering ---------------------------------------------------
    useEffect(() => {
      if (!api?.onFrame || !tabId) return
      const off = api.onFrame(tabId, (frame) => {
        const canvas = canvasRef.current
        const importedSharedTexture = frame.importedSharedTexture
        try {
          if (!canvas) return
          const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
          if (!ctx) return

          const videoFrame = importedSharedTexture.getVideoFrame()
          try {
            if (canvas.width !== videoFrame.displayWidth || canvas.height !== videoFrame.displayHeight) {
              canvas.width = videoFrame.displayWidth
              canvas.height = videoFrame.displayHeight
            }
            ctx.drawImage(videoFrame, 0, 0)
          } finally {
            videoFrame.close()
          }
        } finally {
          importedSharedTexture.release()
        }
      })
      return () => off?.()
    }, [api, tabId])

    // ---- Bounds sync -------------------------------------------------------
    useEffect(() => {
      if (!api || !tabId) return
      const { width, height } = getContentSize(shape)
      void api.setBounds?.({
        tabId,
        rect: { x: 0, y: 0, width, height },
      })
    }, [api, tabId, shape.props.w, shape.props.h])

    // ---- Navigation state --------------------------------------------------
    useEffect(() => {
      if (!api || !tabId) return
      let alive = true
      const sync = async (): Promise<void> => {
        try {
          const res = await api.getNavigationState({ tabId })
          if (!alive || !res.ok) return
          setNavState({
            currentUrl: res.currentUrl ?? 'about:blank',
            canGoBack: res.canGoBack ?? false,
            canGoForward: res.canGoForward ?? false,
            title: res.title ?? '',
          })
          setIsLoading(res.isLoading ?? false)
        } catch { }
      }
      void sync()
      const offUrl = api.onUrlUpdate(({ tabId: tid, url }: { tabId: string; url?: string }) => {
        if (tid !== tabId) return
        if (typeof url === 'string' && url.length > 0) {
          window.__tabRestoreInfo?.set(String(shape.id), {
            currentUrl: url,
            lifecycle: lifecycleStateRef.current,
            thumbPath: window.__tabRestoreInfo?.get(String(shape.id))?.thumbPath ?? null,
          })
        }
        const latestUrl = url ?? window.__tabRestoreInfo?.get(String(shape.id))?.currentUrl
        if (latestUrl && latestUrl !== shape.props.url) {
          updateShapeUrl(latestUrl)
          setNavState((prev) => ({ ...prev, currentUrl: latestUrl }))
        }
        void sync()
      })
      const offNav = api.onNavFinished?.(({ tabId: tid }: { tabId: string }) => {
        if (tid !== tabId) return
        void sync()
      })
      return () => {
        alive = false
        offUrl?.()
        offNav?.()
      }
    }, [api, tabId])

    useEffect(() => {
      if (!api?.onNotice || !tabId) return
      const off = api.onNotice((notice) => {
        if (notice.kind !== 'cursor' || notice.tabId !== tabId) return
        setBrowserCursor(toCssCursor(notice.cursor))
      })
      return () => off?.()
    }, [api, tabId])

    // ---- Input forwarding --------------------------------------------------
    const contentRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
      const el = contentRef.current
      if (!el || !api || !tabId) return
      let pointerIsDown = false
      const surfaceSize = getContentSize(shape)

      const getPoint = (e: MouseEvent | WheelEvent) =>
        toSurfacePoint(el, surfaceSize, e.clientX, e.clientY, fitMode)

      const sendMouseMove = (e: MouseEvent): void => {
        const point = getPoint(e)
        if (!point) return
        void api.sendInput?.({ tabId, event: { type: 'mouseMove', x: point.x, y: point.y } })
      }

      const onMouseDown = (e: MouseEvent) => {
        if (e.button > 2) return
        e.stopPropagation()
        e.preventDefault()
        markActivity()
        el.focus({ preventScroll: true })
        const point = getPoint(e)
        if (!point) return
        pointerIsDown = true
        sendMouseMove(e)
        void api.sendInput?.({
          tabId,
          event: {
            type: 'mouseDown',
            x: point.x,
            y: point.y,
            button: getMouseButton(e.button),
            clickCount: e.detail || 1,
          },
        })
      }

      const onMouseUp = (e: MouseEvent) => {
        if (!pointerIsDown) return
        pointerIsDown = false
        e.stopPropagation()
        e.preventDefault()
        const point = getPoint(e)
        if (!point) return
        void api.sendInput?.({
          tabId,
          event: {
            type: 'mouseUp',
            x: point.x,
            y: point.y,
            button: getMouseButton(e.button),
            clickCount: e.detail || 1,
          },
        })
      }

      const onElementMouseMove = (e: MouseEvent) => {
        markActivity()
        sendMouseMove(e)
      }

      const onWindowMouseMove = (e: MouseEvent) => {
        if (!pointerIsDown) return
        sendMouseMove(e)
      }

      const onWheel = (e: WheelEvent) => {
        e.stopPropagation()
        e.preventDefault()
        markActivity()
        const point = getPoint(e)
        if (!point) return
        void api.sendInput?.({
          tabId,
          event: {
            type: 'mouseWheel',
            x: point.x,
            y: point.y,
            deltaX: -e.deltaX,
            deltaY: -e.deltaY,
            wheelTicksX: -e.deltaX / 100,
            wheelTicksY: -e.deltaY / 100,
          },
        })
      }

      const onMouseLeave = () => {
        if (pointerIsDown) return
        void api.sendInput?.({ tabId, event: { type: 'mouseLeave' } })
      }

      const onMouseEnter = (e: MouseEvent) => {
        const point = getPoint(e)
        if (!point) return
        void api.sendInput?.({ tabId, event: { type: 'mouseEnter', x: point.x, y: point.y } })
      }

      const onKeyDown = (e: KeyboardEvent) => {
        markActivity()
        const keyCode = toElectronKeyCode(e)
        if (!keyCode) return
        e.stopPropagation()
        if (e.key !== 'Tab') e.preventDefault()
        void api.sendInput?.({
          tabId,
          event: { type: 'keyDown', keyCode, modifiers: getKeyModifiers(e) },
        })
        const charKeyCode = getCharKeyCode(e)
        if (!charKeyCode) return
        void api.sendInput?.({
          tabId,
          event: { type: 'char', keyCode: charKeyCode, modifiers: getKeyModifiers(e) },
        })
      }

      const onKeyUp = (e: KeyboardEvent) => {
        markActivity()
        const keyCode = toElectronKeyCode(e)
        if (!keyCode) return
        e.stopPropagation()
        void api.sendInput?.({
          tabId,
          event: { type: 'keyUp', keyCode, modifiers: getKeyModifiers(e) },
        })
      }

      el.addEventListener('mouseenter', onMouseEnter)
      el.addEventListener('mouseleave', onMouseLeave)
      el.addEventListener('mousedown', onMouseDown)
      el.addEventListener('wheel', onWheel, { passive: false })
      el.addEventListener('mousemove', onElementMouseMove)
      el.addEventListener('keydown', onKeyDown)
      el.addEventListener('keyup', onKeyUp)
      window.addEventListener('mouseup', onMouseUp, true)
      window.addEventListener('mousemove', onWindowMouseMove, true)

      return () => {
        el.removeEventListener('mouseenter', onMouseEnter)
        el.removeEventListener('mouseleave', onMouseLeave)
        el.removeEventListener('mousedown', onMouseDown)
        el.removeEventListener('wheel', onWheel)
        el.removeEventListener('mousemove', onElementMouseMove)
        el.removeEventListener('keydown', onKeyDown)
        el.removeEventListener('keyup', onKeyUp)
        window.removeEventListener('mouseup', onMouseUp, true)
        window.removeEventListener('mousemove', onWindowMouseMove, true)
      }
    }, [api, fitMode, shape.props.h, shape.props.w, tabId])

    const onToggleFit = (): void => {
      const current = editor.getShape(shape.id)
      if (!current) return
      const currentShape = current as BrowserShape & { x: number; y: number }

      if (!fitMode) {
        if (!preFitCamRef.current) {
          preFitCamRef.current = editor.getCamera()
        }
        fitRestoreRef.current = {
          x: currentShape.x,
          y: currentShape.y,
          w: currentShape.props.w,
          h: currentShape.props.h,
        }
        editor.bringToFront([currentShape.id])
        syncFitViewportOnce()
        const stopGuards = startFitInputGuards()
        const onResize = (): void => syncFitViewportOnce()
        window.addEventListener('resize', onResize)

        const step = (): void => {
          if (editor.getSelectedShapeIds().length > 0) {
            editor.selectNone()
          }
        }

        const selectionGuard = window.setInterval(step, 120)
        fitStopRef.current = () => {
          window.clearInterval(selectionGuard)
          window.removeEventListener('resize', onResize)
          stopGuards()
        }
        setFitMode(true)
        return
      }

      const restore = fitRestoreRef.current
      fitStopRef.current?.()
      fitStopRef.current = null
      setFitMode(false)
      if (restore) {
        editor.updateShapes([{
          id: shape.id,
          type: 'browser-shape',
          x: restore.x,
          y: restore.y,
          props: {
            ...currentShape.props,
            w: restore.w,
            h: restore.h,
          },
        }])
      }
      if (preFitCamRef.current) {
        editor.setCamera(preFitCamRef.current, { immediate: true })
      }
      preFitCamRef.current = null
      fitRestoreRef.current = null
    }

    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          position: 'relative',
          pointerEvents: 'auto',
          cursor: fitMode ? 'default' : isEditing ? 'default' : 'move',
        }}
        onPointerDownCapture={() => {
          reportInteraction()
          markActivity()
        }}
        onPointerDown={(e) => {
          if (fitMode) {
            e.stopPropagation()
            return
          }
          if (!isAncestorSelected(editor, shape.id as TLShapeId)) {
            editor.bringToFront([shape.id])
            editor.select(shape.id)
          }
        }}
      >
        <div
          ref={browserRootRef}
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            position: 'relative',
            cursor: 'default',
            boxShadow: '0 4px 20px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05)',
            borderRadius: '6px',
            background: '#fff',
            overflow: 'visible',
            pointerEvents: 'auto',
          }}
        >
          {/* Navbar — always interactive */}
          <div
            data-nav-root="1"
            onPointerEnter={() => {
              markActivity()
              if (!isAncestorSelected(editor, shape.id as TLShapeId)) {
                editor.bringToFront([shape.id])
                editor.select(shape.id)
              }
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              markActivity()
              if (isAncestorSelected(editor, shape.id as TLShapeId)) return
              editor.bringToFront([shape.id])
              editor.select(shape.id)
            }}
            style={{ position: 'relative', zIndex: 2, pointerEvents: 'auto' }}
          >
            <NavigationBar
              navState={navState}
              isLoading={isLoading}
              onInteract={markActivity}
              onUrlChange={async (url) => {
                if (!api) return
                const id = await ensureLiveTab()
                if (!id) return
                setIsLoading(true)
                await api.navigate({ tabId: id, url })
                setIsLoading(false)
              }}
              onBack={async () => {
                if (!api || !navState.canGoBack) return
                const id = await ensureLiveTab()
                if (!id) return
                setIsLoading(true)
                await api.goBack({ tabId: id })
                setIsLoading(false)
              }}
              onForward={async () => {
                if (!api || !navState.canGoForward) return
                const id = await ensureLiveTab()
                if (!id) return
                setIsLoading(true)
                await api.goForward({ tabId: id })
                setIsLoading(false)
              }}
              onReload={async () => {
                if (!api) return
                const id = await ensureLiveTab()
                if (!id) return
                setIsLoading(true)
                if (typeof api.reload === 'function') {
                  await api.reload({ tabId: id })
                } else {
                  await api.navigate({ tabId: id, url: navState.currentUrl })
                }
                setIsLoading(false)
              }}
              fitMode={fitMode}
              onToggleFit={onToggleFit}
            />
          </div>

          {/* Content area — only interactive when editing */}
          <div
            ref={contentRef}
            tabIndex={0}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onPointerMove={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: NAV_BAR_HEIGHT,
              left: CONTENT_BORDER,
              right: CONTENT_BORDER,
              bottom: CONTENT_BORDER,
              overflow: 'hidden',
              outline: 'none',
              cursor: browserCursor,
              pointerEvents: 'auto',  // always auto
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                width: '100%',
                height: '100%',
                display: 'block',
                objectFit: 'fill',
                cursor: browserCursor,
              }}
            />
          </div>
        </div>

        {/* Invisible outer drag gutters */}
        <div
          onPointerDown={() => {
            if (!isAncestorSelected(editor, shape.id as TLShapeId)) {
              editor.bringToFront([shape.id])
              editor.select(shape.id)
            }
          }}
          style={{
            position: 'absolute',
            top: -DRAG_GUTTER,
            left: -DRAG_GUTTER,
            right: -DRAG_GUTTER,
            bottom: -DRAG_GUTTER,
            zIndex: -1,
            cursor: 'move',
            pointerEvents: isEditing || fitMode ? 'none' : 'auto',
            background: 'transparent',
          }}
        />
      </HTMLContainer>
    )
  }
}
