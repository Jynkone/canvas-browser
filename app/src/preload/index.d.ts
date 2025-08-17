import type { OverlayAPI } from '../../types/overlay'

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
