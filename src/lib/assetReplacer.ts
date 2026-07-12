import type {
  AppliedPatch,
  ImageDetection,
  ImageType,
  LoadedProject,
} from '../types';
import { sanitizeFilename, uniqueAssetPath } from './filenameSanitizer';
import { pathRelative } from './pathRelative';
import { findCssCommentRanges, findHtmlCommentRanges, isOffsetInRanges } from './sourceRanges';

export interface ReplacementPayload {
  bytes: Uint8Array;
  filename: string;
  /** True when bytes were produced by the optional WebP re-encode flow. */
  reencoded?: boolean;
  /** Current source value from a previous replace patch on the same detection. */
  previousSourceValue?: string;
}

export type ReplacementPatch = Extract<AppliedPatch, { action: 'replace' }>;

/**
 * Whether the replacement pipeline can handle a given detection. Mirrors
 * the explicit scope of this step:
 *   - HTML `<img src>`.
 *   - HTML `<link rel="...icon..." href>` for favicons / touch icons.
 *   - No `<input type=image>`, no `srcset`, no manifest icons.
 *   - CSS `url(...)` only.
 */
export function canReplace(detection: ImageDetection): boolean {
  return isHtmlImgSrc(detection) || isHtmlIconLinkHref(detection) || isCssUrl(detection);
}

/**
 * Whether a broken reference can be cleanly *removed* from its host file.
 * Destructive actions intentionally stay narrower than replacement: HTML
 * `<img>` and CSS `url(...)`, not favicons / touch icons.
 */
export function canRemove(detection: ImageDetection): boolean {
  return isHtmlImgSrc(detection) || isCssUrl(detection);
}

/**
 * Whether a broken reference can be swapped for a placeholder block.
 * Placeholders only make sense as a replacement for the visual element:
 * HTML `<img>` only. CSS url() refs (background-image, list-style-image,
 * cursor...) don't have a natural inline replacement, so convert-to-
 * placeholder doesn't apply.
 */
export function canPlaceholder(detection: ImageDetection): boolean {
  return isHtmlImgSrc(detection);
}

function isHtmlImgSrc(detection: ImageDetection): boolean {
  return (
    detection.sourceKind === 'html'
    && detection.sourceTag.toLowerCase() === 'img'
    && detection.sourceAttr.toLowerCase() === 'src'
  );
}

function isHtmlIconLinkHref(detection: ImageDetection): boolean {
  return (
    detection.sourceKind === 'html'
    && detection.sourceTag.toLowerCase() === 'link'
    && detection.sourceAttr.toLowerCase() === 'href'
    && /icon/.test(detection.extra?.rel?.toLowerCase() ?? '')
  );
}

function isCssUrl(detection: ImageDetection): boolean {
  return (
    detection.sourceKind === 'css'
    && detection.sourceTag.toLowerCase() === 'url'
    && detection.sourceAttr.toLowerCase() === 'url'
  );
}

/**
 * Whether the Broken Images panel should surface this detection at all.
 * A detection is "broken-or-risky" when the file is missing locally OR the
 * URL is remote and was flagged with a riskReason (manus, cdn, blob URL,
 * generic cross-origin http).
 */
export function isBroken(detection: ImageDetection): boolean {
  if (detection.status === 'missing') return true;
  if (detection.status === 'remote' && detection.riskReason) return true;
  return false;
}

/**
 * Apply an image replacement end-to-end:
 *   1. Read the dropped file bytes.
 *   2. Hash/sanitize the file name, pick a collision-free `assets/mockups/`
 *      target inside the zip.
 *   3. Compute a relative reference string from the source file's
 *      directory to that target so the rendered HTML/CSS picks it up.
 *   4. Surgically rewrite the matching URL token inside the source file
 *      (HTML attribute or CSS `url(...)`).
 *   5. Persist both the new asset bytes and the patched source text back
 *      into the same `JSZip` instance held by `project`.
 *
 * Mutates `project.zip` in place. Returns enough metadata for the UI to
 * surface a success card and to support re-replacement without re-detect.
 */
