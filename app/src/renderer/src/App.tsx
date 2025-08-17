import { useMemo } from 'react'
import { Tldraw, useEditor } from 'tldraw'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { BrowserShapeUtil } from './BrowserShapeUtil'

function WithHotkeys() {
  const editor = useEditor()
  useMemo(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey
      if (!isMod || e.key.toLowerCase() !== 't') return
      const ae = document.activeElement as HTMLElement | null
      const tag = (ae?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || ae?.isContentEditable) return
      e.preventDefault()
      const center = editor.screenToPage({ x: innerWidth / 2, y: innerHeight / 2 })
      editor.createShape({
        type: 'browser-shape',
        x: center.x - 500,
        y: center.y - 330,
        props: { w: 1000, h: 660, url: 'https://google.com', tabId: '' },
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editor])
  return null
}

export default function App() {
  const shapeUtils = useMemo(() => [BrowserShapeUtil], [])
  const assetUrls = useMemo(
  () => getAssetUrls({ baseUrl: import.meta.env.DEV ? '/tldraw-assets' : './tldraw-assets' }),
  []
)
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Tldraw
        shapeUtils={shapeUtils}
        assetUrls={assetUrls}
        onMount={(editor) => {
          editor.createShape({
            type: 'browser-shape',
            x: 100, y: 100,
            props: { w: 1000, h: 650, url: 'https://google.com', tabId: '' },
          })
        }}
      >
        <WithHotkeys />
      </Tldraw>
    </div>
  )
}
