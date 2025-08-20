/// <reference types="vite/client" />
import type { Editor } from 'tldraw'

declare global {
  interface Window {
    __tldraw_editor?: Editor
  }
}

export {}
