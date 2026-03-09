import { useEffect, useMemo, useRef } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { useLifecycleManager } from './useLifecycleManager'
import type { OverlayAPI } from '../../types/overlay'

type Props = { editorRef: React.RefObject<Editor | null> }
type Bounds = { x: number; y: number; w: number; h: number }
type NavState = { currentUrl: string; canGoBack: boolean; canGoForward: boolean; title: string }
type BrowserTabSnapshot = {
  lifecycle: 'live' | 'frozen' | 'discarded'
  navState: NavState
  isLoading: boolean
  cursor: string
  thumbDataUrl: string | null
}

declare global {
  interface Window {
    overlay: OverlayAPI
    __tabState?: Map<string, 'live' | 'frozen' | 'discarded'>
    __tabThumbs?: Map<string, { url: string; dataUrlWebp: string }>
    __activeTabs?: Set<string>
    __tabRestoreInfo?: Map<string, { currentUrl: string; lifecycle: 'live' | 'frozen' | 'discarded'; thumbPath: string | null }>
    __browserTabSnapshots?: Map<string, BrowserTabSnapshot>
    __browserTabs?: {
      getSnapshot(tabId: string): BrowserTabSnapshot | null
      markActivity(tabId: string): void
      requestLive(shapeId: TLShapeId): Promise<string | null>
      destroyTab(tabId: string): Promise<void>
    }
  }
}

const TAB_ACTIVITY_EVENT = 'paper:tab-activity' as const
const TAB_STATE_EVENT = 'paper:tab-state-changed' as const
const TAB_SYNC_EVENT = 'paper:tab-sync' as const

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

function emitTabSync(tabId: string): void {
  const snapshot = window.__browserTabSnapshots?.get(tabId)
  if (!snapshot) return
  window.dispatchEvent(new CustomEvent(TAB_SYNC_EVENT, { detail: { tabId, snapshot } }))
}

function makeSnapshot(url: string, lifecycle: 'live' | 'frozen' | 'discarded'): BrowserTabSnapshot {
  return {
    lifecycle,
    navState: {
      currentUrl: url,
      canGoBack: false,
      canGoForward: false,
      title: '',
    },
    isLoading: false,
    cursor: 'default',
    thumbDataUrl: null,
  }
}

