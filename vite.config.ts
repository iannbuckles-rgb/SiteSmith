import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { portConflictDetector } from './src/lib/vitePortDetector'

// https://vitejs.dev/config/

/**
 * The default port for `npm run dev`.
 *
 * Picked to stay well clear of the most contention-prone dev ranges — the
 * Vite cascade (5173, 5174, 5175, …), the React/Node defaults (3000), the
 * proxy-friendly HTTPS range (8000, 8080), and this project's own preview
 * port (4173) — so two projects running side-by-side very rarely collide
 * on first launch. Any port outside those clusters would do equally well.
 * Override at runtime with `npm run dev -- --port <free>`.
 */
const DEV_PORT = 5483

export default defineConfig({
  plugins: [react(), tailwindcss(), portConflictDetector],
  server: {
    host: true,
    port: DEV_PORT,
    // If the desired port is busy, fall through to the next free port
    // instead of failing. The portConflictDetector plugin (imported above
    // from src/lib/vitePortDetector.ts) will surface the swap loudly.
    // Set strictPort: true to opt back in to hard-fail (and stop the dev
    // server on conflict).
    strictPort: false,
  },
})
