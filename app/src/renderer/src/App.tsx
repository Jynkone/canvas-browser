import { useMemo, useRef, useCallback } from 'react'
import { Tldraw, useEditor } from 'tldraw'
import { getAssetUrls } from '@tldraw/assets/selfHosted'
import { BrowserShapeUtil } from './BrowserShapeUtil'

function WithHotkeys() {
  const editor = useEditor()
  const lastCursorPos = useRef({ x: 0, y: 0 })

  // Track cursor position
  const updateCursorPos = useCallback((e: MouseEvent) => {
    lastCursorPos.current = { x: e.clientX, y: e.clientY }
  }, [])

  useMemo(() => {
    // Track mouse movement to always know cursor position
    window.addEventListener('mousemove', updateCursorPos)
    
    const onKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey
      if (!isMod || e.key.toLowerCase() !== 't') return
      const ae = document.activeElement as HTMLElement | null
      const tag = (ae?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || ae?.isContentEditable) return
      e.preventDefault()
      
      // Convert screen coordinates to page coordinates
      const cursorInPage = editor.screenToPage({ 
        x: lastCursorPos.current.x, 
        y: lastCursorPos.current.y 
      })
      
      editor.createShape({
        type: 'browser-shape',
        x: cursorInPage.x - 500, // Half width to center on cursor
        y: cursorInPage.y - 330, // Half height to center on cursor
        props: { w: 1000, h: 660, url: 'https://google.com', tabId: '' },
      })
    }
    
    window.addEventListener('keydown', onKeyDown)
    
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousemove', updateCursorPos)
    }
  }, [editor, updateCursorPos])
  
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