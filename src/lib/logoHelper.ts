import type {
  AppliedPatch,
  ImageDetection,
  LoadedProject,
  LogoCandidate,
  LogoHelperConfig,
  LogoRole,
  ZipEntryMeta,
} from '../types';
import type { ZipArchiveLike } from './archiveTypes';
import { applyReplacement, canReplace } from './assetReplacer';
import { isSupportedImageFile } from './fileTypes';
import { sanitizeFilename, uniqueAssetPath } from './filenameSanitizer';
import { pathRelative } from './pathRelative';
import { resolveAgainst } from './urlResolver';

/* ----------------------------------------------------------------------------
 * Detection
 * --------------------------------------------------------------------------
 * `detectLogos` re-scans HTML / manifest / <link rel="icon"> references
 * using LOOSER dedup than `detectImages`. imageDetector's dedup collapses
 * a header logo and a footer logo with the same rawUrl into one candidate
 * — which we can't address individually when injecting text or writing
 * patches. Here each <img>, <link>, and manifest entry gets a unique id
 * keyed by parentContainerHint / rel / src so duplicates are addressable.
 * ------------------------------------------------------------------------*/

/** Maximum logo candidates we'll surface per HTML file. Generous in case
 *  a single file contains a hero logo, footer logo, and og:image logo. */
const MAX_CANDIDATES_PER_HTML = 32;

/** Concurrency for reading text from JSZip. Mirrors imageDetector. */
const READ_CONCURRENCY = 12;

/** Positive brand signal — class/id mentions of brand, header/footer logo,
 *  navbar-brand, or the bare word "logo" (the most common single-word
 *  wrapper). The word-boundary anchors keep false positives out: a class
 *  named "misology" or "technology" shouldn't match. */
const BRANDY_ATTR = /\b(?:navbar-brand|brand|header-logo|footer-logo|site-logo|brand-mark|wordmark|logo-mark|company-logo|logo)\b/i;
const LOGO_FILENAME = /(?:^|[^a-z])(logo|brand|wordmark|mark|brandmark|company-mark)(?:[^a-z]|$)/i;
const LOGO_ALT = /^(?:logo|brand|company|mowing|landscap|builder|services|logo\s*alt|company\s*logo|brand\s*mark|wordmark)/i;

/** Negative patterns: refuse to call these logos even if filename matches. */
const LOGO_NEGATIVE = /(?:social|facebook|twitter|instagram|tiktok|hero|banner|avatar|portrait|bg|background|sprite|og-|twitter-)/i;

/** rel attribute values that mark a favicon/apple-touch link. */
const ICON_RELS = /(^|\s)(?:icon|shortcut|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)(\s|$)/i;

/**\n * Run the logo scan. Pure function over a project snapshot — does not
 * mutate the zip. Reads are batched to keep memory + CPU usage consistent
 * with `detectImages`.
 */
export async function detectLogos(
  zip: ZipArchiveLike,
  entries: ZipEntryMeta[],
): Promise<LogoCandidate[]> {
  const html = entries.filter((e) => !e.isDirectory && e.category === 'html');
  const manifest = entries.filter(
    (e) => !e.isDirectory && (e.name === 'manifest.json' || e.name.endsWith('.webmanifest')),
  );

  const texts = await readEntriesBatched(zip, [...html, ...manifest]);

  const candidates: LogoCandidate[] = [];
  for (const entry of html) {
    const text = texts.get(entry.path);
    if (text != null) candidates.push(...scanHtmlForLogos(text, entry.path));
  }
  for (const entry of manifest) {
    const text = texts.get(entry.path);
    if (text != null) candidates.push(...scanManifestForLogos(text, entry.path));
  }

  return candidates;
}

/* ----------------------------------------------------------------------------
 * HTML scanner
 * -------------------------------------------------------------------------*/

