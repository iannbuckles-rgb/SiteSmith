import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'

import {
  attachPortConflictDetector,
  boundTcpPort,
  formatPortConflictWarning,
} from '../src/lib/vitePortDetector'

/** Track every server the test creates so `afterEach` can drain them. */
const servers: Server[] = []
let warnSpy: ReturnType<typeof vi.spyOn>

afterEach(async () => {
  warnSpy?.mockRestore()
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections?.()
          s.close(() => resolve())
        }),
    ),
  )
})

function track(server: Server): Server {
  servers.push(server)
  return server
}

/**
 * Find a TCP port that is currently free by binding a throwaway probe on
 * `127.0.0.1` with port `0` (OS-assigned) and immediately releasing it.
 * No reuse — every test gets its own probe and the probe binds a port the
 * rest of the test never touches.
 *
 * The probe is tracked so `afterEach` drains it; if `listen()` errors or
 * `close()` rejects, the probe still gets cleaned up before the next test.
 */
async function pickFreePort(): Promise<number> {
  const probe = track(createServer())
  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      resolve((probe.address() as { port: number }).port)
    })
  })
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

describe('vitePortDetector', () => {
  describe('formatPortConflictWarning', () => {
    it('returns stable copy mentioning both ports', () => {
      const message = formatPortConflictWarning(5483, 5484)
      expect(message).toContain('5483')
      expect(message).toContain('5484')
      expect(message).toMatch(/already in use/i)
      expect(message).toMatch(/npm run dev -- --port/i)
    })

    it('does not embed a localhost URL (host: true binds to all interfaces)', () => {
      const message = formatPortConflictWarning(5483, 5484)
      expect(message).not.toMatch(/localhost/i)
    })
  })

  describe('boundTcpPort', () => {
    it('returns null when the server has not yet bound an address', () => {
      expect(boundTcpPort({ address: () => null })).toBeNull()
    })

    it('returns null for unix-socket-style string addresses', () => {
      expect(boundTcpPort({ address: () => '/tmp/mockswap.sock' })).toBeNull()
    })

    it('returns the numeric port from AddressInfo', () => {
      expect(boundTcpPort({ address: () => ({ port: 4173 }) })).toBe(4173)
    })
  })

  describe('attachPortConflictDetector', () => {
    it('is a no-op when desiredPort is 0 (let the OS pick)', async () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const server = track(createServer())
      attachPortConflictDetector(server, 0)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('warns once when the http server binds to a different port than requested', async () => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Block the desired port on a separate, held server.
      const desiredPort = await pickFreePort()
      const blocker = track(createServer())
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(desiredPort, '127.0.0.1', () => resolve())
      })
      // Sanity: blocker is actually holding the port.
      expect((blocker.address() as { port: number }).port).toBe(desiredPort)

      // The httpServer being tested: attach the detector with the blocked
      // port as its desired port.
      const viteHttp = track(createServer())
      attachPortConflictDetector(viteHttp, desiredPort)

      // First attempt: viteHttp listens on the blocked port → EADDRINUSE.
      await new Promise<void>((resolve) => {
        viteHttp.once('error', () => resolve())
        viteHttp.listen(desiredPort, '127.0.0.1')
      })

      // Second attempt: viteHttp retries with port `0` → OS-assigned → 'listening'.
      const actuallyBoundPort = await new Promise<number>((resolve, reject) => {
        viteHttp.once('error', reject)
        viteHttp.listen(0, '127.0.0.1', () => {
          resolve((viteHttp.address() as { port: number }).port)
        })
      })
      // Sanity: the OS-assigned port differs from the blocked one.
      expect(actuallyBoundPort).not.toBe(desiredPort)

      // Plugin's once('listening') has now fired; let it drain.
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(warnSpy).toHaveBeenCalledTimes(1)
      const message = String(warnSpy.mock.calls[0]?.[0] ?? '')
      expect(message).toContain(String(desiredPort))
      expect(message).toContain(String(actuallyBoundPort))
    })
  })
})
