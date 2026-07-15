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
import {
  buildPreviewIndex,
  choosePrimaryHtml,
  isBuildOutputEntry,
  type PreviewDiagnostic,
  type PreviewIndex,
} from './previewService';
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
const TEXT_EDIT_MESSAGE_TYPE = 'mockswap:text-edit';
const SELECT_MESSAGE_TYPE = 'mockswap:select-element';
const REORDER_MESSAGE_TYPE = 'mockswap:reorder-element';
const NUDGE_MESSAGE_TYPE = 'mockswap:nudge-element';
const SET_EDIT_MODE_MESSAGE_TYPE = 'mockswap:set-edit-mode';
const CLEAR_SELECTION_MESSAGE_TYPE = 'mockswap:clear-selection';
const PREVIEW_STATUS_MESSAGE_TYPE = 'mockswap:preview-status';

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
      if (
        event.source === iframe.contentWindow
        && event.data
        && (event.data as { type?: string }).type === 'mockswap:preview-probe'
      ) {
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
  let compatibilityReason: string | null = null;

  if (projectId && previewServerSupported()) {
    try {
      const reg = await ensureRegistered();
      if (reg) return await buildServedPreview(projectId, zip, entries);
      compatibilityReason = 'The browser did not activate the local preview server.';
    } catch (error) {
      compatibilityReason = `The local preview server failed: ${errorMessage(error)}`;
    }
  } else if (projectId) {
    compatibilityReason = 'This browser context does not support the local preview server.';
  }
  const fallback = await buildPreviewIndex(zip, entries);
  if (compatibilityReason) {
    fallback.diagnostics.unshift({
      level: 'warning',
      message: `${compatibilityReason} Using limited compatibility mode; module imports, workers, and root-relative runtime requests may not render.`,
    });
  }
  return fallback;
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

  const allHtmlPaths = entries
    .filter((e) => !e.isDirectory && e.category === 'html')
    .map((e) => e.path)
    .sort((a, b) => a.localeCompare(b));

  const primaryPath = choosePrimaryHtml(allHtmlPaths);
  // A built site (…/dist/index.html, …/build/index.html) is authored to deploy
  // at a web root, so its assets use root-relative paths like `/assets/app.js`.
  // Serve everything relative to that root — the entry HTML's directory — so
  // those paths resolve instead of 404ing one level too high.
  const siteRoot = deriveSiteRoot(primaryPath);
  // When a project contains both development sources and a browser-ready
  // build, treat the build directory as the complete deployed website. This
  // prevents root source files from overwriting identically named `dist/`
  // assets after their paths are rebased to the preview web root.
  const buildRoot = isBuildOutputEntry(primaryPath) ? siteRoot : '';
  const previewEntries = buildRoot
    ? entries.filter((entry) => entry.isDirectory || entry.path.startsWith(buildRoot))
    : entries;
  const htmlPaths = buildRoot
    ? allHtmlPaths.filter((path) => path.startsWith(buildRoot))
    : allHtmlPaths;
  const diagnostics: PreviewDiagnostic[] = [];
  const cachedPaths = new Set<string>();

  for (const entry of previewEntries) {
    if (entry.isDirectory) continue;
    const file = zip.file(entry.path);
    if (!file) {
      diagnostics.push({
        level: previewDiagnosticLevel(entry),
        message: `Preview could not find archived file "${entry.path}".`,
      });
      continue;
    }

    const key = previewUrl(projectId, servedPreviewPath(entry.path, siteRoot));
    try {
      if (entry.category === 'html') {
        // The nav bridge resolves in-page links against the ZIP path so the
        // result keys back into `urls`; only the served location is stripped.
        const html = augmentHtml(await file.async('text'), entry.path);
        await cache.put(key, new Response(html, { headers: previewHeaders('text/html;charset=utf-8') }));
      } else {
        const blob = await file.async('blob');
        const mime = guessMimeType(entry.name)
          ?? (entry.category === 'css' ? 'text/css;charset=utf-8' : 'application/octet-stream');
        await cache.put(key, new Response(blob, { headers: previewHeaders(mime) }));
      }
      cachedPaths.add(entry.path);
    } catch (error) {
      diagnostics.push({
        level: previewDiagnosticLevel(entry),
        message: `Preview could not serve "${entry.path}": ${errorMessage(error)}`,
      });
    }
  }

  if (primaryPath && !cachedPaths.has(primaryPath)) {
    const detail = diagnostics.find((item) => item.message.includes(`"${primaryPath}"`))?.message;
    throw new Error(detail ?? `The selected entry page "${primaryPath}" could not be served.`);
  }

  const urls = new Map<string, string>();
  for (const p of htmlPaths) urls.set(p, previewUrl(projectId, servedPreviewPath(p, siteRoot)));
  const primaryUrl = primaryPath ? urls.get(primaryPath) ?? '' : '';

  return {
    urls,
    htmlPaths,
    primaryPath,
    primaryUrl,
    mode: 'served',
    diagnostics,
  };
}