export function applyReplacement(
  project: LoadedProject,
  detection: ImageDetection,
  replacement: File,
  previousSourceValue?: string,
): Promise<ReplacementPatch>;
export function applyReplacement(
  project: LoadedProject,
  detection: ImageDetection,
  replacement: ReplacementPayload,
): Promise<ReplacementPatch>;
export async function applyReplacement(
  project: LoadedProject,
  detection: ImageDetection,
  replacement: File | ReplacementPayload,
  /** If a previous patch exists for this detection, the value currently
   *  sitting in the source text. Used as the lookup key for re-applies. */
  previousSourceValue?: string,
): Promise<ReplacementPatch> {
  if (!canReplace(detection)) {
    throw new Error('This reference type is not yet supported for replacement.');
  }

  const payload = await resolveReplacementPayload(replacement, previousSourceValue);
  const bytes = payload.bytes;
  if (bytes.byteLength === 0) {
    throw new Error('Replacement file is empty.');
  }

  const sanitized = sanitizeFilename(payload.filename);
  // LIVE collision detection. `project.entries` is captured once at
  // zip-load and does not reflect writes made inside a bulk-replace
  // loop. If we relied on the stale `project.entries`, every bulk
  // iteration past the first would map to the same `uniqueAssetPath`
  // result, JSZip would silently overwrite the bytes, and a single
  // `undoPatchById` of any patch would delete the shared asset file
  // — leaving the other patches dangling-reference a missing file.
  // Walking `project.zip.files` (the live map JSZip mutates as we go)
  // avoids this: bulk iter N sees iter N-1's writes and bumps the
  // `-N` suffix via `uniqueAssetPath` correctly.
  const liveExistingPaths: string[] = [];
  // `JSZip` exposes its file table as `files: { [path]: JSZipObject }`.
  // Directory entries have `dir: true` and no usable `name` slot for
  // collision checks — skip them so we only compare leaf file paths.
  for (const [path, entry] of Object.entries(project.zip.files)) {
    if (entry.dir) continue;
    liveExistingPaths.push(path);
  }
  // Also seed with paths previously written by earlier patches in this
  // session. `patchesByKey` isn't reachable here (it's React state), so
  // we instead rely on `project.zip.files` to already contain them:
  // every successful applyReplacement wrote the asset via
  // `project.zip.file(newAssetPath, bytes)` so it shows up here.
  const newAssetPath = uniqueAssetPath(sanitized, liveExistingPaths);
  const newRelativeRef = pathRelative(detection.sourceFile, newAssetPath);

  const sourceZipFile = project.zip.file(detection.sourceFile);
  if (!sourceZipFile) {
    throw new Error(`Source file "${detection.sourceFile}" not found in archive.`);
  }
  const sourceText = await sourceZipFile.async('text');
  // Defensive: only honor a previous source value if it's a real
  // replacement ref. The Remove and Placeholder actions record `''` or
  // `'mockswap-placeholder:<label>'` respectively — neither is a valid
  // token to substitute back. Falling back to `detection.rawUrl` keeps
  // the re-apply UX working after a destructive action.
  const previousLooksReplaceable =
    typeof payload.previousSourceValue === 'string'
    && payload.previousSourceValue.length > 0
    && !payload.previousSourceValue.startsWith('mockswap-placeholder:');
  const searchValue = previousLooksReplaceable && payload.previousSourceValue
    ? payload.previousSourceValue
    : detection.rawUrl;

  const patched = detection.sourceKind === 'css'
    ? patchCss(sourceText, searchValue, newRelativeRef)
    : patchHtml(sourceText, detection, searchValue, newRelativeRef);

  if (patched === sourceText) {
    // The diagnostic branches on what we actually searched for, not on
    // the raw parameter — after the `previousLooksReplaceable` fallback
    // the two can diverge (e.g. a non-replace patch's marker falls back
    // to `detection.rawUrl`).
    const searchedForPreviousRef = searchValue !== detection.rawUrl;
    throw new Error(
      searchedForPreviousRef
        ? 'Could not find the previous reference in the source file.'
        : 'Could not find the URL in the source file. Was it already replaced?',
    );
  }

  project.zip.file(newAssetPath, bytes);
  project.zip.file(detection.sourceFile, patched);

  return {
    id: `${detection.sourceFile}::${detection.sourceTag}::${detection.sourceAttr}::${detection.rawUrl}`,
    sourceFile: detection.sourceFile,
    sourceKind: detection.sourceKind,
    sourceTag: detection.sourceTag,
    sourceAttr: detection.sourceAttr,
    rawUrl: detection.rawUrl,
    action: 'replace',
    currentSourceValue: newRelativeRef,
    newAssetPath,
    originalAssetPath: detection.resolvedPath ?? '',
    replacementBytes: bytes.byteLength,
    appliedAt: Date.now(),
    // Snapshot for the unified undo reducer. Source text BEFORE this
    // apply; the reducer does `project.zip.file(p.sourceFile,
    // p.previousSourceText)` to roll back.
    previousSourceText: sourceText,
    // Snapshot AFTER this apply. Drives the History-panel diff view.
    currentSourceText: patched,
    newAssetReencoded: payload.reencoded || undefined,
  };
}

