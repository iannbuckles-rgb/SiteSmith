/* ----------------------------------------------------------------------------
 * CenterPanel
 * ----------------------------------------------------------------------------
 * The middle column of the editor — host of the live website preview.
 *
 * Surface layout (always)
 * -----------------------
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  <PreviewToolbar>  ─  page, history, viewport, zoom, actions   │
 *   ├────────────────────────────────────────────────────────────────┤
 *   │                                                                │
 *   │  <PreviewStage>  ─  iframe inside a viewport-shaped box,       │
 *   │                     zoom-able, fullscreen-able, portals out    │
 *   │                     of the grid when fullscreen is on          │
 *   │                                                                │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * What this version improves over the previous one
 * -------------------------------------------------
 *   1. Viewport presets (mobile / tablet / desktop / full). Designs
 *      ship at multiple sizes — this lets the user sanity-check a
 *      hero at 375 px and a nav at 1280 px without leaving the page.
 *   2. Zoom (25 %–200 %). Designers routinely want to inspect pixel-
 *      snap details; a 4-step slider lives in the toolbar.
 *   3. Navigation history with back/forward buttons. The injected
 *      navScript already steers link clicks via postMessage; routing
 *      every page change through one navigator keeps the history
 *      stack consistent across dropdown, in-iframe clicks, and undo.
 *   4. Fullscreen mode. A button (and ESC) flips the panel into a
 *      fixed-position overlay via createPortal, giving the preview
 *      the entire viewport minus the topbar. ESC traps to exit.
 *   5. Open in new window. `window.open(blob:..., '_blank',
 *      'noopener,noreferrer')` pops the current page out so the
 *      designer can look at it in isolation.
 *   6. Edit-count pill. A subtle violet chip in the toolbar surface
 *      "N edits applied" so the user knows the preview reflects
 *      their work.
 *   7. Better building state. A spinning ring inside a checker
 *      pattern that matches the stage background, so the transition
 *      reads as "the page is being prepared" rather than "the page
 *      disappeared".
 * -------------------------------------------------------------------------*/

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type { LoadedProject } from '../types';
import type { PreviewIndex } from '../lib/previewService';
import {
  VIEWPORT_DIMENSIONS,
  ZOOM_PRESETS,
  type PreviewMode,
  type PreviewHistoryState,
  type PreviewViewport,
} from '../lib/previewControls';

interface CenterPanelProps {
  project: LoadedProject | null;
  preview: PreviewIndex | null;
  previewBuilding: boolean;
  previewKey: number;
  currentPagePath: string;
  onSelectPage: (path: string) => void;
  onRefresh: () => void;
  // Toolbar controls — passed down so App.tsx owns the state and the
  // panel stays purely presentational.
  viewport: PreviewViewport;
  onChangeViewport: (vp: PreviewViewport) => void;
  zoom: number;
  onChangeZoom: (z: number) => void;
  history: PreviewHistoryState;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Called on `keydown` so parent state clears; App uses this to
   *  flip `previewFullscreen` to false. */
  onExitFullscreen: () => void;
  onOpenInNewTab: () => void;
  mode: PreviewMode;
  onChangeMode: (mode: PreviewMode) => void;
  /** Number of AppliedPatch entries currently applied. Drawn as a
   *  small violet pill in the toolbar so the user can tell at a
   *  glance when their preview reflects work. */
  editCount: number;
}

