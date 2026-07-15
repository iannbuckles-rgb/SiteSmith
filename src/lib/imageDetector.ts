import type {
  ImageDetection,
  ImageRiskReason,
  ImageStatus,
  ImageType,
  ZipEntryMeta,
} from '../types';
import type { ZipArchiveLike } from './archiveTypes';
import { throwIfAborted } from './cancellation';
import { findImageSetFunctions } from './cssFunctions';
import {
  isScriptSourcePath,
  isTemplateSourcePath,
  looksLikeImagePath,
  looksLikeKnownNonImagePath,
} from './fileTypes';
import { findCssCommentRanges, replaceRangesWithWhitespace } from './sourceRanges';
import { classifyUrl, parseSrcset, resolveAgainst } from './urlResolver';

/**
 * Image vs non-image file extension filters. CSS `url(...)` matches pass
 * through `looksLikeImage` to suppress font and other-binary refs.
 *
 * Keep these as `i` regex — many sites use mixed-case extensions.
 */
/** Concurrency for reading file text from JSZip. Keeps memory bounded. */
const READ_CONCURRENCY = 12;

const HTML_IMAGE_ATTRS = [
  'src',
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-lazy',
  'data-bg',
  'data-background',
  'data-image',
  'data-image-src',
  'data-original-src',
  'data-src-retina',
  'data-flickity-lazyload',
  'data-zoom-image',
  'data-thumb',
  'data-full',
  'data-large',
] as const;

const HTML_SRCSET_ATTRS = [
  'srcset',
  'data-srcset',
  'data-lazy-srcset',
] as const;

const LINK_IMAGE_RELS = /(^|\s)(?:icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon|image_src|preload)(\s|$)/i;

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
  const code = entries.filter((e) => !e.isDirectory && isScriptSourcePath(e.path));
  const templates = entries.filter((e) => !e.isDirectory && isTemplateSourcePath(e.path));
  const manifest = entries.filter(
    (e) => {
      const name = e.name.toLowerCase();
      return !e.isDirectory && (name === 'manifest.json' || name.endsWith('.webmanifest'));
    },
  );

  const texts = await readEntriesBatched(zip, [...html, ...css, ...code, ...templates, ...manifest], options);
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
  for (const entry of code) {
    throwIfAborted(options.signal);
    const text = texts.get(entry.path);
    if (text != null) raw.push(...scanCode(text, entry.path));
  }
  for (const entry of templates) {
    throwIfAborted(options.signal);
    const text = texts.get(entry.path);
    if (text != null) {
      const exposedMarkup = text.replace(/<\/?(?:template|noscript)\b[^>]*>/gi, '');
      raw.push(...scanHtml(exposedMarkup, entry.path, { includeInertContent: true }));
    }
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
  attrName?: string;
  rel?: string;
}

/**
 * Type heuristic. Precedence: explicit context > filename regex > fallback.
 * The same logic is used by HTML, CSS, and manifest scanners.
 */
function guessImageType(rawUrl: string, hints: TypeHints = {}): ImageType {
  if (hints.rel && /icon/i.test(hints.rel)) return 'favicon';
  if (hints.fromManifest) return 'favicon';
  if (hints.attrName === 'poster') return 'hero';
  if (hints.cssProperty) {
    const p = hints.cssProperty.toLowerCase();
    if (/(background|bg)/.test(p)) return 'background';
    if (/(mask|cursor|list-style)/.test(p)) return 'icon';
  }
  if (hints.tagName === 'source' || hints.tagName === 'picture') return 'hero';
  if (hints.tagName === 'input') return 'icon';

  const fname = (rawUrl.split('/').pop() || '').toLowerCase().split('?')[0].split('#')[0];
  if (/hero|banner/.test(fname)) return 'hero';
  if (/logo/.test(fname)) return 'logo';
  if (/avatar|portrait|service|product/.test(fname)) return 'service';
  if (/bg|background/.test(fname)) return 'background';
  if (/sprite|icon/.test(fname)) return 'icon';
  if (/favicon|apple-touch-icon|app-icon/.test(fname)) return 'favicon';
  return 'unknown';
}

