import type {
  ImageDetection,
  ImageRiskReason,
  ImageStatus,
  ImageType,
  ZipEntryMeta,
} from '../types';
import type { ZipArchiveLike } from './archiveTypes';
import { throwIfAborted } from './cancellation';
import { findCssCommentRanges, replaceRangesWithWhitespace } from './sourceRanges';
import { classifyUrl, parseSrcset, resolveAgainst } from './urlResolver';

/**
 * Image vs non-image file extension filters. CSS `url(...)` matches pass
 * through `looksLikeImage` to suppress font and other-binary refs.
 *
 * Keep these as `i` regex — many sites use mixed-case extensions.
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)(\?|#|$)/i;
const NON_IMAGE_EXT = /\.(woff2?|ttf|eot|otf|pdf|mp4|webm|ogg|mp3|wav|json|xml|wasm)(\?|#|$)/i;

/** Concurrency for reading file text from JSZip. Keeps memory bounded. */
const READ_CONCURRENCY = 12;

/**
 * Run the full image-reference scan over an uploaded project and return a
 * sorted list of detections. Read failures (corrupt zip, unreadable binary
 * mistakenly classified as text) are silently skipped so one bad file
 * doesn't abort the rest of the scan.
 */
export async function detectImages(
  zip: ZipArchiveLike,
  entries: ZipEntryMeta[],
  options: { signal?: AbortSignal } = {},
): Promise<ImageDetection[]> {
  throwIfAborted(options.signal);
  // Case-insensitive lookup table for "does this resolved path actually
  // exist in the archive?". Built once; reused per detection.
  const lookup = buildLookup(entries);

  const html = entries.filter((e) => !e.isDirectory && e.category === 'html');
  const css = entries.filter((e) => !e.isDirectory && e.category === 'css');
  const manifest = entries.filter(
    (e) => !e.isDirectory && (e.name === 'manifest.json' || e.name.endsWith('.webmanifest')),
  );

  const texts = await readEntriesBatched(zip, [...html, ...css, ...manifest], options);
  throwIfAborted(options.signal);

  const raw: Omit<ImageDetection, 'status'>[] = [];
  for (const entry of html) {
    throwIfAborted(options.signal);
    const text = texts.get(entry.path);
    if (text != null) raw.push(...scanHtml(text, entry.path));
  }
  for (const entry of css) {
    throwIfAborted(options.signal);
    const text = texts.get(entry.path);
    if (text != null) raw.push(...scanCss(text, entry.path));
  }
  for (const entry of manifest) {
    throwIfAborted(options.signal);
    const text = texts.get(entry.path);
    if (text != null) raw.push(...scanManifest(text, entry.path));
  }

  // Resolve + classify status, dedupe and sort.
  const dedupKey = new Set<string>();
  const out: ImageDetection[] = [];
  for (const detection of raw) {
    throwIfAborted(options.signal);
    const r = resolveAgainst(detection.sourceFile, detection.rawUrl);
    const resolved = r.isRemote ? '' : r.resolvedPath;
    const status: ImageStatus = r.isRemote
      ? 'remote'
      : resolved && lookup.has(resolved.toLowerCase())
        ? 'ok'
        : 'missing';

    const key = [
      detection.sourceFile,
      detection.sourceTag,
      detection.sourceAttr,
      detection.rawUrl,
      resolved,
      status,
    ].join('|');
    if (dedupKey.has(key)) continue;
    dedupKey.add(key);

    const riskReason: ImageRiskReason | undefined =
      status === 'remote' ? classifyRiskReason(detection.rawUrl) : undefined;

    out.push({ ...detection, resolvedPath: resolved, status, riskReason });
  }

  out.sort(sortDetections);
  return out;
}

/**
 * Conservative sub-classifier for "remote and risky" urls. Manus mockups
 * and generic CDN hotlinks routinely fail in static deployments because
 * the host either disables hot-linking or serves different origins. A URL
 * we're confident is served from the same origin as the zip is left
 * `undefined` even when `status === 'remote'`.
 */
function classifyRiskReason(rawUrl: string): ImageRiskReason | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed) return undefined;
  if (/^blob:/i.test(trimmed)) return 'blob-self';
  if (/^https?:\/\//i.test(trimmed)) {
    if (/manus/i.test(trimmed)) return 'manus';
    if (/cdn/i.test(trimmed)) return 'cdn';
    return 'cross-origin-http';
  }
  if (/^\/\//.test(trimmed)) return 'protocol-relative';
  return undefined;
}

/* ---------------------------------------------------------------------------
 * Lower-level scanners
 * -------------------------------------------------------------------------*/

interface TypeHints {
  tagName?: string;
  cssProperty?: string;
  fromManifest?: boolean;
  rel?: string;
}

/**
 * Type heuristic. Precedence: explicit context > filename regex > fallback.
 * The same logic is used by HTML, CSS, and manifest scanners.
 */
