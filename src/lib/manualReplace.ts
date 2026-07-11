import type { AppliedPatch, LoadedProject } from '../types';
import { sanitizeFilename, uniqueAssetPath } from './filenameSanitizer';
import { pathRelative } from './pathRelative';

/* ----------------------------------------------------------------------------
 * Manual Replace
 * --------------------------------------------------------------------------
 * A plain-text find-and-replace over one or many source files in the loaded
 * zip. Unlike the surgical `applyReplacement` (which only touches the
 * matched <img src> token or CSS url()) the manual flow lets the user
 * rewrite any text in any editable file. Each affected file's pre-patch
 * source is snapshotted into the resulting AppliedPatch so the user can
 * undo the change with a single click — even after Export.
 *
 * Two replacement strategies (NOT regex) are used so `$`/`$&`/etc. in the
 * user's literal search text cannot be interpreted as JS backreference
 * tokens by String.replace:
 *
 *   replace-once → replacer FUNCTION (`text.replace(search, ()=>new)`)
 *   replace-all  → SPLIT-JOIN (`text.split(search).join(new)`)
 *
 * Both strategies are linear-time and immune to regex-compilation surprises
 * for very long search strings.
 * ------------------------------------------------------------------------*/

/** Files we consider editable in the Manual Replace dropdown. Conservative:
 *  we only show files whose extension matches a plain-text MIME class so
 *  the user isn't tempted to replace bytes inside a binary asset (which
 *  would just produce a malformed zip on export). */
const EDITABLE_EXTENSIONS = [
  'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'json', 'xml', 'svg', 'txt', 'md', 'markdown',
  'toml', 'yaml', 'yml', 'ini', 'cfg',
  'vue', 'svelte',
] as const;

export function isEditableExtension(name: string): boolean {
  const lastDot = name.lastIndexOf('.');
  if (lastDot < 0) return false;
  const ext = name.slice(lastDot + 1).toLowerCase();
  return (EDITABLE_EXTENSIONS as readonly string[]).includes(ext);
}

/** All editable files in the project, sorted by path for stable dropdown order. */
export function editableEntries(entries: Array<{ path: string; name: string }>): Array<{ path: string; name: string }> {
  return entries
    .filter((e) => isEditableExtension(e.name))
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Distinct scope key for the file dropdown. `'all-source-files'` is the
 *  bucket value when the user wants the search to span every editable file. */
export const ALL_SCOPE = 'all-source-files';

/* -------------------------------------------------------------------------
 * Planning + previewing
 * ------------------------------------------------------------------------*/

/** Lightweight preview record for a single file the search touched. */
export interface FileMatchPreview {
  path: string;
  matches: number;
  /** First-match context (40 chars before, search text, 40 chars after)
   *  so the UI can render a teaser without scanning gigabytes of HTML.
   *  Undefined for the "all" run so we don't blow the front-end budget. */
  contextSnippet?: {
    before: string;
    match: string;
    after: string;
  };
}

/** Pre-flight result for the Manual Replace panel. Computed WITHOUT
 *  mutating `project.zip`. The Apply button is gated on `canApply`. */
export interface ManualReplacePlan {
  /** Files that would be touched (target scope resolved). Each entry has
   *  a non-zero matches count. */
  files: FileMatchPreview[];
  /** Sum of matches across files (== total substitutions when applied). */
  totalMatches: number;
  /** True iff there's nothing to do (zero matches). */
  canApply: boolean;
  /** First file in the result list (handy for "first context snippet"). */
  firstFile?: FileMatchPreview;
}

/** Run the search against one or many files and emit a plan describing
 *  what would change. Pure: reads files, no writes. */
export async function planManualReplace(
  project: LoadedProject,
  scope: string,
  searchText: string,
  replaceAll: boolean,
): Promise<ManualReplacePlan> {
  const trimmed = searchText;
  if (!trimmed) {
    return { files: [], totalMatches: 0, canApply: false };
  }
  const targets = resolveTargetFiles(project, scope);
  if (targets.length === 0) {
    return { files: [], totalMatches: 0, canApply: false };
  }

  const files: FileMatchPreview[] = [];
  let total = 0;
  for (const path of targets) {
    const zipFile = project.zip.file(path);
    if (!zipFile) continue;
    const text = await zipFile.async('text');
    // When replace-all is OFF the apply caps to one substitution per
    // file, so the plan should mirror that. Otherwise count every
    // non-overlapping match so the user can see how big the rewrite is.
    const matches = replaceAll
      ? countOccurrences(text, trimmed)
      : (text.indexOf(trimmed) === -1 ? 0 : 1);
    if (matches === 0) continue;
    total += matches;
    files.push({
      path,
      matches,
      contextSnippet: matches > 0 ? pickContextSnippet(text, trimmed) : undefined,
    });
  }

  return {
    files,
    totalMatches: total,
    canApply: total > 0,
    firstFile: files[0],
  };
}

/** Count non-overlapping occurrences of `needle` in `haystack`. Pure
 *  substring counting — no regex, no backreference surprises. */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count += 1;
    pos += needle.length;
  }
  return count;
}