function scanHtml(
  html: string,
  sourceFile: string,
  options: { includeInertContent?: boolean } = {},
): Omit<ImageDetection, 'status'>[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: Omit<ImageDetection, 'status'>[] = [];
  const seen = new Set<string>();
  const push = (d: Omit<ImageDetection, 'status'>) => {
    const key = `${d.sourceKind}|${d.sourceFile}|${d.sourceTag}|${d.sourceAttr}|${d.rawUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };
  const pushAttr = (
    element: Element,
    attrName: string,
    rawUrl: string | null,
    typeOverride?: ImageType,
    extra?: Omit<NonNullable<ImageDetection['extra']>, 'cssProperty'>,
  ) => {
    if (!rawUrl || !shouldKeepImageRef(rawUrl)) return;
    const tagName = element.tagName.toLowerCase();
    push({
      rawUrl,
      resolvedPath: '',
      type: typeOverride ?? guessImageType(rawUrl, { tagName, attrName }),
      sourceKind: 'html',
      sourceFile,
      sourceTag: tagName,
      sourceAttr: attrName,
      extra,
    });
  };
  const pushSrcset = (element: Element, attrName: string, srcset: string | null) => {
    if (!srcset) return;
    const tagName = element.tagName.toLowerCase();
    for (const candidate of parseSrcset(srcset)) {
      if (!candidate || !shouldKeepImageRef(candidate)) continue;
      push({
        rawUrl: candidate,
        resolvedPath: '',
        type: guessImageType(candidate, { tagName, attrName }),
        sourceKind: 'html',
        sourceFile,
        sourceTag: tagName,
        sourceAttr: attrName,
      });
    }
  };

  for (const img of Array.from(doc.querySelectorAll('img'))) {
    if (!options.includeInertContent && isIgnoredHtmlContext(img)) continue;

    for (const attr of HTML_IMAGE_ATTRS) pushAttr(img, attr, img.getAttribute(attr));
    for (const attr of HTML_SRCSET_ATTRS) pushSrcset(img, attr, img.getAttribute(attr));
  }

  for (const source of Array.from(doc.querySelectorAll('source'))) {
    if (!options.includeInertContent && isIgnoredHtmlContext(source)) continue;

    const src = source.getAttribute('src');
    if (source.closest('picture') || (src && looksLikeImage(src))) pushAttr(source, 'src', src);
    for (const attr of HTML_SRCSET_ATTRS) pushSrcset(source, attr, source.getAttribute(attr));
  }

  for (const link of Array.from(doc.querySelectorAll('link'))) {
    if (!options.includeInertContent && isIgnoredHtmlContext(link)) continue;

    const rel = (link.getAttribute('rel') || '').toLowerCase();
    const as = (link.getAttribute('as') || '').toLowerCase();
    const href = link.getAttribute('href');
    const isPreloadedImage = /\bpreload\b/.test(rel) && as === 'image';
    if (!href || (!LINK_IMAGE_RELS.test(rel) && !isPreloadedImage)) continue;
    if (!shouldKeepImageRef(href)) continue;
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

  for (const meta of Array.from(doc.querySelectorAll('meta'))) {
    if (!options.includeInertContent && isIgnoredHtmlContext(meta)) continue;

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
      if (!shouldKeepImageRef(content)) continue;
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

  for (const video of Array.from(doc.querySelectorAll('video'))) {
    if (!options.includeInertContent && isIgnoredHtmlContext(video)) continue;
    pushAttr(video, 'poster', video.getAttribute('poster'), 'hero');
  }

  for (const input of Array.from(doc.querySelectorAll('input'))) {
    if (!options.includeInertContent && isIgnoredHtmlContext(input)) continue;
    if ((input.getAttribute('type') || '').toLowerCase() !== 'image') continue;
    pushAttr(input, 'src', input.getAttribute('src'), 'icon');
  }

  for (const object of Array.from(doc.querySelectorAll('object'))) {
    if (!options.includeInertContent && isIgnoredHtmlContext(object)) continue;
    const data = object.getAttribute('data');
    if (data && looksLikeImage(data)) pushAttr(object, 'data', data);
  }

  for (const embed of Array.from(doc.querySelectorAll('embed'))) {
    if (!options.includeInertContent && isIgnoredHtmlContext(embed)) continue;
    const src = embed.getAttribute('src');
    if (src && looksLikeImage(src)) pushAttr(embed, 'src', src);
  }

  for (const image of Array.from(doc.querySelectorAll('image,feimage'))) {
    if (!options.includeInertContent && isIgnoredHtmlContext(image)) continue;
    pushAttr(image, 'href', image.getAttribute('href'));
    pushAttr(image, 'xlink:href', image.getAttribute('xlink:href'));
  }

  for (const element of Array.from(doc.querySelectorAll('[style]'))) {
    if (!options.includeInertContent && isIgnoredHtmlContext(element)) continue;
    const style = element.getAttribute('style');
    if (!style) continue;
    const tagName = element.tagName.toLowerCase();
    for (const detection of scanCss(style, sourceFile)) {
      push({
        ...detection,
        type: guessImageType(detection.rawUrl, {
          tagName,
          attrName: 'style',
          cssProperty: detection.extra?.cssProperty,
        }),
        sourceKind: 'html',
        sourceTag: tagName,
        sourceAttr: 'style',
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
    if (!shouldKeepImageRef(ref)) continue;

    const cssProperty = nearestCssProperty(text, m.index);
    if (cssProperty === 'src' && !looksLikeImage(ref)) continue;

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

  // CSS Images allows quoted strings directly inside image-set(), without a
  // surrounding url(). Those candidates are common in responsive exports and
  // need their own scan/rewrite path.
  for (const range of findImageSetFunctions(text)) {
    const body = text.slice(range.bodyStart, range.bodyEnd);
    const stringRe = /(['"])([^'"]+)\1/g;
    let stringMatch: RegExpExecArray | null;
    while ((stringMatch = stringRe.exec(body)) !== null) {
      if (/url\(\s*$/i.test(body.slice(0, stringMatch.index))) continue;
      const ref = stringMatch[2].trim();
      if (!looksLikeImage(ref) || !shouldKeepImageRef(ref)) continue;
      const absoluteOffset = range.bodyStart + stringMatch.index;
      const cssProperty = nearestCssProperty(text, absoluteOffset);
      push(
        {
          rawUrl: ref,
          resolvedPath: '',
          type: guessImageType(ref, { cssProperty }),
          sourceKind: 'css',
          sourceFile,
          sourceTag: 'image-set',
          sourceAttr: 'string',
          extra: { cssProperty },
        },
        absoluteOffset,
      );
    }
  }

  return out;
}

/**
 * Conservatively scan JavaScript/TypeScript (including JSX/TSX) for literal
 * asset references that remain safe to rewrite without a framework parser.
 * Dynamic expressions are intentionally excluded. Supported forms include
 * static imports/require, `new URL(..., import.meta.url)`, fetch literals,
 * static JSX image attributes, and CSS `url(...)` inside CSS-in-JS strings.
 */
function scanCode(code: string, sourceFile: string): Omit<ImageDetection, 'status'>[] {
  const text = maskCodeComments(code);
  const out: Omit<ImageDetection, 'status'>[] = [];
  const seen = new Set<string>();
  const push = (
    rawUrl: string,
    sourceTag: string,
    sourceAttr: string,
    hints: TypeHints = {},
  ) => {
    const ref = rawUrl.trim();
    if (!looksLikeImagePath(ref) || !shouldKeepImageRef(ref)) return;
    const key = `${sourceTag}|${sourceAttr}|${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      rawUrl: ref,
      resolvedPath: '',
      type: guessImageType(ref, hints),
      sourceKind: 'code',
      sourceFile,
      sourceTag,
      sourceAttr,
    });
  };

  const literalPatterns: Array<{
    tag: string;
    attr: string;
    regex: RegExp;
  }> = [
    {
      tag: 'new-url',
      attr: 'url',
      regex: /\bnew\s+URL\s*\(\s*(['"`])([^'"`\r\n]+)\1\s*,\s*import\.meta\.url\s*\)/g,
    },
    {
      tag: 'require',
      attr: 'source',
      regex: /\brequire\s*\(\s*(['"`])([^'"`\r\n]+)\1\s*\)/g,
    },
    {
      tag: 'import',
      attr: 'source',
      regex: /\bimport\s*\(\s*(['"`])([^'"`\r\n]+)\1\s*\)/g,
    },
    {
      tag: 'import',
      attr: 'source',
      regex: /\b(?:import|export)\s+(?:[^;\r\n]*?\s+from\s+)?(['"])([^'"\r\n]+)\1/g,
    },
    {
      tag: 'fetch',
      attr: 'url',
      regex: /\bfetch\s*\(\s*(['"`])([^'"`\r\n]+)\1/g,
    },
  ];
  for (const { tag, attr, regex } of literalPatterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) push(match[2], tag, attr);
  }

  const jsxTagRe = /<(img|source|video|input|image|feimage|link|meta|object|embed)\b([^<>]*?)\/?\s*>/gi;
  const jsxAttrRe = /\b(srcset|src|poster|href|xlink:href|content|data|data-src|data-lazy-src|data-original|data-original-src|style)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = jsxTagRe.exec(text)) !== null) {
    const tagName = tagMatch[1].toLowerCase();
    const attrs = tagMatch[2];
    jsxAttrRe.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = jsxAttrRe.exec(attrs)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? attrMatch[5] ?? '';
      if (attrName === 'srcset') {
        for (const candidate of parseSrcset(value)) {
          push(candidate, tagName, attrName, { tagName, attrName });
        }
      } else if (attrName === 'style') {
        for (const detection of scanCss(value, sourceFile)) {
          push(detection.rawUrl, tagName, attrName, {
            tagName,
            attrName,
            cssProperty: detection.extra?.cssProperty,
          });
        }
      } else {
        push(value, tagName, attrName, { tagName, attrName });
      }
    }
  }

  for (const detection of scanCss(text, sourceFile)) {
    push(
      detection.rawUrl,
      detection.sourceTag,
      detection.sourceAttr,
      { cssProperty: detection.extra?.cssProperty },
    );
  }
  return out;
}

/** Replace comment bytes with spaces while preserving strings, templates, and
 * line breaks. This keeps regex offsets stable and prevents commented examples
 * from becoming actionable detections. */
function maskCodeComments(code: string): string {
  const chars = [...code];
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const next = chars[i + 1];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && next === '/') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < chars.length && chars[i] !== '\n' && chars[i] !== '\r') {
        chars[i] = ' ';
        i += 1;
      }
      i -= 1;
      continue;
    }
    if (char === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < chars.length) {
        if (chars[i] === '*' && chars[i + 1] === '/') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 1;
          break;
        }
        if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
        i += 1;
      }
    }
  }
  return chars.join('');
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
  const m = manifest as {
    icons?: unknown;
    icon?: unknown;
    screenshots?: unknown;
    shortcuts?: unknown;
  };
  const out: Omit<ImageDetection, 'status'>[] = [];
  const push = (
    rawUrl: string,
    sourceTag: string,
    sourceAttr: string,
    manifestPath: string,
    sizes?: unknown,
  ) => {
    if (!shouldKeepImageRef(rawUrl)) return;
    out.push({
      rawUrl,
      resolvedPath: '',
      type: sourceTag === 'screenshot'
        ? 'hero'
        : guessImageType(rawUrl, { fromManifest: true }),
      sourceKind: 'manifest',
      sourceFile,
      sourceTag,
      sourceAttr,
      extra: {
        sizes: typeof sizes === 'string' ? sizes : undefined,
        manifestPath,
      },
    });
  };

  if (Array.isArray(m.icons)) {
    for (const [index, icon] of m.icons.entries()) {
      if (icon && typeof icon === 'object' && 'src' in icon &&
          typeof (icon as { src: unknown }).src === 'string') {
        push((icon as { src: string }).src, 'icon', 'src', `icons.${index}.src`, (icon as { sizes?: unknown }).sizes);
      }
    }
  }
  if (typeof m.icon === 'string') {
    push(m.icon, 'icon', 'icon', 'icon');
  }
  if (Array.isArray(m.screenshots)) {
    for (const [index, screenshot] of m.screenshots.entries()) {
      if (screenshot && typeof screenshot === 'object' && 'src' in screenshot &&
          typeof (screenshot as { src: unknown }).src === 'string') {
        push((screenshot as { src: string }).src, 'screenshot', 'src', `screenshots.${index}.src`, (screenshot as { sizes?: unknown }).sizes);
      }
    }
  }
  if (Array.isArray(m.shortcuts)) {
    for (const [shortcutIndex, shortcut] of m.shortcuts.entries()) {
      if (!shortcut || typeof shortcut !== 'object') continue;
      const icons = (shortcut as { icons?: unknown }).icons;
      if (!Array.isArray(icons)) continue;
      for (const [iconIndex, icon] of icons.entries()) {
        if (icon && typeof icon === 'object' && 'src' in icon &&
            typeof (icon as { src: unknown }).src === 'string') {
          push(
            (icon as { src: string }).src,
            'shortcut-icon',
            'src',
            `shortcuts.${shortcutIndex}.icons.${iconIndex}.src`,
            (icon as { sizes?: unknown }).sizes,
          );
        }
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------*/

function looksLikeImage(rawUrl: string): boolean {
  return looksLikeImagePath(rawUrl);
}

function shouldKeepImageRef(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (
    /^\{[\s\S]*\}$/.test(trimmed)
    || /\{\{|\}\}|\$\{|<\?|\?>|<%|%>/.test(trimmed)
  ) return false;
  if (/^(data|mailto|tel|javascript):/i.test(trimmed)) return false;
  if (/^#/.test(trimmed)) return false;
  if (looksLikeKnownNonImagePath(trimmed)) return false;
  const kind = classifyUrl(trimmed);
  if (kind === 'remote' && /^(data|mailto|tel|javascript):/i.test(trimmed)) return false;
  return true;
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
