/* ----------------------------------------------------------------------------
 * previewServer
 * ----------------------------------------------------------------------------
 * Renders the project through a Service Worker that serves its files from real,
 * path-based URLs (`/preview/<projectId>/…`). Because the browser then does
 * native URL resolution, everything a blob-URL preview cannot do starts working:
 * ES-module `import`, dynamic `import()`, `fetch()`, `new URL(x, import.meta.url)`,
 * web workers, and wasm — the references a modern ("active") web project relies
 * on. Correct `Content-Type` headers (notably `text/javascript` for modules)
 * come along for free.
 *
 * `buildPreview()` is the single entry point the app calls. It prefers the
 * served pipeline and falls back to the in-iframe blob pipeline
 * (`previewService.buildPreviewIndex`) whenever the Service Worker isn't
 * available (insecure context, unsupported browser, registration failure) so
 * behaviour never regresses.
 * -------------------------------------------------------------------------*/

import type { LoadedProject, ZipEntryMeta } from '../types';
import type { ZipArchiveLike } from './archiveTypes';
import { guessMimeType } from './mime';
import { buildPreviewIndex, choosePrimaryHtml, type PreviewIndex } from './previewService';
import { WorkerZipArchive } from './workerZipArchive';

const CACHE_NAME = 'mockswap-preview';
const SW_URL = '/preview-sw.js';
// Root scope so the app page is claimed and its nested preview iframe is
// reliably controlled. The worker only ever handles `/preview/…` requests and
// passes everything else straight through to the network.
const SW_SCOPE = '/';
/** URL prefix under which project files are served. */
const PREVIEW_PREFIX = '/preview/';

/** postMessage type shared with the app's iframe navigation listener. */
const NAV_MESSAGE_TYPE = 'mockswap:navigate';

/** True when the Service Worker preview server can run in this context. */
export function previewServerSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof caches !== 'undefined' &&
    typeof window !== 'undefined' &&
    window.isSecureContext === true
  );
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Register + activate the preview worker once, memoized for the session. */
function ensureRegistered(): Promise<ServiceWorkerRegistration | null> {
  if (!registration) {
    registration = (async () => {
      try {
        // Drop any narrower-scoped registration from a previous version —
        // a `/preview/`-scoped worker would out-specific the root one and keep
        // the page uncontrolled, which is exactly what breaks iframe control.
        const rootScope = new URL(SW_SCOPE, location.origin).href;
        for (const existing of await navigator.serviceWorker.getRegistrations()) {
          if (existing.active?.scriptURL.endsWith(SW_URL) && existing.scope !== rootScope) {
            await existing.unregister();
          }
        }
        const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
        await whenActivated(reg);
        await whenControlling();
        // Confirm a worker-controlled iframe actually runs here before relying
        // on it — some embedded/webview browsers don't run SW-controlled frames.
        // If it can't, drop the worker so it never intercepts app requests and
        // let the blob pipeline take over.
        if (!(await probeIframeCapability())) {
          await reg.unregister().catch(() => {});
          return null;
        }
        return reg;
      } catch {
        return null;
      }
    })();
  }
  return registration;
}

function whenActivated(reg: ServiceWorkerRegistration): Promise<void> {
  return new Promise((resolve) => {
    if (reg.active) return resolve();
    const worker = reg.installing ?? reg.waiting;
    if (!worker) return resolve();
    const onChange = () => {
      if (worker.state === 'activated') {
        worker.removeEventListener('statechange', onChange);
        resolve();
      }
    };
    worker.addEventListener('statechange', onChange);
  });
}

/**
 * Resolve once this page is controlled by the worker. On the very first
 * registration the page loads uncontrolled and only gains a controller when the
 * activated worker calls `clients.claim()`; the preview iframe must not mount
 * before then or its navigation bypasses the worker. Bounded so a browser that
 * never fires the event can still fall back to the blob pipeline.
 */
function whenControlling(): Promise<void> {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      navigator.serviceWorker.removeEventListener('controllerchange', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 3000);
    navigator.serviceWorker.addEventListener('controllerchange', done);
  });
}

