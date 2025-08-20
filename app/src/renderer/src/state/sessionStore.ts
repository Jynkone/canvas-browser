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
const MAX_LISTENERS = 50
const now = () => Date.now()

// Listener management with cleanup
const listeners = new Set<() => void>()
const notify = () => { 
  for (const fn of listeners) {
    try {
      fn()
    } catch (error) {
      console.warn('Session store listener error:', error)
    }
  }
}

// Save state management to prevent race conditions
let saveInProgress = false
const pendingSave = { current: null as SessionSnapshot | null }

function ensureShapePrefix(id: string): string {
  if (!id || typeof id !== 'string') {
    throw new Error('Invalid shape ID')
  }
  return id.startsWith('shape:') ? id : `shape:${id}`
}

function empty(): SessionSnapshot {
  return { version: 1, camera: { x: 0, y: 0, z: 1 }, tabs: {} }
}

function isValidCameraState(obj: any): obj is CameraState {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.x === 'number' &&
    typeof obj.y === 'number' &&
    typeof obj.z === 'number' &&
    Number.isFinite(obj.x) &&
    Number.isFinite(obj.y) &&
    Number.isFinite(obj.z)
  )
}

function isValidTabSession(obj: any): obj is TabSession {
  return (
    obj &&
    typeof obj === 'object' &&
    typeof obj.shapeId === 'string' &&
    typeof obj.url === 'string' &&
    typeof obj.x === 'number' &&
    typeof obj.y === 'number' &&
    typeof obj.w === 'number' &&
    typeof obj.h === 'number' &&
    typeof obj.lastFocusedAt === 'number' &&
    typeof obj.lastActivityAt === 'number' &&
    (obj.realization === 'attached' || obj.realization === 'frozen') &&
    Number.isFinite(obj.x) &&
    Number.isFinite(obj.y) &&
    Number.isFinite(obj.w) &&
    Number.isFinite(obj.h) &&
    obj.w > 0 &&
    obj.h > 0
  )
}

function isValidSession(obj: any): obj is SessionSnapshot {
  if (!obj || typeof obj !== 'object' || obj.version !== 1) return false
  
  if (!isValidCameraState(obj.camera)) return false
  
  if (!obj.tabs || typeof obj.tabs !== 'object') return false
  
  // Validate all tab sessions
  for (const [key, tab] of Object.entries(obj.tabs)) {
    if (typeof key !== 'string' || !isValidTabSession(tab)) return false
  }
  
  return true
}

function load(): SessionSnapshot {
  try {
    if (typeof localStorage === 'undefined') {
      console.warn('localStorage not available, using memory-only storage')
      return empty()
    }
    
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty()
    
    const parsed = JSON.parse(raw)
    if (isValidSession(parsed)) return parsed
    
    console.warn('Invalid session data found, using empty session')
  } catch (error) {
    console.warn('Failed to load session data:', error)
  }
  return empty()
}

function save(state: SessionSnapshot): void {
  if (saveInProgress) {
    pendingSave.current = state
    return
  }
  
  saveInProgress = true
  
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    }
  } catch (error) {
    console.warn('Failed to save session:', error)
  } finally {
    saveInProgress = false
    
    // Process pending save if any
    if (pendingSave.current) {
      const pending = pendingSave.current
      pendingSave.current = null
      save(pending)
    } else {
      notify()
    }
  }
}

let S = load()

function validateAndCleanupState(): void {
  const validTabs: Record<string, TabSession> = {}
  
  for (const [key, tab] of Object.entries(S.tabs)) {
    if (isValidTabSession(tab)) {
      validTabs[key] = tab
    } else {
      console.warn('Removing invalid tab session:', key, tab)
    }
  }
  
  S.tabs = validTabs
  
  if (!isValidCameraState(S.camera)) {
    console.warn('Invalid camera state, resetting to default')
    S.camera = { x: 0, y: 0, z: 1 }
  }
}

// Run cleanup on startup
validateAndCleanupState()

function upsert(
  rec: Pick<TabSession, 'shapeId'> & Partial<Omit<TabSession, 'shapeId'>>
): TabSession {
  try {
    const k = ensureShapePrefix(rec.shapeId)
    const cur = S.tabs[k]
    
    // Helper function to safely get number with fallback
    const safeNumber = (value: number | undefined, fallback: number): number => {
      return Number.isFinite(value) ? value! : fallback
    }
    
    // Helper function to safely get positive number with fallback
    const safePositiveNumber = (value: number | undefined, fallback: number): number => {
      return Number.isFinite(value) && value! > 0 ? value! : fallback
    }
    
    const merged: TabSession = {
      shapeId: k,
      url: typeof rec.url === 'string' ? rec.url : (cur?.url ?? 'about:blank'),
      title: typeof rec.title === 'string' ? rec.title : cur?.title,
      x: safeNumber(rec.x, cur?.x ?? 0),
      y: safeNumber(rec.y, cur?.y ?? 0),
      w: safePositiveNumber(rec.w, cur?.w ?? 1200),
      h: safePositiveNumber(rec.h, cur?.h ?? 660),
      lastFocusedAt: safeNumber(rec.lastFocusedAt, cur?.lastFocusedAt ?? now()),
      lastActivityAt: safeNumber(rec.lastActivityAt, cur?.lastActivityAt ?? now()),
      lastCapturedAt: Number.isFinite(rec.lastCapturedAt) ? rec.lastCapturedAt : cur?.lastCapturedAt,
      realization: (rec.realization === 'attached' || rec.realization === 'frozen') ? rec.realization : (cur?.realization ?? 'attached'),
      thumbPath: typeof rec.thumbPath === 'string' ? rec.thumbPath : cur?.thumbPath,
      thumbDataUrl: typeof rec.thumbDataUrl === 'string' ? rec.thumbDataUrl : cur?.thumbDataUrl,
    }
    
    S.tabs[k] = merged
    save(S)
    return merged
  } catch (error) {
    console.error('Failed to upsert tab session:', error)
    throw error
  }
}

