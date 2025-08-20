// src/renderer/src/state/sessionStore.ts
export type Realization = 'attached' | 'frozen'
export type CameraState = { x: number; y: number; z: number }

export type TabSession = {
  shapeId: string
  url: string
  title?: string
  lastFocusedAt: number
  lastActivityAt: number
  lastCapturedAt?: number
  realization: Realization
  thumbPath?: string
  thumbDataUrl?: string
  isInHotRanking?: boolean // NEW: tracks if in top N without changing realization
}

export type SessionSnapshot = {
  version: 1
  camera: CameraState
  tabs: Record<string, TabSession>
}

const STORAGE_KEY = 'canvasBrowserSession.v1'
const SAVE_DEBOUNCE_MS = 500 // Batch saves
const MAX_LISTENERS = 50

// Centralized state
let state: SessionSnapshot = { version: 1, camera: { x: 0, y: 0, z: 1 }, tabs: {} }
let isDirty = false
let saveTimeoutId: number | null = null

// Notification system
const listeners = new Set<() => void>()
const notifyListeners = () => {
  for (const fn of listeners) {
    try { fn() } catch (e) { console.warn('Listener error:', e) }
  }
}

// Validation helpers
const isValidNumber = (n: any): n is number => typeof n === 'number' && Number.isFinite(n)
const isValidString = (s: any): s is string => typeof s === 'string'
const isValidRealization = (r: any): r is Realization => r === 'attached' || r === 'frozen'

const isValidCameraState = (obj: any): obj is CameraState => (
  obj && typeof obj === 'object' &&
  isValidNumber(obj.x) && isValidNumber(obj.y) && isValidNumber(obj.z)
)

const isValidTabSession = (obj: any): obj is TabSession => (
  obj && typeof obj === 'object' &&
  isValidString(obj.shapeId) &&
  isValidString(obj.url) &&
  isValidNumber(obj.lastFocusedAt) && isValidNumber(obj.lastActivityAt) &&
  isValidRealization(obj.realization)
)

const ensureShapePrefix = (id: string): string => {
  if (!isValidString(id)) throw new Error('Invalid shape ID')
  return id.startsWith('shape:') ? id : `shape:${id}`
}

// Persistence layer
function loadFromStorage(): SessionSnapshot {
  try {
    if (typeof localStorage === 'undefined') return state
    
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return state
    
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.version !== 1 || !isValidCameraState(parsed.camera)) {
      console.warn('Invalid session format, using defaults')
      return state
    }
    
    // Validate and clean tabs
    const validTabs: Record<string, TabSession> = {}
    if (parsed.tabs && typeof parsed.tabs === 'object') {
      for (const [key, tab] of Object.entries(parsed.tabs)) {
        if (isValidTabSession(tab)) validTabs[key] = tab
      }
    }
    
    return { version: 1, camera: parsed.camera, tabs: validTabs }
  } catch (error) {
    console.warn('Failed to load session:', error)
    return state
  }
}

function saveToStorage(): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    isDirty = false
    notifyListeners()
  } catch (error) {
    console.error('Failed to save session:', error)
  }
}

function scheduleSave(): void {
  if (!isDirty) return
  
  if (saveTimeoutId !== null) {
    clearTimeout(saveTimeoutId)
  }
  
  saveTimeoutId = window.setTimeout(() => {
    saveToStorage()
    saveTimeoutId = null
  }, SAVE_DEBOUNCE_MS)
}

function markDirty(): void {
  isDirty = true
  scheduleSave()
}

function flushSave(): void {
  if (saveTimeoutId !== null) {
    clearTimeout(saveTimeoutId)
    saveTimeoutId = null
  }
  if (isDirty) saveToStorage()
}

// Initialize
state = loadFromStorage()

// Core operations - batch changes instead of individual saves
function updateTab(shapeId: string, updates: Partial<TabSession>): TabSession {
  const key = ensureShapePrefix(shapeId)
  const existing = state.tabs[key]
  const now = Date.now()
  
  // Create merged session with validation (NO position data)
  const merged: TabSession = {
    shapeId: key,
    url: isValidString(updates.url) ? updates.url : (existing?.url ?? 'about:blank'),
    title: updates.title !== undefined ? updates.title : existing?.title,
    lastFocusedAt: isValidNumber(updates.lastFocusedAt) ? updates.lastFocusedAt : (existing?.lastFocusedAt ?? now),
    lastActivityAt: isValidNumber(updates.lastActivityAt) ? updates.lastActivityAt : (existing?.lastActivityAt ?? now),
    lastCapturedAt: updates.lastCapturedAt !== undefined ? updates.lastCapturedAt : existing?.lastCapturedAt,
    realization: isValidRealization(updates.realization) ? updates.realization : (existing?.realization ?? 'attached'),
    thumbPath: updates.thumbPath !== undefined ? updates.thumbPath : existing?.thumbPath,
    thumbDataUrl: updates.thumbDataUrl !== undefined ? updates.thumbDataUrl : existing?.thumbDataUrl,
    isInHotRanking: updates.isInHotRanking !== undefined ? updates.isInHotRanking : existing?.isInHotRanking,
  }
  
  state.tabs[key] = merged
  markDirty()
  return merged
}