/**
 * Load a hidden iframe against the worker's sentinel route and wait for the
 * message it posts. Success proves a worker-controlled iframe both renders and
 * can talk to the app — the exact capability the served preview depends on.
 */
function probeIframeCapability(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(false);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:absolute;left:-9999px;width:0;height:0;border:0';

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      iframe.remove();
      resolve(ok);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data && (event.data as { type?: string }).type === 'mockswap:preview-probe') {
        finish(true);
      }
    };
    // A working browser answers in well under this; the timeout only bites in
    // environments that can't run worker-controlled iframes, where it gates the
    // one-time fallback to the blob pipeline.
    const timer = setTimeout(() => finish(false), 1500);

    window.addEventListener('message', onMessage);
    iframe.src = `${PREVIEW_PREFIX}__probe__`;
    document.body.appendChild(iframe);
  });
}

/**
 * Build a preview index for `project`. Uses the Service Worker server when
 * possible; otherwise falls back to the blob-URL pipeline. Any failure in the
 * served path also falls back, so a preview always renders.
 */
export async function buildPreview(
  project: LoadedProject,
  entries: ZipEntryMeta[],
): Promise<PreviewIndex> {
  const zip = project.zip;
  const projectId = zip instanceof WorkerZipArchive ? zip.projectId : null;

  if (projectId && previewServerSupported()) {
    try {
      const reg = await ensureRegistered();
      if (reg) return await buildServedPreview(projectId, zip, entries);
    } catch {
      // fall through to the blob pipeline
    }
  }
  return buildPreviewIndex(zip, entries);
}

/* ---------------------------------------------------------------------------
 * Served pipeline
 * -------------------------------------------------------------------------*/

async function buildServedPreview(
  projectId: string,
  zip: ZipArchiveLike,
  entries: ZipEntryMeta[],
): Promise<PreviewIndex> {
  const cache = await caches.open(CACHE_NAME);
  // Only one project renders at a time; clear stale entries so a smaller or
  // renamed project never serves ghost files from a previous upload.
  await Promise.all((await cache.keys()).map((req) => cache.delete(req)));

  const htmlPaths = entries
    .filter((e) => !e.isDirectory && e.category === 'html')
    .map((e) => e.path)
    .sort((a, b) => a.localeCompare(b));

  const primaryPath = choosePrimaryHtml(htmlPaths);
  // A built site (…/dist/index.html, …/build/index.html) is authored to deploy
  // at a web root, so its assets use root-relative paths like `/assets/app.js`.
  // Serve everything relative to that root — the entry HTML's directory — so
  // those paths resolve instead of 404ing one level too high.
  const siteRoot = deriveSiteRoot(primaryPath);
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const file = zip.file(entry.path);
    if (!file) continue;

    const key = previewUrl(projectId, servedPreviewPath(entry.path, siteRoot));
    try {
      if (entry.category === 'html') {
        // The nav bridge resolves in-page links against the ZIP path so the
        // result keys back into `urls`; only the served location is stripped.
        const html = augmentHtml(await file.async('text'), entry.path);
        await cache.put(key, new Response(html, { headers: previewHeaders('text/html;charset=utf-8') }));
      } else {
        const blob = await file.async('blob');
        const mime = entry.category === 'css'
          ? 'text/css;charset=utf-8'
          : guessMimeType(entry.name) ?? 'application/octet-stream';
        await cache.put(key, new Response(blob, { headers: previewHeaders(mime) }));
      }
    } catch {
      // Skip unreadable entries; the preview degrades gracefully.
    }
  }

  const urls = new Map<string, string>();
  for (const p of htmlPaths) urls.set(p, previewUrl(projectId, servedPreviewPath(p, siteRoot)));
  const primaryUrl = primaryPath ? urls.get(primaryPath) ?? '' : '';

  return { urls, htmlPaths, primaryPath, primaryUrl };
}

/** The entry HTML's directory (with trailing slash), treated as the web root. */
export function deriveSiteRoot(primaryPath: string): string {
  const slash = primaryPath.lastIndexOf('/');
  return slash === -1 ? '' : primaryPath.slice(0, slash + 1);
}

