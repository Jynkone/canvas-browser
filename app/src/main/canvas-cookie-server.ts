/**
 * canvas-cookie-server.ts
 * 
 * Add this to your Electron main process.
 * Listens for cookie sync messages from the Chrome extension
 * via the native messaging host and imports them into persist:overlay
 * 
 * Usage in your main index.ts:
 *   import { startCookieServer, stopCookieServer } from './canvas-cookie-server'
 *   app.whenReady().then(() => startCookieServer())
 *   app.on('before-quit', () => stopCookieServer())
 */

import http from 'http'
import { session } from 'electron'

const PORT = 49821
const SECRET = 'canvas-browser-local-ipc'
const OVERLAY_PARTITION = 'persist:overlay'

let server: http.Server | null = null

export function startCookieServer(): void {
  const overlaySession = session.fromPartition(OVERLAY_PARTITION)

  server = http.createServer((req, res) => {
    // Only accept POST to /sync-cookies
    if (req.method !== 'POST' || req.url !== '/sync-cookies') {
      res.writeHead(404)
      res.end()
      return
    }

    // Verify shared secret
    if (req.headers['x-canvas-secret'] !== SECRET) {
      res.writeHead(403)
      res.end()
      return
    }

    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const message = JSON.parse(body) as {
          type: string
          domain: string
          cookies: Array<{
            name: string
            value: string
            domain: string
            path: string
            secure: boolean
            httpOnly: boolean
            sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified'
            expirationDate?: number
            hostOnly: boolean
          }>
        }

        if (message.type !== 'SYNC_COOKIES') {
          res.writeHead(400)
          res.end()
          return
        }


        // Import each cookie into persist:overlay
        const results = await Promise.allSettled(
          message.cookies.map(cookie => {
            const url = `${cookie.secure ? 'https' : 'http'}://${
              cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
            }${cookie.path}`

            return overlaySession.cookies.set({
              url,
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              sameSite: cookie.sameSite === 'no_restriction' ? 'no_restriction'
                : cookie.sameSite === 'lax' ? 'lax'
                : cookie.sameSite === 'strict' ? 'strict'
                : 'no_restriction',
              expirationDate: cookie.expirationDate,
            })
          })
        )

        const succeeded = results.filter(r => r.status === 'fulfilled').length
        const failed = results.filter(r => r.status === 'rejected').length


        // Flush cookies to disk
        await overlaySession.cookies.flushStore()

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, imported: succeeded, failed }))
      } catch (e) {
        console.error('[cookie-server] Error:', e)
        res.writeHead(500)
        res.end()
      }
    })
  })

  // Only listen on localhost - never exposed to network
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[cookie-server] Listening on 127.0.0.1:${PORT}`)
  })

  server.on('error', (e) => {
    console.error('[cookie-server] Server error:', e)
  })
}

export function stopCookieServer(): void {
  if (server) {
    server.close()
    server = null
    console.log('[cookie-server] Stopped')
  }
}