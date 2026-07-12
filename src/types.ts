import type { ZipArchiveLike } from './lib/archiveTypes';

/**
 * High-level classification of a file inside the uploaded zip.
 * Used both for stats and for picking icons / colors in the UI.
 */
export type FileCategory = 'html' | 'css' | 'js' | 'image' | 'font' | 'other';

/**
 * Minimal metadata for an entry inside the zip.
 * We intentionally avoid holding the file contents here so we don't
 * load the entire archive into memory up-front.
 */
export interface ZipEntryMeta {
  /** File name including extension (no path) */
  name: string;
  /** Normalized forward-slash path inside the archive */
  path: string;
  isDirectory: boolean;
  size: number;
  category: FileCategory;
}

export interface ProjectSummary {
  totalFiles: number;
  totalSize: number;
  htmlFiles: number;
  cssFiles: number;
  jsFiles: number;
  imageFiles: number;
}

export interface LoadedProject {
  /** Name of the uploaded zip file */
  fileName: string;
  /** Parsed archive handle, either a JSZip instance or a worker-backed facade. */
  zip: ZipArchiveLike;
  entries: ZipEntryMeta[];
  summary: ProjectSummary;
}

export type LeftPanelMode = 'images' | 'logos' | 'manual' | 'history' | 'projects';

/** Tree node built from the flat list of zip entries. */
export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileNode[];
  /** Only set when this node represents a leaf (file) entry. */
  entry?: ZipEntryMeta;
}

/* ----------------------------------------------------------------------------
 * Image fit controls
 * --------------------------------------------------------------------------
 * Lightweight adjustments a user can apply to a single detected reference
 * without picking a new image. Differentiates from 'replace' because the
 * referenced asset is unchanged — only the rendering CSS or HTML
 * attribute set changes. Applies to two and only two rendering surfaces:
 *   - HTML <img>  → inline `style` (object-fit, object-position, radius).
 *                   Overlay is NOT supported for <img> in v1 because it
 *                   would require wrapping the tag in a positioned div.
 *   - CSS url()   → background-size / background-position declarations
 *                   appended to the rule, plus a border-radius + inset
 *                   box-shadow for the hero overlay.
 *
 * NOTE: declared BEFORE `AppliedPatch` because that discriminated union
 * references `ImageFitConfig` via the `'fit-style'` variant.
 * ----------------------------------------------------------------------------*/

/** Allowed `object-fit` / `background-size` values exposed to the user. */
export type ImageFit = 'cover' | 'contain' | 'fill' | 'scale-down' | 'none';

/** Allowed `object-position` / `background-position` values. */
export type ImagePosition = 'center' | 'top' | 'bottom' | 'left' | 'right';

/** Curated set of border-radius presets so generated CSS stays small. */
export type BorderRadius = 'none' | 'small' | 'medium' | 'large' | 'full';

/** Hero overlay density. CSS-only; <img> refs surface this control as
 *  disabled because overlay requires DOM wrapping we don't do in v1. */
export type OverlayDensity = 'none' | 'light' | 'medium';

/** Combined user-facing fit configuration for one detection. */
export interface ImageFitConfig {
  /** What the chosen fit value is in pixels, derived from constants. */
  fit: ImageFit;
  position: ImagePosition;
  borderRadius: BorderRadius;
  overlay: OverlayDensity;
}

/* ----------------------------------------------------------------------------
 * Image detection
 * --------------------------------------------------------------------------*/

/** Best-guess role for a referenced image asset. */
export type ImageType =
  | 'logo'
  | 'hero'
  | 'service'
  | 'background'
  | 'icon'
  | 'favicon'
  | 'social'
  | 'unknown';

/** Resolution status for the referenced URL. */
export type ImageStatus = 'ok' | 'missing' | 'remote';

/**
 * When a detection is `remote`, a riskReason explains *why* the reference is
 * still considered "broken-ish" for the purposes of the user-facing panel.
 * Manus mockups, generic CDNs, and cross-origin HTTP refs routinely fail in
 * static deployments because the host deploys from a different origin or the
 * upstream serves hot-link-protected assets. Surfaced in the Broken Images
 * panel and the Export report.
 */
export type ImageRiskReason =
  | 'manus'
  | 'cdn'
  | 'blob-self'
  | 'cross-origin-http'
  | 'protocol-relative';