/**
 * Convert a zip-internal path to the URL path served by the preview worker.
 * When the selected entry lives in a build folder (`dist/index.html`,
 * `build/index.html`, etc.), files under that folder are served at the preview
 * web root so deploy-root references like `/assets/app.js` resolve correctly.
 * Files outside the web root keep their zip path and cannot overwrite entry
 * files at the preview root.
 */
export function servedPreviewPath(zipPath: string, siteRoot: string): string {
  if (!siteRoot) return zipPath;
  return zipPath.startsWith(siteRoot) ? zipPath.slice(siteRoot.length) : zipPath;
}

/** Map a zip-internal path to its served URL, encoding each segment. */
export function previewUrl(projectId: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${PREVIEW_PREFIX}${encodeURIComponent(projectId)}/${encoded}`;
}

function previewHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    // Keep preview responses shareable across the served preview path and the
    // legacy blob fallback, and prevent browser cache from outliving the
    // in-memory project cache.
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'cache-control': 'no-store',
  };
}

/* ---------------------------------------------------------------------------
 * HTML augmentation
 * ----------------------------------------------------------------------------
 * Two tiny classic scripts injected at the top of <head> so they run before
 * any module script:
 *   1. Storage shim — the sandboxed preview has an opaque origin, where
 *      `localStorage` / `sessionStorage` throw on access. Real sites touch
 *      them on boot and would otherwise die with an uncaught SecurityError.
 *      The shim swaps in an in-memory store only when native access fails,
 *      matching sandbox semantics (per-session, non-persistent).
 *   2. Nav bridge — forwards in-page `<a href>` clicks to relative pages up to
 *      the app so the page dropdown / history stay in sync, mirroring the blob
 *      pipeline's protocol.
 * -------------------------------------------------------------------------*/

export function augmentHtml(html: string, sourcePath: string): string {
  if (/data-mockswap-preview/.test(html)) return html;

  const srcLiteral = escapeForScript(sourcePath);
  const navType = escapeForScript(NAV_MESSAGE_TYPE);
  const body = [
    '(function(){',
    // --- storage shim ---
    'function mem(){var m=Object.create(null);return{',
    'getItem:function(k){k=String(k);return k in m?m[k]:null;},',
    'setItem:function(k,v){m[String(k)]=String(v);},',
    'removeItem:function(k){delete m[String(k)];},',
    'clear:function(){m=Object.create(null);},',
    'key:function(i){return Object.keys(m)[i]||null;},',
    'get length(){return Object.keys(m).length;}};}',
    'var names=["localStorage","sessionStorage"];',
    'for(var i=0;i<names.length;i++){(function(n){var ok=false;',
    'try{var s=window[n];s.getItem("__mockswap_probe");ok=true;}catch(e){ok=false;}',
    'if(!ok){try{Object.defineProperty(window,n,{configurable:true,value:mem()});}catch(e){}}',
    '})(names[i]);}',
    // --- nav bridge ---
    'var __src=' + srcLiteral + ';var __type=' + navType + ';',
    'document.addEventListener("click",function(e){',
    'var t=e.target;while(t&&t.nodeType!==9&&t.nodeName!=="A"){t=t.parentNode;}',
    'if(!t||t.nodeName!=="A")return;var h=t.getAttribute("href");if(!h)return;',
    'if(/^(https?:|mailto:|tel:|javascript:|data:|\\/\\/|blob:|#)/i.test(h))return;',
    'if(t.target&&t.target!=="_self")return;',
    'e.preventDefault();e.stopPropagation();',
    'try{window.parent.postMessage({type:__type,href:h,sourceFile:__src},"*");}catch(_){}',
    '},true);',
    '})();',
  ].join('');

  const scriptTag = '<script data-mockswap-preview>' + body + '</script>';
  const headRe = /<head\b[^>]*>/i;
  if (headRe.test(html)) return html.replace(headRe, (m) => m + scriptTag);
  const htmlRe = /<html\b[^>]*>/i;
  if (htmlRe.test(html)) return html.replace(htmlRe, (m) => m + scriptTag);
  return scriptTag + html;
}

/**
 * JSON-encode a string for safe inclusion in a `<script>` body, additionally
 * escaping `<`/`>` so a crafted path can't terminate the script element early.
 */
function escapeForScript(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}
