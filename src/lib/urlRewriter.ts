import { resolveAgainst } from './urlResolver';
import { findCssCommentRanges, findHtmlCommentRanges, isOffsetInRanges } from './sourceRanges';

/**
 * URL-attribute allowlist for HTML rewriting. `srcset` and `style` are
 * handled specially and are NOT in this set.
 *
 * We deliberately omit `data-*` to avoid second-guessing frameworks. If a
 * specific site needs `data-src` or `data-bg` rewriting, that's a future
 * per-site toggle, not a default.
 */
const URL_ATTRS = new Set([
  'href', 'src', 'action', 'formaction', 'cite', 'longdesc',
  'usemap', 'background', 'poster', 'data', 'codebase', 'ping',
  'xlink:href',
]);

const ATTR_RE = /\b([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const CSS_URL_RE = /url\(\s*(['"]?)([^)'"\s]*?)\1\s*\)/g;

/** Looks up a resolved zip path and returns its blob URL, or undefined. */
export type UrlLookup = (resolvedPath: string) => string | undefined;

/**
 * Rewrites an HTML file in place: rewrites relative URL refs to blob URLs
 * and injects the MockupSwap navigation script that routes `<a href>`
 * clicks back to the parent via `postMessage`.
 */
export function rewriteHtml(
  html: string,
  sourcePath: string,
  lookup: UrlLookup,
): string {
  // Inject nav script first so it sees clicks before any other click handler.
  let result = injectNavScript(html, sourcePath);

  // Rewrite attributes.
  const htmlCommentRanges = findHtmlCommentRanges(result);
  result = result.replace(ATTR_RE, (match, name, q1, q2, q3, offset) => {
    if (isOffsetInRanges(offset, htmlCommentRanges)) return match;

    const lower = name.toLowerCase();
    const quote = q1 != null ? '"' : q2 != null ? "'" : '';

    if (lower === 'srcset') {
      return `${name}=${quote}${rewriteSrcsetValue(valueOf(q1, q2, q3), sourcePath, lookup)}${quote}`;
    }
    if (lower === 'style') {
      const raw = valueOf(q1, q2, q3);
      const rewritten = rewriteCssBody(raw, sourcePath, lookup);
      if (rewritten === raw) return match;
      return `${name}=${quote}${rewritten}${quote}`;
    }
    if (URL_ATTRS.has(lower)) {
      const raw = valueOf(q1, q2, q3);
      const rewritten = rewriteSingleUrl(raw, sourcePath, lookup);
      if (rewritten === null) return match;
      return `${name}=${quote}${rewritten}${quote}`;
    }
    return match;
  });

  // Rewrite url() inside inline <style>...</style> blocks.
  const styleCommentRanges = findHtmlCommentRanges(result);
  result = result.replace(STYLE_BLOCK_RE, (match, body, offset) => {
    if (isOffsetInRanges(offset, styleCommentRanges)) return match;

    const rewritten = rewriteCssBody(body, sourcePath, lookup);
    if (rewritten === body) return match;
    return match.replace(body, rewritten);
  });

  return result;
}

/**
 * Rewrites a CSS file by replacing every `url(...)` reference with the
 * corresponding blob URL (preserving quotes and query/fragment).
 */
export function rewriteCssBody(
  css: string,
  sourcePath: string,
  lookup: UrlLookup,
): string {
  const cssCommentRanges = findCssCommentRanges(css);

  return css.replace(CSS_URL_RE, (match, q, ref, offset) => {
    if (isOffsetInRanges(offset, cssCommentRanges)) return match;
    if (!ref) return match;
    const blobUrl = rewriteSingleUrl(ref, sourcePath, lookup);
    if (blobUrl === null) return match;
    return `url(${q}${blobUrl}${q})`;
  });
}

/* ---------------------------------------------------------------------------
 * Internals
 * -------------------------------------------------------------------------*/

function valueOf(q1: string | undefined, q2: string | undefined, q3: string | undefined): string {
  return q1 ?? q2 ?? q3 ?? '';
}

function isAbsoluteOrSpecial(value: string): boolean {
  return /^(?:https?:|\/\/|data:|blob:|mailto:|tel:|javascript:|#)/i.test(value);
}

interface Split { base: string; suffix: string; }

function splitQueryFragment(value: string): Split {
  const qIdx = value.indexOf('?');
  const hIdx = value.indexOf('#');
  if (qIdx === -1 && hIdx === -1) return { base: value, suffix: '' };
  const cutAt = Math.min(
    qIdx === -1 ? Infinity : qIdx,
    hIdx === -1 ? Infinity : hIdx,
  );
  return { base: value.slice(0, cutAt), suffix: value.slice(cutAt) };
}

/**
 * Resolves `ref` against `sourcePath` and returns the blob URL with its
 * query/fragment preserved, or `null` if the URL is external / non-local
 * / not in the zip (we leave those alone).
 */
function rewriteSingleUrl(
  ref: string,
  sourcePath: string,
  lookup: UrlLookup,
): string | null {
  const { base, suffix } = splitQueryFragment(ref);
  if (!base) return null;
  if (isAbsoluteOrSpecial(base)) return null;

  const r = resolveAgainst(sourcePath, base);
  if (r.isRemote || !r.resolvedPath) return null;
  const blob = lookup(r.resolvedPath);
  if (!blob) return null;
  // Blob URLs never contain `)`, so embedding them in `url(...)` is safe.
  return blob + suffix;
}

function rewriteSrcsetValue(
  value: string,
  sourcePath: string,
  lookup: UrlLookup,
): string {
  return value
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const tokens = trimmed.split(/\s+/);
      const firstToken = tokens[0];
      if (!firstToken) return part;
      const replaced = rewriteSingleUrl(firstToken, sourcePath, lookup);
      if (replaced === null) return trimmed;
      const descriptors = tokens.length > 1 ? ' ' + tokens.slice(1).join(' ') : '';
      return replaced + descriptors;
    })
    .join(', ');
}

/* ---------------------------------------------------------------------------
 * Navigation script
 *
 * We intercept <a href> clicks inside the iframe and forward them to the
 * parent app as a postMessage. The parent resolves the path and (if it's a
 * known HTML file in the zip) swaps the iframe. This single-pass technique
 * avoids a chicken-and-egg rewrite of HTML→HTML blob URLs.
 * -------------------------------------------------------------------------*/

function injectNavScript(html: string, sourcePath: string): string {
  if (/data-mockswap-nav/.test(html)) return html;

  // The zip's own filename is user-controlled. Encoding to `\u003c` for
  // `<` and `\u003e` for `>` prevents a path like
  // `foo/</script><script>alert(1)</script>.html` from terminating the
  // injected `<script>` element early and escaping into HTML context.
  const srcLiteral = escapeForScriptLiteral(sourcePath);
  const body = [
    "(function(){",
    "var __src=" + srcLiteral + ";",
    "document.addEventListener('click',function(e){",
    "var t=e.target;",
    "while(t&&t.nodeType!==9&&t.nodeName!=='A'){t=t.parentNode;}",
    "if(!t||t.nodeName!=='A')return;",
    "var h=t.getAttribute('href');",
    "if(!h)return;",
    // External / non-navigable schemes fall through to the page's own
    // behaviour. We only steer relative hrefs.
    "if(/^(https?:|mailto:|tel:|javascript:|data:|\\/\\/|blob:|#)/i.test(h))return;",
    "e.preventDefault();",
    "e.stopPropagation();",
    "try{window.parent.postMessage({type:'mockswap:navigate',href:h,sourceFile:__src},'*');}catch(_){}",
    "},true);",
    "})();",
  ].join('');

  const scriptTag = '<script data-mockswap-nav>' + body + '</script>';

  // Place the script as early as possible so it sees clicks first.
  const headRe = /<head\b[^>]*>/i;
  if (headRe.test(html)) {
    return html.replace(headRe, (m) => m + scriptTag);
  }
  // No <head>: try to inject before the first existing <script>.
  const scriptOpen = /<script\b/i;
  if (scriptOpen.test(html)) {
    return html.replace(scriptOpen, scriptTag + '<script');
  }
  // Last resort: prepend.
  return scriptTag + html;
}

/**
 * JSON.stringify escapes quotes, backslashes, and control characters but
 * leaves `<` and `>` untouched. Inside a `<script>` element, those bytes
 * can break out of script context (`</script>`), so we additionally escape
 * angle brackets right before splicing the string into the script body.
 */
function escapeForScriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}
