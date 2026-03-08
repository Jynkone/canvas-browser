import { useEffect, useMemo, useRef } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { useLifecycleManager } from './useLifecycleManager'
import type { OverlayAPI } from '../../types/overlay'

declare global {
  interface Window {
    overlay: OverlayAPI
    __tabState?: Map<string, 'live' | 'frozen' | 'discarded'>
    __tabThumbs?: Map<string, { url: string; dataUrlWebp: string }>
    __activeTabs?: Set<string>
    __tabRestoreInfo?: Map<string, { currentUrl: string; lifecycle: 'live' | 'frozen' | 'discarded'; thumbPath: string | null }>
    __overlayRestoreReady?: boolean
  }
}

const TAB_ACTIVITY_EVENT = 'paper:tab-activity' as const
const TAB_INTERACT_EVENT = 'paper:tab-interact' as const
const NEW_TAB_EVENT = 'paper:new-tab' as const
const TAB_STATE_EVENT = 'paper:tab-state-changed' as const
const RESTORE_READY_EVENT = 'paper:restore-ready' as const

type Props = { editorRef: React.RefObject<Editor | null> }
type Bounds = { x: number; y: number; w: number; h: number }

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null
}

function getBounds(editor: Editor, id: TLShapeId): Bounds | null {
  const b = editor.getShapePageBounds(id)
  if (!b) return null
  return { x: b.x, y: b.y, w: b.w, h: b.h }
}

function intersect(a: Bounds, b: Bounds): Bounds | null {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const w = x2 - x1
  const h = y2 - y1
  if (w <= 0 || h <= 0) return null
  return { x: x1, y: y1, w, h }
}

function readTabInfoFromShape(editor: Editor, shapeId: TLShapeId): { tabId: string; url: string } | null {
  const raw = editor.getShape(shapeId)
  if (!isObj(raw)) return null
  if ((raw as { type?: unknown }).type !== 'browser-shape') return null
  const props = (raw as { props?: unknown }).props
  if (!isObj(props)) return null
  const url = (props as { url?: unknown }).url
  return { tabId: String(shapeId), url: typeof url === 'string' ? url : 'about:blank' }
}

function emitTabState(tabId: string, state: 'live' | 'frozen' | 'discarded'): void {
  window.dispatchEvent(new CustomEvent(TAB_STATE_EVENT, { detail: { tabId, state } }))
}

if (!window.__tabState) window.__tabState = new Map()
if (!window.__tabThumbs) window.__tabThumbs = new Map()
if (!window.__activeTabs) window.__activeTabs = new Set()
if (!window.__tabRestoreInfo) window.__tabRestoreInfo = new Map()
if (typeof window.__overlayRestoreReady !== 'boolean') window.__overlayRestoreReady = false

