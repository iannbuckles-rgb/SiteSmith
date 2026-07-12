/* ----------------------------------------------------------------------------
 * previewControls
 * ----------------------------------------------------------------------------
 * Shared types / constants for the live-website preview controls. Lives in
 * `src/lib` (alongside the other pure-TS helpers) because both the top-level
 * state-holder (`App.tsx`) and the presentational stage (`CenterPanel.tsx`)
 * need to agree on the same shape, and `tsc`'s `noUnusedLocals` rule would
 * otherwise let one side declare a copy that's silently out of sync.
 *
 * Adding a viewport preset? Update `PreviewViewport` + `VIEWPORT_DIMENSIONS`
 * together. Adding a zoom step? Update `ZOOM_PRESETS` only. The pair stays
 * the single source of truth for both files.
 * -------------------------------------------------------------------------*/

/**
 * Discrete viewport sizes for the preview stage. `mobile` / `tablet` /
 * `desktop` lock the iframe to a target device width so designers can
 * sanity-check how their hero / nav look at common breakpoints; `full`
 * means "stretch to fill the available area" with no fixed pixel box.
 */
export type PreviewViewport = 'mobile' | 'tablet' | 'desktop' | 'full';

/** Top-level preview surface mode. Preview keeps the rendered site fully
 * interactive; editor turns clicks into element selection + mutation events. */
export type PreviewMode = 'preview' | 'editor';

export type EditorSelectionKind = 'text' | 'image';

export interface EditorSelection {
  sourceFile: string;
  kind: EditorSelectionKind;
  tagName: string;
  label: string;
  text?: string;
  src?: string;
  alt?: string;
  href?: string;
  selectorHint?: string;
}

/** Per-viewport dimension table backing `mobile` / `tablet` / `desktop`.
 *  Excluded `full` because `full` follows the container, not a fixed box. */
interface ViewportDims {
  width: number;
  height: number;
  label: string;
  device: string;
}

export const VIEWPORT_DIMENSIONS: Record<Exclude<PreviewViewport, 'full'>, ViewportDims> = {
  mobile:  { width: 375,  height: 667,  label: 'Mobile',  device: '375 × 667' },
  tablet:  { width: 768,  height: 1024, label: 'Tablet',  device: '768 × 1024' },
  desktop: { width: 1280, height: 800,  label: 'Desktop', device: '1280 × 800' },
};

/**
 * Zoom levels offered in the toolbar dropdown. 25%–200% in 25% steps
 * covers the cases designers actually need (sanity-checking small UI
 * elements and inspecting pixel-snap detail); finer granularity would
 * clutter the dropdown without measurably changing the rendered output.
 */
export const ZOOM_PRESETS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * Navigation history of the preview. `pages` is the full stack of HTML
 * paths visited; `index` points at the current entry. When the user
 * picks a NEW page while standing on an earlier history entry, the
 * forward history is truncated — this matches browser convention so
 * the back button always returns to the previous physical page in
 * browsing order rather than a stale fork.
 */
export interface PreviewHistoryState {
  pages: string[];
  index: number;
}