function scanHtmlForLogos(
  rawHtml: string,
  sourceFile: string,
): LogoCandidate[] {
  const html = stripHtmlComments(rawHtml);
  const candidates: LogoCandidate[] = [];

  // Dedup-by-match only inside this file, NOT by rawUrl — headerLogo and
  // footerLogo that share rawUrl are kept as separate candidates so they
  // can be addressed individually later.
  const tagRe = /<(?:img|link)\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    const name = (tag.slice(1).split(/[\s/>]/)[0] || '').toLowerCase();

    if (name === 'img') {
      const candidate = scoreImgCandidate(tag, html, m.index, sourceFile);
      if (candidate) candidates.push(candidate);
    } else if (name === 'link') {
      const candidate = scoreLinkCandidate(tag, sourceFile);
      if (candidate) candidates.push(candidate);
    }

    if (candidates.length >= MAX_CANDIDATES_PER_HTML) break;
  }

  // Resolve status per candidate: ok (in zip) or missing (not in zip).
  for (const c of candidates) {
    const r = resolveAgainst(c.sourceFile, c.rawUrl);
    c.resolvedPath = r.isRemote ? '' : (r.resolvedPath ?? '');
  }

  // Group into roles: headerLogo, footerLogo, favicon, appleTouchIcon.
  // We want at most one candidate per role so the UI shows N checkboxes.
  const header = pickHeaderCandidate(candidates);
  const footer = pickFooterCandidate(candidates);
  const favicon = candidates.find((c) => c.sourceTag === 'link' && c.role === 'favicon');
  const apple = candidates.find((c) => c.sourceTag === 'link' && c.role === 'appleTouchIcon');

  return [
    ...(header ? [{ ...header, id: idWithIndex(header.detectionId, header) }] : []),
    ...(footer ? [{ ...footer, id: idWithIndex(footer.detectionId, footer) }] : []),
    ...(favicon ? [{ ...favicon, id: idWithIndex(favicon.detectionId, favicon) }] : []),
    ...(apple ? [{ ...apple, id: idWithIndex(apple.detectionId, apple) }] : []),
  ];
}

/* -------------------------------------------------------------------------- */
/* <img> scoring                                                              */
/* -------------------------------------------------------------------------- */

