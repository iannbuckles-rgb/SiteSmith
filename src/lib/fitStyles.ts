import type { BorderRadius, ImageDetection, ImageFit, ImageFitConfig, ImagePosition, OverlayDensity } from '../types';

/* ----------------------------------------------------------------------------
 * Image fit controls
 * --------------------------------------------------------------------------
 * The fit-style controls rewrite how a single detection renders WITHOUT
 * touching the bitmap. Two and only two rendering surfaces are supported:
 *
 *   HTML <img>  → inline `style` attribute appended/merged. object-fit,
 *                 object-position, border-radius. Overlay is intentionally
 *                 NOT supported for <img> because it requires wrapping the
 *                 tag in a positioned div, which is a much more invasive
 *                 surgery we defer to v2.
 *
 *   CSS url()   → declarations appended inside the enclosing rule block.
 *                 background-size, background-position, border-radius, plus
 *                 a hero overlay via `box-shadow: inset 0 0 0 1000px rgba(…)`.
 *
 * Fit, position, radius, overlay are all expressed as constants here so the
 * generated CSS string the user sees in MOCKUPSWAP_CHANGES.md is concise
 * and easy to audit.
 * ------------------------------------------------------------------------*/

/** Lookup tables the user can understand from setting the chip. Every value
 *  here corresponds to literal CSS the user can copy verbatim. Adjust here
 *  and the entire system follows without touching the UI. */
const FIT_TO_OBJECT: Record<ImageFit, string> = {
  'cover': 'cover',
  'contain': 'contain',
  'fill': 'fill',
  'scale-down': 'scale-down',
  'none': 'none',
};
const POSITION_TO_OBJECT: Record<ImagePosition, string> = {
  'center': 'center',
  'top': 'top',
  'bottom': 'bottom',
  'left': 'left',
  'right': 'right',
};
const RADIUS_PRESETS: Record<BorderRadius, string> = {
  'none': '0',
  'small': '4px',
  'medium': '8px',
  'large': '16px',
  'full': '9999px',
};
const OVERLAY_PRESETS: Record<OverlayDensity, string> = {
  'none': '',
  'light': 'rgba(0,0,0,0.35)',
  'medium': 'rgba(0,0,0,0.55)',
};

/** Squashed CSS property names we author so we can ALSO recognise them
 *  when stripping previous runs (idempotence). Property names are case-insensitive
 *  in CSS so we keep these lowercased. */
const FIT_REWRITE_PROPS = [
  'object-fit',
  'object-position',
  'border-radius',
  'background-size',
  'background-position',
  'box-shadow',
] as const;

/** Whether this detection carries a renderable image we can style inline. */
export function canApplyFitStyle(detection: ImageDetection): boolean {
  const tag = detection.sourceTag.toLowerCase();
  if (detection.sourceKind === 'html' && tag === 'img') {
    // <img src> only. <source> uses srcset with fundamentally different
    // sizing semantics and we deliberately don't support it in v1 — letting
    // the panel render for it would just throw "Could not find the URL"
    // at apply time. Keeping `canApplyFitStyle` and `applyFitStyleToImg`
    // in lockstep means the UI never offers a button that the rewriter
    // can't honour.
    return true;
  }
  if (detection.sourceKind === 'css' && tag === 'url') {
    return true;
  }
  return false;
}

/** Whether this detection supports the hero overlay (CSS background only). */
export function canOverlay(detection: ImageDetection): boolean {
  if (detection.sourceKind !== 'css') return false;
  const prop = (detection.extra?.cssProperty ?? '').toLowerCase();
  // Inset box-shadow only makes sense on a block element (background-*),
  // not on cursor/list-style-image/mask-image refs.
  return /background/.test(prop);
}

/* -------------------------------------------------------------------------
 * Style generators
 * ------------------------------------------------------------------------*/

/**
 * Build the inline `style` value for an <img>. We don't strip the existing
 * style attribute; the caller stitches our addition in. Returns the segment
 * to APPEND, including the leading semicolon (or empty string if there are
 * no relevant properties).
 */
export function generateImgInlineAppendage(config: ImageFitConfig): string {
  const parts: string[] = [];
  parts.push(`object-fit:${FIT_TO_OBJECT[config.fit]}`);
  parts.push(`object-position:${POSITION_TO_OBJECT[config.position]}`);
  parts.push(`border-radius:${RADIUS_PRESETS[config.borderRadius]}`);
  // No overlay for <img> in v1; if config.overlay is set we silently ignore
  // it here. The UI surface disables the overlay chip when canOverlay is false.
  return parts.join(';') + ';';
}

/** Build the CSS declarations to APPEND inside the rule that owns our url().
 *  Each declaration ends with a `;`. */
