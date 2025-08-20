import { useEffect, useMemo, useRef } from 'react'
import { Tldraw } from 'tldraw'
import type { Editor } from 'tldraw'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { BrowserShapeUtil } from './Utils/BrowserShapeUtil'
import type { BrowserShape } from './Utils/BrowserShapeUtil'
import WithHotkeys from './Utils/WithHotkeys'
import { useUiChromeManager } from './Utils/useUiChromeManager'
import { sessionStore } from './Utils/SessionStore'

const BROWSER_W = 1200
const BROWSER_H = 660
const ZOOM_HIDE = 0.65
const ZOOM_SHOW = 0.60
const DURATION_MS = 180
const SLIDE_PX = 16

type CreateArg = Parameters<Editor['createShape']>[0]

export default function App() {
  const shapeUtils = useMemo(() => [BrowserShapeUtil], [])
  const assetUrls = useMemo(
    () => getAssetUrls({ baseUrl: import.meta.env.DEV ? '/tldraw-assets' : './tldraw-assets' }),
    []
  )
  const editorRef = useRef<Editor | null>(null)

  useUiChromeManager(editorRef, { DURATION_MS, SLIDE_PX, ZOOM_HIDE, ZOOM_SHOW })

  // Save camera on shutdown
  useEffect(() => {
    const onBeforeUnload = () => {
      const ed = editorRef.current; if (!ed) return
      const c = ed.getCamera()
      sessionStore.setCamera({ x: c.x, y: c.y, z: c.z })
      sessionStore.save()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Tldraw
        shapeUtils={shapeUtils}
        assetUrls={assetUrls}
        hideUi={false}
        onMount={(editor) => {
          window.__tldraw_editor = editor
          editorRef.current = editor

          // Restore camera
          requestAnimationFrame(() => {
            const cam = sessionStore.getCamera()
            const now = editor.getCamera()
            editor.setCamera({ x: cam?.x ?? now.x, y: cam?.y ?? now.y, z: cam?.z ?? 0.6 })
          })

          // Clear any existing browser-shapes (prevents duplication across runs/HMR)
          const existing = editor.getCurrentPageShapes().filter((s) => s.type === 'browser-shape')
          if (existing.length) editor.deleteShapes(existing.map((s) => s.id))

          const stored = sessionStore.getAll()

          if (stored.length === 0) {
            // Default one, attached
            const arg: CreateArg = {
              type: 'browser-shape',
              x: 100,
              y: 100,
              props: { w: BROWSER_W, h: BROWSER_H, url: 'https://google.com', tabId: '' },
            }
            const shape = editor.createShape(arg) as BrowserShape
            sessionStore.ensure(shape.id, { url: 'https://google.com', w: BROWSER_W, h: BROWSER_H, x: 100, y: 100 })
            sessionStore.setRealization(shape.id, 'attached')
            sessionStore.focus(shape.id)
            sessionStore.save()
          } else {
            // Recreate saved shapes WITHOUT forcing id; then rekey session to the new id
            const idMap = new Map<string, string>() // oldId -> newId

            for (const t of stored) {
              const arg: CreateArg = {
                type: 'browser-shape',
                x: t.x,
                y: t.y,
                props: { w: t.w, h: t.h, url: t.url, tabId: '' },
              }
              const created = editor.createShape(arg) as BrowserShape
              idMap.set(t.shapeId, created.id)
              sessionStore.rekey(t.shapeId, created.id)
            }

            // Decide hot-3 by old lastFocusedAt → map to new ids
            const attachNewIds = new Set(
              stored
                .slice()
                .sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)
                .slice(0, 3)
                .map((t) => idMap.get(t.shapeId)!)
            )

            // Mark realizations on new ids
            for (const [ newId] of idMap.entries()) {
              sessionStore.setRealization(newId, attachNewIds.has(newId) ? 'attached' : 'frozen')
            }

            sessionStore.save()
          }

          // Allow shapes to attach views
          sessionStore.markReady()
          editor.focus()
        }}
      >
        <WithHotkeys BROWSER_W={BROWSER_W} BROWSER_H={BROWSER_H} />
      </Tldraw>
    </div>
  )
}
