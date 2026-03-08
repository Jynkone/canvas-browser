const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron')

app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('force_high_performance_gpu')
app.commandLine.appendSwitch('use-cmd-decoder', 'passthrough')
app.commandLine.appendSwitch('enable-features', 'NativeGpuMemoryBuffers,D3D11SharedImages,SharedImageVideo,UseSkiaRenderer')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
// Prevents Windows from causing CPU spikes when calculating hidden window occlusion
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const SITES = [
    { url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', title: 'YouTube — lofi hip hop' },
    { url: 'https://www.youtube.com/watch?v=5qap5aO4i9A', title: 'YouTube — lofi beats' },
    { url: 'https://www.youtube.com/watch?v=DWcJFNfaw9c', title: 'YouTube — nature sounds' },
    { url: 'https://news.ycombinator.com', title: 'Hacker News' },
    { url: 'https://github.com/trending', title: 'GitHub Trending' },
    { url: 'https://en.wikipedia.org/wiki/Main_Page', title: 'Wikipedia' },
    { url: 'https://www.figma.com/community/file/768538007274905302', title: 'Figma Community File' },
    { url: 'https://app.asana.com/-/login', title: 'Asana' },
    { url: 'https://www.reddit.com/r/programming', title: 'Reddit Programming' },
    { url: 'https://stackoverflow.com/questions', title: 'Stack Overflow' },
    { url: 'https://developer.mozilla.org', title: 'MDN Web Docs' },
    { url: 'https://caniuse.com', title: 'Can I Use' },
    { url: 'https://www.npmjs.com', title: 'npm' },
    { url: 'https://tailwindcss.com', title: 'Tailwind CSS' },
    { url: 'https://vitejs.dev', title: 'Vite' },
    { url: 'https://codepen.io/trending', title: 'CodePen Trending' },
    { url: 'https://www.producthunt.com', title: 'Product Hunt' },
    { url: 'https://dribbble.com', title: 'Dribbble' },
    { url: 'https://lobste.rs', title: 'Lobsters' },
    { url: 'https://www.bbc.com/news', title: 'BBC News' },
    { url: 'https://www.theverge.com', title: 'The Verge' },
    { url: 'https://techcrunch.com', title: 'TechCrunch' },
    { url: 'https://www.wired.com', title: 'Wired' },
    { url: 'https://www.smashingmagazine.com', title: 'Smashing Magazine' },
    { url: 'https://css-tricks.com', title: 'CSS Tricks' },
    { url: 'https://www.typescriptlang.org', title: 'TypeScript' },
    { url: 'https://react.dev', title: 'React' },
    { url: 'https://vuejs.org', title: 'Vue.js' },
    { url: 'https://svelte.dev', title: 'Svelte' },
    { url: 'https://nextjs.org', title: 'Next.js' },
    { url: 'https://supabase.com', title: 'Supabase' },
    { url: 'https://vercel.com', title: 'Vercel' },
    { url: 'https://railway.app', title: 'Railway' },
    { url: 'https://www.cloudflare.com', title: 'Cloudflare' },
    { url: 'https://linear.app', title: 'Linear' },
    { url: 'https://www.notion.so', title: 'Notion' },
    { url: 'https://www.figma.com', title: 'Figma' },
    { url: 'https://storybook.js.org', title: 'Storybook' },
    { url: 'https://turbo.build', title: 'Turborepo' },
    { url: 'https://bun.sh', title: 'Bun' },
    { url: 'https://deno.com', title: 'Deno' },
    { url: 'https://astro.build', title: 'Astro' },
    { url: 'https://remix.run', title: 'Remix' },
    { url: 'https://trpc.io', title: 'tRPC' },
    { url: 'https://zod.dev', title: 'Zod' },
    { url: 'https://www.prisma.io', title: 'Prisma' },
    { url: 'https://pnpm.io', title: 'pnpm' },
    { url: 'https://esbuild.github.io', title: 'esbuild' },
    { url: 'https://vitest.dev', title: 'Vitest' },
    { url: 'https://playwright.dev', title: 'Playwright' },
]

const RENDERER_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Canvas Browser — Stress Test</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&display=swap');
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #0a0a0f; --surface: #13131a; --border: #1e1e2e;
    --accent: #7c6aff; --text: #e0e0f0; --muted: #4a4a6a;
    --card-shadow: 0 8px 40px rgba(0,0,0,0.6);
  }
  html, body { width: 100%; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font-family: 'DM Mono', monospace; cursor: default; user-select: none; }
  body::before { content: ''; position: fixed; inset: 0; background-image: linear-gradient(rgba(124,106,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(124,106,255,0.03) 1px, transparent 1px); background-size: 40px 40px; pointer-events: none; z-index: 0; }
  #hud { position: fixed; top: 0; left: 0; right: 0; height: 44px; background: rgba(10,10,15,0.92); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 16px; gap: 16px; z-index: 1000; }
  #hud-title { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 14px; color: var(--accent); letter-spacing: 0.05em; }
  #hud-sep { width: 1px; height: 20px; background: var(--border); }
  #hud-stats { font-size: 11px; color: var(--muted); }
  #hud-stats span { color: var(--text); }
  #hud-right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .hud-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); font-family: 'DM Mono', monospace; font-size: 11px; padding: 4px 10px; border-radius: 4px; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .hud-btn:hover { border-color: var(--accent); background: rgba(124,106,255,0.1); }
  #zoom-level { font-size: 11px; color: var(--muted); min-width: 44px; text-align: center; }
  #viewport { position: fixed; top: 44px; left: 0; right: 0; bottom: 0; overflow: hidden; z-index: 1; }
  #world { position: absolute; width: 6000px; height: 4000px; transform-origin: 0 0; will-change: transform; }
  .tab-card { position: absolute; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; overflow: hidden; box-shadow: var(--card-shadow); cursor: grab; will-change: transform; display: flex; flex-direction: column; transition: border-color 0.2s; }
  .tab-card:hover { border-color: var(--accent); box-shadow: 0 8px 40px rgba(124,106,255,0.15), var(--card-shadow); }
  .tab-card.dragging { cursor: grabbing; border-color: var(--accent); z-index: 100 !important; }
  .tab-card.resizing { cursor: nwse-resize; border-color: var(--accent); z-index: 100 !important; }
  .tab-titlebar { height: 38px; background: #1e1e1e; border-bottom: 1px solid rgba(255,255,255,0.07); display: flex; align-items: center; padding: 0 10px; gap: 8px; flex-shrink: 0; border-radius: 16px 16px 0 0; }
  .tab-title { font-size: 10px; color: rgba(255,255,255,0.45); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab-fps { font-size: 9px; color: var(--muted); min-width: 38px; text-align: right; flex-shrink: 0; }
  .tab-fps.active { color: #28c840; }
  .tab-canvas-wrap { position: relative; overflow: hidden; flex: 1; background: #fff; }
  .tab-canvas-wrap canvas { display: block; width: 100%; height: 100%; }
  .tab-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; background: rgba(10,10,15,0.7); color: var(--muted); font-size: 11px; pointer-events: none; transition: opacity 0.3s; }
  .tab-overlay.hidden { opacity: 0; }
  .tab-spinner { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .resize-handle { position: absolute; bottom: 0; right: 0; width: 18px; height: 18px; cursor: nwse-resize; z-index: 10; background: linear-gradient(135deg, transparent 50%, var(--accent) 50%); opacity: 0.3; border-radius: 0 0 16px 0; transition: opacity 0.15s; }
  .tab-card:hover .resize-handle { opacity: 0.7; }
  #minimap { position: fixed; bottom: 16px; right: 16px; width: 160px; height: 100px; background: rgba(10,10,15,0.9); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; z-index: 1000; }
  #minimap-viewport { position: absolute; border: 1px solid var(--accent); background: rgba(124,106,255,0.1); pointer-events: none; }
  .minimap-tab { position: absolute; background: var(--accent); opacity: 0.4; border-radius: 1px; }
  #instructions { position: fixed; bottom: 16px; left: 16px; font-size: 10px; color: var(--muted); line-height: 1.8; z-index: 1000; }
  #instructions kbd { background: var(--surface); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px; font-size: 9px; color: var(--text); }
</style>
</head>
<body>
<div id="hud">
  <div id="hud-title">CANVAS BROWSER</div>
  <div id="hud-sep"></div>
  <div id="hud-stats">tabs: <span id="stat-tabs">0</span> &nbsp; active: <span id="stat-active">0</span> &nbsp; total fps: <span id="stat-fps">0</span></div>
  <div id="hud-right">
    <button class="hud-btn" id="btn-fit">fit all</button>
    <button class="hud-btn" id="btn-reset">reset view</button>
    <div id="zoom-level">100%</div>
  </div>
</div>
<div id="viewport"><div id="world"></div></div>
<div id="minimap"><div id="minimap-viewport"></div></div>
<div id="instructions"><kbd>scroll</kbd> zoom &nbsp; <kbd>drag</kbd> pan &nbsp; <kbd>drag card</kbd> move &nbsp; <kbd>drag ◢</kbd> resize</div>

<script>
const { sharedTexture, ipcRenderer } = require('electron')
const world = document.getElementById('world')
const viewport = document.getElementById('viewport')
const WORLD_W = 12000, WORLD_H = 8000
// OSR always renders at fixed 1920x1080. Zoom is pure CSS — never touches OSR.
// Physical card resize instantly calls setContentSize to reflow content.
let camX = 0, camY = 0, zoom = 1
let isPanning = false, panStart = null
const tabs = new Map()

function applyCamera() {
  world.style.transform = \`translate(\${-camX * zoom}px, \${-camY * zoom}px) scale(\${zoom})\`
  document.getElementById('zoom-level').textContent = Math.round(zoom * 100) + '%'
  updateMinimap()
}
function clampCamera() {
  const vw = viewport.clientWidth, vh = viewport.clientHeight
  camX = Math.max(0, Math.min(camX, Math.max(0, WORLD_W - vw / zoom)))
  camY = Math.max(0, Math.min(camY, Math.max(0, WORLD_H - vh / zoom)))
}

let zoomSettleTimer = null
viewport.addEventListener('wheel', e => {
  e.preventDefault()
  const rect = viewport.getBoundingClientRect()
  const mx = e.clientX - rect.left, my = e.clientY - rect.top
  const wx = camX + mx / zoom, wy = camY + my / zoom
  zoom = Math.max(0.1, Math.min(3, zoom * (1 - e.deltaY * 0.001)))
  camX = wx - mx / zoom; camY = wy - my / zoom
  clampCamera(); applyCamera()
  if (zoomSettleTimer) clearTimeout(zoomSettleTimer)
  zoomSettleTimer = setTimeout(() => { zoomSettleTimer = null; notifyVisibleTabs() }, 400)
}, { passive: false })

viewport.addEventListener('mousedown', e => {
  if (e.target !== viewport && e.target !== world) return
  isPanning = true
  panStart = { x: e.clientX, y: e.clientY, camX, camY }
  viewport.style.cursor = 'grabbing'
})
window.addEventListener('mousemove', e => {
  if (!isPanning) return
  camX = panStart.camX - (e.clientX - panStart.x) / zoom
  camY = panStart.camY - (e.clientY - panStart.y) / zoom
  clampCamera(); applyCamera()
})
window.addEventListener('mouseup', () => {
  if (isPanning) { isPanning = false; viewport.style.cursor = 'default'; notifyVisibleTabs() }
})

function createTabCard(id, url, title, x, y, w, h) {
  const card = document.createElement('div')
  card.className = 'tab-card'
  card.style.cssText = \`left:\${x}px; top:\${y}px; width:\${w}px; height:\${h}px;\`
  card.innerHTML = \`
    <div class="tab-titlebar">
      <div class="tab-title">\${title}</div>
      <div class="tab-fps" id="fps-\${id}">-- fps</div>
    </div>
    <div class="tab-canvas-wrap">
      <canvas id="canvas-\${id}"></canvas>
      <div class="tab-overlay" id="overlay-\${id}"><div class="tab-spinner"></div><div>loading</div></div>
    </div>
    <div class="resize-handle" id="resize-\${id}"></div>
  \`
  world.appendChild(card)

  // ── Drag to move ────────────────────────────────────────────────────────────
  let dragging = false, dStart = null
  card.querySelector('.tab-titlebar').addEventListener('mousedown', e => {
    e.stopPropagation()
    dragging = true; dStart = { x: e.clientX, y: e.clientY, cx: x, cy: y }
    card.classList.add('dragging'); card.style.zIndex = 50
  })
  window.addEventListener('mousemove', e => {
    if (!dragging) return
    x = dStart.cx + (e.clientX - dStart.x) / zoom
    y = dStart.cy + (e.clientY - dStart.y) / zoom
    card.style.left = x + 'px'; card.style.top = y + 'px'
    const t = tabs.get(id); if (t) { t.x = x; t.y = y }
    updateMinimap()
  })
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; card.classList.remove('dragging'); card.style.zIndex = '' }
  })

  const canvas = card.querySelector(\`#canvas-\${id}\`)
  
  // OPTIMIZATION: desynchronized:true bypasses the DOM compositor for near-zero CPU blitting
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  
  const fpsEl = card.querySelector(\`#fps-\${id}\`)
  const overlay = card.querySelector(\`#overlay-\${id}\`)
  tabs.set(id, { card, canvas, ctx, fpsEl, overlay, frameCount: 0, lastFps: 0, lastFpsTime: Date.now(), x, y, w, h })
  updateStats()

  // ── Drag to resize ──────────────────────────────────────────────────────────
  let resizing = false, rStart = null
  card.querySelector(\`#resize-\${id}\`).addEventListener('mousedown', e => {
    e.stopPropagation()
    resizing = true
    rStart = { x: e.clientX, y: e.clientY, w, h }
    card.classList.add('resizing'); card.style.zIndex = 50
  })
  window.addEventListener('mousemove', e => {
    if (!resizing) return
    w = Math.max(300, rStart.w + (e.clientX - rStart.x) / zoom)
    h = Math.max(300, rStart.h + (e.clientY - rStart.y) / zoom)
    card.style.width = w + 'px'
    card.style.height = h + 'px'
    const t = tabs.get(id); if (t) { t.w = w; t.h = h }
    updateMinimap()
    // Physical resize = instant reflow to card dimensions. No debounce.
    ipcRenderer.send('resize-tabs', [{ id, visible: true, osrW: Math.round(w), osrH: Math.max(240, Math.round(h - 38)), frameInterval: 33 }])
  })
  window.addEventListener('mouseup', () => {
    if (resizing) { resizing = false; card.classList.remove('resizing'); card.style.zIndex = '' }
  })

  // ── Click & scroll forwarding ───────────────────────────────────────────────
  const canvasWrap = card.querySelector('.tab-canvas-wrap')
  canvasWrap.addEventListener('mousedown', e => {
    if (dragging || resizing) return
    e.stopPropagation()
    const rect = canvasWrap.getBoundingClientRect()
    const osrX = Math.round((e.clientX - rect.left) / rect.width  * canvas.width)
    const osrY = Math.round((e.clientY - rect.top)  / rect.height * canvas.height)
    ipcRenderer.send('tab-input', { id, type: 'mouseDown', x: osrX, y: osrY, button: 'left', clickCount: 1 })
  })
  canvasWrap.addEventListener('mouseup', e => {
    if (dragging || resizing) return
    e.stopPropagation()
    const rect = canvasWrap.getBoundingClientRect()
    const osrX = Math.round((e.clientX - rect.left) / rect.width  * canvas.width)
    const osrY = Math.round((e.clientY - rect.top)  / rect.height * canvas.height)
    ipcRenderer.send('tab-input', { id, type: 'mouseUp', x: osrX, y: osrY, button: 'left', clickCount: 1 })
  })
  canvasWrap.addEventListener('wheel', e => {
    e.stopPropagation()
    const rect = canvasWrap.getBoundingClientRect()
    const osrX = Math.round((e.clientX - rect.left) / rect.width  * canvas.width)
    const osrY = Math.round((e.clientY - rect.top)  / rect.height * canvas.height)
    ipcRenderer.send('tab-input', { id, type: 'mouseWheel', x: osrX, y: osrY, deltaX: 0, deltaY: -e.deltaY, wheelTicksX: 0, wheelTicksY: -e.deltaY / 100 })
  }, { passive: false })
}

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, tabId) => {
  const t = tabs.get(tabId)
  if (!t) { importedSharedTexture.release(); return }
  try {
    const frame = importedSharedTexture.getVideoFrame()
    if (t.frameCount === 0) t.overlay.classList.add('hidden')
    t.frameCount++
    const now = Date.now()
    if (now - t.lastFpsTime >= 1000) {
      t.lastFps = t.frameCount; t.frameCount = 0; t.lastFpsTime = now
      t.fpsEl.textContent = t.lastFps + ' fps'
      t.fpsEl.className = 'tab-fps' + (t.lastFps > 0 ? ' active' : '')
      updateStats()
    }
    if (t.canvas.width !== frame.displayWidth || t.canvas.height !== frame.displayHeight) {
      t.canvas.width = frame.displayWidth; t.canvas.height = frame.displayHeight
    }
    // This is hardware-accelerated via Skia
    t.ctx.drawImage(frame, 0, 0)
    frame.close()
  } catch (e) {
    console.error('[renderer] frame error tab', tabId, e.message)
  } finally {
    importedSharedTexture.release()
  }
})

ipcRenderer.on('tab-created', (_e, { id, url, title, x, y, w, h }) => {
  createTabCard(id, url, title, x, y, w, h)
  notifyVisibleTabs()
})

function updateStats() {
  document.getElementById('stat-tabs').textContent = tabs.size
  let totalFps = 0, active = 0
  tabs.forEach(t => { if (t.lastFps > 0) { active++; totalFps += t.lastFps } })
  document.getElementById('stat-active').textContent = active
  document.getElementById('stat-fps').textContent = totalFps
}

const minimap = document.getElementById('minimap')
const minimapVP = document.getElementById('minimap-viewport')
const MM_W = 160, MM_H = 100
function updateMinimap() {
  const sx = MM_W / WORLD_W, sy = MM_H / WORLD_H
  minimap.querySelectorAll('.minimap-tab').forEach(el => el.remove())
  tabs.forEach(t => {
    const dot = document.createElement('div')
    dot.className = 'minimap-tab'
    dot.style.cssText = \`left:\${t.x*sx}px;top:\${t.y*sy}px;width:\${t.w*sx}px;height:\${t.h*sy}px;\`
    minimap.appendChild(dot)
  })
  const vw = viewport.clientWidth / zoom, vh = viewport.clientHeight / zoom
  minimapVP.style.cssText = \`left:\${camX*sx}px;top:\${camY*sy}px;width:\${Math.min(vw*sx,MM_W)}px;height:\${Math.min(vh*sy,MM_H)}px;\`
}

function notifyVisibleTabs() {
  const vw = viewport.clientWidth, vh = viewport.clientHeight
  const updates = []
  tabs.forEach((t, id) => {
    const sx = (t.x - camX) * zoom, sy = (t.y - camY) * zoom
    const sw = t.w * zoom, sh = t.h * zoom
    const visible = sx < vw && sy < vh && sx + sw > 0 && sy + sh > 0
    if (visible) {
      updates.push({ id, visible: true, osrW: 1920, osrH: 1080, frameInterval: 33 })
    } else {
      // OPTIMIZATION: Dropped frameInterval from 100 to 1000 to severely throttle background IPC spam
      updates.push({ id, visible: false, osrW: 0, osrH: 0, frameInterval: 1000 })
    }
  })
  ipcRenderer.send('resize-tabs', updates)
}

document.getElementById('btn-fit').addEventListener('click', () => {
  if (!tabs.size) return
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  tabs.forEach(t => { minX=Math.min(minX,t.x); minY=Math.min(minY,t.y); maxX=Math.max(maxX,t.x+t.w); maxY=Math.max(maxY,t.y+t.h) })
  const pad = 60
  zoom = Math.min(viewport.clientWidth/(maxX-minX+pad*2), viewport.clientHeight/(maxY-minY+pad*2), 1)
  camX = minX - pad; camY = minY - pad
  clampCamera(); applyCamera(); notifyVisibleTabs()
})
document.getElementById('btn-reset').addEventListener('click', () => {
  camX=0; camY=0; zoom=1; applyCamera(); notifyVisibleTabs()
})
applyCamera()
</script>
</body>
</html>`

// ─── Main process ─────────────────────────────────────────────────────────────
const osrWindows = new Map()
let mainWin = null
let nextId = 0

function createOSR(id, url) {
    const osr = new BrowserWindow({
        show: false,
        width: 1920, height: 1080,
        webPreferences: {
            offscreen: { useSharedTexture: true },
            backgroundThrottling: false,
            sandbox: false,
            deviceScaleFactor: 1,
        }
    })

    osr.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    osr.webContents.startPainting()
    osr.webContents.setFrameRate(30)

    // OPTIMIZATION: Mute audio immediately so 50 tabs don't destroy the Windows audio mixer
    osr.webContents.setAudioMuted(true)

    osr.webContents.on('paint', async (e) => {
        const texture = e.texture
        if (!texture) return
        if (!mainWin || mainWin.isDestroyed()) { texture.release(); return }
        const entry = osrWindows.get(id)
        if (!entry || !entry.visible) { texture.release(); return }

        const imported = sharedTexture.importSharedTexture({
            textureInfo: texture.textureInfo,
            allReferencesReleased: () => texture.release()
        })

        await sharedTexture.sendSharedTexture({
            frame: mainWin.webContents.mainFrame,
            importedSharedTexture: imported
        }, id).catch(() => { })

        imported.release()
    })

    osr.webContents.loadURL(url).catch(console.error)
    osr.webContents.on('did-finish-load', () => {
        osr.webContents.setZoomFactor(1.0)
        osr.webContents.setZoomLevel(0)
    })
    osrWindows.set(id, { osr, url, visible: true, frameInterval: 33, currentW: 1920, currentH: 1080 })
}

ipcMain.on('tab-input', (_e, { id, type, x, y, button, clickCount, deltaX, deltaY, wheelTicksX, wheelTicksY }) => {
    const entry = osrWindows.get(id)
    if (!entry || !entry.visible) return
    const event = { type, x, y }
    if (button) { event.button = button; event.clickCount = clickCount }
    if (type === 'mouseWheel') { event.deltaX = deltaX; event.deltaY = deltaY; event.wheelTicksX = wheelTicksX; event.wheelTicksY = wheelTicksY; event.canScroll = true }
    entry.osr.webContents.sendInputEvent(event)
})

ipcMain.on('resize-tabs', (_e, updates) => {
    updates.forEach(({ id, visible, osrW, osrH, frameInterval }) => {
        const entry = osrWindows.get(id)
        if (!entry) return
        entry.visible = visible
        if (visible) {
            entry.osr.webContents.startPainting()
            entry.frameInterval = frameInterval || 33
            if (osrW !== entry.currentW || osrH !== entry.currentH) {
                entry.currentW = osrW
                entry.currentH = osrH
                try { entry.osr.setContentSize(osrW, osrH) } catch (e) { }
            }
        } else {
            entry.osr.webContents.stopPainting()
        }
    })
})

app.whenReady().then(() => {
    mainWin = new BrowserWindow({
        width: 1440, height: 900,
        backgroundColor: '#0a0a0f',
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    })

    mainWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(RENDERER_HTML))

    mainWin.webContents.once('did-finish-load', () => {
        const cols = 5, cardW = 1024, cardH = 640
        const gapX = 48, gapY = 48, startX = 60, startY = 60

        SITES.forEach((site, i) => {
            const col = i % cols, row = Math.floor(i / cols)
            const x = startX + col * (cardW + gapX)
            const y = startY + row * (cardH + gapY)
            const id = nextId++
            mainWin.webContents.send('tab-created', { id, url: site.url, title: site.title, x, y, w: cardW, h: cardH })
            setTimeout(() => createOSR(id, site.url), i * 150)
        })
    })
})

app.on('window-all-closed', () => {
    osrWindows.forEach(({ osr }) => { try { osr.destroy() } catch (e) { } })
    app.quit()
})