/** Which kind of host file the reference was found in. */
export type ImageSourceKind = 'html' | 'css' | 'manifest';

/**
 * One image reference discovered inside the project. `resolvedPath` and
 * `status` are computed lazily after the scan runs.
 */
export interface ImageDetection {
  /** URL as it appears in the source (with any query / fragment intact). */
  rawUrl: string;
  /** Resolved path inside the zip; empty string when the URL is remote. */
  resolvedPath: string;
  type: ImageType;
  status: ImageStatus;
  sourceKind: ImageSourceKind;
  /** Path of the host file inside the zip. */
  sourceFile: string;
  /** HTML tag name, CSS selector hint, or `icon` for manifest entries. */
  sourceTag: string;
  /** Attribute that held the URL (`src`, `href`, `content`, `srcset`, ...). */
  sourceAttr: string;
  /** Optional context (HTML property/name, rel, manifest sizes). */
  extra?: {
    property?: string;
    rel?: string;
    sizes?: string;
    cssProperty?: string;
  };
  /**
   * Only present when status === 'remote'. Drives the Broken Images filter
   * independently from `status` so a clean remote URL doesn't get flagged.
   */
  riskReason?: ImageRiskReason;
}

/* ----------------------------------------------------------------------------
 * Editing / replacement
 * --------------------------------------------------------------------------*/

export type EditorEditField = 'text' | 'src' | 'alt' | 'href' | 'class' | 'style';

export interface EditorAppliedEdit {
  field: EditorEditField;
  oldValue: string;
  newValue: string;
}

/**
 * An applied patch against a detected image reference. The `id` is stable
 * across re-applies so the UI can show "Applied" status without forking the
 * bookkeeping. `currentSourceValue` is what we last wrote into the source
 * file's URL slot — for `replace` it's the new asset reference, for
 * `remove` it's the empty deletion marker, for `placeholder` it's the
 * placeholder HTML marker (used as the lookup key for any future rework).
 *
 * Undo / reset support: every variant carries enough pre-patch state to be
 *   reverted with a single click.
 *   - The four `replace` / `fit-style` / `remove` / `placeholder` variants
 *     mutate ONE file each, so `previousSourceText` snapshots that single
 *     file's bytes as they stood immediately before the apply.
 *   - `manual-replace` can mutate MANY files in one apply, so it carries
 *     a `modifiedFiles[]` array — one entry per file actually changed,
 *     each with its own `previousSourceText` snapshot. The dedicated
 *     `manual-replace` shape is preserved here because two manual
 *     replaces against overlapping scopes must round-trip cleanly
 *     (a manual replace can straddle headlines and image refs we don't
 *     even track as detections).
 *
 *   The undo reducer in `App.tsx` switches on `action`; see
 *   `undoPatchById` for the single-action shape and the per-file loop
 *   used by `manual-replace`.
 */