if (!window.__tabState) window.__tabState = new Map()
if (!window.__tabThumbs) window.__tabThumbs = new Map()
if (!window.__activeTabs) window.__activeTabs = new Set()
if (!window.__tabRestoreInfo) window.__tabRestoreInfo = new Map()
if (!window.__browserTabSnapshots) window.__browserTabSnapshots = new Map()

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

  const patchSnapshot = (
    tabId: string,
    patch: Omit<Partial<BrowserTabSnapshot>, 'navState'> & { navState?: Partial<NavState> },
    fallbackUrl = 'about:blank'
  ): void => {
    const prev =
      window.__browserTabSnapshots?.get(tabId) ??
      makeSnapshot(
        window.__tabRestoreInfo?.get(tabId)?.currentUrl ?? fallbackUrl,
        window.__tabState?.get(tabId) ?? 'discarded'
      )
    const next: BrowserTabSnapshot = {
      ...prev,
      ...patch,
      navState: {
        ...prev.navState,
        ...(patch.navState ?? {}),
      },
    }
    window.__browserTabSnapshots?.set(tabId, next)
    emitTabSync(tabId)
  }

  const syncNavigation = async (tabId: string): Promise<void> => {
    try {
      const res = await window.overlay.getNavigationState({ tabId })
      if (!res.ok) return
      patchSnapshot(tabId, {
        navState: {
          currentUrl: res.currentUrl ?? 'about:blank',
          canGoBack: res.canGoBack ?? false,
          canGoForward: res.canGoForward ?? false,
          title: res.title ?? '',
        },
        isLoading: res.isLoading ?? false,
      }, res.currentUrl)
    } catch { }
  }

  const destroyTab = async (tabId: string): Promise<void> => {
    try {
      await window.overlay.destroy({ tabId })
    } catch { }
    window.__tabState?.delete(tabId)
    window.__tabThumbs?.delete(tabId)
    window.__activeTabs?.delete(tabId)
    window.__tabRestoreInfo?.delete(tabId)
    window.__browserTabSnapshots?.delete(tabId)
    tabToShape.current.delete(tabId)
  }

  const capturePoster = async (tabId: string, url: string): Promise<void> => {
    try {
      const res = await window.overlay.snapshot({ tabId })
      if (!res.ok) return
      window.__tabThumbs?.set(tabId, { url, dataUrlWebp: res.dataUrl })
      patchSnapshot(tabId, { thumbDataUrl: res.dataUrl, navState: { currentUrl: url } }, url)
      const prev = window.__tabRestoreInfo?.get(tabId)
      const saved = await window.overlay.saveThumb({ tabId, url, dataUrlWebp: res.dataUrl })
      window.__tabRestoreInfo?.set(tabId, {
        currentUrl: url,
        lifecycle: prev?.lifecycle ?? 'frozen',
        thumbPath: saved.ok ? saved.thumbPath : prev?.thumbPath ?? null,
      })
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
      } else if (currentState !== 'live') {
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
      patchSnapshot(tabId, { lifecycle: 'live', isLoading: false }, prev?.currentUrl ?? info.url)
      emitTabState(tabId, 'live')
      await syncNavigation(tabId)
    })()

    reviveInFlight.current.set(shapeId, run)
    try {
      await run
    } finally {
      if (reviveInFlight.current.get(shapeId) === run) reviveInFlight.current.delete(shapeId)
    }
  }

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      window.__tabState?.clear()
      window.__tabThumbs?.clear()
      window.__activeTabs?.clear()
      window.__tabRestoreInfo?.clear()
      window.__browserTabSnapshots?.clear()

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
          patchSnapshot(tab.tabId, { lifecycle: tab.lifecycle }, tab.currentUrl)
          if (!tab.thumbPath || !fs.existsSync(tab.thumbPath)) continue
          const dataUrlWebp = `data:image/webp;base64,${fs.readFileSync(tab.thumbPath).toString('base64')}`
          window.__tabThumbs?.set(tab.tabId, { url: tab.currentUrl, dataUrlWebp })
          patchSnapshot(tab.tabId, { thumbDataUrl: dataUrlWebp }, tab.currentUrl)
        }
      } catch { }

      if (cancelled) return

      const editor = editorRef.current
      if (!editor) return

      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type !== 'browser-shape') continue
        const shapeId = shape.id as TLShapeId
        const tabId = String(shapeId)
        const shapeUrl = (shape as { props: { url: string } }).props.url
        const persistedState = window.__tabState?.get(tabId)

        if (persistedState && persistedState !== 'live') {
          tabToShape.current.set(tabId, shapeId)
          patchSnapshot(tabId, { lifecycle: persistedState }, shapeUrl)
          emitTabState(tabId, persistedState)
          continue
        }

        try {
          const hasRestoreInfo = !!window.__tabRestoreInfo?.get(tabId)
          const res = hasRestoreInfo
            ? await window.overlay.createTab({ shapeId: tabId, restore: true })
            : await window.overlay.createTab({ url: shapeUrl, shapeId: tabId })
          if (!res.ok || cancelled) continue
          tabToShape.current.set(res.tabId, shapeId)
          window.__tabState?.set(res.tabId, 'live')
          const prev = window.__tabRestoreInfo?.get(res.tabId)
          window.__tabRestoreInfo?.set(res.tabId, {
            currentUrl: prev?.currentUrl ?? shapeUrl,
            lifecycle: 'live',
            thumbPath: prev?.thumbPath ?? null,
          })
          window.__activeTabs?.add(res.tabId)
          bumpInteractionByShapeId(shapeId)
          patchSnapshot(res.tabId, { lifecycle: 'live', isLoading: false }, prev?.currentUrl ?? shapeUrl)
          emitTabState(res.tabId, 'live')
          await syncNavigation(res.tabId)
        } catch { }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [editorRef])

  useEffect(() => {
    const offUrl = window.overlay.onUrlUpdate(({ tabId, url }) => {
      if (!tabId || !url) return
      const prev = window.__tabRestoreInfo?.get(tabId)
      window.__tabRestoreInfo?.set(tabId, {
        currentUrl: url,
        lifecycle: window.__tabState?.get(tabId) ?? prev?.lifecycle ?? 'live',
        thumbPath: prev?.thumbPath ?? null,
      })
      patchSnapshot(tabId, {
        navState: { currentUrl: url },
        isLoading: true,
      }, url)
      void syncNavigation(tabId)
    })

    const offNav = window.overlay.onNavFinished?.(({ tabId }) => {
      if (!tabId) return
      void syncNavigation(tabId)
    })

    const offNotice = window.overlay.onNotice((notice) => {
      if (notice.kind !== 'cursor') return
      patchSnapshot(notice.tabId, { cursor: notice.cursor || 'default' })
    })

    const bridge = {
      getSnapshot: (tabId: string): BrowserTabSnapshot | null =>
        window.__browserTabSnapshots?.get(tabId) ?? null,
      markActivity: (tabId: string): void => {
        bumpInteractionByTabId(tabId)
        window.dispatchEvent(new CustomEvent(TAB_ACTIVITY_EVENT, { detail: { tabId } }))
      },
      requestLive: async (shapeId: TLShapeId): Promise<string | null> => {
        const info = editorRef.current ? readTabInfoFromShape(editorRef.current, shapeId) : null
        if (!info) return null
        bumpInteractionByShapeId(shapeId)
        await revive(shapeId)
        return window.__tabState?.get(info.tabId) === 'live' ? info.tabId : null
      },
      destroyTab,
    }

    window.__browserTabs = bridge

    return () => {
      offUrl?.()
      offNav?.()
      offNotice?.()
      if (window.__browserTabs === bridge) delete window.__browserTabs
    }
  }, [editorRef])

  const inputs = useMemo(() => ({
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
  }), [editorRef])

  const outputs = useMemo(() => ({
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
          patchSnapshot(tabId, { lifecycle: 'frozen', isLoading: false }, info.url)
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
        patchSnapshot(tabId, { lifecycle: 'discarded', isLoading: false }, info.url)
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
  }), [editorRef])

  const limits = useMemo(() => ({
    hotCapOverview: 8,
    tinyPxFloor: 48_000,
    freezeHiddenMs: 3 * 60_000,
    discardFrozenMs: 12 * 60_000,
  }), [])

  useLifecycleManager(inputs, outputs, limits)

  return null
}