function previewDiagnosticLevel(entry: ZipEntryMeta): PreviewDiagnostic['level'] {
  return entry.category === 'html' || entry.category === 'css' || entry.category === 'js'
    ? 'error'
    : 'warning';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 *   3. Text edit bridge — when the parent enables edit mode, double-clicking a
 *      text element makes it editable in-place and reports the literal text
 *      delta back to the app for a real zip mutation.
 * -------------------------------------------------------------------------*/

export function augmentHtml(html: string, sourcePath: string): string {
  if (/data-mockswap-preview/.test(html)) return html;

  const instrumentedHtml = instrumentEditableMarkup(html);
  const srcLiteral = escapeForScript(sourcePath);
  const navType = escapeForScript(NAV_MESSAGE_TYPE);
  const editType = escapeForScript(TEXT_EDIT_MESSAGE_TYPE);
  const selectType = escapeForScript(SELECT_MESSAGE_TYPE);
  const reorderType = escapeForScript(REORDER_MESSAGE_TYPE);
  const nudgeType = escapeForScript(NUDGE_MESSAGE_TYPE);
  const editModeType = escapeForScript(SET_EDIT_MODE_MESSAGE_TYPE);
  const clearSelectionType = escapeForScript(CLEAR_SELECTION_MESSAGE_TYPE);
  const statusType = escapeForScript(PREVIEW_STATUS_MESSAGE_TYPE);
  const body = [
    '(function(){',
    // --- runtime diagnostics bridge ---
    'var __src=' + srcLiteral + ';var __statusType=' + statusType + ';',
    'function __report(level,message,detail){try{window.parent.postMessage({type:__statusType,level:level,message:String(message||"Preview error"),detail:detail?String(detail):undefined,sourceFile:__src},"*");}catch(_){}}',
    'window.addEventListener("error",function(e){var t=e.target;if(t&&t!==window){var tag=(t.tagName||"resource").toLowerCase();var url=t.currentSrc||t.src||t.href||t.getAttribute&&t.getAttribute("src")||t.getAttribute&&t.getAttribute("href")||"unknown URL";__report("error","Failed to load "+tag+" resource.",url);return;}var detail=e.filename?[e.filename,e.lineno||0,e.colno||0].join(":"):undefined;__report("error",e.message||"Unhandled preview error",detail);},true);',
    'window.addEventListener("unhandledrejection",function(e){var r=e.reason;var message=r&&r.message?r.message:String(r||"Unhandled promise rejection");var detail=r&&r.stack?r.stack:undefined;__report("error",message,detail);});',
    'document.addEventListener("DOMContentLoaded",function(){__report("ready","Preview document loaded");},{once:true});',
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
    'var __type=' + navType + ';var __editType=' + editType + ';var __selectType=' + selectType + ';var __reorderType=' + reorderType + ';var __nudgeType=' + nudgeType + ';var __editModeType=' + editModeType + ';var __clearSelectType=' + clearSelectionType + ';',
    'document.addEventListener("click",function(e){',
    'if(window.__mockswapTextEditEnabled)return;',
    'var t=e.target;while(t&&t.nodeType!==9&&t.nodeName!=="A"){t=t.parentNode;}',
    'if(!t||t.nodeName!=="A")return;var h=t.getAttribute("href");if(!h)return;',
    'if(/^(https?:|mailto:|tel:|javascript:|data:|\\/\\/|blob:|#)/i.test(h))return;',
    'if(t.target&&t.target!=="_self")return;',
    'e.preventDefault();e.stopPropagation();',
    'try{window.parent.postMessage({type:__type,href:h,sourceFile:__src},"*");}catch(_){}',
    '},true);',
    // --- direct editing + reorder bridge ---
    'window.__mockswapTextEditEnabled=false;',
    'var textSelector="h1,h2,h3,h4,h5,h6,p,a,button,span,li,label,small,strong,em,figcaption,blockquote";',
    'var fieldSelector="input,textarea,select";',
    'var componentSelector="section,article,header,footer,main,nav,aside,form,fieldset,figure,div";',
    'var selectableSelector=textSelector+",img,"+fieldSelector+","+componentSelector;',
    'var __mockswapDragEl=null;var __mockswapDropEl=null;var __mockswapNudgeSession=null;',
    'function isField(el){return !!(el&&el.matches&&el.matches(fieldSelector));}',
    'function isSelectable(el){return !!(el&&el.matches&&(el.matches("img")||el.matches(fieldSelector)||(el.matches(textSelector)&&clean(el.textContent))||(el.matches(componentSelector)&&hasSource(el))));}',
    'function hasSource(el){return typeof numAttr(el,"data-mockswap-source-start")==="number"&&typeof numAttr(el,"data-mockswap-source-end")==="number";}',
    'function textTarget(node){var el=node&&node.nodeType===1?node:node&&node.parentElement;while(el&&el.nodeType===1){if(!isField(el)&&el.matches&&el.matches(textSelector)&&clean(el.textContent))return el;if(el===document.body)break;el=el.parentElement;}return null;}',
    'function selectTarget(node){var el=node&&node.nodeType===1?node:node&&node.parentElement;while(el&&el.nodeType===1){if(isSelectable(el))return el;if(el===document.body)break;el=el.parentElement;}return null;}',
    'function clean(value){return String(value||"").replace(/\\s+/g," ").trim();}',
    'function hint(el){var s=el.tagName.toLowerCase();if(el.id)s+="#"+el.id;if(el.className&&typeof el.className==="string")s+="."+el.className.trim().split(/\\s+/).slice(0,3).join(".");return s;}',
    'function baseName(value){value=String(value||"").split(/[?#]/)[0];var parts=value.split("/");return parts[parts.length-1]||value||"Image";}',
    'function numAttr(el,n){var v=el.getAttribute(n);if(v==null)return undefined;var x=Number(v);return Number.isFinite(x)?x:undefined;}',
    'function normPx(v){if(!Number.isFinite(v))return 0;var n=Math.round(v*1000)/1000;return Math.abs(n)<.0005?0:n;}',
    'function fmtPx(v){return String(normPx(v))+"px";}',
    'function readPx(v){v=String(v||"").trim().toLowerCase();if(v==="0"||v==="+0"||v==="-0")return 0;var m=v.match(/^([+-]?(?:\\d+|\\d*\\.\\d+))px$/);return m?normPx(Number(m[1])):0;}',
    'function readTranslate(el){var raw=(el&&el.style&&el.style.translate)||"";raw=String(raw||"").trim();if(!raw||raw.toLowerCase()==="none")return{x:0,y:0};var parts=raw.replace(/,/g," ").split(/\\s+/).filter(Boolean);return{x:readPx(parts[0]),y:parts[1]?readPx(parts[1]):0};}',
    'function writeTranslate(el,x,y){x=normPx(x);y=normPx(y);if(x===0&&y===0){el.style.removeProperty("translate");}else{el.style.translate=fmtPx(x)+" "+fmtPx(y);}}',
    'function flushNudge(){var s=__mockswapNudgeSession;if(!s)return;__mockswapNudgeSession=null;if(!s.selection||(s.dx===0&&s.dy===0))return;try{window.parent.postMessage({type:__nudgeType,sourceFile:__src,selection:s.selection,deltaX:normPx(s.dx),deltaY:normPx(s.dy)},"*");}catch(_){}}',
    'function fieldLabel(el){var tag=el.tagName.toLowerCase();var type=el.getAttribute("type");var label=el.getAttribute("aria-label")||el.getAttribute("placeholder")||el.getAttribute("name")||el.getAttribute("id")||"";if(!label&&tag==="select"&&el.options&&el.selectedIndex>=0)label=el.options[el.selectedIndex].text||"";return clean(label)||(type?tag+"["+type+"]":tag);}',
    'function fieldValue(el){var tag=el.tagName.toLowerCase();if(tag==="textarea")return el.value||el.textContent||"";if(tag==="select")return el.value||"";if("value" in el)return el.getAttribute("value")!==null?el.getAttribute("value"):(el.value||"");return el.getAttribute("value")||"";}',
    'function componentLabel(el){return clean(el.getAttribute("aria-label")||el.getAttribute("id")||el.getAttribute("class")||clean(el.textContent).slice(0,80))||el.tagName.toLowerCase();}',
    'function elementLabel(el){var isImage=el.tagName&&el.tagName.toLowerCase()==="img";if(isImage){var src=el.getAttribute("src")||"";return clean(el.getAttribute("alt")||baseName(src))||"Image";}if(isField(el))return fieldLabel(el);if(el.matches&&el.matches(componentSelector))return componentLabel(el);return clean(el.textContent)||el.tagName.toLowerCase();}',
    'function elementKind(el){if(el.tagName&&el.tagName.toLowerCase()==="img")return "image";if(isField(el)||(el.matches&&el.matches(componentSelector)))return "element";return "text";}',
    'function reorderTarget(el){if(!el||!hasSource(el))return undefined;return{tagName:el.tagName.toLowerCase(),label:elementLabel(el),sourceStart:numAttr(el,"data-mockswap-source-start"),sourceEnd:numAttr(el,"data-mockswap-source-end"),selectorHint:hint(el)};}',
    'function adjacentTarget(el,dir){if(!el||!el.parentElement)return undefined;var n=dir<0?el.previousElementSibling:el.nextElementSibling;while(n){if(isSelectable(n)&&hasSource(n))return reorderTarget(n);n=dir<0?n.previousElementSibling:n.nextElementSibling;}return undefined;}',
    'function selectionPayload(el){var kind=elementKind(el);var isImage=kind==="image";var isForm=isField(el);var src=isImage?(el.getAttribute("src")||""):undefined;var text=kind==="text"?clean(el.textContent):undefined;var p=reorderTarget(el);if(!p)return null;p.sourceFile=__src;p.kind=kind;p.text=text;p.src=src;p.alt=isImage?(el.getAttribute("alt")||""):undefined;p.href=el.getAttribute("href")||undefined;p.target=el.getAttribute("target")||undefined;p.rel=el.getAttribute("rel")||undefined;p.title=el.getAttribute("title")||undefined;p.elementId=el.getAttribute("id")||undefined;p.className=typeof el.className==="string"?el.className:undefined;p.style=el.getAttribute("style")||"";p.role=el.getAttribute("role")||undefined;p.ariaLabel=el.getAttribute("aria-label")||undefined;p.name=el.getAttribute("name")||undefined;p.inputType=el.getAttribute("type")||undefined;p.value=isForm?fieldValue(el):undefined;p.placeholder=el.getAttribute("placeholder")||undefined;p.hasElementChildren=!!el.querySelector("*");p.moveBeforeTarget=adjacentTarget(el,-1);p.moveAfterTarget=adjacentTarget(el,1);return p;}',
    'function clearSelected(el){if(!el)return;el.removeAttribute("data-mockswap-selected");if(el.getAttribute("data-mockswap-tabindex")==="true"){el.removeAttribute("tabindex");el.removeAttribute("data-mockswap-tabindex");}}',
    'function focusSelected(el){try{if(!el.hasAttribute("tabindex")){el.setAttribute("tabindex","-1");el.setAttribute("data-mockswap-tabindex","true");}el.focus({preventScroll:true});}catch(_){}}',
    'function syncDraggables(){var nodes=document.querySelectorAll(selectableSelector);for(var i=0;i<nodes.length;i++){var el=nodes[i];if(window.__mockswapTextEditEnabled&&isSelectable(el)&&hasSource(el))el.setAttribute("draggable","true");else el.removeAttribute("draggable");}}',
    'function selectElement(el){if(!el)return;var old=document.querySelector("[data-mockswap-selected]");if(old&&old!==el){flushNudge();clearSelected(old);}el.setAttribute("data-mockswap-selected","true");focusSelected(el);var p=selectionPayload(el);if(!p)return;try{p.type=__selectType;window.parent.postMessage(p,"*");}catch(_){}}',
    'document.addEventListener("mouseover",function(e){if(!window.__mockswapTextEditEnabled)return;var el=selectTarget(e.target);if(el){el.setAttribute("data-mockswap-hover","true");if(hasSource(el))el.setAttribute("draggable","true");}},true);',
    'document.addEventListener("mouseout",function(e){var el=e.target;if(el&&el.nodeType===1&&el.removeAttribute)el.removeAttribute("data-mockswap-hover");},true);',
    'document.addEventListener("click",function(e){if(!window.__mockswapTextEditEnabled)return;var el=selectTarget(e.target);if(!el)return;e.preventDefault();e.stopPropagation();selectElement(el);},true);',
    'function commit(el){if(!el||!el.__mockswapEditing)return;var oldText=el.__mockswapOldText||"";var nextText=clean(el.textContent);el.contentEditable="false";el.removeAttribute("data-mockswap-editing");el.__mockswapEditing=false;if(!nextText||nextText===oldText){el.textContent=oldText;return;}el.textContent=nextText;try{window.parent.postMessage({type:__editType,sourceFile:__src,oldText:oldText,newText:nextText,tagName:el.tagName.toLowerCase(),label:oldText,sourceStart:numAttr(el,"data-mockswap-source-start"),sourceEnd:numAttr(el,"data-mockswap-source-end"),selectorHint:hint(el)},"*");}catch(_){}}',
    'function clearDropMarker(){if(__mockswapDropEl){__mockswapDropEl.removeAttribute("data-mockswap-drop-before");__mockswapDropEl.removeAttribute("data-mockswap-drop-after");}__mockswapDropEl=null;}',
    'function validDrop(source,target){return !!(source&&target&&source!==target&&source.parentElement&&source.parentElement===target.parentElement&&hasSource(source)&&hasSource(target));}',
    'function dropPlacement(target,e){var r=target.getBoundingClientRect();if(r.width>r.height*1.35)return e.clientX<r.left+r.width/2?"before":"after";return e.clientY<r.top+r.height/2?"before":"after";}',
    'document.addEventListener("dragstart",function(e){if(!window.__mockswapTextEditEnabled)return;var el=selectTarget(e.target);if(!el||!hasSource(el))return;__mockswapDragEl=el;selectElement(el);el.setAttribute("data-mockswap-dragging","true");if(e.dataTransfer){e.dataTransfer.effectAllowed="move";try{e.dataTransfer.setData("text/plain",elementLabel(el));}catch(_){}}},true);',
    'document.addEventListener("dragover",function(e){if(!window.__mockswapTextEditEnabled||!__mockswapDragEl)return;var target=selectTarget(e.target);if(!validDrop(__mockswapDragEl,target))return;e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect="move";var placement=dropPlacement(target,e);if(__mockswapDropEl&&__mockswapDropEl!==target)clearDropMarker();__mockswapDropEl=target;target.removeAttribute("data-mockswap-drop-before");target.removeAttribute("data-mockswap-drop-after");target.setAttribute(placement==="before"?"data-mockswap-drop-before":"data-mockswap-drop-after","true");},true);',
    'document.addEventListener("drop",function(e){if(!window.__mockswapTextEditEnabled||!__mockswapDragEl)return;var target=selectTarget(e.target);if(!validDrop(__mockswapDragEl,target))return;e.preventDefault();e.stopPropagation();var placement=dropPlacement(target,e);var selection=selectionPayload(__mockswapDragEl);var reference=reorderTarget(target);clearDropMarker();try{window.parent.postMessage({type:__reorderType,sourceFile:__src,selection:selection,reference:reference,placement:placement},"*");}catch(_){}},true);',
    'document.addEventListener("dragend",function(){if(__mockswapDragEl)__mockswapDragEl.removeAttribute("data-mockswap-dragging");__mockswapDragEl=null;clearDropMarker();},true);',
    'function keyboardMove(e){if(!window.__mockswapTextEditEnabled)return;if(e.ctrlKey||e.metaKey)return;if(e.key!=="ArrowUp"&&e.key!=="ArrowDown"&&e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;if(document.querySelector("[data-mockswap-editing]"))return;var selected=document.querySelector("[data-mockswap-selected]");if(!selected||!hasSource(selected))return;var step=e.shiftKey?10:(e.altKey?0.25:1);var dx=0,dy=0;if(e.key==="ArrowLeft")dx=-step;else if(e.key==="ArrowRight")dx=step;else if(e.key==="ArrowUp")dy=-step;else dy=step;var payload=selectionPayload(selected);if(!payload)return;if(!__mockswapNudgeSession||__mockswapNudgeSession.el!==selected){flushNudge();__mockswapNudgeSession={el:selected,selection:payload,dx:0,dy:0};}var cur=readTranslate(selected);writeTranslate(selected,cur.x+dx,cur.y+dy);__mockswapNudgeSession.dx=normPx(__mockswapNudgeSession.dx+dx);__mockswapNudgeSession.dy=normPx(__mockswapNudgeSession.dy+dy);e.preventDefault();e.stopPropagation();}',
    'document.addEventListener("keydown",keyboardMove,true);',
    'window.addEventListener("blur",flushNudge);',
    'window.addEventListener("message",function(e){var d=e.data;if(!d||typeof d!=="object")return;if(d.type===__clearSelectType){flushNudge();var cur=document.querySelector("[data-mockswap-selected]");if(cur)clearSelected(cur);return;}if(d.type!==__editModeType)return;window.__mockswapTextEditEnabled=!!d.enabled;document.documentElement.toggleAttribute("data-mockswap-text-edit",window.__mockswapTextEditEnabled);syncDraggables();if(!window.__mockswapTextEditEnabled){flushNudge();var editing=document.querySelector("[data-mockswap-editing]");if(editing)commit(editing);var selected=document.querySelector("[data-mockswap-selected]");if(selected)clearSelected(selected);if(__mockswapDragEl)__mockswapDragEl.removeAttribute("data-mockswap-dragging");__mockswapDragEl=null;clearDropMarker();}});',
    'document.addEventListener("dblclick",function(e){if(!window.__mockswapTextEditEnabled)return;var el=textTarget(e.target);if(!el)return;e.preventDefault();e.stopPropagation();var active=document.querySelector("[data-mockswap-editing]");if(active&&active!==el)commit(active);el.__mockswapOldText=clean(el.textContent);if(!el.__mockswapOldText)return;el.__mockswapEditing=true;el.setAttribute("data-mockswap-editing","true");el.contentEditable="true";el.focus();try{var r=document.createRange();r.selectNodeContents(el);var s=window.getSelection();s.removeAllRanges();s.addRange(r);}catch(_){}},true);',
    'document.addEventListener("focusout",function(e){var el=e.target;if(el&&el.__mockswapEditing)setTimeout(function(){commit(el);},0);},true);',
    'document.addEventListener("keydown",function(e){var el=e.target;if(!el||!el.__mockswapEditing)return;if(e.key==="Escape"){e.preventDefault();el.textContent=el.__mockswapOldText||"";commit(el);}else if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();commit(el);}},true);',
    'try{var st=document.createElement("style");st.setAttribute("data-mockswap-edit-style","");st.textContent="html[data-mockswap-text-edit] "+selectableSelector.split(",").join(",html[data-mockswap-text-edit] ")+"{cursor:crosshair!important} html[data-mockswap-text-edit] [draggable=true]{cursor:grab!important} [data-mockswap-hover]{outline:1px dashed #a78bfa!important;outline-offset:2px!important} [data-mockswap-selected],[data-mockswap-editing]{outline:2px solid #8b5cf6!important;outline-offset:2px!important;box-shadow:0 0 0 4px rgba(139,92,246,.18)!important} [data-mockswap-dragging]{opacity:.55!important} [data-mockswap-drop-before]{box-shadow:inset 0 3px 0 #22d3ee,0 0 0 4px rgba(34,211,238,.18)!important} [data-mockswap-drop-after]{box-shadow:inset 0 -3px 0 #22d3ee,0 0 0 4px rgba(34,211,238,.18)!important}";document.head&&document.head.appendChild(st);}catch(_){}',
    '})();',
  ].join('');

  const scriptTag = '<script data-mockswap-preview>' + body + '</script>';
  const headRe = /<head\b[^>]*>/i;
  if (headRe.test(instrumentedHtml)) return instrumentedHtml.replace(headRe, (m) => m + scriptTag);
  const htmlRe = /<html\b[^>]*>/i;
  if (htmlRe.test(instrumentedHtml)) return instrumentedHtml.replace(htmlRe, (m) => m + scriptTag);
  return scriptTag + instrumentedHtml;
}

const EDITABLE_SOURCE_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'a', 'button', 'span', 'li', 'label', 'small',
  'strong', 'em', 'figcaption', 'blockquote', 'img',
  'input', 'textarea', 'select',
  'section', 'article', 'header', 'footer', 'main', 'nav',
  'aside', 'form', 'fieldset', 'figure', 'div',
]);

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea']);

