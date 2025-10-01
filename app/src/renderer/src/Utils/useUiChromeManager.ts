import { useEffect } from 'react'
import type { Editor } from 'tldraw'

type Cfg = { DURATION_MS: number; SLIDE_PX: number; ZOOM_HIDE: number; ZOOM_SHOW: number }

type Pos = 'top' | 'bottom' | 'left' | 'right'
type Target = { el: HTMLElement; pos: Pos }

const EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'

// ensure portals have mounted, then a paint
const raf2 = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })

function setVisible(t: Target, cfg: Cfg, immediate = false) {
  const dur = immediate ? 0 : cfg.DURATION_MS
  const s = t.el.style
  s.willChange = 'transform, opacity'
  s.transition = `transform ${dur}ms ${EASING}, opacity ${dur}ms ${EASING}`
  s.setProperty('transform', 'translateX(0) translateY(0)', 'important')
  s.setProperty('opacity', '1', 'important')
  s.pointerEvents = 'auto'
}

function setHidden(t: Target, cfg: Cfg, immediate = false) {
  const dur = immediate ? 0 : cfg.DURATION_MS
  const d = cfg.SLIDE_PX
  const s = t.el.style
  s.willChange = 'transform, opacity'
  s.transition = `transform ${dur}ms ${EASING}, opacity ${dur}ms ${EASING}`
  const map: Record<Pos, string> = {
    top: `translateY(-${d}px)`,
    bottom: `translateY(${d}px)`,
    left: `translateX(-${d}px)`,
    right: `translateX(${d}px)`,
  }
  s.setProperty('transform', map[t.pos], 'important')
  s.setProperty('opacity', '0', 'important')
  s.pointerEvents = 'none'
}

function collectTargets(): Target[] {
  const pick = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel))
  const uniq = <T,>(xs: T[]) => Array.from(new Set(xs))

  const topCandidates = pick(
    [
            '.tlui-menu-zone',
      '.tlui-buttons__horizontal',
      
      // Specific buttons from DOM
      '[data-testid="main-menu.button"]',
      '.tlui-helper-buttons',
            '[data-testid="tlui-page-menu"]',
      '.tlui-page-menu',
      '[class*="tlui-toolbar-container tlui-buttons__horizontal"]',
      '[class="tlui-button tlui-button__icon"]',


      
      '[data-testid="tlui-top-zone"]',
      '.tlui-top-zone',
      '.tlui-toolbar',
      '.tlui-header',
      '.tlui-main-menu',
      '.tlui-actions-menu',
      '.tlui-quick-actions',
      '[class="tlui-popover"]',
      '.tlui-top-bar',
      '.tlui-menu-bar',
      '[class*="tlui-top"]',
      '[class*="toolbar"]',
      '[class*="tlui-menu"]',

      '[class*="tlui-menu"]',
      '[class*="toolbar"]',


    ].join(',')
  )
  const rightCandidates = pick(
    ['[data-testid="tlui-right-zone"]',  '.tlui-style-panel',  '[class*="tlui-right"]'].join(
      ','
    )
  )

  const out: Target[] = []
  for (const el of uniq(topCandidates)) out.push({ el, pos: 'top' })
  for (const el of uniq(rightCandidates)) out.push({ el, pos: 'right' })
  return out
}

/**
 * Hides TL UI (slide/fade) when zoomed in beyond ZOOM_HIDE and shows it again
 * when zoomed out below ZOOM_SHOW. Returns nothing; use with <Tldraw hideUi={false} />.
 */
export function useUiChromeManager(editorRef: React.RefObject<Editor | null>, cfg: Cfg): void {
  // initial apply after portals mount, then on DOM changes / resize
  useEffect(() => {
    const apply = (immediate = false) => {
      const z = editorRef.current?.getZoomLevel() ?? 1
      const hide = z >= cfg.ZOOM_HIDE
      const targets = collectTargets()
      if (hide) targets.forEach((t) => setHidden(t, cfg, immediate))
      else {
        targets.forEach((t) => setHidden(t, cfg, true))
        void targets[0]?.el.getBoundingClientRect()
        targets.forEach((t) => setVisible(t, cfg, immediate))
      }
    }

    const init = async () => { await raf2(); apply(true) }
    void init()

    const mo = new MutationObserver(() => apply(true))
    mo.observe(document.body, { childList: true, subtree: true })

    const onResize = () => apply(true)
    window.addEventListener('resize', onResize)

    return () => {
      mo.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [cfg, editorRef])

  // hysteresis loop
  useEffect(() => {
    let rafId = 0
    let hidden = false

    const step = () => {
      const z = editorRef.current?.getZoomLevel() ?? 1
      const nextHidden = hidden ? !(z <= cfg.ZOOM_SHOW) : z >= cfg.ZOOM_HIDE
      if (nextHidden !== hidden) {
        hidden = nextHidden
        const targets = collectTargets()
        if (hidden) {
          targets.forEach((t) => setHidden(t, cfg, false))
        } else {
          targets.forEach((t) => setHidden(t, cfg, true))
          void targets[0]?.el.getBoundingClientRect()
          targets.forEach((t) => setVisible(t, cfg, false))
        }
      }
      rafId = requestAnimationFrame(step)
    }

    rafId = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafId)
  }, [editorRef, cfg])
}