function get(shapeId: string): TabSession | undefined {
  try {
    return S.tabs[ensureShapePrefix(shapeId)]
  } catch (error) {
    console.warn('Invalid shapeId in get:', shapeId)
    return undefined
  }
}

function remove(shapeId: string): boolean {
  try {
    const k = ensureShapePrefix(shapeId)
    if (k in S.tabs) {
      delete S.tabs[k]
      save(S)
      return true
    }
    return false
  } catch (error) {
    console.warn('Failed to remove tab:', error)
    return false
  }
}

function setCamera(cam: CameraState): void { 
  if (!isValidCameraState(cam)) {
    console.warn('Invalid camera state:', cam)
    return
  }
  S.camera = cam
  save(S) 
}

function getCamera(): CameraState { return { ...S.camera } }

function setLastFocused(shapeId: string, t = now()): void {
  const r = get(shapeId)
  if (!r || !Number.isFinite(t)) return
  r.lastFocusedAt = t
  save(S)
}

function setLastActivity(shapeId: string, t = now()): void {
  const r = get(shapeId)
  if (!r || !Number.isFinite(t)) return
  r.lastActivityAt = t
  save(S)
}

function setRealization(shapeId: string, realization: Realization): void {
  const r = get(shapeId)
  if (!r || (realization !== 'attached' && realization !== 'frozen')) return
  r.realization = realization
  save(S)
}

function setThumbPath(shapeId: string, filePath: string): void {
  const r = get(shapeId)
  if (!r || typeof filePath !== 'string') return
  r.thumbPath = filePath
  r.thumbDataUrl = undefined
  r.lastCapturedAt = now()
  save(S)
}

function setThumbDataUrl(shapeId: string, dataUrl: string): void {
  const r = get(shapeId)
  if (!r || typeof dataUrl !== 'string') return
  r.thumbDataUrl = dataUrl
  r.thumbPath = undefined
  r.lastCapturedAt = now()
  save(S)
}

function setSizeAndPos(shapeId: string, x: number, y: number, w: number, h: number): void {
  const r = get(shapeId)
  if (!r) return
  
  // Validate inputs
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    console.warn('Invalid size/position values:', { x, y, w, h })
    return
  }
  
  if (w <= 0 || h <= 0) {
    console.warn('Invalid dimensions (must be positive):', { w, h })
    return
  }
  
  r.x = x
  r.y = y
  r.w = w
  r.h = h
  save(S)
}

function setUrl(shapeId: string, url: string): void {
  const r = get(shapeId)
  if (!r || typeof url !== 'string') return
  r.url = url
  save(S)
}

function trackUrlInteraction(shapeId: string, url: string): void {
  const r = get(shapeId)
  if (!r || typeof url !== 'string') return
  
  // If URL changed, this counts as a significant interaction
  if (r.url !== url) {
    setUrl(shapeId, url)
    setLastActivity(shapeId)
  }
}

function markHotN(n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    console.warn('Invalid n for markHotN:', n)
    return
  }
  
  const all = Object.values(S.tabs)
  all.sort((a, b) =>
    Math.max(a.lastActivityAt, a.lastFocusedAt) > Math.max(b.lastActivityAt, b.lastFocusedAt) ? -1 : 1
  )
  
  const hot = new Set(all.slice(0, Math.max(0, n)).map(t => t.shapeId))
  
  for (const t of all) {
    t.realization = hot.has(t.shapeId) ? 'attached' : 'frozen'
  }
  
  save(S)
}

function getAllTabs(): TabSession[] {
  return Object.values(S.tabs)
}

function getTabCount(): number {
  return Object.keys(S.tabs).length
}

function subscribe(fn: () => void): () => void {
  if (typeof fn !== 'function') {
    throw new Error('Subscriber must be a function')
  }
  
  if (listeners.size >= MAX_LISTENERS) {
    console.warn(`Too many session store listeners (${listeners.size}), clearing old ones`)
    listeners.clear()
  }
  
  listeners.add(fn)
  return () => { 
    listeners.delete(fn) 
  }
}

// Cleanup function for when the app is closing
function cleanup(): void {
  listeners.clear()
  if (pendingSave.current) {
    save(pendingSave.current)
    pendingSave.current = null
  }
}

export const sessionStore = {
  load: () => ({ ...S, tabs: { ...S.tabs } }), // Return a copy
  save: () => save(S),
  get,
  upsert,
  remove,
  setCamera,
  getCamera,
  setLastFocused,
  setLastActivity,
  setRealization,
  setThumbPath,
  setThumbDataUrl,
  setSizeAndPos,
  setUrl,
  trackUrlInteraction,
  markHotN,
  getAllTabs,
  getTabCount,
  subscribe,
  cleanup,
  STORAGE_KEY,
}

export const IDLE_EVICT_MS = 30 * 60 * 1000 // 30 min