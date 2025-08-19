import { useEffect, useState } from 'react'
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

/* ---------------- inline animation helpers (same as your demo) ---------------- */

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

/* ---------------- DOM targeting (covers portals + the rounded chips) ---------------- */

function collectTargets(): Target[] {
  const pick = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel))
  const uniq = <T,>(xs: T[]) => Array.from(new Set(xs))

  // top bar & wrappers (the rounded grey panel you screenshotted)
  const topCandidates = pick(
    [
      // canonical
      '[data-testid="tlui-top-zone"]',
      '.tlui-top-zone',
      '.tlui-toolbar',
      '.tlui-header',
      '.tlui-main-menu',
      '.tlui-actions-menu',
      '.tlui-quick-actions',
      // variants / wrappers
      '.tlui-top-bar',
      '.tlui-menu-bar',
      '[role="menubar"]',
      // fallbacks
      '[class*="tlui-top"]',
      '[class*="toolbar"]',
    ].join(',')
  )

  // bottom zone + zoom/minimap HUD (portal-mounted in TL)
  const bottomCandidates = pick(
    [
      '[data-testid="tlui-bottom-zone"]',
      '.tlui-bottom-zone',
      '.tlui-navigation-zone',
      '.tlui-navigation-panel',
      '.tlui-page-menu',
      '.tlui-help-menu',
      // zoom & minimap (critical)
      '[data-testid="tlui-zoom-zone"]',
      '.tlui-zoom',
      '.tlui-zoom-zone',
      '.tlui-zoom-menu',
      '[data-testid="tlui-minimap-zone"]',
      '.tlui-minimap',
      '.tlui-minimap-zone',
      // lenient fallbacks
      '[class*="zoom"]',
      '[class*="minimap"]',
    ].join(',')
  )

  const leftCandidates = pick(
    [
      '[data-testid="tlui-left-zone"]',
      '.tlui-left-zone',
      '.tlui-tools',
      '.tlui-tools-dock',
      '[class*="tlui-left"]',
    ].join(',')
  )

  const rightCandidates = pick(
    [
      '[data-testid="tlui-right-zone"]',
      '.tlui-right-zone',
      '.tlui-style-panel',
      '.tlui-inspector',
      '[class*="tlui-right"]',
    ].join(',')
  )

  // For the top bar specifically, animate the visible "panel" container
  const selectPanelContainer = (el: HTMLElement): HTMLElement => {
    const known = el.closest<HTMLElement>(
      '.tlui-toolbar, .tlui-top-zone, [data-testid="tlui-top-zone"], .tlui-menu-bar'
    )
    if (known) return known

    // otherwise walk up and pick first node that looks like the rounded chip
    let cur: HTMLElement | null = el
    for (let i = 0; i < 4 && cur; i++) {
      const cs = getComputedStyle(cur)
      const hasBg =
        cs.backgroundColor &&
        cs.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        cs.backgroundColor !== 'transparent'
      const hasShadow = !!cs.boxShadow && cs.boxShadow !== 'none'
      const rounded = parseFloat(cs.borderRadius || '0') > 0
      if (hasBg || hasShadow || rounded) return cur
      cur = cur.parentElement
    }
    return el
  }

  const out: Target[] = []
  for (const el of uniq(topCandidates)) out.push({ el: selectPanelContainer(el), pos: 'top' })
  for (const el of uniq(bottomCandidates)) out.push({ el, pos: 'bottom' })
  for (const el of uniq(leftCandidates)) out.push({ el, pos: 'left' })
  for (const el of uniq(rightCandidates)) out.push({ el, pos: 'right' })

  if (out.length) return out

  // Geometry fallback (rare): nearest edge for any tlui* node
  const vw = window.innerWidth
  const vh = window.innerHeight
  const EDGE = 140
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('.tlui, [class*="tlui"], [data-testid*="tlui"]')
  )
  for (const el of candidates) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.width > vw * 0.9 && r.height > vh * 0.9) continue
    const nearTop = r.top <= EDGE
    const nearBottom = vh - r.bottom <= EDGE
    const nearLeft = r.left <= EDGE
    const nearRight = vw - r.right <= EDGE
    let pos: Pos
    if (nearTop) pos = 'top'
    else if (nearBottom) pos = 'bottom'
    else if (nearLeft) pos = 'left'
    else if (nearRight) pos = 'right'
    else {
      const dTop = r.top,
        dBottom = vh - r.bottom,
        dLeft = r.left,
        dRight = vw - r.right
      const min = Math.min(dTop, dBottom, dLeft, dRight)
      pos = min === dTop ? 'top' : min === dBottom ? 'bottom' : min === dLeft ? 'left' : 'right'
    }
    out.push({ el: selectPanelContainer(el), pos })
  }
  return out
}

/* ---------------- main hook ---------------- */

export function useUiChromeManager(
  _rootRef: React.RefObject<HTMLElement | null>,
  editorRef: React.RefObject<Editor | null>,
  cfg: Cfg
) {
  // keep TL UI mounted so animations can play (we always return false)
  const [hideUiProp] = useState(false)

  // prime nodes once TL portals are mounted, and when DOM changes
  useEffect(() => {
    const init = async () => {
      await raf2()
      const targets = collectTargets()
      targets.forEach((t) => setVisible(t, cfg, true))
    }
    void init()

    const mo = new MutationObserver(() => {
      const targets = collectTargets()
      targets.forEach((t) => setVisible(t, cfg, true))
    })
    mo.observe(document.body, { childList: true, subtree: true })

    const onResize = () => {
      const targets = collectTargets()
      targets.forEach((t) => setVisible(t, cfg, true))
    }
    window.addEventListener('resize', onResize)

    return () => {
      mo.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [cfg])

  // hysteresis: hide ≥ ZOOM_HIDE, show ≤ ZOOM_SHOW
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
          // force a transition: start hidden immediately, then animate to visible
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

  return hideUiProp
}