export function generateBgDeclarationAppendage(config: ImageFitConfig): string {
  const parts: string[] = [];
  parts.push(`background-size:${FIT_TO_OBJECT[config.fit]}`);
  parts.push(`background-position:${POSITION_TO_OBJECT[config.position]}`);
  parts.push(`border-radius:${RADIUS_PRESETS[config.borderRadius]}`);
  if (config.overlay !== 'none') {
    // Inset box-shadow with a huge spread covers the whole element; this
    // renders the dark overlay on top of a background-image without
    // needing a child node. A regular outline/box-shadow does not cover
    // the painted area for background images the way inset + huge spread does.
    const c = OVERLAY_PRESETS[config.overlay];
    if (c) parts.push(`box-shadow:inset 0 0 0 1000px ${c}`);
  }
  return parts.join(';') + ';';
}

/**
 * Concise literal CSS for the export report. Just the four properties the
 * user picked; we deliberately don't expand "border-radius: 8px" into a
 * long-form cross-browser writeup because modern browsers all support the
 * unprefixed form.
 */
export function describeGeneratedCss(detection: ImageDetection, config: ImageFitConfig): string {
  if (detection.sourceKind === 'css') return generateBgDeclarationAppendage(config);
  return generateImgInlineAppendage(config);
}

/* -------------------------------------------------------------------------
 * Surgical rewrites
 * ------------------------------------------------------------------------*/

/* Reusable regex templates; if you need `g` and `.exec`, ALWAYS create a
 * local RegExp so `lastIndex` state doesn't leak across calls. */
const ATTR_NAME_OR_VALUE = `(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))`;

/**
 * Apply the user's fit config to a specific <img>-style reference inside
 * an HTML source. Surgically MERGES the new declarations into the existing
 * `style` attribute (rather than replacing it) so unrelated author styles
 * survive. Replaces any prior object-fit / object-position / border-radius
 * our previous run authored for idempotence.
 *
 * Returns the unchanged sourceText if no <img> tag matching `searchValue`
 * was found. Caller treats equal-strings as "nothing applied, fail loudly".
 */
export function applyFitStyleToImg(
  html: string,
  detection: ImageDetection,
  config: ImageFitConfig,
): { sourceText: string; generatedCss: string; changed: boolean } {
  const generated = generateImgInlineAppendage(config);
  let changed = false;
  const tagRe = new RegExp(`<([a-zA-Z][\\w:-]*)\\b([^>]*?)(\\/?)>`, 'g');
  const replaced = html.replace(tagRe, (full, tag: string, attrs: string, selfClose: string) => {
    if (tag.toLowerCase() !== detection.sourceTag.toLowerCase()) return full;
    if (detection.sourceAttr.toLowerCase() !== 'src') return full;
    const srcValue = readAttr(attrs, 'src');
    if (srcValue !== detection.rawUrl) return full;

    // Maintain a fresh style attribute, replacing only fits we manage.
    const oldStyle = readAttr(attrs, 'style');
    const cleaned = stripManagedProperties(oldStyle);
    // Drop the trailing `;` on `generated` so we don't double up when
    // concatenating with our existing-style suffix.
    const newStyle = cleaned
      ? cleaned + generated.slice(0, -1)
      : generated.slice(0, -1);
    const newAttrs = rewriteAttr(attrs, 'style', newStyle);
    changed = true;
    return `<${tag}${newAttrs}${selfClose}>`;
  });
  return { sourceText: replaced, generatedCss: generated, changed };
}

/**
 * Apply the fit config to a CSS `url()` reference. Finds the declaration
 * block (the `{ … }` body) that contains the url(), strips our managed
 * longhand properties from it, and inserts new ones just before the closing
 * brace. Returns unchanged sourceText if no url() match.
 *
 * One fit-style per detection per apply call: we BREAK after the first
 * successful match so a same-block duplicate url() with the same rawUrl
 * (rare but real, e.g. `background: url(a), url(b)`) cannot double-insert
 * our declarations on a re-apply.
 */
export function applyFitStyleToCss(
  css: string,
  detection: ImageDetection,
  config: ImageFitConfig,
): { sourceText: string; generatedCss: string; changed: boolean } {
  const urlRe = new RegExp(`url\\(\\s*(['\"]?)([^)'\"\\s]*?)\\1\\s*\\)`, 'g');
  const generated = generateBgDeclarationAppendage(config);
  let changed = false;
  let result = css;

  let matches: RegExpExecArray | null;
  while ((matches = urlRe.exec(css)) !== null) {
    if (matches[2] !== detection.rawUrl) continue;
    const ctx = findEnclosingDeclarationBlock(css, matches.index);
    if (!ctx) continue;
    // Strip previously-managed properties so re-applies replace cleanly.
    const strippedBlock = stripManagedPropertiesFromBlock(ctx.block);
    // Insert the new declarations at the END of the block (before the `}`).
    const newBlock = strippedBlock.replace(/\s*\}$/, '') + generated + '}';
    changed = true;
    result = css.slice(0, ctx.blockStart) + newBlock + css.slice(ctx.blockEnd + 1);
    // One fit-style per detection per apply. Break so a same-block
    // duplicate url() with the same rawUrl can't double-insert our
    // declarations on the next iteration.
    break;
  }

  return { sourceText: result, generatedCss: generated, changed };
}

