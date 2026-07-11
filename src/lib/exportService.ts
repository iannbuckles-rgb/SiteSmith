import JSZip from 'jszip';

import { formatBytes } from './fileTypes';
import type {
  AppliedPatch,
  ImageDetection,
  LoadedProject,
} from '../types';


/**
 * Optional progress callback. Receives the same `{ percent }` shape that
 * JSZip's `onUpdate(metadata)` surfaces during `generateAsync`. The
 * percent is in the 0..100 range and monotonically non-decreasing; a
 * single, possibly-imperfect, terminal `percent === 100` event fires
 * just before the promise resolves. The caller is expected to clamp +
 * floor/round (the TopBar widget does this in `describePhase`).
 */
export interface BuildExportProgress {
  percent: number;
}

/**
 * Build an export-ready zip. We deliberately do NOT mutate `project.zip`
 * further: we copy every non-metadata entry into a fresh `JSZip` instance,
 * append the human-readable report, then `generateAsync` the result.
 *
 * - Folder structure is preserved verbatim because we copy entries with
 *   their original paths.
 * - The exported HTML / CSS carry the patched, relative-path references
 *   written by `applyReplacement`. There are no blob URLs and no absolute
 *   local paths, so the zip is immediately deployable.
 *
 * Pre-conditions: `project` is a LiveProject-like object with an in-memory
 * JSZip that already contains every replacement applied so far.
 */
export async function buildExport(
  project: LoadedProject,
  patches: AppliedPatch[],
  detections: ImageDetection[],
  options?: {
    /** Forwarded to JSZip's `onUpdate(metadata)` during generateAsync. */
    onProgress?: (metadata: BuildExportProgress) => void;
  },
): Promise<{ blob: Blob; filename: string; reportText: string; fileCount: number }> {
  const outZip = new JSZip();
  let fileCount = 0;

  // Copy every non-directory entry from the live zip. Queuing the
  // `entry.async('uint8array')` promise is fine; JSZip awaits it during
  // generateAsync, so we don't need a buffering pass.
  project.zip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) return;
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized) return;
    // Defensive: some macOS zippers sneak these in despite zipReader's
    // filtering; one more layer of safety costs nothing.
    if (
      normalized.includes('__MACOSX/') ||
      normalized.endsWith('/__MACOSX') ||
      normalized.endsWith('.DS_Store') ||
      normalized.endsWith('/Thumbs.db')
    ) return;

    outZip.file(normalized, zipEntry.async('uint8array'));
    fileCount += 1;
  });

  const reportText = buildReport(patches, detections);
  outZip.file('MOCKUPSWAP_CHANGES.md', reportText);

  // `onUpdate` is the 2nd positional arg per @types/jszip 3.10.1;
  // passing it as an options property would be a TS error AND a silent
  // runtime no-op. Typing the callback against Parameters<...>[1] keeps
  // the metadata signature auto-tracked if the library evolves.
  const onUpdate: NonNullable<Parameters<typeof outZip.generateAsync>[1]> =
    (metadata) => {
      options?.onProgress?.({ percent: metadata.percent });
    };
  const blob = await outZip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    onUpdate,
  );

  const filename = deriveExportFilename(project.fileName);
  return { blob, filename, reportText, fileCount: fileCount + 1 };
}

/**
 * Trigger an in-browser download for a blob. We use the standard
 * object-URL + hidden anchor pattern and revoke shortly after the click
 * propagates \u2014 long enough for Firefox / Safari to honour the download
 * attribute, short enough that we don't leak object URLs between exports.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

/* ---------------------------------------------------------------------------
 * Filename helper
 * -------------------------------------------------------------------------*/

export function deriveExportFilename(original: string): string {
  let stem = original;
  const lower = original.toLowerCase();
  if (lower.endsWith('.zip')) {
    stem = original.slice(0, -4);
  } else {
    const i = original.lastIndexOf('.');
    if (i > 0) stem = original.slice(0, i);
  }
  stem = stem
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!stem) stem = 'site';
  return `${stem}-mockupswap.zip`;
}

/* ---------------------------------------------------------------------------
 * MOCKUPSWAP_CHANGES.md report
 * -------------------------------------------------------------------------*/

const REPORT_NAME = 'MOCKUPSWAP_CHANGES.md';
const LIST_BROKEN_CAP = 50;
const LIST_REMOTE_CAP = 30;
const LIST_MISSING_CAP = 50;
const LIST_REMOVED_CAP = 50;
const LIST_PLACEHOLDER_CAP = 50;