export function CenterPanel({
  project,
  preview, previewBuilding, previewKey, currentPagePath,
  onSelectPage, onRefresh,
  viewport, onChangeViewport,
  zoom, onChangeZoom,
  history, onNavigateBack, onNavigateForward,
  fullscreen, onToggleFullscreen, onExitFullscreen,
  onOpenInNewTab,
  mode, onChangeMode,
  editCount,
}: CenterPanelProps) {
  // ESC closes fullscreen overlay — a universal expectation for
  // maximised views. The handler only mounts when the overlay is
  // actually shown so we don't pay for the listener otherwise.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onExitFullscreen();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen, onExitFullscreen]);

  const toolbar = (
    <PreviewToolbar
      project={project}
      preview={preview}
      currentPagePath={currentPagePath}
      onSelectPage={onSelectPage}
      onRefresh={onRefresh}
      viewport={viewport}
      onChangeViewport={onChangeViewport}
      zoom={zoom}
      onChangeZoom={onChangeZoom}
      history={history}
      onNavigateBack={onNavigateBack}
      onNavigateForward={onNavigateForward}
      fullscreen={fullscreen}
      onToggleFullscreen={onToggleFullscreen}
      onOpenInNewTab={onOpenInNewTab}
      mode={mode}
      onChangeMode={onChangeMode}
      editCount={editCount}
    />
  );

  const stage = (
    <div className="preview-stage flex-1 overflow-auto" data-testid="preview-stage">
      <PreviewStage
        project={project}
        preview={preview}
        previewBuilding={previewBuilding}
        previewKey={previewKey}
        currentPagePath={currentPagePath}
        viewport={viewport}
        zoom={zoom}
        mode={mode}
      />
    </div>
  );

  // Fullscreen takes the surface out of the 3-column grid via a
  // portal: the panel renders into document.body so the rest of the
  // editor (sidebars, modal, etc.) naturally falls behind the
  // overlay. Empty space behind the overlay is dimmed by a subtle
  // tinted backdrop extending the deep-zinc system tone.
  if (fullscreen) {
    return createPortal(
      <div
        className="preview-fullscreen-root fixed inset-0 z-[60] flex flex-col bg-zinc-950"
        data-testid="preview-panel-fullscreen"
      >
        {toolbar}
        {stage}
      </div>,
      document.body,
    );
  }

  return (
    <main
      className="flex h-full min-h-0 flex-col bg-zinc-950"
      data-testid="preview-panel"
    >
      {toolbar}
      {stage}
    </main>
  );
}

/* ---------------------------------------------------------------------------
 * Toolbar
 * -------------------------------------------------------------------------*/

interface PreviewToolbarProps {
  project: LoadedProject | null;
  preview: PreviewIndex | null;
  currentPagePath: string;
  onSelectPage: (path: string) => void;
  onRefresh: () => void;
  viewport: PreviewViewport;
  onChangeViewport: (vp: PreviewViewport) => void;
  zoom: number;
  onChangeZoom: (z: number) => void;
  history: PreviewHistoryState;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenInNewTab: () => void;
  mode: PreviewMode;
  onChangeMode: (mode: PreviewMode) => void;
  editCount: number;
}