/* -------------------------------------------------------------------------
 * Internals
 * ------------------------------------------------------------------------*/

function readAttr(attrs: string, name: string): string | null {
  // Local regex; ATTR_NAME_OR_VALUE is module-level but only used inside
  // new RegExp() here whose `lastIndex` starts at 0.
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\s*=\\s*${ATTR_NAME_OR_VALUE}`, 'i');
  const m = attrs.match(pattern);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

/**
 * Replace (or append) a single attribute on a tag-attr string. Uses a
 * fresh local regex so `lastIndex` state can never carry over from
 * another caller — module-level `g` regexes are a notorious source of
 * "bug only manifests in production" failures.
 */
function rewriteAttr(attrs: string, name: string, value: string): string {
  const safe = escapeForStyleAttribute(value);
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\s*=\\s*${ATTR_NAME_OR_VALUE}`, 'i');
  const m = attrs.match(pattern);
  const replacement = `${name}="${safe}"`;
  if (!m || m.index === undefined) {
    // Append; ensure a leading space if needed.
    const sep = attrs.length && !/\s$/.test(attrs) ? ' ' : '';
    return attrs + sep + replacement;
  }
  return attrs.slice(0, m.index) + replacement + attrs.slice(m.index + m[0].length);
}

function stripManagedProperties(styleAttr: string | null): string | null {
  if (!styleAttr) return null;
  // Split into individual declarations and discard any matching our keys.
  const parts = styleAttr.split(';').map((p) => p.trim()).filter(Boolean);
  const reduced = parts.filter((p) => {
    const prop = p.split(':')[0]?.toLowerCase().trim();
    if (!prop) return false;
    return !(FIT_REWRITE_PROPS as readonly string[]).includes(prop);
  });
  return reduced.length ? reduced.join(';') + ';' : '';
}

function stripManagedPropertiesFromBlock(block: string): string {
  // Local regex — module-level shared `g` state would corrupt next call.
  const re = new RegExp(
    `(^|;|\\{)\\s*([a-zA-Z-][a-zA-Z0-9-]*)\\s*:\\s*([^;}]+)(?=\\s*[;}])`,
    'g',
  );
  return block.replace(re, (full, lead: string, prop: string) => {
    const lower = prop.toLowerCase();
    if ((FIT_REWRITE_PROPS as readonly string[]).includes(lower)) {
      // Drop the managed declaration; keep the captured lead (which is
      // one of `^` (start of block), `{` (first decl), or `;` between
      // decls) so the surrounding separators stay balanced. Returning
      // just `lead` is sufficient — the next declaration flows on
      // immediately after.
      return lead;
    }
    return full;
  });
}

interface DeclarationBlockContext {
  blockStart: number;
  blockEnd: number;
  block: string;
}

/** Locate the `{ … }` rule body containing the offset of a url() match.
 *  Returns null if no enclosing block can be found (e.g. parsed CSS that
 *  has been minified into a single line at offset 0 — extremely unusual). */
function findEnclosingDeclarationBlock(css: string, urlOffset: number): DeclarationBlockContext | null {
  // Walk backwards to find the nearest `{` that's NOT preceded by an
  // identifier (which would be an at-rule like `@media {`).
  let openIdx = -1;
  for (let i = urlOffset - 1; i >= 0; i--) {
    const ch = css[i];
    if (ch === '{') { openIdx = i; break; }
    if (ch === '}') { return null; } // we crossed into a sibling rule
  }
  if (openIdx === -1) return null;
  // Walk forwards for the closing `}`.
  let closeIdx = -1;
  for (let i = openIdx + 1; i < css.length; i++) {
    if (css[i] === '}') { closeIdx = i; break; }
  }
  if (closeIdx === -1) return null;
  return {
    blockStart: openIdx,
    blockEnd: closeIdx,
    block: css.slice(openIdx, closeIdx + 1),
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function escapeForStyleAttribute(value: string): string {
  // Inline `style` attribute values double for `:;"'`. We don't broadly
  // quote-escape so the generated CSS stays readable; just neutralize
  // attribute terminators that would break the wrapper attribute.
  return value.replace(/"/g, '&quot;');
}