function scoreImgCandidate(
  tag: string,
  fullHtml: string,
  tagIndex: number,
  sourceFile: string,
): LogoCandidate | null {
  const src = getAttr(tag, 'src');
  if (!src) return null;

  const alt = getAttr(tag, 'alt') ?? undefined;
  const klass = getAttr(tag, 'class') ?? '';
  const idAttr = getAttr(tag, 'id') ?? '';

  // Negative-patterned matches are never logos (social, hero, background…).
  const joinedForNeg = `${src} ${alt ?? ''} ${klass} ${idAttr}`;
  if (LOGO_NEGATIVE.test(joinedForNeg)) return null;

  // Positives: filename, alt, class/id, surrounding container.
  const fnameMatches = LOGO_FILENAME.test(src);
  const altMatches = !!alt && LOGO_ALT.test(alt);
  const attrMatches = BRANDY_ATTR.test(`${klass} ${idAttr}`);
  const container = nearestContainer(fullHtml, tagIndex);

  const inSemanticHeader = container?.tag === 'header';
  const inSemanticFooter = container?.tag === 'footer';
  const inSemanticNav = container?.tag === 'nav';
  const containerMatches = inSemanticHeader || inSemanticFooter || inSemanticNav;

  // Any one positive is enough, but more positives = lock-in.
  const positiveCount = (fnameMatches ? 1 : 0) + (altMatches ? 1 : 0) + (attrMatches ? 1 : 0) + (containerMatches ? 1 : 0);
  if (positiveCount < 1) return null;

  let role: LogoRole = 'headerLogo';
  if (inSemanticFooter) role = 'footerLogo';

  return {
    id: '',
    role,
    detectionId: idForDetection(sourceFile, 'img', 'src', src),
    sourceFile,
    sourceKind: 'html',
    sourceTag: 'img',
    sourceAttr: 'src',
    rawUrl: src,
    resolvedPath: '',
    alt,
    parentContainerHint: container
      ? { tag: container.tag, classes: container.classes, id: container.id }
      : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* <link rel="icon..."> scoring                                               */
/* -------------------------------------------------------------------------- */

function scoreLinkCandidate(tag: string, sourceFile: string): LogoCandidate | null {
  const rel = (getAttr(tag, 'rel') || '').toLowerCase();
  const href = getAttr(tag, 'href');
  if (!href || !rel) return null;
  if (!ICON_RELS.test(rel)) return null;

  const isApple = /apple-touch-icon/i.test(rel);
  return {
    id: '',
    role: isApple ? 'appleTouchIcon' : 'favicon',
    detectionId: idForDetection(sourceFile, 'link', 'href', href),
    sourceFile,
    sourceKind: 'html',
    sourceTag: 'link',
    sourceAttr: 'href',
    rawUrl: href,
    resolvedPath: '',
    rel,
    sizes: getAttr(tag, 'sizes') ?? undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Header / footer pickers                                                    */
/* --------------------------------------------------------------------------
 * pickHeaderCandidate: prefer first candidate inside a <header> semantic,
 * else the first candidate whose class/id matches brand-y signature,
 * else the first candidate marked headerLogo by scoreImgCandidate.
 *
 * pickFooterCandidate: prefer first candidate inside <footer> semantic,
 * else first candidate whose class contains 'footer-logo'.
 * -------------------------------------------------------------------------- */

function pickHeaderCandidate(candidates: LogoCandidate[]): LogoCandidate | null {
  const inHeader = candidates.find((c) => c.parentContainerHint?.tag === 'header');
  if (inHeader) return inHeader;
  const branded = candidates.find((c) =>
    c.role === 'headerLogo' && (
      (c.alt && LOGO_ALT.test(c.alt)) ||
      BRANDY_ATTR.test(`${c.parentContainerHint?.classes ?? ''} ${c.parentContainerHint?.id ?? ''}`)
    ),
  );
  if (branded) return branded;
  return candidates.find((c) => c.role === 'headerLogo') ?? null;
}

function pickFooterCandidate(candidates: LogoCandidate[]): LogoCandidate | null {
  const inFooter = candidates.find((c) => c.parentContainerHint?.tag === 'footer');
  if (inFooter) return inFooter;
  const classFoot = candidates.find((c) =>
    /\bfooter-logo\b/i.test(`${c.parentContainerHint?.classes ?? ''} ${c.parentContainerHint?.id ?? ''}`),
  );
  return classFoot ?? null;
}

/* -------------------------------------------------------------------------- */
/* Manifest scanner                                                           */
/* --------------------------------------------------------------------------
 * Each entry in the manifest's `icons[]` array becomes its own
 * `manifestIcon` candidate. The singular `icon` field at the manifest
 * root also produces one candidate so the user can target it too.
 * -------------------------------------------------------------------------- */

function scanManifestForLogos(
  text: string,
  sourceFile: string,
): LogoCandidate[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return [];
  }
  if (!manifest || typeof manifest !== 'object') return [];

  const m = manifest as { icons?: unknown; icon?: unknown };
  const out: LogoCandidate[] = [];

  if (Array.isArray(m.icons)) {
    m.icons.forEach((icon: unknown, idx: number) => {
      if (icon && typeof icon === 'object' && 'src' in icon && typeof (icon as { src: unknown }).src === 'string') {
        const src = (icon as { src: string }).src;
        const sizes = (icon as { sizes?: unknown }).sizes;
        out.push({
          id: '',
          role: 'manifestIcon',
          detectionId: idForDetection(sourceFile, 'icon', 'src', `${src}#${idx}`),
          sourceFile,
          sourceKind: 'manifest',
          sourceTag: 'icon',
          sourceAttr: 'src',
          rawUrl: src,
          resolvedPath: '',
          sizes: typeof sizes === 'string' ? sizes : undefined,
        });
      }
    });
  }

  // Manifests sometimes carry a top-level `icon` (singular) field too.
  // Surface it as another `manifestIcon` candidate, marked with `#top`.
  if (typeof m.icon === 'string') {
    out.push({
      id: '',
      role: 'manifestIcon',
      detectionId: idForDetection(sourceFile, 'icon', 'icon', m.icon),
      sourceFile,
      sourceKind: 'manifest',
      sourceTag: 'icon',
      sourceAttr: 'icon',
      rawUrl: m.icon,
      resolvedPath: '',
    });
  }

  return out;
}

/* ----------------------------------------------------------------------------
 * Apply
 * --------------------------------------------------------------------------
 * Pipeline:
 *   - headerLogo + icon-text → custom icon-text surgery
 *   - manifestIcon           → JSON src swap
 *   - <link rel="icon|apple"> → custom href swap (writes asset bytes too)
 *   - everything else        → applyReplacement (asset-pipeline)
 * Each affected test returns an `AppliedPatch` so the export flow and
 * reports stay identical to a regular single-detection replace.
 * ------------------------------------------------------------------------*/

export interface LogoHelperApplyResult {
  patches: AppliedPatch[];
  groupId: string;
}

export async function applyLogoHelper(
  project: LoadedProject,
  candidates: LogoCandidate[],
  file: File,
  config: LogoHelperConfig,
): Promise<LogoHelperApplyResult> {
  if (!isSupportedImageFile(file)) {
    throw new Error(`"${file.name}" isn't an image. Only image files can be used as a logo.`);
  }
  if (candidates.length === 0) {
    throw new Error('No logo candidates detected.');
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error('Logo file is empty.');
  }

  const groupId = `mockswap-logo-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const patches: AppliedPatch[] = [];

  for (const role of config.targets) {
    const candidate = candidates.find((c) => c.role === role);
    if (!candidate) continue;

    if (role === 'headerLogo' && config.headerMode === 'icon-text') {
      const patch = await applyHeaderLogoWithText(project, candidate, bytes, config);
      if (patch) patches.push(patch);
      continue;
    }

    if (role === 'manifestIcon') {
      const patch = await applyManifestIcon(project, candidate, bytes);
      if (patch) patches.push(patch);
      continue;
    }

    if (candidate.sourceKind === 'html' && candidate.sourceTag === 'link') {
      // Favicon / apple-touch-icon: custom <link href> surgery.
      const assetForRole = ensureAsset(project, file, bytes);
      const patch = await applyHtmlLinkHref(project, candidate, assetForRole);
      if (patch) patches.push(patch);
      continue;
    }

    if (canReplace(toDetectionLike(candidate))) {
      const blob = new Blob([bytes], { type: file.type });
      const fileForApply = new File([blob], file.name, { type: file.type });
      const detection: ImageDetection = toDetectionLike(candidate);
      const patch = await applyReplacement(project, detection, fileForApply);
      const enriched = withLogoMetadata(patch, config, undefined);
      patches.push(enriched);
    }
  }

  if (patches.length === 0) {
    throw new Error('None of the selected targets were applicable to the detected logos.');
  }

  return { patches, groupId };
}

/**
 * Materialise the asset bytes under a collision-free `assets/mockups/...`
 * path. Synchronous — we already have the bytes in memory; the "async"
 * signature was a leftover from a previous design.
 */
function ensureAsset(
  project: LoadedProject,
  file: File,
  bytes: Uint8Array,
): string {
  const sanitized = sanitizeFilename(file.name);
  const existing = project.entries.map((e) => e.path);
  const candidatePath = `assets/mockups/${sanitized}`;
  const takenLower = new Set(existing.map((p) => p.toLowerCase()));
  if (!takenLower.has(candidatePath.toLowerCase())) {
    project.zip.file(candidatePath, bytes);
    return candidatePath;
  }
  const fresh = uniqueAssetPath(sanitized, existing);
  project.zip.file(fresh, bytes);
  return fresh;
}

/* -------------------------------------------------------------------------- */
/* Header-logo with text injection                                           */
/* --------------------------------------------------------------------------
 * Two-step surgery:
 *   1. swap <img src="...">'s src for the new logo's relative path.
 *   2. find the enclosing brand container; if its body has no text
 *      content, INJECT a <span> with the user-supplied business name.
 *      If text already exists beside the image, leave it alone (the
 *      user spec says "Add or preserve live HTML text beside the icon").
 *
 * We deliberately don't use DOMParser because it reformats whitespace
 * and strips doctypes; we walk the byte offsets ourselves so the file's
 * original formatting survives round-tripping.
 * -------------------------------------------------------------------------- */

async function applyHeaderLogoWithText(
  project: LoadedProject,
  candidate: LogoCandidate,
  bytes: Uint8Array,
  config: LogoHelperConfig,
): Promise<AppliedPatch | null> {
  const zipFile = project.zip.file(candidate.sourceFile);
  if (!zipFile) throw new Error(`Source file "${candidate.sourceFile}" not found in archive.`);
  const sourceText = await zipFile.async('text');

  const sanitized = sanitizeFilename(findReferencedFileName(candidate) || 'logo');
  const existing = project.entries.map((e) => e.path);
  const newAssetPath = uniqueAssetPath(sanitized, existing);
  project.zip.file(newAssetPath, bytes);
  const newRelativeRef = pathRelative(candidate.sourceFile, newAssetPath);

  // Step 1: swap <img src>. We also opportunistically add `alt` if the
  // existing tag is missing one — addresses the "Add alt text" requirement.
  const swapped = swapImgSrcAndEnsureAlt(
    sourceText,
    candidate.sourceTag,
    candidate.sourceAttr,
    candidate.rawUrl,
    newRelativeRef,
    config.businessName.trim() || 'Logo',
  );
  if (swapped.sourceText === sourceText) {
    // src didn't match — clean up the orphan asset we wrote.
    project.zip.remove(newAssetPath);
    return null;
  }

  // Step 2: try parent text injection.
  const businessName = config.businessName.trim();
  let injectedBlock: string | undefined;
  let withText = swapped.sourceText;
  if (businessName) {
    const injection = injectLogoTextNode(withText, candidate, businessName);
    if (injection) {
      withText = injection.html;
      injectedBlock = injection.insertedHtml;
    }
  }

  project.zip.file(candidate.sourceFile, withText);

  const patch = {
    id: candidate.id,
    sourceFile: candidate.sourceFile,
    sourceKind: candidate.sourceKind,
    sourceTag: candidate.sourceTag,
    sourceAttr: candidate.sourceAttr,
    rawUrl: candidate.rawUrl,
    action: 'replace' as const,
    currentSourceValue: newRelativeRef,
    newAssetPath,
    originalAssetPath: candidate.resolvedPath,
    replacementBytes: bytes.byteLength,
    appliedAt: Date.now(),
    previousSourceText: sourceText,
    // Snapshot AFTER apply for the History-panel diff view.
    currentSourceText: withText,
  };

  return withLogoMetadata(patch, config, injectedBlock);
}

/* -------------------------------------------------------------------------- */
/* Manifest icon                                                              */
/* --------------------------------------------------------------------------
 * Read the manifest JSON, swap the matching icon entry's src field for
 * a relative path. Falls back to the singular top-level `icon` field
 * when the icons[idx] lookup misses (e.g. idx out of bounds).
 * -------------------------------------------------------------------------- */

async function applyManifestIcon(
  project: LoadedProject,
  candidate: LogoCandidate,
  bytes: Uint8Array,
): Promise<AppliedPatch | null> {
  const zipFile = project.zip.file(candidate.sourceFile);
  if (!zipFile) return null;
  const sourceText = await zipFile.async('text');

  const sanitized = sanitizeFilename('logo');
  const existing = project.entries.map((e) => e.path);
  const newAssetPath = uniqueAssetPath(sanitized, existing);
  project.zip.file(newAssetPath, bytes);
  const newRelativeRef = pathRelative(candidate.sourceFile, newAssetPath);

  let parsed: unknown;
  try { parsed = JSON.parse(sourceText); } catch {
    project.zip.remove(newAssetPath);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    project.zip.remove(newAssetPath);
    return null;
  }
  const manifest = parsed as { icons?: unknown; icon?: unknown; [k: string]: unknown };

  let touched = false;

  if (Array.isArray(manifest.icons)) {
    const idx = extractManifestIndex(candidate.detectionId);
    const isTopLevel = candidate.sourceAttr === 'icon' && idx === undefined;
    if (!isTopLevel && typeof idx === 'number'
      && manifest.icons[idx] && typeof manifest.icons[idx] === 'object'
      && 'src' in (manifest.icons[idx] as Record<string, unknown>)) {
      (manifest.icons[idx] as Record<string, unknown>).src = newRelativeRef;
      touched = true;
    }
  }
  if (!touched && typeof manifest.icon === 'string' && candidate.sourceAttr === 'icon') {
    manifest.icon = newRelativeRef;
    touched = true;
  }
  if (!touched) {
    project.zip.remove(newAssetPath);
    return null;
  }

  const rewritten = JSON.stringify(manifest, null, 2);
  project.zip.file(candidate.sourceFile, rewritten);

  const patch = {
    id: candidate.id,
    sourceFile: candidate.sourceFile,
    sourceKind: candidate.sourceKind,
    sourceTag: candidate.sourceTag,
    sourceAttr: candidate.sourceAttr,
    rawUrl: candidate.rawUrl,
    action: 'replace' as const,
    currentSourceValue: newRelativeRef,
    newAssetPath,
    originalAssetPath: candidate.resolvedPath,
    replacementBytes: bytes.byteLength,
    appliedAt: Date.now(),
    previousSourceText: sourceText,
    // Snapshot AFTER apply for the History-panel diff view.
    currentSourceText: rewritten,
  };
  return patch;
}

/** Extract the `idx` suffix off `icon::src::<url>#<idx>` ids. Returns
 *  undefined for ids that lack a numeric suffix (the singular-icon case). */
function extractManifestIndex(detectionId: string): number | undefined {
  const i = detectionId.lastIndexOf('#');
  if (i === -1) return undefined;
  const tail = detectionId.slice(i + 1);
  const n = Number(tail);
  return Number.isFinite(n) ? n : undefined;
}

/* -------------------------------------------------------------------------- */
/* <link rel="icon" href="..."> rewrite                                       */
/* --------------------------------------------------------------------------
 * The existing `applyReplacement` only knows HTML <img src>. For favicon /
 * apple-touch-icon we re-implement just enough to swap the href attribute
 * while preserving the link's other attributes (sizes, type, etc.).
 * -------------------------------------------------------------------------- */

async function applyHtmlLinkHref(
  project: LoadedProject,
  candidate: LogoCandidate,
  newAssetPath: string,
): Promise<AppliedPatch | null> {
  const zipFile = project.zip.file(candidate.sourceFile);
  if (!zipFile) return null;
  const sourceText = await zipFile.async('text');
  const newRelativeRef = pathRelative(candidate.sourceFile, newAssetPath);

  const swapped = swapHtmlAttribute(sourceText, candidate.sourceTag, candidate.sourceAttr, candidate.rawUrl, newRelativeRef);
  if (swapped === sourceText) return null;

  project.zip.file(candidate.sourceFile, swapped);

  return {
    id: candidate.id,
    sourceFile: candidate.sourceFile,
    sourceKind: candidate.sourceKind,
    sourceTag: candidate.sourceTag,
    sourceAttr: candidate.sourceAttr,
    rawUrl: candidate.rawUrl,
    action: 'replace',
    currentSourceValue: newRelativeRef,
    newAssetPath,
    originalAssetPath: candidate.resolvedPath,
    replacementBytes: 0, // bytes authored by the caller via ensureAsset
    appliedAt: Date.now(),
    previousSourceText: sourceText,
    // Snapshot AFTER apply for the History-panel diff view.
    currentSourceText: swapped,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Icon-text parent surgery + nearest-container                                                  */
/* ---------------------------------------------------------------------------------------------- */

interface LogoTextInjection {
  html: string;
  insertedHtml: string;
}

function injectLogoTextNode(
  html: string,
  candidate: LogoCandidate,
  businessName: string,
): LogoTextInjection | null {
  const imgOpenIdx = findImgTagOffset(html, candidate.rawUrl);
  if (imgOpenIdx === -1) return null;

  const container = findEnclosingBrandContainer(html, imgOpenIdx);
  if (!container) return null;

  // Read existing text content between the img and the parent close tag —\n  // strip markup and trim; if there's any letter content, PRESERVE it.
  const innerBlock = html.slice(container.innerStart, container.innerEnd);
  const existingText = innerBlock
    .replace(/<[^>]+>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const imgCloseIdx = html.indexOf('>', imgOpenIdx);
  if (imgCloseIdx === -1) return null;

  if (existingText) {
    // Existing text beside the logo wins; we don't double-print it.
    return { html, insertedHtml: '(preserved existing text beside logo)' };
  }

  const safeName = escapeForInnerText(businessName);
  const idSeed = `mockswap-logo-text-${candidate.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const span = `<span id="${idSeed}" class="mockswap-logo-text" style="margin-left:8px;font-weight:700;white-space:nowrap;">${safeName}</span>`;

  // Splice the span into the inner block, right after the img tag's `>`.
  const before = html.slice(container.innerStart, imgCloseIdx + 1);
  const after = html.slice(imgCloseIdx + 1, container.innerEnd);
  const innerNew = before + span + after;
  const htmlNew = html.slice(0, container.innerStart) + innerNew + html.slice(container.innerEnd);
  return { html: htmlNew, insertedHtml: span };
}

interface BrandContainer {
  openIdx: number;
  innerStart: number;
  closeIdx: number;
  innerEnd: number;
  tag: string;
  classes: string;
  id: string;
}

/**
 * Walk backwards from the candidate's `<img>` byte offset to find a parent
 * container with a brand-y class or id. Best-effort: we look at the
 * IMMEDIATE open tag whose `>` appears before the `<img>` and whose
 * matching `</tag>` appears after the `<img>`. That keeps things simple
 * and matches what authors actually write: a single
 * `<a class="navbar-brand"><img></a>` wrapping a logo.
 */
function findEnclosingBrandContainer(html: string, imgOpenIdx: number): BrandContainer | null {
  let i = imgOpenIdx - 1;
  while (i > 0) {
    if (html[i] !== '<') { i -= 1; continue; }
    const tagText = html.slice(i, imgOpenIdx);
    const openMatch = tagText.match(/^<([a-zA-Z][\w:-]*)\b([^>]*)>/);
    if (!openMatch) { i -= 1; continue; }
    const tagName = openMatch[1].toLowerCase();
    const attrsBlob = openMatch[2];
    const klass = getAttr('<' + tagName + attrsBlob + '>', 'class') ?? '';
    const idAttr = getAttr('<' + tagName + attrsBlob + '>', 'id') ?? '';
    const attributesJoined = `${klass} ${idAttr}`;
    const isBrand = BRANDY_ATTR.test(attributesJoined);
    const isSemantic = tagName === 'header' || tagName === 'footer' || tagName === 'nav';
    if (!isBrand && !isSemantic) return null;

    const imgCloseIdx = html.indexOf('>', imgOpenIdx);
    const closeOffset = findMatchingCloseTag(html, imgCloseIdx + 1, tagName);
    if (closeOffset === -1) return null;

    return {
      openIdx: i,
      innerStart: i + openMatch[0].length,
      closeIdx: closeOffset,
      innerEnd: closeOffset,
      tag: tagName,
      classes: klass,
      id: idAttr,
    };
  }
  return null;
}

/**\n * Walk forward from `searchFrom` looking for either `</tagName>` or for\n * nested open tags of the same name (skip them) so we match the right\n * closing tag in case the file has well-formed but slightly nested\n * brand containers.\n */
function findMatchingCloseTag(html: string, searchFrom: number, tagName: string): number {
  const openRe = new RegExp(`<\\s*${tagName}\\b`, 'gi');
  const closeRe = new RegExp(`</\\s*${tagName}\\s*>`, 'gi');
  let depth = 1;
  openRe.lastIndex = searchFrom;
  closeRe.lastIndex = searchFrom;
  let nextOpen = openRe.exec(html);
  let nextClose = closeRe.exec(html);
  while (depth > 0) {
    if (nextClose === null) return -1;
    if (nextOpen !== null && nextOpen.index < nextClose.index) {
      depth += 1;
      nextOpen = openRe.exec(html);
    } else {
      depth -= 1;
      if (depth === 0) return nextClose.index;
      nextClose = closeRe.exec(html);
    }
  }
  return -1;
}

/**
 * Walk backwards from `tagIndex` and return the nearest enclosing
 * semantic container (header / footer / nav) along with its class and id.
 * Returns null if the img tag is not inside one of those containers.
 */
function nearestContainer(
  html: string,
  tagIndex: number,
): { tag: string; classes: string; id: string } | null {
  let i = tagIndex - 1;
  while (i > 0) {
    if (html[i] !== '<') { i -= 1; continue; }
    const slice = html.slice(i);
    const openMatch = slice.match(/^<([a-zA-Z][\w:-]*)\b([^>]*)>/);
    if (!openMatch) { i -= 1; continue; }
    const tagName = openMatch[1].toLowerCase();
    if (tagName === 'img' || tagName === 'link') { i -= 1; continue; }
    return {
      tag: tagName,
      classes: getAttr('<' + tagName + openMatch[2] + '>', 'class') ?? '',
      id: getAttr('<' + tagName + openMatch[2] + '>', 'id') ?? '',
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* HTML string helpers                                                        */
/* -------------------------------------------------------------------------- */

function stripHtmlComments(text: string): string {
  // Inlined here because imageDetector's version is internal.
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

async function readEntriesBatched(
  zip: ZipArchiveLike,
  entries: ZipEntryMeta[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < entries.length; i += READ_CONCURRENCY) {
    const batch = entries.slice(i, i + READ_CONCURRENCY);
    await Promise.all(
      batch.map(async (entry) => {
        const file = zip.file(entry.path);
        if (!file) return;
        try {
          const text = await file.async('text');
          map.set(entry.path, text);
        } catch {
          // Skip un-decodable entries.
        }
      }),
    );
  }
  return map;
}

function getAttr(tag: string, name: string): string | null {
  const pattern = new RegExp(
    `(?:^|\\s)${escapeRegex(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  );
  const m = tag.match(pattern);
  if (!m) return null;
  return decode(m[1] ?? m[2] ?? m[3] ?? '');
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Escape unsafe inner-text characters so user input can't break out of a
 *  span element. Less strict than attribute escaping (< and > is enough). */
function escapeForInnerText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Attribute-value escaping used for src / href / style / id / etc. */
function escapeForAttribute(value: string): string {
  return escapeForInnerText(value).replace(/"/g, '&quot;');
}

function findImgTagOffset(html: string, rawUrl: string): number {
  const tagRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    if (getAttr(tag, 'src') === rawUrl) return m.index;
  }
  return -1;
}

interface SwapResult {
  sourceText: string;
  altInjected: boolean;
}

/**
 * Swap the <img>'s src to the new value. If the original tag lacks an
 * `alt` attribute, inject `alt="<fallback>"` so accessibility doesn't
 * regress. Returns the unchanged sourceText if the lookup misses (the
 * caller uses that as a "did anything change?" signal).
 */
function swapImgSrcAndEnsureAlt(
  html: string,
  tagName: string,
  attrName: string,
  searchValue: string,
  newValue: string,
  altFallback: string,
): SwapResult {
  const tagRe = /<([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>/g;
  let altInjected = false;
  const replaced = html.replace(tagRe, (full, tag: string, attrs: string, selfClose: string) => {
    if (tag.toLowerCase() !== tagName.toLowerCase()) return full;
    let newAttrs = attrs.replace(
      /\b([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
      (m: string, an: string, q1: string | undefined, q2: string | undefined, q3: string | undefined) => {
        if (an.toLowerCase() !== attrName.toLowerCase()) return m;
        if ((q1 ?? q2 ?? q3 ?? '') !== searchValue) return m;
        const quote = q1 != null ? '"' : q2 != null ? "'" : '';
        return `${an}=${quote}${newValue}${quote}`;
      },
    );

    // After the src swap, check whether the tag now has an `alt` attribute.
    if (newAttrs !== attrs) {
      const altRe = /\balt\s*=/i;
      if (!altRe.test(newAttrs)) {
        altInjected = true;
        // Insert alt immediately after the src attribute (or the first
        // attribute, whichever comes first).
        const insertAfter = newAttrs.match(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i)
          ?? newAttrs.match(/\b[a-zA-Z][\w:-]*/);
        if (insertAfter && insertAfter.index !== undefined) {
          const ins = insertAfter.index + insertAfter[0].length;
          const safe = escapeForAttribute(altFallback);
          newAttrs = newAttrs.slice(0, ins) + ` alt="${safe}"` + newAttrs.slice(ins);
        }
      }
      return `<${tag}${newAttrs}${selfClose}>`;
    }
    return full;
  });
  return { sourceText: replaced, altInjected };
}

function swapHtmlAttribute(
  html: string,
  tagName: string,
  attrName: string,
  searchValue: string,
  newValue: string,
): string {
  const tagRe = /<([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>/g;
  return html.replace(tagRe, (full, tag: string, attrs: string, selfClose: string) => {
    if (tag.toLowerCase() !== tagName.toLowerCase()) return full;
    const newAttrs = attrs.replace(
      /\b([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
      (m: string, an: string, q1: string | undefined, q2: string | undefined, q3: string | undefined) => {
        if (an.toLowerCase() !== attrName.toLowerCase()) return m;
        if ((q1 ?? q2 ?? q3 ?? '') !== searchValue) return m;
        const quote = q1 != null ? '"' : q2 != null ? "'" : '';
        return `${an}=${quote}${newValue}${quote}`;
      },
    );
    return newAttrs === attrs ? full : `<${tag}${newAttrs}${selfClose}>`;
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers + types                                                            */
/* -------------------------------------------------------------------------- */

function idForDetection(
  sourceFile: string, sourceTag: string, sourceAttr: string, rawUrl: string,
): string {
  return `${sourceFile}::${sourceTag}::${sourceAttr}::${rawUrl}`;
}

/** Make a per-candidate id unique by appending the candidate's context. */
function idWithIndex(detectionId: string, candidate: LogoCandidate): string {
  const stamp = candidate.parentContainerHint
    ? `${candidate.parentContainerHint.tag}:${candidate.parentContainerHint.classes ?? ''}`
    : candidate.rel ?? candidate.rawUrl;
  return `${detectionId}#${encodeURIComponent(stamp).slice(0, 40)}`;
}

/** Map a candidate onto the detection shape `applyReplacement` expects. */
function toDetectionLike(candidate: LogoCandidate): ImageDetection {
  const type = candidate.role === 'headerLogo' || candidate.role === 'footerLogo'
    ? 'logo'
    : candidate.role === 'favicon' || candidate.role === 'appleTouchIcon'
      ? 'favicon'
      : 'icon';
  return {
    rawUrl: candidate.rawUrl,
    resolvedPath: candidate.resolvedPath,
    type,
    status: candidate.resolvedPath ? 'ok' : 'missing',
    sourceKind: candidate.sourceKind,
    sourceFile: candidate.sourceFile,
    sourceTag: candidate.sourceTag,
    sourceAttr: candidate.sourceAttr,
  };
}

/** Attach Logo Helper metadata onto a 'replace' patch. Type-guarded for
 *  discriminated unions — if the input is 'remove' / 'placeholder' we
 *  return it unchanged. */
function withLogoMetadata(
  patch: AppliedPatch,
  config: LogoHelperConfig,
  injectedTextBlock: string | undefined,
): AppliedPatch {
  if (patch.action !== 'replace') return patch;
  return {
    ...patch,
    logoMode: config.headerMode,
    businessName: config.businessName.trim() || undefined,
    injectedTextBlock,
  };
}

/** Best-effort filename hint from a candidate's rawUrl; falls back to
 *  `logo` if the URL has no usable basename. */
function findReferencedFileName(candidate: LogoCandidate): string {
  const url = candidate.rawUrl;
  if (!url) return 'logo';
  const lastSlash = Math.max(url.lastIndexOf('/'), url.lastIndexOf('\\'));
  const base = lastSlash >= 0 ? url.slice(lastSlash + 1) : url;
  const qIdx = base.indexOf('?');
  const hIdx = base.indexOf('#');
  const cut = Math.min(qIdx === -1 ? base.length : qIdx, hIdx === -1 ? base.length : hIdx);
  return base.slice(0, cut) || 'logo';
}

/**
 * Group-by-role helper for the UI: returns at most one candidate per role.
 * Lets UI components render N checkboxes from a single bucket.
 */
export function pickByRole(candidates: LogoCandidate[]): Partial<Record<LogoRole, LogoCandidate>> {
  const out: Partial<Record<LogoRole, LogoCandidate>> = {};
  for (const c of candidates) {
    if (!out[c.role]) out[c.role] = c;
  }
  return out;
}