// Public API - simplified without position tracking
export const sessionStore = {
  // Read operations (no side effects)
  get: (shapeId: string): TabSession | undefined => {
    try {
      return state.tabs[ensureShapePrefix(shapeId)]
    } catch {
      return undefined
    }
  },

  getAllTabs: (): TabSession[] => Object.values(state.tabs),
  getTabCount: (): number => Object.keys(state.tabs).length,
  getCamera: (): CameraState => ({ ...state.camera }),
  load: (): SessionSnapshot => ({ ...state, tabs: { ...state.tabs } }),

  // NEW: Get tabs in chronological order with hot/cold separation
  getTabsChronological: (): { hot: TabSession[], cold: TabSession[] } => {
    const all = Object.values(state.tabs)
    all.sort((a, b) => Math.max(b.lastActivityAt, b.lastFocusedAt) - Math.max(a.lastActivityAt, a.lastFocusedAt))
    
    return {
      hot: all.filter(t => t.realization === 'attached'),
      cold: all.filter(t => t.realization === 'frozen')
    }
  },

  // Write operations (batched)
  upsert: (shapeId: string, updates: Partial<TabSession>): TabSession => 
    updateTab(shapeId, { ...updates, shapeId }),

  remove: (shapeId: string): boolean => {
    try {
      const key = ensureShapePrefix(shapeId)
      if (key in state.tabs) {
        delete state.tabs[key]
        markDirty()
        return true
      }
      return false
    } catch {
      return false
    }
  },

  setCamera: (camera: CameraState): void => {
    if (!isValidCameraState(camera)) return
    state.camera = camera
    markDirty()
  },

  // Batch updates for common operations
  updateTabBatch: (shapeId: string, updates: Partial<TabSession>): TabSession => 
    updateTab(shapeId, updates),

  // Convenience methods that use batching (NO position methods)
  trackActivity: (shapeId: string, url?: string): void => {
    const updates: Partial<TabSession> = { lastActivityAt: Date.now() }
    if (url) updates.url = url
    updateTab(shapeId, updates)
  },

  setFocus: (shapeId: string): void => {
    updateTab(shapeId, { lastFocusedAt: Date.now() })
  },

  setRealization: (shapeId: string, realization: Realization): void => {
    if (!isValidRealization(realization)) return
    updateTab(shapeId, { realization })
  },

  setThumb: (shapeId: string, thumb: { path?: string; dataUrl?: string }): void => {
    updateTab(shapeId, {
      thumbPath: thumb.path,
      thumbDataUrl: thumb.dataUrl,
      lastCapturedAt: Date.now()
    })
  },

  // NEW: Just tracks rankings, doesn't change realization (RUNTIME)
  trackHotN: (n: number): void => {
    if (!Number.isInteger(n) || n < 0) return
    
    const all = Object.values(state.tabs)
    all.sort((a, b) => Math.max(b.lastActivityAt, b.lastFocusedAt) - Math.max(a.lastActivityAt, a.lastFocusedAt))
    
    // Just store the ranking, don't change realization
    const hotIds = new Set(all.slice(0, n).map(t => t.shapeId))
    
    // Update ranking metadata without changing realization states
    for (const tab of all) {
      const existingTab = state.tabs[tab.shapeId]
      if (existingTab) {
        existingTab.isInHotRanking = hotIds.has(tab.shapeId)
      }
    }
    
    markDirty()
  },

  // NEW: Actually enforces realization states (STARTUP ONLY)
  enforceHotN: (n: number): void => {
    if (!Number.isInteger(n) || n < 0) return
    
    const all = Object.values(state.tabs)
    all.sort((a, b) => Math.max(b.lastActivityAt, b.lastFocusedAt) - Math.max(a.lastActivityAt, a.lastFocusedAt))
    
    const hot = new Set(all.slice(0, n).map(t => t.shapeId))
    
    // Actually change realization states
    for (const tab of all) {
      const existingTab = state.tabs[tab.shapeId]
      if (existingTab) {
        existingTab.realization = hot.has(tab.shapeId) ? 'attached' : 'frozen'
        existingTab.isInHotRanking = hot.has(tab.shapeId)
      }
    }
    
    markDirty()
  },

  // Control persistence
  save: flushSave,
  
  // Subscription
  subscribe: (fn: () => void): (() => void) => {
    if (typeof fn !== 'function') throw new Error('Subscriber must be a function')
    if (listeners.size >= MAX_LISTENERS) listeners.clear()
    
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  // Cleanup
  cleanup: (): void => {
    flushSave()
    listeners.clear()
    if (saveTimeoutId !== null) {
      clearTimeout(saveTimeoutId)
      saveTimeoutId = null
    }
  },

  STORAGE_KEY,
}

export const IDLE_EVICT_MS = 30 * 60 * 1000

// Auto-cleanup on page unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', sessionStore.cleanup)
  window.addEventListener('unload', sessionStore.cleanup)
}