async function resolveReplacementPayload(
  replacement: File | ReplacementPayload,
  previousSourceValue?: string,
): Promise<ReplacementPayload> {
  if (isReplacementPayload(replacement)) {
    return replacement;
  }
  return {
    bytes: new Uint8Array(await replacement.arrayBuffer()),
    filename: replacement.name,
    previousSourceValue,
  };
}

function isReplacementPayload(replacement: File | ReplacementPayload): replacement is ReplacementPayload {
  const maybePayload = replacement as Partial<ReplacementPayload>;
  return maybePayload.bytes instanceof Uint8Array && typeof maybePayload.filename === 'string';
}

/**
 * Remove a broken image reference from its host file in-place.
 *
 * Semantics:
 *  - HTML `<img ... src="rawUrl">`     → drop the entire tag.
 *  - CSS `background-image: url(rawUrl)` → drop the entire declaration.
 *  - CSS `background: <shorthand with url(rawUrl)>` → drop the url() token
 *    only; keep any color/position/repeat tokens. If the resulting value
 *    is empty/whitespace, drop the entire declaration.
 *  - CSS `<other-property>: url(rawUrl)` → drop the entire declaration.
 *
 * Mutates `project.zip`. Returns the AppliedPatch so the UI can show it as
 * an "Applied" state in the right panel.
 */
export async function applyRemove(
  project: LoadedProject,
  detection: ImageDetection,
): Promise<AppliedPatch> {
  if (!canRemove(detection)) {
    throw new Error('This reference type cannot be removed.');
  }

  const zipFile = project.zip.file(detection.sourceFile);    if (!zipFile) {
      throw new Error(`Source file "${detection.sourceFile}" not found in archive.`);
    }
    const sourceText = await zipFile.async('text');

    const patched = detection.sourceKind === 'css'
      ? removeCssUrl(sourceText, detection.rawUrl)
      : removeHtmlImg(sourceText, detection.rawUrl);

    if (patched === sourceText) {
      throw new Error('Could not find the URL in the source file. Was it already removed?');
    }

    project.zip.file(detection.sourceFile, patched);

    return {
      id: patchId(detection),
      sourceFile: detection.sourceFile,
      sourceKind: detection.sourceKind,
      sourceTag: detection.sourceTag,
      sourceAttr: detection.sourceAttr,
      rawUrl: detection.rawUrl,
      action: 'remove',
      currentSourceValue: '',
      appliedAt: Date.now(),
      // Snapshot for the unified undo reducer.
      previousSourceText: sourceText,
      // Snapshot AFTER this apply. Drives the History-panel diff view.
      currentSourceText: patched,
    };
}

/**
 * Replace a broken `<img>` tag with a placeholder div sized to the
 * original's layout-hinting attributes and labelled by `ImageType`.
 *
 * Only enabled for HTML `img` refs; CSS `url(...)` has no inline analogue,
 * so this function rejects other source kinds.
 */
