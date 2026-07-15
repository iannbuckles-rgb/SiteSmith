import type { ZipEntryMeta } from '../types';
import type { ZipArchiveLike } from './archiveTypes';
import { guessMimeType } from './mime';
import { rewriteCssBody, rewriteHtml } from './urlRewriter';

/**
 * The result of preparing a project for in-iframe rendering:
 *   - `urls` maps every HTML file to a top-level preview blob URL.
 *     Subresources are embedded in that preview bootstrap and materialized
 *     as frame-owned blob URLs inside the sandboxed iframe.
 *   - `htmlPaths` is the alphabetised list of HTML files in the archive
 *     so the UI can show a page-switch dropdown.
 *   - `primaryPath` / `primaryUrl` are the chosen entry HTML.
 */
export interface PreviewIndex {
  urls: Map<string, string>;
  htmlPaths: string[];
  primaryPath: string;
  primaryUrl: string;
}

/** MIME types used when wrapping rewritten text blobs. */
const TEXT_MIMES = {
  html: 'text/html;charset=utf-8',
  css:  'text/css;charset=utf-8',
  js:   'text/javascript;charset=utf-8',
} as const;

interface SandboxAssetPayload {
  token: string;
  mime: string;
  base64: string;
  text: boolean;
}

/**
 * Reads every relevant zip entry and produces a `PreviewIndex`.
 *
 * Strategy:
 *   1. Non-HTML assets are embedded into each preview document bootstrap.
 *      CSS is still URL-rewritten; JS is passed through (we do not rewrite
 *      JS imports in v1).
 *   2. Each HTML file becomes a top-level blob URL that first creates
 *      frame-owned subresource blob URLs, then writes the real rewritten
 *      HTML into the sandboxed document.
 *
 * HTML→HTML navigation is handled out-of-band by the
 * MockupSwap navigation script injected into every HTML file.
 */
export async function buildPreviewIndex(
  zip: ZipArchiveLike,
  entries: ZipEntryMeta[],
): Promise<PreviewIndex> {
  const urls = new Map<string, string>();
  const htmlPaths: string[] = [];
  const assetTokens = new Map<string, string>();
  const assetPayloads: SandboxAssetPayload[] = [];

  for (const entry of entries) {
    if (entry.isDirectory || entry.category === 'html') continue;
    assetTokens.set(entry.path, tokenForPath(entry.path));
  }

  const lookupAssetToken = (resolved: string): string | undefined => assetTokens.get(resolved);

  // Pass 1: non-HTML assets. These are not exposed as parent-created blob
  // URLs because a sandboxed iframe without allow-same-origin cannot load
  // parent-origin blob subresources. The preview bootstrap recreates them
  // inside the frame's opaque origin instead.
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.category === 'html') continue;

    const file = zip.file(entry.path);
    if (!file) continue;
    const token = assetTokens.get(entry.path);
    if (!token) continue;

    try {
      if (entry.category === 'css') {
        const text = await file.async('text');
        const content = rewriteCssBody(text, entry.path, lookupAssetToken);
        assetPayloads.push({
          token,
          mime: guessMimeType(entry.name) ?? TEXT_MIMES.css,
          base64: textToBase64(content),
          text: true,
        });
      } else {
        const mime = guessMimeType(entry.name)
          ?? (entry.category === 'js' ? TEXT_MIMES.js : 'application/octet-stream');
        assetPayloads.push({
          token,
          mime,
          base64: await file.async('base64'),
          text: false,
        });
      }
    } catch {
      // Skip unreadable / binary-misclassified entries.
    }
  }

  // Pass 2: HTML. HTML files are intentionally absent from the asset-token
  // lookup so <a href> inter-page links continue to route through the
  // injected nav script instead of being rewritten directly to blob URLs.
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.category !== 'html') continue;

    const file = zip.file(entry.path);
    if (!file) continue;
    try {
      const text = await file.async('text');
      htmlPaths.push(entry.path);
      const content = rewriteHtml(text, entry.path, lookupAssetToken);
      const sandboxedDocument = buildSandboxedDocument(content, assetPayloads);
      const blob = new Blob([sandboxedDocument], { type: TEXT_MIMES.html });
      urls.set(entry.path, URL.createObjectURL(blob));
    } catch {
      // Skip unreadable entries silently.
    }
  }

  htmlPaths.sort((a, b) => a.localeCompare(b));
  const primaryPath = choosePrimaryHtml(htmlPaths);
  const primaryUrl = primaryPath ? urls.get(primaryPath) ?? '' : '';

  return { urls, htmlPaths, primaryPath, primaryUrl };
}

