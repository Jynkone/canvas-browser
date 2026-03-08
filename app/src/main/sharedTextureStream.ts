import { sharedTexture } from 'electron'

type PendingFrame = {
  textureInfo: unknown
  releaseSource: () => void
}

type ImportedSharedTexture = {
  release(): void
}

type SendFrame = (importedSharedTexture: ImportedSharedTexture) => Promise<void>

export class SharedTextureStream {
  private inFlight = false
  private closed = false
  private pending: PendingFrame | null = null

  constructor(private readonly sendFrame: SendFrame) { }

  enqueue(textureInfo: unknown, releaseSource: () => void): void {
    if (this.closed) {
      releaseSource()
      return
    }

    const next: PendingFrame = { textureInfo, releaseSource }

    if (this.inFlight) {
      if (this.pending) {
        try { this.pending.releaseSource() } catch { }
      }
      this.pending = next
      return
    }

    void this.flush(next)
  }

  close(): void {
    this.closed = true
    if (this.pending) {
      try { this.pending.releaseSource() } catch { }
      this.pending = null
    }
  }

  private async flush(frame: PendingFrame): Promise<void> {
    if (this.closed) {
      frame.releaseSource()
      return
    }

    this.inFlight = true
    let sourceReleased = false

    const releaseAndContinue = (): void => {
      if (sourceReleased) return
      sourceReleased = true
      try { frame.releaseSource() } catch { }
      this.inFlight = false

      if (this.closed) return

      const queued = this.pending
      this.pending = null
      if (queued) void this.flush(queued)
    }

    const importedSharedTexture = sharedTexture.importSharedTexture({
      textureInfo: frame.textureInfo as never,
      allReferencesReleased: releaseAndContinue,
    }) as ImportedSharedTexture

    try {
      await this.sendFrame(importedSharedTexture)
    } catch {
      // `allReferencesReleased` remains the source-of-truth for cleanup.
    } finally {
      try { importedSharedTexture.release() } catch { }
    }
  }
}