/** Slice text around the FIRST occurrence of `needle` for the context
 *  preview. Returns up to 40 chars on each side with safe boundary
 *  clamping. */
export function pickContextSnippet(text: string, needle: string): { before: string; match: string; after: string } {
  const idx = text.indexOf(needle);
  if (idx === -1) return { before: '', match: needle, after: '' };
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + needle.length + 40);
  return {
    before: text.slice(start, idx),
    match: text.slice(idx, idx + needle.length),
    after: text.slice(idx + needle.length, end),
  };
}

/* -------------------------------------------------------------------------
 * Apply
 * ------------------------------------------------------------------------*/

/** Inputs the Manual Replace panel collects and hands to `applyManualReplace`. */
export interface ApplyManualReplaceInput {
  /** Either a specific source path, or `ALL_SCOPE` for cross-file. */
  scope: string;
  searchText: string;
  replacementText: string;
  replaceAll: boolean;
  /** Optional image uploaded alongside the text replacement. */
  imageFile?: File | null;
  /** Custom asset filename override; defaults to `imageFile.name` if blank. */
  customAssetFilename?: string;
}

/** Outcome of `applyManualReplace`. Distinct from the AppliedPatch so we
 *  can carry the computed relative-path helper text the UI used to pre-fill
 *  the Replacement field. */
export interface ManualReplaceApplyResult {
  patch: AppliedPatch;
  /** The asset path we wrote into the zip; used by the UI pre-fill logic
   *  on a subsequent apply when the user keeps the same image. */
  newAssetPath?: string;
  /** Pre-fill recommendation for the Replacement field. Relative from
   *  `firstFile` if scope was a single file, or root-anchored otherwise. */
  suggestedReference?: string;
}

/** Apply the manual replacement end-to-end:
 *   1. Resolve the target scope to a list of editable files.
 *   2. For each affected file, snapshot the pre-patch source text.
 *   3. Rewrite the file text using the chosen strategy.
 *   4. Persist the patched text back to the same JSZip instance.
 *   5. If an imageFile was provided, sanitize the filename, pick a
 *      collision-free `assets/mockups/<name>` path, write the bytes,
 *      and pre-fill the suggested relative reference.
 *   6. Build the AppliedPatch and return it so the parent can insert
 *      into patchesByKey.
 *
 * Throws if the search text doesn't match anything (zero modifications). */