export type AppliedPatch =
  | {
      id: string;
      sourceFile: string;
      sourceKind: ImageSourceKind;
      sourceTag: string;
      sourceAttr: string;
      rawUrl: string;
      action: 'replace';
      // Position the new ref occupies in the source after patching.
      currentSourceValue: string;
      // Asset-side bookkeeping for a real replacement.
      newAssetPath: string;
      originalAssetPath: string;
      replacementBytes: number;
      appliedAt: number;
      // Pre-patch snapshot of `sourceFile`. Drives the unified undo flow.
      previousSourceText: string;
      // Post-patch snapshot of `sourceFile`. Drives the diff view in the
      // History panel — always paired with `previousSourceText` so the diff
      // shows what THIS patch did, not what the file looks like today.
      currentSourceText: string;
      // Logo Helper extensions. When `logoMode` is set, the patch originated
      // from a Logo Helper run rather than a single-detection replace.
      // `injectedTextBlock` records the exact HTML text appended (or 'preserved'
      // when existing text was kept) so a re-apply or audit can see what
      // happened to the source file.
      logoMode?: LogoHelperHeaderMode;
      businessName?: string;
      injectedTextBlock?: string;
      // True iff the asset bytes were written via a WebP re-encode on apply.
      // Surfaced as a pill in the History row so the user can tell what file
      // landed in the export.
      newAssetReencoded?: boolean;
    }
  | {
      id: string;
      sourceFile: string;
      sourceKind: ImageSourceKind;
      sourceTag: string;
      sourceAttr: string;
      rawUrl: string;
      action: 'fit-style';
      // The user-facing fit configuration the patch was generated from.
      config: ImageFitConfig;
      // The literal CSS / inline-style text we wrote into the source so the
      // user can audit it in the export report in one glance.
      generatedCss: string;
      appliedAt: number;
      // Pre-patch snapshot of `sourceFile`. Drives the unified undo flow.
      previousSourceText: string;
      // Post-patch snapshot of `sourceFile`. Drives the diff view in the
      // History panel.
      currentSourceText: string;
    }
  | {
      id: string;
      sourceFile: string;
      sourceKind: ImageSourceKind;
      sourceTag: string;
      sourceAttr: string;
      rawUrl: string;
      action: 'remove';
      // Empty / whitespace so a re-apply locates the same slot.
      currentSourceValue: string;
      appliedAt: number;
      // Pre-patch snapshot of `sourceFile`. Drives the unified undo flow.
      previousSourceText: string;
      // Post-patch snapshot of `sourceFile`. Drives the diff view.
      currentSourceText: string;
    }
  | {
      id: string;
      sourceFile: string;
      sourceKind: ImageSourceKind;
      sourceTag: string;
      sourceAttr: string;
      rawUrl: string;
      action: 'placeholder';
      currentSourceValue: string;
      placeholder: { label: string };
      appliedAt: number;
      // Pre-patch snapshot of `sourceFile`. Drives the unified undo flow.
      previousSourceText: string;
      // Post-patch snapshot of `sourceFile`. Drives the diff view.
      currentSourceText: string;
    }
  | {
      id: string;
      action: 'manual-replace';
      /** Either a specific source file path or 'all-source-files' when the
       *  user picked "match across every editable file". */
      targetScope: string;
      /** The verbatim text the user provided in the Search field. We carry
       *  the literal here (not a regex) so a future undo can recompute
       *  matches deterministically without re-parsing. */
      searchText: string;
      /** The verbatim text the user provided in the Replacement field. */
      replacementText: string;
      /** true = replace every occurrence in each targeted file;
       *  false = replace only the first occurrence per file. */
      replaceAll: boolean;
      /** Path of an asset that was written to the zip on this apply, if the
       *  user uploaded an image. Used to undo the asset write; omitted if
       *  the manual replace was a pure text change. */
      newAssetPath?: string;
      replacementBytes?: number;
      /** Per-file snapshots of the source text BEFORE the patch was
       *  applied. Stored only for files that actually changed. Drives the
       *  undo button: restoring these snapshots rewinds the zip exactly.
       *  Files are typically small enough that in-memory storage per
       *  applied patch is negligible. Each entry also carries
       *  `currentText` so the History panel can render a per-file diff
       *  (manual-replace can touch many files, so we snapshot per file). */
      modifiedFiles: Array<{
        path: string;
        previousSourceText: string;
        currentText: string;
      }>;
      /** Convenience: total successful substitutions across all files. */
      matchCount: number;
      /** Convenience: files touched (== modifiedFiles.length). */
      filesTouched: number;
      appliedAt: number;
    }
  | {
      id: string;
      action: 'editor-edit';
      sourceFile: string;
      target: {
        kind: 'text' | 'image' | 'element';
        tagName: string;
        label: string;
        selectorHint?: string;
        sourceStart?: number;
        sourceEnd?: number;
      };
      edits: EditorAppliedEdit[];
      appliedAt: number;
      previousSourceText: string;
      currentSourceText: string;
    }
  | {
      id: string;
      action: 'editor-reorder';
      sourceFile: string;
      target: {
        kind: 'text' | 'image' | 'element';
        tagName: string;
        label: string;
        selectorHint?: string;
        sourceStart?: number;
        sourceEnd?: number;
      };
      reference: {
        tagName: string;
        label: string;
        selectorHint?: string;
        sourceStart?: number;
        sourceEnd?: number;
      };
      placement: 'before' | 'after';
      appliedAt: number;
      previousSourceText: string;
      currentSourceText: string;
    };

/* ----------------------------------------------------------------------------
 * Export
 * --------------------------------------------------------------------------*/