function guessImageType(rawUrl: string, hints: TypeHints = {}): ImageType {
  if (hints.rel && /icon/i.test(hints.rel)) return 'favicon';
  if (hints.fromManifest) return 'favicon';
  if (hints.cssProperty) {
    const p = hints.cssProperty.toLowerCase();
    if (/(background|bg)/.test(p)) return 'background';
    if (/(mask|cursor|list-style)/.test(p)) return 'icon';
  }
  if (hints.tagName === 'source' || hints.tagName === 'picture') return 'hero';

  const fname = (rawUrl.split('/').pop() || '').toLowerCase().split('?')[0].split('#')[0];
  if (/hero|banner/.test(fname)) return 'hero';
  if (/logo/.test(fname)) return 'logo';
  if (/avatar|portrait|service|product/.test(fname)) return 'service';
  if (/bg|background/.test(fname)) return 'background';
  if (/sprite|icon/.test(fname)) return 'icon';
  if (/favicon|apple-touch-icon|app-icon/.test(fname)) return 'favicon';
  return 'unknown';
}

function scanHtml(html: string, sourceFile: string): Omit<ImageDetection, 'status'>[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: Omit<ImageDetection, 'status'>[] = [];
  const seen = new Set<string>();
  const push = (d: Omit<ImageDetection, 'status'>) => {
    const key = `${d.sourceKind}|${d.sourceFile}|${d.sourceTag}|${d.sourceAttr}|${d.rawUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    if (isIgnoredHtmlContext(img)) continue;

    const src = img.getAttribute('src');
    if (src) {
      push({
        rawUrl: src,
        resolvedPath: '',
        type: guessImageType(src, { tagName: 'img' }),
        sourceKind: 'html',
        sourceFile,
        sourceTag: 'img',
        sourceAttr: 'src',
      });
    }

    const srcset = img.getAttribute('srcset');
    if (srcset) {
      for (const candidate of parseSrcset(srcset)) {
        if (!candidate) continue;
        if (classifyUrl(candidate) === 'remote' && !looksLikeImage(candidate)) continue;
        push({
          rawUrl: candidate,
          resolvedPath: '',
          type: guessImageType(candidate, { tagName: 'img' }),
          sourceKind: 'html',
          sourceFile,
          sourceTag: 'img',
          sourceAttr: 'srcset',
        });
      }
    }
  }

  for (const source of Array.from(doc.querySelectorAll('source'))) {
    if (isIgnoredHtmlContext(source)) continue;

    const srcset = source.getAttribute('srcset');
    if (!srcset) continue;
    for (const candidate of parseSrcset(srcset)) {
      if (!candidate) continue;
      if (classifyUrl(candidate) === 'remote' && !looksLikeImage(candidate)) continue;
      push({
        rawUrl: candidate,
        resolvedPath: '',
        type: guessImageType(candidate, { tagName: 'source' }),
        sourceKind: 'html',
        sourceFile,
        sourceTag: 'source',
        sourceAttr: 'srcset',
      });
    }
  }

  for (const link of Array.from(doc.querySelectorAll('link'))) {
    if (isIgnoredHtmlContext(link)) continue;

    const rel = (link.getAttribute('rel') || '').toLowerCase();
    const href = link.getAttribute('href');
    if (href && /icon/.test(rel)) {
      push({
        rawUrl: href,
        resolvedPath: '',
        type: guessImageType(href, { rel }),
        sourceKind: 'html',
        sourceFile,
        sourceTag: 'link',
        sourceAttr: 'href',
        extra: { rel, sizes: link.getAttribute('sizes') ?? undefined },
      });
    }
  }

  for (const meta of Array.from(doc.querySelectorAll('meta'))) {
    if (isIgnoredHtmlContext(meta)) continue;

    const property = (meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase();
    const content = meta.getAttribute('content');
    if (!content) continue;
    const isOg =
      property === 'og:image' ||
      property === 'og:image:url' ||
      property === 'og:image:secure_url';
    const isTwitter =
      property === 'twitter:image' || property === 'twitter:image:src';
    if (isOg || isTwitter) {
      push({
        rawUrl: content,
        resolvedPath: '',
        type: 'social',
        sourceKind: 'html',
        sourceFile,
        sourceTag: 'meta',
        sourceAttr: 'content',
        extra: { property },
      });
    }
  }

  return out;
}

function scanCss(css: string, sourceFile: string): Omit<ImageDetection, 'status'>[] {
  const text = replaceRangesWithWhitespace(css, findCssCommentRanges(css));
  const out: Omit<ImageDetection, 'status'>[] = [];
  const seen = new Set<string>();
  const push = (d: Omit<ImageDetection, 'status'>, idx: number) => {
    const key = `${d.sourceFile}|url|${idx}|${d.rawUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  const urlRe = /url\(\s*(['"]?)([^)'"]*?)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    const ref = m[2].trim();
    if (!ref) continue;
    if (/^(data):/i.test(ref)) continue; // data URIs aren't file-based images

    const cssProperty = nearestCssProperty(text, m.index);
    const isRemote = classifyUrl(ref) === 'remote';
    if (!isRemote && NON_IMAGE_EXT.test(ref)) continue; // skip fonts/etc

    push(
      {
        rawUrl: ref,
        resolvedPath: '',
        type: guessImageType(ref, { cssProperty }),
        sourceKind: 'css',
        sourceFile,
        sourceTag: 'url',
        sourceAttr: 'url',
        extra: { cssProperty },
      },
      m.index,
    );
  }

  return out;
}

function scanManifest(
  text: string,
  sourceFile: string,
): Omit<ImageDetection, 'status'>[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [];
  }
  if (!manifest || typeof manifest !== 'object') return [];
  const m = manifest as { icons?: unknown; icon?: unknown };
  const out: Omit<ImageDetection, 'status'>[] = [];

  if (Array.isArray(m.icons)) {
    for (const icon of m.icons) {
      if (icon && typeof icon === 'object' && 'src' in icon &&
          typeof (icon as { src: unknown }).src === 'string') {
        const sizes = (icon as { sizes?: unknown }).sizes;
        out.push({
          rawUrl: (icon as { src: string }).src,
          resolvedPath: '',
          type: guessImageType((icon as { src: string }).src, { fromManifest: true }),
          sourceKind: 'manifest',
          sourceFile,
          sourceTag: 'icon',
          sourceAttr: 'src',
          extra: { sizes: typeof sizes === 'string' ? sizes : undefined },
        });
      }
    }
  }
  if (typeof m.icon === 'string') {
    out.push({
      rawUrl: m.icon,
      resolvedPath: '',
      type: guessImageType(m.icon, { fromManifest: true }),
      sourceKind: 'manifest',
      sourceFile,
      sourceTag: 'icon',
      sourceAttr: 'icon',
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------*/

function looksLikeImage(rawUrl: string): boolean {
  // Strip query/fragment for the extension check.
  const path = rawUrl.split('?')[0].split('#')[0];
  return IMAGE_EXT.test(path);
}

function isIgnoredHtmlContext(element: Element): boolean {
  return element.closest('template,noscript') !== null;
}

/**
 * Walks backwards from a url() index to find the most recent CSS property
 * name for that value. Best-effort: tabs/newlines don't matter; CSS is
 * matched as a flat string. Returns the property name (lowercase) or
 * undefined if it can't be determined.
 */
function nearestCssProperty(text: string, urlIndex: number): string | undefined {
  const before = text.slice(0, urlIndex);
  const boundary = Math.max(
    before.lastIndexOf(';'),
    before.lastIndexOf('{'),
    before.lastIndexOf('}'),
  );
  const start = boundary < 0 ? 0 : boundary + 1;
  const chunk = before.slice(start);
  const match = chunk.match(/([a-zA-Z-][a-zA-Z0-9-]*)\s*:\s*[^;{}]*$/);
  return match?.[1].toLowerCase();
}

function buildLookup(entries: ZipEntryMeta[]): Set<string> {
  const set = new Set<string>();
  for (const e of entries) {
    if (!e.isDirectory) set.add(e.path.toLowerCase());
  }
  return set;
}

/**
 * Reads `entries` from JSZip in batches to keep peak memory bounded.
 * Returns a map keyed by zip path; missing entries are simply absent.
 */
async function readEntriesBatched(
  zip: ZipArchiveLike,
  entries: ZipEntryMeta[],
  options: { signal?: AbortSignal } = {},
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < entries.length; i += READ_CONCURRENCY) {
    throwIfAborted(options.signal);
    const batch = entries.slice(i, i + READ_CONCURRENCY);
    await Promise.all(
      batch.map(async (entry) => {
        throwIfAborted(options.signal);
        const file = zip.file(entry.path);
        if (!file) return;
        try {
          const text = await file.async('text');
          throwIfAborted(options.signal);
          map.set(entry.path, text);
        } catch {
          throwIfAborted(options.signal);
          // Skip un-decodable entries silently.
        }
      }),
    );
    throwIfAborted(options.signal);
  }
  return map;
}

/* ---------------------------------------------------------------------------
 * Sorting
 * -------------------------------------------------------------------------*/

const STATUS_RANK: Record<ImageStatus, number> = { missing: 0, remote: 1, ok: 2 };
const TYPE_RANK: Record<ImageType, number> = {
  favicon: 0,
  logo: 1,
  hero: 2,
  social: 3,
  service: 4,
  icon: 5,
  background: 6,
  unknown: 7,
};

function sortDetections(a: ImageDetection, b: ImageDetection): number {
  const sDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (sDiff !== 0) return sDiff;
  const tDiff = TYPE_RANK[a.type] - TYPE_RANK[b.type];
  if (tDiff !== 0) return tDiff;
  const fDiff = a.sourceFile.localeCompare(b.sourceFile);
  if (fDiff !== 0) return fDiff;
  return a.rawUrl.localeCompare(b.rawUrl);
}