export async function applyPlaceholder(
  project: LoadedProject,
  detection: ImageDetection,
): Promise<AppliedPatch> {
  if (!canPlaceholder(detection)) {
    throw new Error('This reference type cannot be converted to a placeholder.');
  }

  const zipFile = project.zip.file(detection.sourceFile);    if (!zipFile) {
      throw new Error(`Source file "${detection.sourceFile}" not found in archive.`);
    }
    const sourceText = await zipFile.async('text');

    const label = placeholderLabel(detection.type);
    const patched = replaceHtmlImgWithPlaceholder(sourceText, detection.rawUrl, label);

    if (patched === sourceText) {
      throw new Error('Could not find the URL in the source file. Was it already replaced?');
    }

    project.zip.file(detection.sourceFile, patched);

    return {
      id: patchId(detection),
      sourceFile: detection.sourceFile,
      sourceKind: detection.sourceKind,
      sourceTag: detection.sourceTag,
      sourceAttr: detection.sourceAttr,
      rawUrl: detection.rawUrl,
      action: 'placeholder',
      currentSourceValue: `mockswap-placeholder:${label}`,
      placeholder: { label },
      appliedAt: Date.now(),
      // Snapshot for the unified undo reducer.
      previousSourceText: sourceText,
      // Snapshot AFTER this apply. Drives the History-panel diff view.
      currentSourceText: patched,
    };
}

/**
 * Stable id for any patch against a detection. Re-applies of replace,
 * remove, or placeholder converge here so the patchesByKey map stays
 * one-entry-per-detection.
 */
function patchId(detection: ImageDetection): string {
  return `${detection.sourceFile}::${detection.sourceTag}::${detection.sourceAttr}::${detection.rawUrl}`;
}

/* ---------------------------------------------------------------------------
 * Sourcetex rewriters for the patch step itself (not the live-preview
 * rewriter in urlRewriter.ts — that one resolves URLs, this one rewrites
 * them by exact value match).
 * -------------------------------------------------------------------------*/

