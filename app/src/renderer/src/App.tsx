import { useMemo } from 'react'
import { Tldraw } from 'tldraw'
import { BrowserShapeUtil } from './BrowserShapeUtil'

export default function App() {
  const shapeUtils = useMemo(() => [BrowserShapeUtil], [])

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Tldraw
        shapeUtils={shapeUtils}
        onMount={(editor) => {
          editor.createShape({
            type: 'browser-shape',
            x: 100,
            y: 100,
            props: { w: 1000, h: 650, url: 'https://example.com', tabId: '' },
          })
        }}
      />
    </div>
  )
}
