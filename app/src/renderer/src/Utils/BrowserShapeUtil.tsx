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
  Box,
} from 'tldraw'
import { NavigationBar, NAV_BAR_HEIGHT } from '../components/NavigationBar'


export type BrowserShape = TLBaseShape<
  'browser-shape',
  { w: number; h: number; url: string }
>

export const browserTabSuspendRegistry = new Map<string, React.RefObject<boolean>>()

const TAB_ACTIVITY_EVENT = 'paper:tab-activity' as const
const NEW_TAB_EVENT = 'paper:new-tab' as const
const PLACEMENT_EVENT = 'paper:placement-changed' as const


const DRAG_GUTTER = 60 // invisible move hit area (no longer affects visuals/geometry)
const MIN_W = 300
// Geometry is tight now; don't bake gutters into visual min height.
const MIN_H = 225 + NAV_BAR_HEIGHT

type NavState = { currentUrl: string; canGoBack: boolean; canGoForward: boolean; title: string }
// Pause all overlay sync + fit churn for this tab

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
    const suspendTabRef = useRef<boolean>(false);

    type TabActivityDetail = Readonly<{ tabId: string }>;
    const bumpActivity = (): void => {
      const id = tabIdRef.current;
      if (!id) return;
      window.dispatchEvent(
        new CustomEvent<TabActivityDetail>('paper:tab-activity', { detail: { tabId: id } })
      );
    };

    // NEW: clicks in the content area (below the mini-nav) count as “use”
    const onContentPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return; // left click only
      const target = e.target as Element;
      if (target.closest('[data-nav-root="1"]')) return; // nav already bumps
      bumpActivity();
      // don’t stop/bubble-block: TLDraw selection etc. should still work
    };


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

        ; (async () => {
          try {
            const res = await api.createTab({ url: shape.props.url, shapeId: shape.id })
            if (!res.ok || cancelled) return

            const id = res.tabId
            tabIdRef.current = id

            window.dispatchEvent(new CustomEvent<Readonly<{ tabId: string; shapeId: TLShapeId }>>(NEW_TAB_EVENT, {
              detail: { tabId: id, shapeId: shape.id as TLShapeId },
            }))
            window.dispatchEvent(new CustomEvent<Readonly<{ tabId: string }>>(TAB_ACTIVITY_EVENT, {
              detail: { tabId: id },
            }))


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

      const sync = async (): Promise<void> => {
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

      // initial fetch
      void sync()

      // 1) URL changed (clicking links, history.push/replace, redirects that change URL)
      const offUrl = api.onUrlUpdate(({ tabId }: { tabId: string; url?: string }) => {
        if (tabId !== tabIdRef.current) return
        void sync()
        window.dispatchEvent(
          new CustomEvent<Readonly<{ tabId: string }>>(TAB_ACTIVITY_EVENT, { detail: { tabId } })
        )
      })

      // 2) Navigation finished (covers loads/reloads/SPAs that settle without a new URL)
      const offNav = api.onNavFinished?.(({ tabId }: { tabId: string }) => {
        if (tabId !== tabIdRef.current) return
        void sync()
        window.dispatchEvent(
          new CustomEvent<Readonly<{ tabId: string }>>(TAB_ACTIVITY_EVENT, { detail: { tabId } })
        )
      })

      return () => {
        alive = false
        offUrl?.()
        offNav?.()
      }
    }, [api])

    const [liveActive, setLiveActive] = useState<boolean>(false)
    const liveActiveRef = useRef<boolean>(false)

    useEffect(() => {
      const update = () => {
        const id = tabIdRef.current
        if (!id) return
        const life = window.__tabState?.get(id)
        const isActive = window.__activeTabs?.has(id) ?? false
        const isLive = life === 'live' && isActive && !suspendTabRef.current
        setLiveActive(isLive)
        liveActiveRef.current = isLive
      }

      update()
      window.addEventListener(PLACEMENT_EVENT, update)
      window.addEventListener(TAB_ACTIVITY_EVENT, update)
      window.addEventListener(NEW_TAB_EVENT, update)

      return () => {
        window.removeEventListener(PLACEMENT_EVENT, update)
        window.removeEventListener(TAB_ACTIVITY_EVENT, update)
        window.removeEventListener(NEW_TAB_EVENT, update)
      }
    }, [suspendTabRef])

    // Treat typing in the nav bar and clicking its controls as interaction
    // Replace your current "Treat typing in the nav bar..." effect with this:
    useEffect(() => {
      const isInNav = (target: EventTarget | null): boolean =>
        target instanceof Element && !!target.closest('[data-nav-root="1"]')

      const bumpIfNav = (e: Event): void => {
        if (!isInNav(e.target)) return
        const id = tabIdRef.current
        if (!id) return
        window.dispatchEvent(
          new CustomEvent<Readonly<{ tabId: string }>>('paper:tab-activity', { detail: { tabId: id } })
        )

      }

      window.addEventListener('keydown', bumpIfNav, { capture: true })
      window.addEventListener('input', bumpIfNav, { capture: true })
      window.addEventListener('pointerdown', bumpIfNav, { capture: true })

      return () => {
        window.removeEventListener('keydown', bumpIfNav, { capture: true } as AddEventListenerOptions)
        window.removeEventListener('input', bumpIfNav, { capture: true } as AddEventListenerOptions)
        window.removeEventListener('pointerdown', bumpIfNav, { capture: true } as AddEventListenerOptions)
      }
    }, [])

    useEffect(() => {
      return () => {
        const id = tabIdRef.current;
        if (api && id) {
          void api.destroy({ tabId: id }); // <- this hits your ipcMain.handle('overlay:destroy', ...)
        }
      };
    }, [api]);



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
      if (suspendTabRef.current) return;
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

        if (suspendTabRef.current) return;

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
    const BORDER = 3 as const // keep tldraw blue outline visible without shrinking content



    type TabThumb = { dataUrlWebp?: string }

    function SnapshotImage(
      { tabIdRef, liveActive }: {
        tabIdRef: React.RefObject<string | null>
        liveActive: boolean
      }
    ) {
      if (liveActive) return null
      const id = tabIdRef.current
      if (!id) return null

      const rec = window.__tabThumbs?.get(id) as TabThumb | undefined
      const src = rec?.dataUrlWebp ?? null
      if (!src) return null

      return (
        <img
          src={src}
          alt=""
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            // we capture at the display size; don't ask the browser to resample:
            objectFit: 'fill',
            pointerEvents: 'none',
            willChange: 'transform',
            contain: 'paint',
            transform: 'translateZ(0)',
          }}
          decoding="async"
          draggable={false}
        />
      )
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
                const id = tabIdRef.current;
                if (!api || !id) return;
                setIsLoading(true);
                await api.navigate({ tabId: id, url });
                setIsLoading(false);
              }}

              // ⬅️ Back = normal browser back
              onBack={async () => {
                const id = tabIdRef.current;
                if (!api || !id) return;
                if (!navState.canGoBack) return;
                setIsLoading(true);
                await api.goBack({ tabId: id });
                setIsLoading(false);
              }}

              // ➡️ Forward = normal browser forward
              onForward={async () => {
                const id = tabIdRef.current;
                if (!api || !id) return;
                if (!navState.canGoForward) return;
                setIsLoading(true);
                await api.goForward({ tabId: id });
                setIsLoading(false);
              }}

              // 🔁 Reload = real reload
              onReload={async () => {
                const id = tabIdRef.current;
                if (!api || !id) return;
                setIsLoading(true);
                // if your preload has api.reload:
                if (typeof api.reload === 'function') {
                  await api.reload({ tabId: id });
                } else {
                  // fallback: just navigate to current url
                  await api.navigate({ tabId: id, url: navState.currentUrl });
                }
                setIsLoading(false);
              }}

              fitMode={fitMode}
              onToggleFit={onToggleFit}
            />
          </div>

          {/* Content area (below navbar) */}
          <div
            onPointerDown={onContentPointerDown}
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

            <SnapshotImage tabIdRef={tabIdRef} liveActive={liveActive} />

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
