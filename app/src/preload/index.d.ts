// renderer/src/preload/index.d.ts (or similar)

import type { OverlayAPI } from './overlay' // ← adjust path if needed

export {}

declare global {
  interface Window {
    overlay: OverlayAPI
    electron: {
      process: {
        versions: {
          node: string
          chrome: string
          electron: string
        }
      }
    }
  }
}
