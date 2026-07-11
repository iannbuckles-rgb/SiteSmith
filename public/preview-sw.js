/* ============================================================================
 * MockupSwap preview service worker
 * ============================================================================
 * Serves an uploaded project from real, path-based URLs so the browser resolves
 * every reference natively — relative and root-relative paths, ES-module
 * `import` / dynamic `import()`, `fetch()`, `new URL(x, import.meta.url)`, web
 * workers, wasm — exactly like a local dev server. This is what lets modern,
 * bundled ("active") web projects render, not just flat HTML/CSS.
 *
 * Files live in the `mockswap-preview` Cache under `/preview/<id>/…`, written
 * app-side. Requests are served two ways:
 *
 *   1. Direct — a URL already under `/preview/<id>/…` (how the browser resolves
 *      a project's RELATIVE references, since the page lives in that directory).
 *
 *   2. Root-relative — real builds emit absolute paths like `/assets/app.js` or
 *      `/_next/static/…`, which the browser resolves against the ORIGIN root and
 *      requests as bare `/assets/…`. We map those back into the project by
 *      looking at the REQUESTING CLIENT: the preview iframe's document URL stays
 *      `/preview/<id>/index.html` for the whole session, so every request it
 *      makes — including deeply nested module imports whose own URL is now
 *      root-relative — still resolves to the right project. Requests from any
 *      other client (the app itself) are passed straight through.
 *
 * The worker stays a dumb static server: file set, MIME types and HTML
 * augmentation are all decided app-side at cache-population time.
 * ==========================================================================*/

const CACHE_NAME = 'mockswap-preview';
const PREVIEW_PREFIX = '/preview/';
const PREVIEW_DIR_RE = /^(\/preview\/[^/]+\/)/;

// Capability sentinel: lets the app confirm that a service-worker-controlled
// iframe actually runs in this browser before committing to the served
// pipeline. It posts a message to its parent; if the app hears it, the served
// preview is viable, otherwise the app falls back to the blob pipeline.
const PROBE_PATH = PREVIEW_PREFIX + '__probe__';
const PROBE_HTML =
  '<!doctype html><meta charset="utf-8"><script>' +
  'try{parent.postMessage({type:"mockswap:preview-probe"},"*");}catch(e){}' +
  '</script>ok';

self.addEventListener('install', () => {
  // Take over as soon as installed so the first preview load is controlled.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === PROBE_PATH) {
    event.respondWith(probeResponse());
    return;
  }
  // A project file addressed directly under its preview directory.
  if (url.pathname.startsWith(PREVIEW_PREFIX)) {
    event.respondWith(serveFromCache(url.pathname));
    return;
  }
  // Skip dev-server / tooling internals so hot-reload is never intercepted.
  if (isToolingPath(url.pathname)) return;

  // Possibly a root-relative asset from a preview page. `resolveRequest` maps
  // it into the project when the requester is a preview client, and otherwise
  // passes the request straight through to the network.
  event.respondWith(resolveRequest(event, url));
});

function isToolingPath(pathname) {
  return (
    pathname.startsWith('/@') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/') ||
    pathname === '/preview-sw.js'
  );
}

async function resolveRequest(event, url) {
  try {
    const base = await previewBaseForClient(event.clientId, event.request.referrer);
    if (base) {
      return serveFromCache(base + url.pathname.replace(/^\/+/, ''));
    }
  } catch {
    // fall through to network
  }
  return fetch(event.request);
}

/**
 * Resolve the `/preview/<id>/` base for the request's originating client.
 * Prefers the client's live document URL (stable across the whole preview
 * session, including nested imports); falls back to the referrer when the
 * client can't be looked up.
 */
async function previewBaseForClient(clientId, referrer) {
  if (clientId) {
    const client = await self.clients.get(clientId);
    const base = client && matchPreviewDir(client.url);
    if (base) return base;
  }
  return matchPreviewDir(referrer);
}

function matchPreviewDir(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value, self.location.origin);
    if (parsed.origin !== self.location.origin) return null;
    const match = parsed.pathname.match(PREVIEW_DIR_RE);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function probeResponse() {
  return new Response(PROBE_HTML, {
    headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function serveFromCache(pathname) {
  const cache = await caches.open(CACHE_NAME);

  // Direct hit (query string ignored so `style.css?v=2` finds `style.css`).
  let response = await cache.match(pathname, { ignoreSearch: true });

  // Directory / extensionless navigation → try an index.html underneath it.
  if (!response) {
    const asIndex = pathname.replace(/\/?$/, '/') + 'index.html';
    response = await cache.match(asIndex, { ignoreSearch: true });
  }

  if (response) return response;

  return new Response('Not found in preview: ' + pathname, {
    status: 404,
    headers: { 'content-type': 'text/plain;charset=utf-8' },
  });
}