/* ----------------------------------------------------------------------------
 * Logo Helper
 * --------------------------------------------------------------------------
 * The Logo Helper is a bulk-apply workflow that lets the user upload a
 * single logo/icon asset and have it applied to multiple logo-bearing
 * references across the project. It runs ON TOP of the existing
 * per-detection replace pipeline: each affected reference still goes
 * through `applyReplacement` so the export flow and bookkeeping stay
 * identical. The Logo Helper just selects which references to act on in
 * one user-driven batch, and (in icon-with-text mode) inflates the
 * header-logo rewrite with an injected text node.
 *
 * Detection runs separately from `detectImages` because imageDetector
 * dedups by `rawUrl` per file, which collapses header/footer logos that
 * share the same source path into a single candidate we can't address
 * individually. `detectLogos` re-scans HTML for logo hints WITHOUT that
 * dedup, giving each match a unique matchIndex-based id.
 * --------------------------------------------------------------------------*/

/** Which "slot" a logo reference occupies in the design. */
export type LogoRole =
  | 'headerLogo'
  | 'footerLogo'
  | 'favicon'
  | 'appleTouchIcon'
  | 'manifestIcon';

/** How the header logo was rendered: image-only OR icon + live text. */
export type LogoHelperHeaderMode = 'image-only' | 'icon-text';

/**
 * A logo-bearing reference surfaced by `detectLogos`. Each candidate has
 * a globally-unique `id` (file + rawUrl + matchIndex) so two duplicate
 * `<img src="logo.png">` tags in the same HTML file show up as distinct
 * candidates — one for the header and one for the footer, for example.
 *
 * `parentContainerHint` carries the surrounding tag/class so the icon-text
 * rewriter has a best-guess surgery target without re-parsing the file.
 */
export interface LogoCandidate {
  /** Globally-unique id across the project. */
  id: string;
  role: LogoRole;
  /** Underlying detection id (matches ImageDetection composite key). */
  detectionId: string;
  sourceFile: string;
  sourceKind: ImageSourceKind;
  sourceTag: string;
  sourceAttr: string;
  rawUrl: string;
  resolvedPath: string;
  /** Best-effort description of the surrounding context. */
  parentContainerHint?: {
    tag: string;
    classes?: string;
    id?: string;
  };
  /** `alt` attribute if HTML <img> tag; undefined for link/manifest. */
  alt?: string;
  /** rel/sizes metadata when sourceKind==='html' and tag is <link>. */
  rel?: string;
  sizes?: string;
}

/** User-facing configuration for one Logo Helper run. */
export interface LogoHelperConfig {
  /** Roles to apply the uploaded asset to. */
  targets: Set<LogoRole>;
  /** Header logo mode — relevant only when targets includes 'headerLogo'. */
  headerMode: LogoHelperHeaderMode;
  /** Business name displayed beside the icon when headerMode=='icon-text'. */
  businessName: string;
  /** User-customised business name per role (footer etc. — future). */
  perRoleBusinessNames?: Partial<Record<LogoRole, string>>;
}

/** A group record of N applied patches generated by one Logo Helper run. */
export interface LogoHelperAppliedGroup {
  appliedAt: number;
  config: LogoHelperConfig;
  /** References to the per-detection AppliedPatches via their stable ids. */
  patchIds: string[];
  /** True iff icon-text mode injected text into the parent container. */
  textInjectionApplied: boolean;
}

/* ----------------------------------------------------------------------------
 * Export
 *
 *   - `idle`    — the export button is ready and clickable.
 *   - `busy`    — `buildExport` is running; the button is disabled and shows progress.
 *   - `success` — the export zip was generated and downloaded; the right panel
 *                 surfaces a summary card and an "Export again" affordance.
 *   - `error`   — `buildExport` failed; the right panel surfaces the error and
 *                 a retry button.
 */
export type ExportState = 'idle' | 'busy' | 'success' | 'error';

/**
 * Aggregated counts the report and the success card both rely on. `reportText`
 * is the full MOCKUPSWAP_CHANGES.md body so the UI can show a preview if we
 * ever want to.
 */
export interface ExportSummary {
  filename: string;
  zipSizeBytes: number;
  replacementCount: number;
  /** Number of patches whose action is `'remove'`. */
  removedCount: number;
  /** Number of patches whose action is `'placeholder'`. */
  placeholderCount: number;
  brokenCount: number;
  remoteCount: number;
  fileCount: number;
  reportText: string;
}
