/**
 * `npm run dev` port-conflict detector.
 *
 * Without this, Vite's built-in "Port X is in use, trying another one…"
 * line can scroll past in a busy terminal and the dev URL ends up
 * surprising the user. This module attaches a one-shot `listening` listener
 * to the dev server's `http.Server` and compares the actual bound port
 * against the requested port — if they differ, it emits a single,
 * unmistakable `console.warn`.
 *
 * The `attachPortConflictDetector(httpServer, desiredPort)` function is the
 * pure, side-effect-free boundary the unit tests drive directly; the
 * `portConflictDetector` Vite `Plugin` literal is the production wiring.
 *
 * Crucially, the desired port is captured **at call time** (not from a
 * hard-coded constant) so an *intentional* CLI override like
 * `npm run dev -- --port <other>` does not produce a false-positive
 * warning.
 */
import type { Plugin } from 'vite'

/**
 * Structural subset of `http.Server` that `attachPortConflictDetector`
 * actually consumes — both Node's `http.Server` and Vite's narrower
 * `HttpServer` satisfy it, so neither call site needs a cast.
 */
export type Addressable = {
  address(): string | { port: number } | null
}

export type HttpServerLike = Addressable & {
  once(event: 'listening', listener: () => void): unknown
}

/**
 * Format the warning copy. Pure — easy to assert on in tests, and easy to
 * iterate on the wording without re-spinning any HTTP machinery.
 */
export function formatPortConflictWarning(
  desiredPort: number,
  actualPort: number,
): string {
  return (
    `\n⚠️  Desired port ${desiredPort} was already in use.\n` +
    `   Dev server is now running on port ${actualPort}.\n` +
    `   Stop the other process or run: npm run dev -- --port <free>\n`
  )
}

/**
 * Resolve the actual TCP port a server is bound to, or `null` if the
 * bound address is not an AddressInfo (e.g. a unix socket, or the
 * server has not yet started listening).
 */
export function boundTcpPort(server: Addressable): number | null {
  const addr = server.address()
  if (!addr || typeof addr !== 'object') return null
  return 'port' in addr ? addr.port : null
}

/**
 * Attach a one-shot port-conflict detector to `httpServer`. If
 * `desiredPort` is `0`, this is a no-op (port `0` in Vite means "let the
 * OS pick a free port"; there is no desired port to compare against, so
 * a rebind never counts as a conflict).
 *
 * Otherwise, on the next `listening` event the bound port is compared
 * against `desiredPort`; if they differ, a single warning is emitted to
 * `console.warn`. Tests can intercept with `vi.spyOn(console, 'warn')`.
 */
export function attachPortConflictDetector(
  httpServer: HttpServerLike,
  desiredPort: number,
): void {
  if (desiredPort === 0) return
  httpServer.once('listening', () => {
    const actualPort = boundTcpPort(httpServer)
    if (actualPort !== null && actualPort !== desiredPort) {
      console.warn(formatPortConflictWarning(desiredPort, actualPort))
    }
  })
}

/**
 * The Vite plugin. `configureServer(server)` reads the resolved config's
 * requested port (which already merges any `--port` CLI flag) and hands
 * the http.Server + port off to `attachPortConflictDetector`.
 */
export const portConflictDetector: Plugin = {
  name: 'mockswap:port-conflict-detector',
  configureServer(server) {
    const httpServer = server.httpServer
    if (!httpServer) return
    attachPortConflictDetector(httpServer, server.config.server.port ?? 0)
  },
}
