// src/renderer/src/state/sessionStore.ts
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
  lastFocusedAt: number
  lastActivityAt: number
  lastCapturedAt?: number
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
const now = () => Date.now()

const listeners = new Set<() => void>()
const notify = () => { for (const fn of listeners) fn() }

function ensureShapePrefix(id: string): string {
  return id.startsWith('shape:') ? id : `shape:${id}`
}

function empty(): SessionSnapshot {
  return { version: 1, camera: { x: 0, y: 0, z: 1 }, tabs: {} }
}

function load(): SessionSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty()
    const s = JSON.parse(raw) as SessionSnapshot
    if (s?.version === 1 && s.camera && s.tabs) return s
  } catch {}
  return empty()
}

function save(state: SessionSnapshot): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  notify()
}

let S = load()

function upsert(
  rec: Pick<TabSession, 'shapeId'> & Partial<Omit<TabSession, 'shapeId'>>
): TabSession {
  const k = ensureShapePrefix(rec.shapeId)
  const cur = S.tabs[k]
  const merged: TabSession = {
    shapeId: k,
    url: rec.url ?? cur?.url ?? 'about:blank',
    title: rec.title ?? cur?.title,
    x: rec.x ?? cur?.x ?? 0,
    y: rec.y ?? cur?.y ?? 0,
    w: rec.w ?? cur?.w ?? 1200,
    h: rec.h ?? cur?.h ?? 660,
    lastFocusedAt: rec.lastFocusedAt ?? cur?.lastFocusedAt ?? now(),
    lastActivityAt: rec.lastActivityAt ?? cur?.lastActivityAt ?? now(),
    lastCapturedAt: rec.lastCapturedAt ?? cur?.lastCapturedAt,
    realization: rec.realization ?? cur?.realization ?? 'attached',
    thumbPath: rec.thumbPath ?? cur?.thumbPath,
    thumbDataUrl: rec.thumbDataUrl ?? cur?.thumbDataUrl,
  }
  S.tabs[k] = merged
  save(S)
  return merged
}

function get(shapeId: string): TabSession | undefined {
  return S.tabs[ensureShapePrefix(shapeId)]
}

function setCamera(cam: CameraState): void { S.camera = cam; save(S) }
function getCamera(): CameraState { return S.camera }

function setLastFocused(shapeId: string, t = now()): void {
  const r = get(shapeId); if (!r) return
  r.lastFocusedAt = t; save(S)
}
function setLastActivity(shapeId: string, t = now()): void {
  const r = get(shapeId); if (!r) return
  r.lastActivityAt = t; save(S)
}
function setRealization(shapeId: string, realization: Realization): void {
  const r = get(shapeId); if (!r) return
  r.realization = realization; save(S)
}
function setThumbPath(shapeId: string, filePath: string): void {
  const r = get(shapeId); if (!r) return
  r.thumbPath = filePath; r.thumbDataUrl = undefined; r.lastCapturedAt = now(); save(S)
}
function setThumbDataUrl(shapeId: string, dataUrl: string): void {
  const r = get(shapeId); if (!r) return
  r.thumbDataUrl = dataUrl; r.thumbPath = undefined; r.lastCapturedAt = now(); save(S)
}
function setSizeAndPos(shapeId: string, x: number, y: number, w: number, h: number): void {
  const r = get(shapeId); if (!r) return
  r.x = x; r.y = y; r.w = w; r.h = h; save(S)
}
function setUrl(shapeId: string, url: string): void {
  const r = get(shapeId); if (!r) return
  r.url = url; save(S)
}

function markHotN(n: number): void {
  const all = Object.values(S.tabs)
  all.sort((a, b) =>
    Math.max(a.lastActivityAt, a.lastFocusedAt) > Math.max(b.lastActivityAt, b.lastFocusedAt) ? -1 : 1
  )
  const hot = new Set(all.slice(0, Math.max(0, n)).map(t => t.shapeId))
  for (const t of all) t.realization = hot.has(t.shapeId) ? 'attached' : 'frozen'
  save(S)
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export const sessionStore = {
  load: () => S,
  save: () => save(S),
  get,
  upsert,
  setCamera,
  getCamera,
  setLastFocused,
  setLastActivity,
  setRealization,
  setThumbPath,
  setThumbDataUrl,
  setSizeAndPos,
  setUrl,
  markHotN,
  subscribe,
  STORAGE_KEY,
}

export const IDLE_EVICT_MS = 30 * 60 * 1000 // 30 min