export function instrumentEditableMarkup(html: string): string {
  if (/data-mockswap-source-start=/.test(html)) return html;
  let out = '';
  let cursor = 0;
  let index = 0;

  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start === -1) break;

    if (html.startsWith('<!--', start)) {
      const endComment = html.indexOf('-->', start + 4);
      index = endComment === -1 ? html.length : endComment + 3;
      continue;
    }

    const tag = readHtmlTagAt(html, start);
    if (!tag) {
      index = start + 1;
      continue;
    }

    if (!tag.closing && EDITABLE_SOURCE_TAGS.has(tag.name)) {
      const raw = html.slice(tag.start, tag.end);
      if (!/\sdata-mockswap-source-start\s*=/.test(raw)) {
        out += html.slice(cursor, tag.insertAt);
        out += ` data-mockswap-source-start="${tag.start}" data-mockswap-source-end="${tag.end}"`;
        cursor = tag.insertAt;
      }
    }

    if (!tag.closing && RAW_TEXT_TAGS.has(tag.name)) {
      const closeRe = new RegExp(`</\\s*${tag.name}\\s*>`, 'i');
      const rest = html.slice(tag.end);
      const close = rest.search(closeRe);
      index = close === -1 ? tag.end : tag.end + close + rest.slice(close).match(closeRe)![0].length;
      continue;
    }

    index = tag.end;
  }

  if (cursor === 0) return html;
  return out + html.slice(cursor);
}

function readHtmlTagAt(source: string, start: number): null | {
  start: number;
  end: number;
  insertAt: number;
  name: string;
  closing: boolean;
} {
  if (source[start] !== '<') return null;
  const next = source[start + 1];
  if (!next || next === '!' || next === '?') return null;
  let pos = start + 1;
  let closing = false;
  if (source[pos] === '/') {
    closing = true;
    pos += 1;
  }
  while (/\s/.test(source[pos] ?? '')) pos += 1;
  const nameStart = pos;
  while (/[A-Za-z0-9:-]/.test(source[pos] ?? '')) pos += 1;
  if (pos === nameStart) return null;
  const name = source.slice(nameStart, pos).toLowerCase();
  const closeAt = findHtmlTagEnd(source, pos);
  if (closeAt === -1) return null;
  let insertAt = closeAt;
  let before = closeAt - 1;
  while (before > start && /\s/.test(source[before] ?? '')) before -= 1;
  if (source[before] === '/') insertAt = before;
  return { start, end: closeAt + 1, insertAt, name, closing };
}

function findHtmlTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

/**
 * JSON-encode a string for safe inclusion in a `<script>` body, additionally
 * escaping `<`/`>` so a crafted path can't terminate the script element early.
 */
function escapeForScript(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}
