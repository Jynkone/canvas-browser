import {
  HTMLContainer,
  Rectangle2d,
  RecordProps,
  ShapeUtil,
  TLBaseShape,
  TLResizeInfo,
  T,
  resizeBox,
  useEditor,
} from 'tldraw'
import React, { useEffect, useRef, useState } from 'react'

export type BrowserShape = TLBaseShape<
  'browser-shape',
  { w: number; h: number; url: string; tabId: string }
>

export class BrowserShapeUtil extends ShapeUtil<BrowserShape> {
  static type = 'browser-shape' as const

  static props: RecordProps<BrowserShape> = {
    w: T.number,
    h: T.number,
    url: T.string,
    tabId: T.string,
  }

  getDefaultProps(): BrowserShape['props'] {
    return { w: 800, h: 600, url: 'https://example.com', tabId: '' }
  }

  canEdit() { return false }
  canResize() { return true }
  isAspectRatioLocked() { return false }

  getGeometry(shape: BrowserShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  onResize(shape: BrowserShape, info: TLResizeInfo<BrowserShape>) {
    return resizeBox(shape, info)
  }

  component(shape: BrowserShape) {
    return <BrowserShapeComponent shape={shape} />
  }

  indicator(shape: BrowserShape) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}

function BrowserShapeComponent({ shape }: { shape: BrowserShape }) {
  const editor = useEditor()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [dpr, setDpr] = useState(1)

  // Create an offscreen tab for this shape
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (shape.props.tabId) { setReady(true); return }
      const id = await window.osr.create(shape.props.url, shape.props.w, shape.props.h)
      if (cancelled) return
      editor.updateShapes([{ id: shape.id, type: shape.type, props: { ...shape.props, tabId: id } }])
      setReady(true)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Draw frames from main
  useEffect(() => {
    if (!ready || !shape.props.tabId) return

    const unsub = window.osr.onFrame((msg) => {
      if (msg.id !== shape.props.tabId) return
      const { width, height } = msg.sz

      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d', { willReadFrequently: false })
      if (!ctx) return

      // Scale backing store with zoom for crisper text
      const zoom = editor.getZoomLevel()
      const nextDpr = Math.min(2, Math.max(1, window.devicePixelRatio * zoom))
      if (nextDpr !== dpr) setDpr(nextDpr)
      const targetW = Math.max(1, Math.round(shape.props.w * nextDpr))
      const targetH = Math.max(1, Math.round(shape.props.h * nextDpr))
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }

      // Convert BGRA Buffer -> RGBA Uint8ClampedArray
      const bgra = new Uint8ClampedArray(msg.pixels.buffer, msg.pixels.byteOffset, msg.pixels.byteLength)
      const rgba = new Uint8ClampedArray(bgra.length)
      for (let i = 0; i < bgra.length; i += 4) {
        rgba[i] = bgra[i + 2]
        rgba[i + 1] = bgra[i + 1]
        rgba[i + 2] = bgra[i]
        rgba[i + 3] = bgra[i + 3]
      }
      const img = new ImageData(rgba, width, height)

      // Draw scaled
      const tmp = document.createElement('canvas')
      tmp.width = width
      tmp.height = height
      const tctx = tmp.getContext('2d')!
      tctx.putImageData(img, 0, 0)

      ctx.save()
      ctx.imageSmoothingEnabled = true
      ctx.clearRect(0, 0, targetW, targetH)
      ctx.drawImage(tmp, 0, 0, targetW, targetH)
      ctx.restore()
    })

    return () => unsub()
  }, [ready, shape.props.tabId, shape.props.w, shape.props.h, editor, dpr])

  // Keep OSR surface sized with the shape
  useEffect(() => {
    if (!ready || !shape.props.tabId) return
    window.osr.resize(shape.props.tabId, Math.round(shape.props.w), Math.round(shape.props.h))
  }, [ready, shape.props.tabId, shape.props.w, shape.props.h])

  // Simple toolbar
  return (
    <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, background: '#111' }}>
      <div style={{ position: 'absolute', left: 8, top: 8, right: 8, height: 36, display: 'flex', gap: 8, zIndex: 10 }}>
        <UrlBar shape={shape} />
      </div>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block' }}
        onPointerDown={(e) => {
          if (!shape.props.tabId) return
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
          const x = Math.max(0, Math.min(shape.props.w - 1, e.clientX - rect.left))
          const y = Math.max(0, Math.min(shape.props.h - 1, e.clientY - rect.top))
          window.osr.input(shape.props.tabId, { type: 'mouseDown', x, y, button: 'left' })
        }}
        onPointerMove={(e) => {
          if (!shape.props.tabId) return
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
          const x = Math.max(0, Math.min(shape.props.w - 1, e.clientX - rect.left))
          const y = Math.max(0, Math.min(shape.props.h - 1, e.clientY - rect.top))
          window.osr.input(shape.props.tabId, { type: 'mouseMove', x, y })
        }}
        onPointerUp={(e) => {
          if (!shape.props.tabId) return
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
          const x = Math.max(0, Math.min(shape.props.w - 1, e.clientX - rect.left))
          const y = Math.max(0, Math.min(shape.props.h - 1, e.clientY - rect.top))
          window.osr.input(shape.props.tabId, { type: 'mouseUp', x, y, button: 'left' })
        }}
        onWheel={(e) => {
          if (!shape.props.tabId) return
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
          const x = Math.max(0, Math.min(shape.props.w - 1, e.clientX - rect.left))
          const y = Math.max(0, Math.min(shape.props.h - 1, e.clientY - rect.top))
          window.osr.input(shape.props.tabId, { type: 'mouseWheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY })
        }}
      />
    </HTMLContainer>
  )
}

function UrlBar({ shape }: { shape: BrowserShape }) {
  const editor = useEditor()
  const [url, setUrl] = useState(shape.props.url)
  const go = async () => {
    if (!shape.props.tabId) return
    editor.updateShapes([{ id: shape.id, type: shape.type, props: { ...shape.props, url } }])
    await window.osr.navigate(shape.props.tabId, url)
  }
  return (
    <>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()}
        placeholder="https://..."
        style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid #333' }}
      />
      <button onClick={go} style={{ padding: '6px 12px', borderRadius: 8 }}>Go</button>
    </>
  )
}