function PreviewToolbar({
  project, preview, currentPagePath,
  onSelectPage,
  onRefresh,
  viewport, onChangeViewport,
  zoom, onChangeZoom,
  history, onNavigateBack, onNavigateForward,
  fullscreen, onToggleFullscreen,
  onOpenInNewTab,
  mode, onChangeMode,
  editCount,
}: PreviewToolbarProps) {
  const hasPages = !!project && !!preview && preview.htmlPaths.length > 0;
  const canGoBack = hasPages && history.index > 0;
  const canGoForward = hasPages && history.index < history.pages.length - 1;
  const htmlPathOptions = preview?.htmlPaths ?? [];

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-zinc-800 bg-zinc-900/80 px-3 py-1.5 backdrop-blur"
      data-testid="preview-toolbar"
    >
      {/* Brand + counts — the chunk that stays visible even on
        the narrowest viewports because it's the lowest-flex item
        on the left. */}
      <div className="flex shrink-0 items-center gap-2" data-testid="preview-brand">
        <h2 className="text-sm font-semibold text-zinc-200">Preview</h2>
        {project && (
          <span
            className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400"
            data-testid="preview-file-count"
          >
            {project.summary.totalFiles} files
          </span>
        )}
        {editCount > 0 && (
          <span
            className="rounded-full bg-violet-900/60 px-2 py-0.5 text-[11px] font-medium text-violet-200 ring-1 ring-violet-700/50"
            title="Edits applied in this session"
            data-testid="preview-edit-count"
          >
            {editCount} edit{editCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* History-aware page navigation. Hidden entirely when the
        project has no HTML — there's nothing to navigate between. */}
      {hasPages && (
        <>
          <ToolbarDivider />
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Page navigation history"
          >
            <IconButton
              onClick={onNavigateBack}
              disabled={!canGoBack}
              testId="preview-nav-back"
              title="Previous page (Alt+←)"
              ariaLabel="Previous page"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </IconButton>
            <IconButton
              onClick={onNavigateForward}
              disabled={!canGoForward}
              testId="preview-nav-forward"
              title="Next page (Alt+→)"
              ariaLabel="Next page"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </IconButton>
          </div>
          <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-400">
            <span className="hidden text-zinc-500 sm:inline">Page</span>
            <select
              value={currentPagePath}
              onChange={(event) => onSelectPage(event.target.value)}
              className="max-w-[260px] truncate rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] text-zinc-100 transition-colors hover:border-zinc-500 focus:border-violet-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
              title={currentPagePath}
              data-testid="preview-page-select"
            >
              {htmlPathOptions.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
        </>
      )}

      {/* Viewport presets — these chips are what `professional`
        preview-tooling surfaces always expose. Each is two-tone:
        an icon + label, with the active variant lifted to violet. */}
      <ToolbarDivider />
      <div
        className="flex shrink-0 items-center gap-1"
        role="group"
        aria-label="Preview viewport size"
      >
        <ViewportChip
          active={viewport === 'mobile'}
          onClick={() => onChangeViewport('mobile')}
          testId="viewport-mobile"
          title={hasPages ? `Mobile (${VIEWPORT_DIMENSIONS.mobile.device})` : 'Upload a project to enable'}
          disabled={!hasPages}
          icon={<PhoneIcon />}
          label={VIEWPORT_DIMENSIONS.mobile.label}
        />
        <ViewportChip
          active={viewport === 'tablet'}
          onClick={() => onChangeViewport('tablet')}
          testId="viewport-tablet"
          title={hasPages ? `Tablet (${VIEWPORT_DIMENSIONS.tablet.device})` : 'Upload a project to enable'}
          disabled={!hasPages}
          icon={<TabletIcon />}
          label={VIEWPORT_DIMENSIONS.tablet.label}
        />
        <ViewportChip
          active={viewport === 'desktop'}
          onClick={() => onChangeViewport('desktop')}
          testId="viewport-desktop"
          title={hasPages ? `Desktop (${VIEWPORT_DIMENSIONS.desktop.device})` : 'Upload a project to enable'}
          disabled={!hasPages}
          icon={<DesktopIcon />}
          label={VIEWPORT_DIMENSIONS.desktop.label}
        />
        <ViewportChip
          active={viewport === 'full'}
          onClick={() => onChangeViewport('full')}
          testId="viewport-full"
          title={hasPages ? 'Stretch to fit available area' : 'Upload a project to enable'}
          disabled={!hasPages}
          icon={<FullWidthIcon />}
          label="Full"
        />
      </div>

      {/* Zoom — kept separated from viewport because they're
        orthogonal dimensions (device size × scale). */}
      {hasPages && (
        <>
          <ToolbarDivider />
          <label className="flex items-center gap-1.5 text-[11px] text-zinc-400">
            <span className="hidden text-zinc-500 sm:inline">Zoom</span>
            <select
              value={String(zoom)}
              onChange={(event) => onChangeZoom(Number(event.target.value))}
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-[11px] tabular-nums text-zinc-100 transition-colors hover:border-zinc-500 focus:border-violet-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
              title="Zoom level"
              data-testid="preview-zoom-select"
            >
              {ZOOM_PRESETS.map((z) => (
                <option key={z} value={String(z)}>{Math.round(z * 100)}%</option>
              ))}
            </select>
          </label>
        </>
      )}

      {/* Right-aligned cluster: refresh, open-in-new-tab, fullscreen. */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {hasPages && (
          <>
            <ModeSwitch mode={mode} onChangeMode={onChangeMode} />
            <IconButton
              onClick={onRefresh}
              testId="preview-refresh"
              title="Reload current page"
              ariaLabel="Reload current page"
            >
              <RefreshIcon />
            </IconButton>
            <IconButton
              onClick={onOpenInNewTab}
              testId="preview-popup"
              title="Open this page in a new browser window"
              ariaLabel="Open preview in new window"
            >
              <PopupIcon />
            </IconButton>
          </>
        )}
        <IconButton
          onClick={onToggleFullscreen}
          active={fullscreen}
          testId="preview-fullscreen"
          title={fullscreen ? 'Exit fullscreen (Esc)' : 'Expand preview to fill window'}
          ariaLabel={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {fullscreen ? <ContractIcon /> : <ExpandIcon />}
        </IconButton>
      </div>
    </div>
  );
}

function ToolbarDivider() {
  // 1-px zinc-800 marker between groups so the eye reads them as
  // related clusters rather than one long row of buttons.
  return <span aria-hidden="true" className="hidden h-4 w-px shrink-0 bg-zinc-800 md:inline-block" />;
}

function ModeSwitch({
  mode,
  onChangeMode,
}: {
  mode: PreviewMode;
  onChangeMode: (mode: PreviewMode) => void;
}) {
  return (
    <div
      className="mr-1 grid grid-cols-2 rounded-md border border-zinc-800 bg-zinc-950 p-0.5"
      role="group"
      aria-label="Preview mode"
      data-testid="preview-mode-switch"
    >
      <ModeButton
        active={mode === 'preview'}
        label="Preview"
        testId="mode-preview"
        onClick={() => onChangeMode('preview')}
      >
        <PointerIcon />
      </ModeButton>
      <ModeButton
        active={mode === 'editor'}
        label="Editor"
        testId="mode-editor"
        onClick={() => onChangeMode('editor')}
      >
        <TextEditIcon />
      </ModeButton>
    </div>
  );
}

function ModeButton({
  active,
  label,
  testId,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  testId: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`${label} mode`}
      title={`${label} mode`}
      onClick={onClick}
      data-testid={testId}
      className={`inline-flex h-7 min-w-[76px] items-center justify-center gap-1.5 rounded px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
        active
          ? 'bg-violet-600 text-white shadow-sm'
          : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
      }`}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

interface IconButtonProps {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  ariaLabel?: string;
  testId?: string;
  children: ReactNode;
}

function IconButton({ onClick, disabled, active, title, ariaLabel, testId, children }: IconButtonProps) {
  const baseCls = 'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900';
  let cls = baseCls;
  if (disabled) {
    cls += ' cursor-not-allowed border-zinc-800 bg-zinc-900/30 text-zinc-600';
  } else if (active) {
    cls += ' border-violet-500/60 bg-violet-500/15 text-violet-100 hover:border-violet-400 hover:bg-violet-500/25';
  } else {
    cls += ' border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100';
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={active ? 'true' : undefined}
      title={title}
      data-testid={testId}
      className={cls}
    >
      {children}
    </button>
  );
}

interface ViewportChipProps {
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  title: string;
  testId: string;
  icon: ReactNode;
  label: string;
}

function ViewportChip({ active, onClick, disabled, title, testId, icon, label }: ViewportChipProps) {
  // The chip is wider than the icon-only buttons because the user
  // benefits from seeing "Mobile" / "Desktop" labelling without
  // having to hover. Suffix label is hidden on narrow toolbars
  // because the icon already conveys the meaning.
  const baseCls = 'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900';
  let cls = baseCls;
  if (disabled) {
    cls += ' cursor-not-allowed border-zinc-800 bg-zinc-900/30 text-zinc-600';
  } else if (active) {
    cls += ' border-violet-500/60 bg-violet-500/15 text-violet-100 hover:border-violet-400 hover:bg-violet-500/25';
  } else {
    cls += ' border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-100';
  }
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={cls}
    >
      <span className={active ? 'text-violet-200' : 'text-zinc-400'}>{icon}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/* ---------------------------------------------------------------------------
 * Stage
 * -------------------------------------------------------------------------*/

interface PreviewStageProps {
  project: LoadedProject | null;
  preview: PreviewIndex | null;
  previewBuilding: boolean;
  previewKey: number;
  currentPagePath: string;
  viewport: PreviewViewport;
  zoom: number;
  mode: PreviewMode;
}

function PreviewStage({
  project, preview, previewBuilding, previewKey, currentPagePath,
  viewport, zoom, mode,
}: PreviewStageProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    target.postMessage({ type: 'mockswap:set-edit-mode', enabled: mode === 'editor' }, '*');
  }, [mode, previewKey, currentPagePath]);

  if (!project) {
    return (
      <div className="flex min-h-[320px] flex-1 items-center justify-center p-8">
        <EmptyState />
      </div>
    );
  }
  if (previewBuilding) {
    return (
      <div className="flex min-h-[320px] flex-1 items-center justify-center p-8">
        <BuildingState />
      </div>
    );
  }
  if (!preview || preview.htmlPaths.length === 0) {
    return (
      <div className="flex min-h-[320px] flex-1 items-center justify-center p-8">
        <NoHtmlState />
      </div>
    );
  }

  const src = preview.urls.get(currentPagePath) ?? preview.primaryUrl;
  const caption =
    viewport === 'full'
      ? null
      : `${VIEWPORT_DIMENSIONS[viewport].device}${zoom !== 1 ? ` · ${Math.round(zoom * 100)}%` : ''}`;

  return (
    <div className="preview-viewport-shell" data-viewport={viewport}>
      <PreviewViewportFrame viewport={viewport}>
        <ZoomWrapper zoom={zoom}>
          <iframe
            ref={iframeRef}
            key={previewKey}
            src={src}
            onLoad={() => {
              iframeRef.current?.contentWindow?.postMessage(
                { type: 'mockswap:set-edit-mode', enabled: mode === 'editor' },
                '*',
              );
            }}
            title={currentPagePath ? `Website preview — ${currentPagePath}` : 'Website preview'}
            // The preview is served by the MockupSwap service worker from real
            // `/preview/…` URLs so the browser resolves module imports, fetch,
            // dynamic URLs, workers and wasm natively. A service worker can only
            // control a same-origin client, so `allow-same-origin` is required —
            // without it the frame's opaque origin bypasses the worker and the
            // project can't render. `allow-top-navigation` is intentionally
            // omitted so a previewed page can never navigate the editor away.
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
            allow="clipboard-read; clipboard-write"
            data-testid="preview-iframe"
            className="block h-full w-full border-0 bg-white"
          />
        </ZoomWrapper>
      </PreviewViewportFrame>
      {caption && (
        <span className="preview-viewport-caption" data-testid="preview-viewport-caption">
          {caption}
        </span>
      )}
    </div>
  );
}

/**
 * Wraps the iframe in a container that reflects the active viewport
 * size. For `mobile` / `tablet` / `desktop` we apply a fixed
 * pixel box which gives the iframe a real device size. For `full`
 * the wrapper scales with the stage. The data-viewport attribute is
 * used downstream by CSS (see index.css) to apply the device-frame
 * border treatment.
 */
function PreviewViewportFrame({ viewport, children }: { viewport: PreviewViewport; children: ReactNode }) {
  if (viewport === 'full') {
    return (
      <div className="preview-viewport-frame" data-viewport="full">
        {children}
      </div>
    );
  }
  const dims = VIEWPORT_DIMENSIONS[viewport];
  // Inline style for width/height because Tailwind can't statically
  // express "375px / 768px / 1280px" as named utilities without a
  // theme extension; declaring them inline keeps the component
  // portable and matches the value table at the top of this file.
  return (
    <div
      className="preview-viewport-frame"
      data-viewport={viewport}
      style={{ width: `${dims.width}px`, height: `${dims.height}px` }}
      data-viewport-dims={dims.device}
    >
      {children}
    </div>
  );
}

/**
 * Zoom wrapper. Renders a `<div>` whose `transform: scale(zoom)`
 * enlarges the iframe visually. The parent `.preview-stage` element
 * has `overflow: auto`, so when zoom > 1 the user can scroll to
 * reveal the (visually) extended iframe area. We use
 * `transform-origin: top left` so panning the visible area always
 * starts at the same anchor — central origin would shift content
 * around uncomfortably as the user clicks between zoom levels.
 */
function ZoomWrapper({ zoom, children }: { zoom: number; children: ReactNode }) {
  return (
    <div
      className="preview-zoom-wrapper h-full w-full"
      style={{
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
        // Counter-size the layout box so the wrapper "fits" inside
        // the viewport frame out to zoom === 1 (where it then equals
        // the frame). Above 1, the layout box is smaller than the
        // frame, which is fine — overflow:auto handles the rest.
        width: `${100 / zoom}%`,
        height: `${100 / zoom}%`,
        transition: 'transform 200ms ease-out',
      }}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * States (empty / building / no-html)
 * -------------------------------------------------------------------------*/

/**
 * The stage sits on a light/neutral checker backdrop regardless of app theme,
 * so these overlays paint their own opaque card with explicit dark-on-light
 * colours rather than relying on the zinc utility scale (which assumes a dark
 * surface and would render near-invisible headings here).
 */
function StageCard({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="preview-stage-card" data-testid={testId}>
      {children}
    </div>
  );
}

function EmptyState() {
  return (
    <StageCard testId="preview-empty">
      <div className="preview-stage-icon preview-stage-icon--brand">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-6 w-6" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
      </div>
      <h2 className="preview-stage-title">Upload a website to begin</h2>
      <p className="preview-stage-body">
        Drop a <code>.zip</code>, a project folder, or its files into the left panel.
        MockupSwap reads and renders everything locally — nothing ever leaves this page.
      </p>
    </StageCard>
  );
}

function BuildingState() {
  return (
    <StageCard testId="preview-building">
      <div className="preview-stage-spinner" aria-hidden="true" />
      <h2 className="preview-stage-title">Building preview…</h2>
      <p className="preview-stage-body">
        Reading files from the project and rewriting references so the site renders locally.
      </p>
    </StageCard>
  );
}

function NoHtmlState() {
  return (
    <StageCard testId="preview-no-html">
      <div className="preview-stage-icon preview-stage-icon--warn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6" aria-hidden="true">
          <path d="M12 9v4" />
          <circle cx="12" cy="17.5" r="1" />
          <path d="M10.3 3.7 2.6 17.4a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
        </svg>
      </div>
      <h2 className="preview-stage-title">No HTML files found</h2>
      <p className="preview-stage-body">
        This project doesn't contain any <code>.html</code> or <code>.htm</code> files for the
        preview to render. You can still inspect the file tree and detected images in the
        left panel.
      </p>
    </StageCard>
  );
}

/* ---------------------------------------------------------------------------
 * Inline svg icons
 * -------------------------------------------------------------------------*/

function PointerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M4 4l7.5 16 2-6.5 6.5-2L4 4z" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15.5-6.4L21 8" />
      <polyline points="21 3 21 8 16 8" />
      <path d="M21 12a9 9 0 0 1-15.5 6.4L3 16" />
      <polyline points="3 21 3 16 8 16" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <polyline points="15 3 21 3 21 9" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="10" y1="14" x2="3" y2="21" />
    </svg>
  );
}

function ContractIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <polyline points="4 14 4 20 10 20" />
      <line x1="3" y1="11" x2="10" y2="20" />
      <polyline points="20 10 20 4 14 4" />
      <line x1="21" y1="13" x2="14" y2="4" />
    </svg>
  );
}

function PopupIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M14 3h7v7" />
      <line x1="21" y1="3" x2="10" y2="14" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

function TextEditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M4 20h4" />
      <path d="M6 20V5" />
      <path d="M4 5h8" />
      <path d="M14 19l5-5" />
      <path d="M15 13l2-2a1.5 1.5 0 0 1 2 2l-2 2" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <line x1="11" y1="18" x2="13" y2="18" />
    </svg>
  );
}

function TabletIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <line x1="12" y1="18" x2="12" y2="18" />
    </svg>
  );
}

function DesktopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="2" y="4" width="20" height="13" rx="1.5" />
      <line x1="9" y1="21" x2="15" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function FullWidthIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M3 12h18" />
      <path d="M3 18h18" />
      <polyline points="21 9 24 12 21 15" transform="translate(-3 0)" />
    </svg>
  );
}