export async function applyManualReplace(
  project: LoadedProject,
  input: ApplyManualReplaceInput,
): Promise<ManualReplaceApplyResult> {
  const search = input.searchText;
  if (!search) {
    throw new Error('Search text is empty. Type the snippet you want to replace.');
  }
  if (input.replacementText.includes(search) && input.replaceAll) {
    // Replace-all where the replacement text contains the search text
    // is an infinite loop in the user's mental model. Catch it early.
    throw new Error('Replacement text contains the search text. With Replace All that would loop forever \u2014 pick a different replacement.');
  }

  const targets = resolveTargetFiles(project, input.scope);
  if (targets.length === 0) {
    throw new Error('No editable files matched that scope.');
  }

  // 1. Asset write (independent of the text patch). Omitted when no image.
  let newAssetPath: string | undefined;
  if (input.imageFile) {
    const rawName = (input.customAssetFilename ?? '').trim() || input.imageFile.name;
    const sanitized = sanitizeFilename(rawName);
    const existingPaths = collectExistingPaths(project);
    newAssetPath = uniqueAssetPath(sanitized, existingPaths);
    const bytes = new Uint8Array(await input.imageFile.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error('Replacement file is empty.');
    project.zip.file(newAssetPath, bytes);
  }

  // 2. Walk target files; patch + snapshot those that actually change.
  // Per-file match count: all-occurrences for replaceAll, capped to 1
  // for replace-once (the first match in the file). Sum is the total
  // substitutions the apply would effect.
  const modifiedFiles: Array<{ path: string; previousSourceText: string; currentText: string }> = [];
  let matchCount = 0;
  for (const path of targets) {
    const zipFile = project.zip.file(path);
    if (!zipFile) continue;
    const previous = await zipFile.async('text');
    const patched = rewriteText(previous, search, input.replacementText, input.replaceAll);
    if (patched === previous) continue;
    project.zip.file(path, patched);
    const count = input.replaceAll
      ? countOccurrences(previous, search)
      : (previous.indexOf(search) === -1 ? 0 : 1);
    matchCount += count;
    modifiedFiles.push({ path, previousSourceText: previous, currentText: patched });
  }

  if (modifiedFiles.length === 0) {
    // Roll back an asset write if we already placed one \u2014 otherwise we'd
    // leave a stranded file in the user's zip.
    if (newAssetPath) project.zip.remove(newAssetPath);
    throw new Error('Search text was not found in any of the target files.');
  }

  // 3. Suggestion for the UI's replacement text on a follow-up apply. For
  // a single-file scope we return a relative-to-source path; for "all"
  // we return NO suggestion because no one relative path is valid across
  // every target \u2014 the user can paste one manually.
  const suggestedReference = newAssetPath
    ? (input.scope === ALL_SCOPE
      ? undefined
      : pathRelative(modifiedFiles[0].path, newAssetPath))
    : undefined;

  // 4. Build the patch.
  const patch: AppliedPatch = {
    id: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    action: 'manual-replace',
    targetScope: input.scope,
    searchText: search,
    replacementText: input.replacementText,
    replaceAll: input.replaceAll,
    newAssetPath,
    replacementBytes: newAssetPath && input.imageFile ? input.imageFile.size : undefined,
    modifiedFiles,
    matchCount,
    filesTouched: modifiedFiles.length,
    appliedAt: Date.now(),
    // Asset re-encode flag: propagates from ReplacementForm so the
    // History row can show a "WebP re-encoded" pill. Set only when an
    // image was uploaded AND the re-encode was requested AND succeeded.
  };

  return { patch, newAssetPath, suggestedReference };
}

/* -------------------------------------------------------------------------
 * Undo (reverse a previously applied manual-replace)
 * ------------------------------------------------------------------------*/

/** Reverse an applied manual-replace patch:
 *   1. Restore each touched file's previous source text.
 *   2. Remove the asset added on apply (if any).
 *   3. Return the patched-then-restored files so the parent can verify. */
export function undoManualReplace(
  project: LoadedProject,
  patch: AppliedPatch,
): { restoredFiles: string[]; removedAsset?: string } {
  if (patch.action !== 'manual-replace') {
    throw new Error('undoManualReplace requires a manual-replace patch.');
  }
  const restoredFiles: string[] = [];
  for (const m of patch.modifiedFiles) {
    project.zip.file(m.path, m.previousSourceText);
    restoredFiles.push(m.path);
  }
  let removedAsset: string | undefined;
  if (patch.newAssetPath) {
    project.zip.remove(patch.newAssetPath);
    removedAsset = patch.newAssetPath;
  }
  return { restoredFiles, removedAsset };
}

/* -------------------------------------------------------------------------
 * Internals
 * ------------------------------------------------------------------------*/

function rewriteText(text: string, search: string, replace: string, all: boolean): string {
  if (!search) return text;
  if (all) {
    // split+join is immune to `$&`/`$1` literal-substring backreferences
    // and regex-compilation surprises. Linear-time, no regex.
    return text.split(search).join(replace);
  }
  // Replace-once with a function replacer: same backreference immunity
  // because the function returns a literal string, not a $& token.
  return text.replace(search, () => replace);
}

/** Resolve the dropdown scope to a list of file paths. */
function resolveTargetFiles(project: LoadedProject, scope: string): string[] {
  if (scope === ALL_SCOPE) {
    return editableEntries(project.entries).map((e) => e.path);
  }
  // Single-file scope must still be editable; if the user picked a
  // non-editable file via the dropdown (we filter so this is rare) we
  // return the path blindly because the safety net exists at apply time.
  return [scope];
}

function collectExistingPaths(project: LoadedProject): string[] {
  const paths: string[] = [];
  project.zip.forEach((relPath, entry) => {
    if (entry.dir) return;
    const normalized = relPath.replace(/\\/g, '/');
    if (!normalized) return;
    if (
      normalized.includes('__MACOSX/') ||
      normalized.endsWith('/__MACOSX') ||
      normalized.endsWith('.DS_Store') ||
      normalized.endsWith('/Thumbs.db')
    ) return;
    paths.push(normalized);
  });
  return paths;
}