export function buildReport(patches: AppliedPatch[], detections: ImageDetection[]): string {
  const lines: string[] = [];
  const now = new Date().toISOString();

  lines.push(`# ${REPORT_NAME.replace(/\.md$/, '')}`, '');
  lines.push(`**Generated:** ${now}`, '');
  lines.push(
    'This file is informational. MockupSwap added it to every exported archive so you can audit what changed and what is still unresolved. You can leave it in the project, or delete it before deploying \u2014 it has no runtime effect.',
    '',
  );
  lines.push('---', '');

  lines.push('## Images replaced', '');
  const replacePatches = patches.filter((p) => p.action === 'replace');
  if (replacePatches.length === 0) {
    lines.push('_No replacements were applied._', '', '---', '');
  } else {
    lines.push(
      `${replacePatches.length} replacement${replacePatches.length === 1 ? '' : 's'} applied. The original referenced file(s) remain in the archive but are no longer referenced by any source file.`,
      '',
    );
    // Iterate only the 'replace' variants — `newAssetPath` /
    // `replacementBytes` are present only on the 'replace' arm of the
    // AppliedPatch discriminated union.
    const sorted = replacePatches.sort((a, b) => {
      const f = a.sourceFile.localeCompare(b.sourceFile);
      if (f !== 0) return f;
      return a.rawUrl.localeCompare(b.rawUrl);
    });
    let lastSource = '';
    for (const p of sorted) {
      if (p.sourceFile !== lastSource) {
        if (lastSource !== '') lines.push('');
        lines.push(`### \`${p.sourceFile}\``, '');
        lastSource = p.sourceFile;
      }
      const at = new Date(p.appliedAt).toISOString();
      lines.push(`- **Old path** (in source): \`${p.rawUrl}\``);
      lines.push(`  **New path** (in source): \`${p.currentSourceValue}\``);
      lines.push(`  **Asset added** to archive: \`${p.newAssetPath}\` (${formatBytes(p.replacementBytes)})`);
      lines.push(`  Applied at: ${at}`);
    }
    lines.push('', '---', '');
  }

  // Broken / missing local references \u2014 surfaced from the original upload.
  const broken = detections.filter((d) => d.status === 'missing');
  lines.push('## Broken images detected', '');
  if (broken.length === 0) {
    lines.push(
      '_None._ Every local image reference in the source files pointed at an asset present in the archive.',
      '',
    );
  } else {
    lines.push(
      `${broken.length} reference${broken.length === 1 ? '' : 's'} in the original HTML/CSS pointed at local assets that were not in the archive.${
        patches.length > 0 ? ' Any that were replaced are listed under "Images replaced" above; the rest remain unresolved.' : ''
      }`,
      '',
    );
    for (const d of sortByFile(broken).slice(0, LIST_BROKEN_CAP)) {
      lines.push(`- \`${d.rawUrl}\` referenced in \`${d.sourceFile}\` (${d.type})`);
    }
    if (broken.length > LIST_BROKEN_CAP) {
      lines.push(`- \u2026 and ${broken.length - LIST_BROKEN_CAP} more.`);
    }
    lines.push('');
  }

  // Remote dependencies (not localized).
  const remote = detections.filter((d) => d.status === 'remote');
  lines.push('## Remaining remote dependencies', '');
  if (remote.length === 0) {
    lines.push('_None._ Every reference was local.', '');
  } else {
    lines.push(
      `${remote.length} reference${remote.length === 1 ? '' : 's'} point at external hosts. The deployed site will require network access at runtime to fetch these.`,
      '',
    );
    for (const d of sortByFile(remote).slice(0, LIST_REMOTE_CAP)) {
      lines.push(`- \`${d.rawUrl}\` referenced in \`${d.sourceFile}\` (${d.type})`);
    }
    if (remote.length > LIST_REMOTE_CAP) {
      lines.push(`- \u2026 and ${remote.length - LIST_REMOTE_CAP} more.`);
    }
    lines.push('');
  }

  // Remaining unresolved broken references. We subtract both replace-style
  // takeovers (matched on `resolvedPath`) and remove/placeholder patches
  // (matched on the same `sourceFile|sourceTag|sourceAttr|rawUrl`
  // composite key used by `patchesByKey`). Without the second pass, a
  // detection that was originally missing AND then removed would still
  // appear in this list \u2014 double-reported.
  const replacedOriginals = new Set(
    patches
      .filter((p) => p.action === 'replace')
      .map((p) => p.originalAssetPath)
      .filter((p): p is string => Boolean(p)),
  );
  const patchedDetectionKeys = new Set(
    patches
      .filter((p) => p.action === 'remove' || p.action === 'placeholder')
      .map((p) => `${p.sourceFile}|${p.sourceTag}|${p.sourceAttr}|${p.rawUrl}`),
  );
  const remainingMissing = broken.filter((d) => {
    const key = `${d.sourceFile}|${d.sourceTag}|${d.sourceAttr}|${d.rawUrl}`;
    if (patchedDetectionKeys.has(key)) return false;
    const path = d.resolvedPath ?? '';
    return !!path && !replacedOriginals.has(path);
  });

  // Removed and placeholder sections.
  const removed = patches.filter((p) => p.action === 'remove');
  const placeholder = patches.filter((p) => p.action === 'placeholder');
  lines.push('## Remaining missing assets', '');
  if (remainingMissing.length === 0) {
    if (broken.length === 0) {
      lines.push('_Nothing was broken in the original archive \u2014 nothing remains to fix._', '');
    } else {
      lines.push(
        `_Every originally-broken reference was replaced; the remaining list is empty._`,
        '',
      );
    }
  } else {
    lines.push(
      `${remainingMissing.length} originally-broken reference${remainingMissing.length === 1 ? '' : 's'} were NOT replaced. They will render as broken-image icons on deploy unless the underlying asset is supplied under the original path.`,
      '',
    );
    for (const d of sortByFile(remainingMissing).slice(0, LIST_MISSING_CAP)) {
      lines.push(`- \`${d.rawUrl}\` referenced in \`${d.sourceFile}\` (${d.type})`);
    }
    if (remainingMissing.length > LIST_MISSING_CAP) {
      lines.push(`- \u2026 and ${remainingMissing.length - LIST_MISSING_CAP} more.`);
    }
    lines.push('');
  }

  lines.push('## Image references removed', '');
  if (removed.length === 0) {
    lines.push('_None._ No image references were removed during this session.', '');
  } else {
    lines.push(
      `${removed.length} reference${removed.length === 1 ? '' : 's'} were removed from their host files. For CSS, only the \`url(...)\` token was deleted and the surrounding color / position / repeat tokens were preserved where the original \`background\` shorthand stayed valid. For HTML \`<img>\` tags the entire tag was dropped. The deploy-time behavior of backgrounds is unchanged except for the missing image.`,
      '',
    );
    const sorted = [...removed].sort((a, b) => {
      const f = a.sourceFile.localeCompare(b.sourceFile);
      if (f !== 0) return f;
      return a.rawUrl.localeCompare(b.rawUrl);
    });
    let lastSource = '';
    let count = 0;
    for (const p of sorted) {
      if (count >= LIST_REMOVED_CAP) break;
      if (p.sourceFile !== lastSource) {
        if (lastSource !== '') lines.push('');
        lines.push(`### \`${p.sourceFile}\``, '');
        lastSource = p.sourceFile;
      }
      const at = new Date(p.appliedAt).toISOString();
      lines.push(`- Removed \`${p.rawUrl}\` (${p.sourceTag}${p.sourceAttr && p.sourceAttr !== p.sourceTag ? `·${p.sourceAttr}` : ''}) at ${at}`);
      count += 1;
    }
    if (removed.length > LIST_REMOVED_CAP) {
      lines.push(`- \u2026 and ${removed.length - LIST_REMOVED_CAP} more.`);
    }
    lines.push('');
  }

  lines.push('## Image references replaced with placeholders', '');
  if (placeholder.length === 0) {
    lines.push('_None._ No \`<img>\` tags were converted to placeholder blocks.', '');
  } else {
    lines.push(
      `${placeholder.length} \`<img>\` reference${placeholder.length === 1 ? ' was' : 's were'} converted to a styled placeholder div. Existing \`class\` / \`style\` / \`id\` / \`width\` / \`height\` attributes are preserved so layout hooks still apply.`,
      '',
    );
    const sorted = [...placeholder].sort((a, b) => {
      const f = a.sourceFile.localeCompare(b.sourceFile);
      if (f !== 0) return f;
      return a.rawUrl.localeCompare(b.rawUrl);
    });
    let lastSource = '';
    let count = 0;
    for (const p of sorted) {
      if (count >= LIST_PLACEHOLDER_CAP) break;
      if (p.sourceFile !== lastSource) {
        if (lastSource !== '') lines.push('');
        lines.push(`### \`${p.sourceFile}\``, '');
        lastSource = p.sourceFile;
      }
      const at = new Date(p.appliedAt).toISOString();
      lines.push(`- \`<img>\` → placeholder labelled **${p.placeholder.label}** for old URL \`${p.rawUrl}\` at ${at}`);
      count += 1;
    }
    if (placeholder.length > LIST_PLACEHOLDER_CAP) {
      lines.push(`- \u2026 and ${placeholder.length - LIST_PLACEHOLDER_CAP} more.`);
    }
    lines.push('');
  }

  // Fit & style applied section. Pulled BEFORE the Logo Helper block so a
  // single page that had both logo and hero fit tweaks reads top-to-bottom
  // in the order "what we changed about layout" then "what we changed
  // about the brand". Grouped by (sourceFile) so a single hero css file
  // that borrowed six fit tweaks reads as one block per file.
  const fitPatches = patches.filter(
    (p): p is Extract<AppliedPatch, { action: 'fit-style' }> =>
      p.action === 'fit-style',
  );
  if (fitPatches.length > 0) {
    lines.push('## Fit & style applied', '');
    lines.push(
      `${fitPatches.length} fit-style tweak${fitPatches.length === 1 ? '' : 's'} applied. These do not change the referenced asset — only how it renders (cropping, position, rounded corners, optional hero overlay).`,
      '',
    );
    const fitByFile = new Map<string, Array<Extract<AppliedPatch, { action: 'fit-style' }>>>();
    for (const p of fitPatches) {
      const arr = fitByFile.get(p.sourceFile) ?? [];
      arr.push(p);
      fitByFile.set(p.sourceFile, arr);
    }
    for (const [sourceFile, group] of fitByFile) {
      lines.push(`### \`${sourceFile}\``, '');
      const sorted = [...group].sort((a, b) => a.rawUrl.localeCompare(b.rawUrl));
      for (const p of sorted) {
        const kind = p.sourceKind === 'css' ? 'CSS rule' : 'HTML <img>';
        const at = new Date(p.appliedAt).toISOString();
        lines.push(`- **${kind}** for \`${p.rawUrl.trim()}\``);
        lines.push(`  Fit: \`object-fit: ${p.config.fit}\` / position: \`object-position: ${p.config.position}\``);
        lines.push(`  Border-radius: \`${p.config.borderRadius}\` / overlay: \`${p.config.overlay}\``);
        lines.push(`  Generated CSS: \`${p.generatedCss.trim()}\``);
        lines.push(`  Applied at: ${at}`);
      }
      lines.push('');
    }
  }

  // Manual Replacements section. Pulled BEFORE Logo Helper because the
  // audit audience reads \"what the user manually rewrote\" before the
  // \"what the Logo Helper bulk-applied\". A single manual-replace patch
  // can touch multiple files, so we group per-source-file with the file's
  // match count and the literal finder/replacement strings the user
  // typed — that lets an auditor re-run a search against the export and
  // reproduce the change without guessing.
  const manualPatches = patches.filter(
    (p): p is Extract<AppliedPatch, { action: 'manual-replace' }> =>
      p.action === 'manual-replace',
  ).sort((a, b) => b.appliedAt - a.appliedAt);
  if (manualPatches.length > 0) {
    lines.push('## Manual replacements', '');
    lines.push(
      `${manualPatches.length} manual replace${manualPatches.length === 1 ? '' : 's'} applied. Each entry lists exactly which files were touched, how many matches were rewritten, the search snippet the user typed, and the replacement it became. Asset uploads are listed when applicable.`,
      '',
    );
    for (const p of manualPatches) {
      const scopeLabel = p.targetScope === 'all-source-files'
        ? `All editable files (${p.filesTouched})`
        : p.targetScope;
      const modeLabel = p.replaceAll ? 'Replace all' : 'Replace once';
      const at = new Date(p.appliedAt).toISOString();
      lines.push(`### \`${scopeLabel}\``, '');
      lines.push(`- **Mode**: ${modeLabel}`);
      lines.push(`- **Total matches**: ${p.matchCount} across ${p.filesTouched} file${p.filesTouched === 1 ? '' : 's'}`);
      lines.push(`- **Find**: \`${p.searchText.replace(/`/g, '\u2018')}\``);
      lines.push(`- **Replace with**: \`${p.replacementText.replace(/`/g, '\u2018')}\``);
      if (p.newAssetPath) {
        const sizeText = p.replacementBytes ? ` (${formatBytes(p.replacementBytes)})` : '';
        lines.push(`- **Asset added** to archive: \`${p.newAssetPath}\`${sizeText}`);
      }
      if (p.modifiedFiles.length > 0) {
        lines.push('- **Files patched**:');
        for (const f of p.modifiedFiles) {
          lines.push(`  - \`${f.path}\``);
        }
      }
      lines.push(`- **Applied at**: ${at}`);
      lines.push('');
    }
  }

  // Logo Helper applied section. Every 'replace' patch carrying Logo Helper
  // metadata (logoMode set) is grouped by the (sourceFile, asset) pair so
  // the report reads like a checklist, with one block per affected file.
  const logoPatches = patches.filter(
    (p): p is Extract<AppliedPatch, { action: 'replace' }> =>
      p.action === 'replace' && !!p.logoMode,
  );
  if (logoPatches.length > 0) {
    lines.push('## Logo Helper applied', '');
    lines.push(
      `${logoPatches.length} logo${logoPatches.length === 1 ? '' : 's'} applied through the Logo Helper. Each entry shows the role, the asset that was written into the archive, and whether a live HTML text node was injected beside the icon.`,
      '',
    );
    const groups = new Map<string, Array<Extract<AppliedPatch, { action: 'replace' }>>>();
    for (const p of logoPatches) {
      const key = `${p.sourceFile}::${p.newAssetPath}`;
      const arr = groups.get(key) ?? [];
      arr.push(p);
      groups.set(key, arr);
    }
    let groupIndex = 0;
    for (const [key, group] of groups) {
      groupIndex += 1;
      const [sourceFile, newAssetPath] = key.split('::');
      const headerPatch = group.find((g) => roleFromId(g.id) === 'headerLogo');
      const headerMode = headerPatch?.logoMode ?? group[0].logoMode;
      const businessName = group.map((g) => g.businessName).find(Boolean);
      const injected = group.find((g) =>
        typeof g.injectedTextBlock === 'string'
        && g.injectedTextBlock.startsWith('<span'),
      );
      lines.push(`### Group ${groupIndex} — \`${sourceFile}\``, '');
      lines.push(`- **Asset added** to archive: \`${newAssetPath}\` (${formatBytes(group[0].replacementBytes)})`);
      lines.push(`- **Header mode**: \`${headerMode ?? 'n/a'}\``);
      if (businessName) lines.push(`- **Business name**: ${businessName}`);
      if (injected) {
        lines.push(`- **Live text injected**: yes — a real \`<span>\` was added beside the icon. The business name is NOT baked into the image.`);
      } else if (headerMode === 'icon-text') {
        lines.push(`- **Live text injected**: no — existing text beside the logo was preserved.`);
      }
      for (const p of group) {
        lines.push(`  - **Old URL** \`${p.rawUrl}\` → **New URL** \`${p.currentSourceValue}\` (${roleFromId(p.id)})`);
      }
    }
    lines.push('');
  }

  lines.push('---', '');
  lines.push('_Generated by MockupSwap._', '');
  return lines.join('\n');
}

function sortByFile(detections: ImageDetection[]): ImageDetection[] {
  return [...detections].sort((a, b) => {
    const f = a.sourceFile.localeCompare(b.sourceFile);
    if (f !== 0) return f;
    return a.rawUrl.localeCompare(b.rawUrl);
  });
}

/** Best-effort role hint pulled from a Logo Helper candidate's id; used
 *  solely for the export report so the user can scan the file and tell
 *  which role each patch addressed. Returns 'logo' as a safe fallback. */
function roleFromId(id: string): string {
  if (id.endsWith('#header:') || id.includes('#header:')) return 'headerLogo';
  if (id.endsWith('#footer:') || id.includes('#footer:')) return 'footerLogo';
  if (id.includes('apple-touch-icon') || id.endsWith('#apple-touch-icon')) return 'appleTouchIcon';
  if (id.includes('#icon') || id.endsWith('icon')) return 'favicon';
  return 'logo';
}