/* ---------------------------------------------------------------------------
 * Internals
 * -------------------------------------------------------------------------*/

/**
 * Pick the entry HTML file. Prefer the deploy root (`index.html`), then common
 * build-output roots (`dist/index.html`, `build/index.html`, `out/index.html`),
 * then the shallowest nested index. That keeps route pages like
 * `about/index.html` from becoming the preview's active website entry.
 */
export function choosePrimaryHtml(htmlPaths: string[]): string {
  if (htmlPaths.length === 0) return '';
  const sorted = [...htmlPaths].sort((a, b) => a.localeCompare(b));
  const rootIndex = sorted.find((p) => isRootIndexHtml(p));
  if (rootIndex) return rootIndex;

  const buildEntry = sorted.find((p) => isCommonBuildEntry(p));
  if (buildEntry) return buildEntry;

  const indexes = sorted.filter(isIndexHtml);
  if (indexes.length > 0) {
    indexes.sort((a, b) => segmentCount(a) - segmentCount(b) || a.localeCompare(b));
    return indexes[0];
  }

  return sorted[0];
}

function isIndexHtml(path: string): boolean {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  return base === 'index.html' || base === 'index.htm';
}

function isRootIndexHtml(path: string): boolean {
  return !path.includes('/') && isIndexHtml(path);
}

function isCommonBuildEntry(path: string): boolean {
  if (!isIndexHtml(path)) return false;
  const segments = path.split('/');
  if (segments.length < 2) return false;
  const dir = segments[segments.length - 2]?.toLowerCase();
  return dir === 'dist' || dir === 'build' || dir === 'out';
}

function segmentCount(path: string): number {
  return path.split('/').length;
}

function buildSandboxedDocument(html: string, assets: SandboxAssetPayload[]): string {
  const assetsJson = escapeJsonForScript(JSON.stringify(assets));
  const htmlLiteral = escapeForScriptLiteral(html);
  const bootstrap = [
    '<!doctype html><meta charset="utf-8"><script>',
    '(function(){',
    'var assets=' + assetsJson + ';',
    'var html=' + htmlLiteral + ';',
    'var urls=Object.create(null);',
    'function bytes(b64){var bin=atob(b64);var len=bin.length;var out=new Uint8Array(len);for(var i=0;i<len;i++){out[i]=bin.charCodeAt(i);}return out;}',
    'function text(b64){return new TextDecoder().decode(bytes(b64));}',
    'function replaceTokens(value){for(var i=0;i<assets.length;i++){var a=assets[i];var url=urls[a.token];if(url){value=value.split(a.token).join(url);}}return value;}',
    'for(var i=0;i<assets.length;i++){var a=assets[i];if(a.text)continue;urls[a.token]=URL.createObjectURL(new Blob([bytes(a.base64)],{type:a.mime}));}',
    'for(var j=0;j<assets.length;j++){var b=assets[j];if(!b.text)continue;urls[b.token]=URL.createObjectURL(new Blob([replaceTokens(text(b.base64))],{type:b.mime}));}',
    'document.open();document.write(replaceTokens(html));document.close();',
    '})();',
    '</script>',
  ].join('');
  return bootstrap;
}

function tokenForPath(path: string): string {
  return `__MOCKSWAP_ASSET_${base64UrlEncode(path)}__`;
}

function base64UrlEncode(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function textToBase64(value: string): string {
  return bytesToBase64(new TextEncoder().encode(value));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function escapeJsonForScript(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function escapeForScriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}
