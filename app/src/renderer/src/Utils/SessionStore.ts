export type Realization = 'attached' | 'frozen'
export type CameraState = { x: number; y: number; z: number }

export type TabSession = {
  shapeId: string
  url: string
  title?: string
  x: number
  y: number
  w: number
  h: number
  lastFocusedAt: number         // LRU by focus/activation
  lastActivityAt: number        // user interaction (pointer/key on the shape)
  lastCapturedAt?: number       // last successful screenshot timestamp
  realization: Realization
  thumbPath?: string
  thumbDataUrl?: string
}

export type SessionSnapshot = {
  version: 1
  camera: CameraState
  tabs: Record<string, TabSession>
}

const STORAGE_KEY = 'canvasBrowserSession.v1'

function ensureShapePrefix(id: string): string {
  return id.startsWith('shape:') ? id : `shape:${id}`
}

function load(): SessionSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const s = JSON.parse(raw) as SessionSnapshot
      if (s?.version === 1 && s.tabs) {
        const migrated: Record<string, TabSession> = {}
        for (const [key, rec] of Object.entries(s.tabs)) {
          const newId = ensureShapePrefix(rec.shapeId ?? key)
          migrated[newId] = {
            ...rec,
            shapeId: newId,
            lastActivityAt: rec.lastActivityAt ?? rec.lastFocusedAt ?? 0,
          }
        }
        return { version: 1, camera: s.camera ?? { x: 0, y: 0, z: 0.6 }, tabs: migrated }
      }
    }
  } catch {}
  return { version: 1, camera: { x: 0, y: 0, z: 0.6 }, tabs: {} }
}

function save(s: SessionSnapshot): void { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) }

function synthThumb(url: string, w: number, h: number): string {
  const W = Math.min(Math.max(Math.floor(w), 128), 1600)
  const H = Math.min(Math.max(Math.floor(h), 96), 1200)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const g = c.getContext('2d'); if (!g) return 'data:image/png;base64,'
  g.fillStyle = '#f1f3f5'; g.fillRect(0, 0, W, H)
  g.fillStyle = '#343a40'; g.font = 'bold 16px system-ui'
  g.fillText((() => { try { return new URL(url).hostname } catch { return 'New Tab' } })(), 16, 24)
  return c.toDataURL('image/png')
}

export class SessionStore {
  private s: SessionSnapshot = load()
  private ready = false
  private readyListeners: Array<() => void> = []

  getCamera(): CameraState { return this.s.camera }
  setCamera(c: CameraState): void { this.s.camera = c }

  isReady(): boolean { return this.ready }
  onReady(fn: () => void): () => void {
    this.readyListeners.push(fn); return () => { this.readyListeners = this.readyListeners.filter(f => f !== fn) }
  }
  markReady(): void {
    if (this.ready) return
    this.ready = true
    const ls = this.readyListeners.slice(); this.readyListeners = []
    ls.forEach((f) => f())
  }

  save(): void { save(this.s) }
  count(): number { return Object.keys(this.s.tabs).length }

  get(): SessionSnapshot
  get(shapeId: string): TabSession | undefined
  get(shapeId?: string): SessionSnapshot | TabSession | undefined {
    return typeof shapeId === 'string' ? this.s.tabs[ensureShapePrefix(shapeId)] : this.s
  }
  getAll(): TabSession[] { return Object.values(this.s.tabs) }

  ensure(shapeId: string, seed: { url: string; w: number; h: number; x: number; y: number; title?: string }): TabSession {
    const sid = ensureShapePrefix(shapeId)
    let t = this.s.tabs[sid]
    if (!t) {
      const now = Date.now()
      t = this.s.tabs[sid] = {
        shapeId: sid,
        url: seed.url,
        title: seed.title,
        x: seed.x, y: seed.y, w: seed.w, h: seed.h,
        lastFocusedAt: now,
        lastActivityAt: now,
        realization: 'attached',
        thumbDataUrl: synthThumb(seed.url, seed.w, seed.h),
      }
    }
    return t
  }

  /** move a record to a new TLDraw id (when TLDraw generated a fresh id) */
  rekey(oldId: string, newId: string): void {
    const from = this.s.tabs[ensureShapePrefix(oldId)]
    if (!from) return
    const toId = ensureShapePrefix(newId)
    delete this.s.tabs[ensureShapePrefix(oldId)]
    this.s.tabs[toId] = { ...from, shapeId: toId }
  }

  focus(shapeId: string): void {
    const t = this.s.tabs[ensureShapePrefix(shapeId)]
    if (t) { const now = Date.now(); t.lastFocusedAt = now; t.lastActivityAt = now }
  }

  bumpActivity(shapeId: string): void {
    const t = this.s.tabs[ensureShapePrefix(shapeId)]
    if (t) t.lastActivityAt = Date.now()
  }

  setRealization(shapeId: string, r: Realization): void {
    const t = this.s.tabs[ensureShapePrefix(shapeId)]; if (t) t.realization = r
  }

  setBounds(shapeId: string, x: number, y: number, w: number, h: number): void {
    const t = this.s.tabs[ensureShapePrefix(shapeId)]; if (t) { t.x = x; t.y = y; t.w = w; t.h = h }
  }
  upsertBounds(shapeId: string, w: number, h: number, x: number, y: number): void { this.setBounds(shapeId, x, y, w, h) }

  setUrlTitle(shapeId: string, url: string, title?: string): void {
    const t = this.s.tabs[ensureShapePrefix(shapeId)]
    if (t) { t.url = url; if (title !== undefined) t.title = title }
  }

  setThumbPath(shapeId: string, filePath: string): void {
  const t = this.s.tabs[ensureShapePrefix(shapeId)]
  if (t) { t.thumbPath = filePath; t.thumbDataUrl = undefined }
}

setThumbDataUrl(shapeId: string, dataUrl: string): void {
  const t = this.s.tabs[ensureShapePrefix(shapeId)]
  if (t) { t.thumbDataUrl = dataUrl; t.thumbPath = undefined }
}

  setLastCaptured(shapeId: string, ts: number): void {
    const t = this.s.tabs[ensureShapePrefix(shapeId)]; if (t) t.lastCapturedAt = ts
  }

  hot(n: number): string[] {
    return this.getAll().sort((a, b) => b.lastFocusedAt - a.lastFocusedAt).slice(0, n).map((t) => t.shapeId)
  }
}

export const sessionStore = new SessionStore()