const ATTR_RE = /\b([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
const CSS_URL_RE = /url\(\s*(['"]?)([^)'"\s]*?)\1\s*\)/g;

function patchHtml(
  html: string,
  detection: ImageDetection,
  searchValue: string,
  newRef: string,
): string {
  type Repl = (m: string, an: string, q1: string | undefined, q2: string | undefined, q3: string | undefined) => string;
  const replaceAttr: Repl = (m, an, q1, q2, q3) => {
    const value = q1 ?? q2 ?? q3 ?? '';
    if (an.toLowerCase() !== detection.sourceAttr.toLowerCase()) return m;
    if (value !== searchValue) return m;
    const quote = q1 != null ? '"' : q2 != null ? "'" : '';
    return `${an}=${quote}${newRef}${quote}`;
  };
  const comments = findHtmlCommentRanges(html);
  return replaceHtmlTags(html, comments, ({ full, tagName, attrs }) => {
    if (!htmlTagMatchesDetection(tagName, attrs, detection)) return full;
    const newAttrs = attrs.replace(ATTR_RE, replaceAttr);
    return newAttrs === attrs ? full : `<${tagName}${newAttrs}>`;
  });
}

function htmlTagMatchesDetection(
  tagName: string,
  attrs: string,
  detection: ImageDetection,
): boolean {
  const expectedTag = detection.sourceTag.toLowerCase();
  if (tagName.toLowerCase() !== expectedTag) return false;
  if (expectedTag !== 'link' || detection.sourceAttr.toLowerCase() !== 'href') return true;

  const rel = extractAttr(attrs, 'rel')?.toLowerCase() ?? '';
  const expectedRel = detection.extra?.rel?.toLowerCase() ?? '';
  return expectedRel ? rel === expectedRel : /icon/.test(rel);
}

function patchCss(css: string, searchValue: string, newRef: string): string {
  const comments = findCssCommentRanges(css);
  return css.replace(CSS_URL_RE, (match: string, q: string, ref: string, offset: number) => {
    if (isOffsetInRanges(offset, comments)) return match;
    if (ref !== searchValue) return match;
    return `url(${q}${newRef}${q})`;
  });
}

/* ---------------------------------------------------------------------------
 * Source-text operations for the Broken Images flow
 * -------------------------------------------------------------------------*/

function removeHtmlImg(html: string, rawUrl: string): string {
  const comments = findHtmlCommentRanges(html);
  return replaceHtmlTags(html, comments, ({ full, tagName, attrs }) => {
    if (tagName.toLowerCase() !== 'img') return full;
    const src = extractAttr(attrs, 'src');
    if (src !== rawUrl) return full;
    // Replace with a single space so a stray run of text immediately
    // around the dropped tag isn't glued together.
    return ' ';
  });
}

/**
 * Replace `<img ... src="rawUrl">` with a styled placeholder div.
 * Preserves the original tag's `class`, `id`, `width`, and `height`
 * attributes so any layout hooks (Tailwind width/height utilities,
 * aspect-ratio constraints) keep applying.
 *
 * Inline `style` is APPENDED to ours so the placeholder's diagonal-stripe
 * background is always visible regardless of the user's prior styling.
 * The placeholder uses `display:inline-flex` so it occupies the same
 * inline flow slot the `<img>` previously did, avoiding layout jumps.
 */
function replaceHtmlImgWithPlaceholder(
  html: string,
  rawUrl: string,
  label: string,
): string {
  const safeLabel = escapeForAttribute(label);
  const comments = findHtmlCommentRanges(html);
  return replaceHtmlTags(html, comments, ({ full, tagName, attrs }) => {
    if (tagName.toLowerCase() !== 'img') return full;
    const src = extractAttr(attrs, 'src');
    if (src !== rawUrl) return full;

    const klass = extractAttr(attrs, 'class');
    const idAttr = extractAttr(attrs, 'id');
    const widthAttr = extractAttr(attrs, 'width');
    const heightAttr = extractAttr(attrs, 'height');
    const styleAttr = extractAttr(attrs, 'style');
    // Carry accessibility metadata through. We prefer the original
    // `alt` text as the placeholder's accessible name when present,
    // falling back to the type-derived label. `role`, `aria-label`,
    // `aria-hidden` are forwarded verbatim if present on the source.
    const altAttr = extractAttr(attrs, 'alt');
    const roleAttr = extractAttr(attrs, 'role');
    const ariaLabelAttr = extractAttr(attrs, 'aria-label');
    const ariaHiddenAttr = extractAttr(attrs, 'aria-hidden');

    const classes = ['mockswap-placeholder'];
    if (klass) classes.unshift(klass);

    const styleParts = [
      placeholderStyleBase,
    ];
    if (styleAttr) styleParts.push(styleAttr);
    const mergedStyle = styleParts.join(';');

    const accessibleName = (ariaLabelAttr || altAttr || label).trim();

    const segments: string[] = ['<div'];
    segments.push(` class="${escapeForAttribute(classes.join(' '))}"`);
    if (idAttr) segments.push(` id="${escapeForAttribute(idAttr)}"`);
    if (widthAttr) segments.push(` width="${escapeForAttribute(widthAttr)}"`);
    if (heightAttr) segments.push(` height="${escapeForAttribute(heightAttr)}"`);
    if (roleAttr) segments.push(` role="${escapeForAttribute(roleAttr)}"`);
    if (ariaHiddenAttr) segments.push(` aria-hidden="${escapeForAttribute(ariaHiddenAttr)}"`);
    segments.push(` aria-label="${escapeForAttribute(accessibleName)}"`);
    segments.push(` style="${escapeForAttribute(mergedStyle)}"`);
    segments.push(' data-mockswap-placeholder="true">');
    segments.push(safeLabel);
    segments.push('</div>');
    return segments.join('');
  });
}

/**
 * Conservative placeholder styling. Preserves layout (inline-flex, derives
 * from img semantics) and signals "missing image" through the diagonal
 * hatch + soft border + uppercase label.
 */
const placeholderStyleBase =
  'display:inline-flex;align-items:center;justify-content:center;' +
  'background:repeating-linear-gradient(45deg,#3f3f46,#3f3f46 8px,' +
  '#27272a 8px,#27272a 16px);color:#d4d4d8;font:600 12px system-ui,' +
  '-apple-system,sans-serif;text-transform:uppercase;letter-spacing:.05em;' +
  'text-align:center;border:1px dashed #71717a;border-radius:6px;' +
  'min-height:80px;min-width:80px;padding:8px;line-height:1.2';

/**
 * Push out an empty url() token from a CSS shorthand. The remaining tokens
 * are kept verbatim because CSS shorthand permits non-image components to
 * stand alone (e.g. `background: red 50%/cover no-repeat;` is valid).
 *
 * If the property is `background-image` (no shorthand), the entire
 * declaration is dropped — partial shorthand values are not legal.
 *
 * For all other properties that hold a url() (cursor, list-style-image,
 * mask-image, etc.) we drop the whole declaration.
 */
function removeCssUrl(css: string, rawUrl: string): string {
  const urlRe = new RegExp(CSS_URL_RE.source, 'g');
  const comments = findCssCommentRanges(css);
  let cursor = 0;
  let out = '';
  let changed = false;
  let matches: RegExpExecArray | null;

  // Walk every url() and operate only on matches whose value equals rawUrl.
  // Range-based replacement is important here: a String.replace callback can
  // only replace the url(...) token, but dropping or rewriting a CSS
  // declaration requires replacing the whole declaration span.
  while ((matches = urlRe.exec(css)) !== null) {
    const match = matches[0];
    const ref = matches[2];
    if (isOffsetInRanges(matches.index, comments)) continue;
    if (ref !== rawUrl) continue;
    const ctx = findEnclosingDeclaration(css, match, matches.index);
    if (!ctx) continue;

    const property = ctx.property;
    if (!property) {
      // No identifiable property — too risky to touch, leave for the user.
      continue;
    }

    let replacement: string;
    let start: number;
    let end: number;

    if (property === 'background-image') {
      // Drop the entire declaration. Remove the leading `;` if present.
      start = ctx.dropStart;
      end = ctx.dropEnd;
      replacement = ' ';
    } else if (property === 'background') {
      // Strip the url() token from the shorthand value; if what's left is
      // empty/whitespace, drop the whole declaration.
      const valueText = css.slice(ctx.declarationValueStart, ctx.declarationValueEnd);
      const matchStart = matches.index - ctx.declarationValueStart;
      const matchEnd = matchStart + match.length;
      if (matchStart < 0 || matchEnd > valueText.length) continue;
      const strippedValue = (
        valueText.slice(0, matchStart) + ' ' + valueText.slice(matchEnd)
      ).replace(/\s+/g, ' ').trim();
      if (!strippedValue) {
        start = ctx.dropStart;
        end = ctx.dropEnd;
        replacement = ' ';
      } else {
        start = ctx.statementStart;
        end = ctx.statementEnd;
        replacement = ctx.statement.replace(
          ctx.declarationValue,
          strippedValue,
        );
      }
    } else {
      // Any other property: drop the whole declaration.
      start = ctx.dropStart;
      end = ctx.dropEnd;
      replacement = ' ';
    }

    if (start < cursor) continue;
    out += css.slice(cursor, start) + replacement;
    cursor = end;
    urlRe.lastIndex = Math.max(urlRe.lastIndex, end);
    changed = true;
  }

  return changed ? out + css.slice(cursor) : css;
}

interface DeclarationContext {
  /** The matched url() insertion point. */
  match: string;
  /** The enclosing property name (lowercase) or undefined if unresolvable. */
  property: string | undefined;
  /** The full declaration value text (between `:` and the matching `;`/`}`). */
  declarationValue: string;
  /** Absolute start/end range for the raw declaration value. */
  declarationValueStart: number;
  declarationValueEnd: number;
  /** The full `{property}: {declarationValue}` source text including
   *  surrounding whitespace; callers can replace this to swap a value. */
  statement: string;
  /** Start/end range for replacing only the declaration statement. */
  statementStart: number;
  statementEnd: number;
  /** Start/end range for dropping the whole declaration. Keeps the
   *  surrounding `{`, `;`, or `}` delimiters balanced. */
  dropStart: number;
  dropEnd: number;
}

function findEnclosingDeclaration(
  css: string,
  urlMatch: string,
  offset?: number,
): DeclarationContext | null {
  // Anchor the search on the regex match offset when available. Falls back
  // to the first occurrence for callers that didn't pass an offset, but
  // the supported call paths always do.
  const idx = typeof offset === 'number' ? offset : css.indexOf(urlMatch);
  if (idx === -1) return null;

  // Walk backwards to find the start of the declaration (the last `;` or
  // `{` before the match).
  let declStart = -1;
  for (let i = idx - 1; i >= 0; i--) {
    const ch = css[i];
    if (ch === ';' || ch === '{') { declStart = i; break; }
  }
  if (declStart === -1) return null;

  // Walk forwards to find the end of the declaration (matching `;` or
  // `}`, whichever comes first).
  let declEnd = -1;
  for (let i = idx + urlMatch.length; i < css.length; i++) {
    const ch = css[i];
    if (ch === ';' || ch === '}') { declEnd = i; break; }
  }
  if (declEnd === -1) return null;

  const statementStart = declStart + 1;
  const statementEnd = declEnd;
  const statement = css.slice(statementStart, statementEnd);
  const dropStart = statementStart;
  const dropEnd = css[declEnd] === ';' ? declEnd + 1 : declEnd;

  // Parse the property name from `property: rest`.
  const colonIdx = statement.indexOf(':');
  if (colonIdx === -1) {
    return {
      match: urlMatch,
      property: undefined,
      declarationValue: '',
      declarationValueStart: statementEnd,
      declarationValueEnd: statementEnd,
      statement,
      statementStart,
      statementEnd,
      dropStart,
      dropEnd,
    };
  }
  const property = statement.slice(0, colonIdx).trim().toLowerCase();
  const declarationValueStart = statementStart + colonIdx + 1;
  const declarationValueEnd = statementEnd;
  const declarationValue = css.slice(declarationValueStart, declarationValueEnd).trim();

  return {
    match: urlMatch,
    property,
    declarationValue,
    declarationValueStart,
    declarationValueEnd,
    statement,
    statementStart,
    statementEnd,
    dropStart,
    dropEnd,
  };
}

interface HtmlTagMatch {
  full: string;
  tagName: string;
  attrs: string;
  start: number;
  end: number;
}

function replaceHtmlTags(
  html: string,
  commentRanges: ReturnType<typeof findHtmlCommentRanges>,
  replacer: (tag: HtmlTagMatch) => string,
): string {
  let out = '';
  let cursor = 0;
  let changed = false;

  for (const tag of findHtmlTags(html)) {
    if (isOffsetInRanges(tag.start, commentRanges)) continue;

    const replacement = replacer(tag);
    if (replacement === tag.full) continue;
    if (tag.start < cursor) continue;

    out += html.slice(cursor, tag.start) + replacement;
    cursor = tag.end;
    changed = true;
  }

  return changed ? out + html.slice(cursor) : html;
}

function findHtmlTags(html: string): HtmlTagMatch[] {
  const tags: HtmlTagMatch[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start === -1) break;

    const tagStart = html.slice(start).match(/^<([a-zA-Z][\w:-]*)\b/);
    if (!tagStart?.[1]) {
      cursor = start + 1;
      continue;
    }

    const tagName = tagStart[1];
    let quote: '"' | "'" | null = null;
    let end = -1;
    for (let i = start + tagStart[0].length; i < html.length; i += 1) {
      const ch = html[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        end = i + 1;
        break;
      }
    }

    if (end === -1) break;

    const attrsStart = start + 1 + tagName.length;
    tags.push({
      full: html.slice(start, end),
      tagName,
      attrs: html.slice(attrsStart, end - 1),
      start,
      end,
    });
    cursor = end;
  }

  return tags;
}

function extractAttr(attrs: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${escapeRe(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = attrs.match(pattern);
  if (!m) return null;
  return decodeValue(m[1] ?? m[2] ?? m[3] ?? '');
}

function escapeRe(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function decodeValue(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Quote-safe attribute value. Disarms `<` and `>` so a malicious rawUrl
 *  (or label) can't break out of the attribute. */
function escapeForAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function placeholderLabel(type: ImageType): string {
  switch (type) {
    case 'hero':    return 'Hero Image';
    case 'service': return 'Service Image';
    case 'logo':    return 'Logo';
    case 'background': return 'Background Image';
    case 'icon':
    case 'favicon':
    case 'social':
    case 'unknown':
    default:        return 'Missing Image';
  }
}