export default function LifecycleHost({ editorRef }: Props) {
  const lastInteraction = useRef<Map<TLShapeId, number>>(new Map())
  const tabToShape = useRef(new Map<string, TLShapeId>())
  const reviveInFlight = useRef(new Map<TLShapeId, Promise<void>>())

  const bumpInteractionByShapeId = (shapeId: TLShapeId): void => {
    lastInteraction.current.set(shapeId, performance.now())
  }

  const bumpInteractionByTabId = (tabId: string): void => {
    const shapeId = tabToShape.current.get(tabId)
    if (shapeId) bumpInteractionByShapeId(shapeId)
  }

  const capturePoster = async (tabId: string, url: string): Promise<void> => {
    try {
      const res = await window.overlay.snapshot({ tabId })
      if (!res.ok) return
      window.__tabThumbs?.set(tabId, { url, dataUrlWebp: res.dataUrl })
      const prev = window.__tabRestoreInfo?.get(tabId)
      window.__tabRestoreInfo?.set(tabId, {
        currentUrl: url,
        lifecycle: prev?.lifecycle ?? 'frozen',
        thumbPath: prev?.thumbPath ?? null,
      })
      await window.overlay.saveThumb({ tabId, url, dataUrlWebp: res.dataUrl })
    } catch { }
  }

  const revive = async (shapeId: TLShapeId): Promise<void> => {
    const pending = reviveInFlight.current.get(shapeId)
    if (pending) {
      await pending
      return
    }

    const run = (async () => {
    const editor = editorRef.current
    if (!editor) return
    const info = readTabInfoFromShape(editor, shapeId)
    if (!info) return

    const { tabId } = info
    const currentState = window.__tabState?.get(tabId)

    if (currentState === 'frozen') {
      await window.overlay.thaw({ tabId })
    } else {
      await window.overlay.createTab({ shapeId: tabId, restore: true })
    }

    await window.overlay.show({ tabId })
    window.__activeTabs?.add(tabId)
    window.__tabState?.set(tabId, 'live')
    const prev = window.__tabRestoreInfo?.get(tabId)
    window.__tabRestoreInfo?.set(tabId, {
      currentUrl: prev?.currentUrl ?? info.url,
      lifecycle: 'live',
      thumbPath: prev?.thumbPath ?? null,
    })
    tabToShape.current.set(tabId, shapeId)
    bumpInteractionByShapeId(shapeId)
    emitTabState(tabId, 'live')
    })()

    reviveInFlight.current.set(shapeId, run)
    try {
      await run
    } finally {
      if (reviveInFlight.current.get(shapeId) === run) {
        reviveInFlight.current.delete(shapeId)
      }
    }
  }

  useEffect(() => {
    let cancelled = false

    ; (async () => {
      window.__overlayRestoreReady = false
      window.__tabState?.clear()
      window.__tabThumbs?.clear()
      window.__activeTabs?.clear()
      window.__tabRestoreInfo?.clear()

      try {
        const res = await window.overlay.getPersistedState()
        if (!res.ok || cancelled) return

        const fs = require('node:fs') as typeof import('node:fs')
        for (const tab of res.tabs) {
          window.__tabState?.set(tab.tabId, tab.lifecycle)
          window.__tabRestoreInfo?.set(tab.tabId, {
            currentUrl: tab.currentUrl,
            lifecycle: tab.lifecycle,
            thumbPath: tab.thumbPath,
          })
          if (!tab.thumbPath || !fs.existsSync(tab.thumbPath)) continue
          const dataUrlWebp = `data:image/webp;base64,${fs.readFileSync(tab.thumbPath).toString('base64')}`
          window.__tabThumbs?.set(tab.tabId, {
            url: tab.currentUrl,
            dataUrlWebp,
          })
        }
      } catch { }
      finally {
        if (cancelled) return
        window.__overlayRestoreReady = true
        window.dispatchEvent(new Event(RESTORE_READY_EVENT))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onActivity = (event: Event): void => {
      const detail = (event as CustomEvent<{ tabId: string }>).detail
      const tabId = detail?.tabId
      if (!tabId) return
      bumpInteractionByTabId(tabId)
    }

    const onNewTab = (event: Event): void => {
      const detail = (event as CustomEvent<{ tabId: string; shapeId: TLShapeId }>).detail
      if (!detail?.tabId || !detail?.shapeId) return
      tabToShape.current.set(detail.tabId, detail.shapeId)
      window.__tabState?.set(detail.tabId, 'live')
      const prev = window.__tabRestoreInfo?.get(detail.tabId)
      window.__tabRestoreInfo?.set(detail.tabId, {
        currentUrl: prev?.currentUrl ?? readTabInfoFromShape(editorRef.current!, detail.shapeId)?.url ?? 'about:blank',
        lifecycle: 'live',
        thumbPath: prev?.thumbPath ?? null,
      })
      window.__activeTabs?.add(detail.tabId)
      bumpInteractionByShapeId(detail.shapeId)
      emitTabState(detail.tabId, 'live')
    }

    const onInteract = (event: Event): void => {
      const detail = (event as CustomEvent<{ shapeId: TLShapeId }>).detail
      const shapeId = detail?.shapeId
      if (!shapeId) return
      bumpInteractionByShapeId(shapeId)
      void revive(shapeId)
    }

    window.addEventListener(TAB_ACTIVITY_EVENT, onActivity as EventListener, { capture: true })
    window.addEventListener(TAB_INTERACT_EVENT, onInteract as EventListener, { capture: true })
    window.addEventListener(NEW_TAB_EVENT, onNewTab as EventListener, { capture: true })

    return () => {
      window.removeEventListener(TAB_ACTIVITY_EVENT, onActivity as EventListener, { capture: true } as AddEventListenerOptions)
      window.removeEventListener(TAB_INTERACT_EVENT, onInteract as EventListener, { capture: true } as AddEventListenerOptions)
      window.removeEventListener(NEW_TAB_EVENT, onNewTab as EventListener, { capture: true } as AddEventListenerOptions)
    }
  }, [])

  const inputs = useMemo(() => {
    return {
      getVisibleShapes: () => {
        const editor = editorRef.current
        if (!editor) return []
        const viewport = editor.getViewportPageBounds()
        const viewportBounds: Bounds = {
          x: viewport.minX,
          y: viewport.minY,
          w: viewport.maxX - viewport.minX,
          h: viewport.maxY - viewport.minY,
        }

        const out: Array<{ id: TLShapeId; w: number; h: number; overlap: number }> = []
        for (const shape of editor.getCurrentPageShapes()) {
          if (shape.type !== 'browser-shape') continue
          const id = shape.id as TLShapeId
          const bounds = getBounds(editor, id)
          if (!bounds) continue
          const overlap = intersect(bounds, viewportBounds)
          const frac = overlap ? (overlap.w * overlap.h) / Math.max(1, bounds.w * bounds.h) : 0
          out.push({ id, w: bounds.w, h: bounds.h, overlap: Math.max(0, Math.min(1, frac)) })
        }
        return out
      },
      getCamera: () => {
        const camera = editorRef.current?.getCamera()
        return { x: camera?.x ?? 0, y: camera?.y ?? 0, zoom: camera?.z ?? 1 }
      },
      getTabInfo: (shapeId: TLShapeId) => {
        const editor = editorRef.current
        if (!editor) return null
        return readTabInfoFromShape(editor, shapeId)
      },
      getLifecycleState: (tabId: string) => window.__tabState?.get(tabId),
      now: () => performance.now(),
      getLastInteractionMs: (shapeId: TLShapeId) => lastInteraction.current.get(shapeId),
      hasThumb: (shapeId: TLShapeId) => {
        const editor = editorRef.current
        if (!editor) return false
        const info = readTabInfoFromShape(editor, shapeId)
        if (!info) return false
        return !!window.__tabThumbs?.get(info.tabId)
      },
    }
  }, [editorRef])

  const outputs = useMemo(() => {
    return {
      setLifecycle: (shapeId: TLShapeId, state: 'live' | 'frozen' | 'discarded'): void => {
        const editor = editorRef.current
        if (!editor) return
        const info = readTabInfoFromShape(editor, shapeId)
        if (!info) return

        const { tabId } = info

        if (state === 'live') {
          void revive(shapeId)
          return
        }

        if (state === 'frozen') {
          void (async () => {
            await capturePoster(tabId, info.url)
            await window.overlay.hide({ tabId })
            await window.overlay.freeze({ tabId })
            window.__activeTabs?.delete(tabId)
            window.__tabState?.set(tabId, 'frozen')
            const prev = window.__tabRestoreInfo?.get(tabId)
            window.__tabRestoreInfo?.set(tabId, {
              currentUrl: info.url,
              lifecycle: 'frozen',
              thumbPath: prev?.thumbPath ?? null,
            })
            emitTabState(tabId, 'frozen')
          })()
          return
        }

        void (async () => {
          await capturePoster(tabId, info.url)
          await window.overlay.destroy({ tabId, discard: true })
          window.__activeTabs?.delete(tabId)
          window.__tabState?.set(tabId, 'discarded')
          const prev = window.__tabRestoreInfo?.get(tabId)
          window.__tabRestoreInfo?.set(tabId, {
            currentUrl: info.url,
            lifecycle: 'discarded',
            thumbPath: prev?.thumbPath ?? null,
          })
          emitTabState(tabId, 'discarded')
        })()
      },

      setPlacement: (shapeId: TLShapeId, placement: 'active' | 'background', _needThumb: boolean): void => {
        const editor = editorRef.current
        if (!editor) return
        const info = readTabInfoFromShape(editor, shapeId)
        if (!info) return

        const { tabId } = info
        const state = window.__tabState?.get(tabId) ?? 'live'

        if (placement === 'active' && state === 'live') {
          void window.overlay.show({ tabId })
          window.__activeTabs?.add(tabId)
          return
        }

        void window.overlay.hide({ tabId })
        window.__activeTabs?.delete(tabId)
      },
    }
  }, [editorRef])

  const limits = useMemo(() => ({
    hotCapOverview: 8,
    tinyPxFloor: 48_000,
    freezeHiddenMs: 0.1 * 60_000,
    discardFrozenMs: 0.3 * 60_000,
  }), [])

  useLifecycleManager(inputs, outputs, limits)

  return null
}
