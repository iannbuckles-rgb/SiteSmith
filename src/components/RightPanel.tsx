import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';

import {
  canPlaceholder,
  canRemove,
  canReplace,
  isBroken,
} from '../lib/assetReplacer';
import { formatBytes } from '../lib/fileTypes';
import { FitStylePanel } from './FitStylePanel';
import type {
  AppliedPatch,
  ExportState,
  ExportSummary,
  ImageDetection,
  ImageFitConfig,
} from '../types';
import type { EditorSelection, PreviewMode } from '../lib/previewControls';

/** What the right panel is currently configured to do with the selected
 *  detection. The user toggles among these with chips in the section. */
type PendingAction = 'replace' | 'remove' | 'placeholder';

interface RightPanelProps {
  selectedDetection: ImageDetection | null;
  thumbnail: string | undefined;
  appliedPatch: AppliedPatch | null;
  pendingFile: File | null;
  busy: boolean;
  /** Busy state for the destructive broken-image ops (Remove / Placeholder). */
  brokenBusy: boolean;
  error: string | null;
  /** Combined replace + broken-actions error string. Replace errors come
   *  from `error`; broken-action errors come from `brokenError`. */
  brokenError: string | null;
  onPickReplacementFile: (file: File) => void;
  onCancelReplacement: () => void;
  onApplyReplacement: () => void;
  onApplyBrokenAction: (action: 'remove' | 'placeholder') => void;
  /** Cancel a pending broken-action confirm without clobbering any
   *  in-progress Replace draft. Distinct from `onCancelReplacement` so
   *  the two error slots stay separated. */
  onCancelBrokenAction: () => void;
  onReplaceAgain: () => void;
  /** Fit & style controls. The panel only renders when the selected
   *  detection is one `applyFitStyle` can mutate (HTML <img> or CSS
   *  url()), so passing through for unsupported detections is cheap
   *  and keeps the parent free of branching. Errors stay inside the
   *  FitStylePanel — toggling selections auto-clears them, so the
   *  parent doesn't need a cancel handle. */
  fitStyleBusy: boolean;
  fitStyleError: string | null;
  onApplyFitStyle: (config: ImageFitConfig) => void;
  onResetFitStyle: () => void;
  /** WebP re-encode opt-in. When true, the picked replacement image is
   *  routed through the WebP re-encoder before being written to the zip.
   *  The re-encoder transparently falls back to the original bytes for
   *  unsupported types (SVG, GIF, animated WebP), oversized canvases,
   *  or where WebP would actually grow the file. UI surfaces a
   *  re-encoded pill in the History row for traceability. */
  webpReencodeEnabled: boolean;
  onToggleWebpReencode: (next: boolean) => void;
  mode: PreviewMode;
  editorSelection: EditorSelection | null;
  editorBusy: boolean;
  editorError: string | null;
  onApplyEditorText: (value: string) => void;
  onApplyEditorImageUrl: (value: string) => void;
  onApplyEditorImageFile: (file: File) => void;
  onClearEditorSelection: () => void;
  exportState: ExportState;
  exportSummary: ExportSummary | null;
  exportError: string | null;
  canExport: boolean;
  onExport: () => void;
  onExportAgain: () => void;
}

const ACCEPTED_IMAGE_MIMES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/avif', 'image/bmp', 'image/x-icon',
];

export function RightPanel({
  selectedDetection, thumbnail, appliedPatch,
  pendingFile, busy, brokenBusy, error, brokenError,
  onPickReplacementFile, onCancelReplacement, onApplyReplacement,
  onApplyBrokenAction, onCancelBrokenAction, onReplaceAgain,
  fitStyleBusy, fitStyleError,
  onApplyFitStyle, onResetFitStyle,
  webpReencodeEnabled, onToggleWebpReencode,
  mode, editorSelection, editorBusy, editorError,
  onApplyEditorText, onApplyEditorImageUrl, onApplyEditorImageFile, onClearEditorSelection,
  exportState, exportSummary, exportError, canExport, onExport, onExportAgain,
}: RightPanelProps) {
  const broken = selectedDetection ? isBroken(selectedDetection) : false;

  return (
    <aside
      className="flex h-full min-h-0 flex-col gap-3 border-l border-zinc-800 bg-zinc-950 p-3"
      data-testid="right-panel"
    >
      {mode === 'editor' ? (
        <EditorInspector
          selection={editorSelection}
          busy={editorBusy}
          error={editorError}
          onApplyText={onApplyEditorText}
          onApplyImageUrl={onApplyEditorImageUrl}
          onApplyImageFile={onApplyEditorImageFile}
          onClear={onClearEditorSelection}
        />
      ) : (
        <>
          <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3" data-testid="asset-details">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Asset Details
            </h3>
            {selectedDetection ? (
              <AssetDetailsBody detection={selectedDetection} thumbnail={thumbnail} />
            ) : (
              <p className="mt-2 text-xs text-zinc-500">
                Select an image reference from the left panel to inspect details.
              </p>
            )}
          </section>

          <section
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
            data-testid="replacement-section"
          >
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              {broken ? 'Broken Image' : 'Replacement'}
            </h3>
            {!selectedDetection ? (
              <p className="mt-2 text-xs text-zinc-500">
                Pick a detection on the left to enable replacement.
              </p>
            ) : appliedPatch && !pendingFile ? (
              <AppliedSummary
                patch={appliedPatch}
                onReplaceAgain={onReplaceAgain}
              />
            ) : (
              <ActionArea
                detection={selectedDetection}
                pendingFile={pendingFile}
                replacementBusy={busy}
                brokenBusy={brokenBusy}
                onPickFile={onPickReplacementFile}
                onCancel={onCancelReplacement}
                onCancelBrokenAction={onCancelBrokenAction}
                onApplyReplacement={onApplyReplacement}
                onApplyBrokenAction={onApplyBrokenAction}
                webpReencodeEnabled={webpReencodeEnabled}
                onToggleWebpReencode={onToggleWebpReencode}
              />
            )}
          </section>

          {(error || brokenError) && (
            <div
              aria-live="polite"
              className="rounded-md border border-rose-700/60 bg-rose-900/30 px-3 py-2 text-xs text-rose-200"
            >
              {brokenError || error}
            </div>
          )}

          {selectedDetection && (
            <section
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
              data-testid="fit-style-section"
            >
              <FitStylePanel
                detection={selectedDetection}
                appliedPatch={appliedPatch}
                busy={fitStyleBusy}
                error={fitStyleError}
                onApply={onApplyFitStyle}
                onReset={onResetFitStyle}
              />
            </section>
          )}
        </>
      )}

      <ExportSection
        state={exportState}
        summary={exportSummary}
        error={exportError}
        canExport={canExport}
        onExport={onExport}
        onExportAgain={onExportAgain}
      />
    </aside>
  );
}

interface EditorInspectorProps {
  selection: EditorSelection | null;
  busy: boolean;
  error: string | null;
  onApplyText: (value: string) => void;
  onApplyImageUrl: (value: string) => void;
  onApplyImageFile: (file: File) => void;
  onClear: () => void;
}

function EditorInspector({
  selection,
  busy,
  error,
  onApplyText,
  onApplyImageUrl,
  onApplyImageFile,
  onClear,
}: EditorInspectorProps) {
  const [textDraft, setTextDraft] = useState('');
  const [srcDraft, setSrcDraft] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTextDraft(selection?.text ?? '');
    setSrcDraft(selection?.src ?? '');
  }, [selection]);

  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) onApplyImageFile(file);
  }, [onApplyImageFile]);

  return (
    <section
      className="rounded-lg border border-violet-700/40 bg-zinc-900/70 p-3"
      data-testid="editor-inspector"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-violet-200">
            Editor
          </h3>
          <p className="mt-1 text-xs text-zinc-400">
            {selection ? 'Selected element' : 'Click text, buttons, links, or images in the page.'}
          </p>
        </div>
        {selection && (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
            data-testid="editor-clear-selection"
          >
            Clear
          </button>
        )}
      </div>

      {!selection ? (
        <div className="mt-3 rounded-md border border-dashed border-zinc-700 bg-zinc-950/50 p-3 text-xs leading-relaxed text-zinc-500">
          Preview mode keeps the website clickable. Editor mode turns clicks into selections so edits can be applied to the project zip.
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <dl className="space-y-1 text-xs">
            <Field label="Type" value={selection.kind === 'image' ? 'image' : selection.tagName} />
            <Field label="Element" value={selection.selectorHint ?? selection.tagName} mono />
            <Field label="File" value={selection.sourceFile} title={selection.sourceFile} mono />
          </dl>

          {selection.kind === 'text' ? (
            <div className="space-y-2" data-testid="editor-text-controls">
              <label className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Text
                <textarea
                  value={textDraft}
                  onChange={(event) => setTextDraft(event.target.value)}
                  rows={4}
                  className="mt-1 min-h-24 w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs leading-relaxed text-zinc-100 outline-none transition-colors focus:border-violet-400 focus:ring-2 focus:ring-violet-400/30"
                  data-testid="editor-text-input"
                />
              </label>
              <button
                type="button"
                onClick={() => onApplyText(textDraft)}
                disabled={busy || textDraft.trim() === (selection.text ?? '').trim() || textDraft.trim().length === 0}
                aria-busy={busy}
                className="w-full rounded-md bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="editor-apply-text"
              >
                {busy ? 'Applying…' : selection.tagName === 'button' ? 'Update button' : 'Update text'}
              </button>
            </div>
          ) : (
            <div className="space-y-3" data-testid="editor-image-controls">
              <label className="block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Image source
                <input
                  value={srcDraft}
                  onChange={(event) => setSrcDraft(event.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 outline-none transition-colors focus:border-violet-400 focus:ring-2 focus:ring-violet-400/30"
                  data-testid="editor-image-src-input"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onApplyImageUrl(srcDraft)}
                  disabled={busy || srcDraft.trim() === (selection.src ?? '').trim() || srcDraft.trim().length === 0}
                  aria-busy={busy}
                  className="rounded-md bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="editor-apply-image-url"
                >
                  {busy ? 'Applying…' : 'Update source'}
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="editor-pick-image"
                >
                  Replace file
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_IMAGE_MIMES.join(',')}
                onChange={handleFileChange}
                className="hidden"
                data-testid="editor-image-file-input"
              />
              {selection.alt && (
                <p className="rounded-md border border-zinc-800 bg-zinc-950/50 px-2 py-1.5 text-[11px] text-zinc-400">
                  Alt: <span className="text-zinc-200">{selection.alt}</span>
                </p>
              )}
            </div>
          )}

          {error && (
            <div
              aria-live="polite"
              className="rounded-md border border-rose-700/60 bg-rose-900/30 px-3 py-2 text-xs text-rose-200"
              data-testid="editor-error"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

interface AssetDetailsBodyProps {
  detection: ImageDetection;
  thumbnail: string | undefined;
}

function AssetDetailsBody({ detection, thumbnail }: AssetDetailsBodyProps) {
  return (
    <div className="mt-2 space-y-2 text-xs">
      {thumbnail ? (
        <div className="h-32 w-full overflow-hidden rounded-md bg-zinc-100 ring-1 ring-zinc-800">
          <img
            src={thumbnail}
            alt="Asset preview"
            className="h-full w-full object-contain"
          />
        </div>
      ) : (
        <div
          className="flex h-32 w-full items-center justify-center rounded-md border border-dashed border-zinc-700 bg-zinc-950/60 text-[11px] text-zinc-500"
          title={detection.status === 'remote' ? 'This is a remote URL' : 'Asset missing in zip'}
        >
          {detection.status === 'remote'
            ? 'Remote URL \u2014 no local thumbnail'
            : detection.status === 'missing'
              ? 'Asset missing in zip'
              : 'Loading thumbnail\u2026'}
        </div>
      )}

      <dl className="space-y-1">
        <Field label="Path" value={detection.rawUrl} title={detection.rawUrl} mono />
        {detection.resolvedPath && (
          <Field label="Resolved" value={detection.resolvedPath} title={detection.resolvedPath} mono />
        )}
        <Field label="Type" value={detection.type} />
        <Field label="Status" value={detection.status} />
        <Field label="In file" value={detection.sourceFile} title={detection.sourceFile} mono />
        {detection.extra?.property && (
          <Field label="Meta" value={detection.extra.property} />
        )}
        {detection.extra?.rel && (
          <Field label="Rel" value={detection.extra.rel} />
        )}
      </dl>
    </div>
  );
}

function Field({
  label, value, title, mono = false,
}: { label: string; value: string; title?: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-baseline gap-x-2">
      <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd
        className={`truncate text-zinc-200 ${mono ? 'font-mono text-[12px]' : ''}`}
        title={title ?? value}
      >
        {value}
      </dd>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Export section
 * -------------------------------------------------------------------------*/

interface ExportSectionProps {
  state: ExportState;
  summary: ExportSummary | null;
  error: string | null;
  canExport: boolean;
  onExport: () => void;
  onExportAgain: () => void;
}

function ExportSection({
  state, summary, error, canExport, onExport, onExportAgain,
}: ExportSectionProps) {
  const showButton = state === 'idle' || state === 'busy';
  return (
    <section
      className="mt-auto rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
      data-testid="export-section"
    >
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Export
      </h3>
      {showButton && (
        <button
          type="button"
          onClick={onExport}
          disabled={!canExport || state === 'busy'}
          aria-busy={state === 'busy'}
          className="mt-2 w-full rounded-md bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="export-zip-button"
        >
          {state === 'busy' ? (
            <span className="inline-flex items-center gap-2">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              Exporting…
            </span>
          ) : (
            'Export updated zip'
          )}
        </button>
      )}
      {state === 'success' && summary && (
        <ExportSuccess summary={summary} onExportAgain={onExportAgain} />
      )}
      {state === 'error' && (
        <ExportErrorBanner message={error ?? 'Export failed'} onExport={onExport} />
      )}
    </section>
  );
}

interface ExportSuccessProps {
  summary: ExportSummary;
  onExportAgain: () => void;
}

function ExportSuccess({ summary, onExportAgain }: ExportSuccessProps) {
  return (
    <div className="mt-2 space-y-2" data-testid="export-success">
      <div className="rounded-md border border-emerald-700/40 bg-emerald-950/30 p-3">
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" className="h-4 w-4 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <p className="text-xs font-medium text-emerald-200">Export complete</p>
        </div>
        <dl className="mt-2 space-y-1 text-[11px]">
          <SummaryRow label="Filename" value={summary.filename} mono title={summary.filename} />
          <SummaryRow label="Zip size" value={formatBytes(summary.zipSizeBytes)} />
          <SummaryRow label="Files" value={String(summary.fileCount)} />
          <SummaryRow
            label="Replaced"
            value={String(summary.replacementCount)}
            tone={summary.replacementCount > 0 ? 'emerald' : 'muted'}
          />
          <SummaryRow
            label="Broken"
            value={String(summary.brokenCount)}
            tone={summary.brokenCount > 0 ? 'rose' : 'muted'}
            note={summary.brokenCount > 0 ? 'some refs point at missing files' : undefined}
          />
          <SummaryRow
            label="Remote"
            value={String(summary.remoteCount)}
            tone={summary.remoteCount > 0 ? 'violet' : 'muted'}
            note={summary.remoteCount > 0 ? 'external URLs not localized' : undefined}
          />
          {summary.removedCount > 0 && (
            <SummaryRow
              label="Removed"
              value={String(summary.removedCount)}
              tone="amber"
              note="image refs dropped from source"
            />
          )}
          {summary.placeholderCount > 0 && (
            <SummaryRow
              label="Placeholders"
              value={String(summary.placeholderCount)}
              tone="amber"
              note={'<img> swapped for placeholder div'}
            />
          )}
        </dl>
      </div>
      <button
        type="button"
        onClick={onExportAgain}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-violet-400 hover:bg-violet-500/10 hover:text-violet-100"
        data-testid="export-again"
      >
        Export again
      </button>
    </div>
  );
}

interface ExportErrorProps {
  message: string;
  onExport: () => void;
}

function ExportErrorBanner({ message, onExport }: ExportErrorProps) {
  return (
    <div className="mt-2 space-y-2" data-testid="export-error">
      <div
        role="alert"
        className="rounded-md border border-rose-700/60 bg-rose-900/30 px-3 py-2 text-xs text-rose-200"
      >
        {message}
      </div>
      <button
        type="button"
        onClick={onExport}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 hover:border-violet-400 hover:text-violet-100"
      >
        Try again
      </button>
    </div>
  );
}

function SummaryRow({
  label, value, mono = false, title, tone, note,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
  tone?: 'muted' | 'emerald' | 'rose' | 'violet' | 'amber';
  note?: string;
}) {
  const tones: Record<NonNullable<typeof tone>, string> = {
    muted: 'text-zinc-200',
    emerald: 'text-emerald-300',
    rose: 'text-rose-300',
    violet: 'text-violet-300',
    amber: 'text-amber-300',
  };
  return (
    <div className="grid grid-cols-[80px_1fr] items-baseline gap-x-2">
      <dt className="uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className={`truncate ${tones[tone ?? 'muted']} ${mono ? 'font-mono text-[11px]' : ''}`} title={title ?? value}>
        {value}
        {note && <span className="ml-1 text-[10px] text-zinc-500">· {note}</span>}
      </dd>
    </div>
  );
}

interface AppliedSummaryProps {
  patch: AppliedPatch;
  onReplaceAgain: () => void;
}

function AppliedSummary({ patch, onReplaceAgain }: AppliedSummaryProps) {
  // Headline + tone picks walk every action. Fit-style falls through a
  // dedicated branch (not into the default "Reference removed") because
  // a fit-style succeeds in-place without removing the original asset.
  const headline = patch.action === 'replace'
    ? 'Replacement saved'
    : patch.action === 'placeholder'
      ? 'Placeholder inserted'
      : patch.action === 'fit-style'
        ? 'Fit & style applied'
        : 'Reference removed';
  const tone = patch.action === 'remove'
    ? 'border-amber-700/40 bg-amber-950/30'
    : patch.action === 'fit-style'
      ? 'border-violet-700/40 bg-violet-950/30'
      : 'border-emerald-700/40 bg-emerald-950/30';
  const iconCls = patch.action === 'remove'
    ? 'text-amber-300'
    : patch.action === 'fit-style'
      ? 'text-violet-300'
      : 'text-emerald-300';
  const headlineCls = patch.action === 'remove'
    ? 'text-amber-200'
    : patch.action === 'fit-style'
      ? 'text-violet-200'
      : 'text-emerald-200';

  return (
    <div className="mt-2 space-y-2" data-testid="applied-patch">
      <div className={`rounded-md border p-3 ${tone}`}>
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" className={`h-4 w-4 ${iconCls}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <p className={`text-xs font-medium ${headlineCls}`}>{headline}</p>
        </div>
        <dl className="mt-2 space-y-1 text-[11px]">
          {patch.action === 'fit-style' && (
            <>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">Fit</dt>
                <dd className="text-zinc-200">
                  {patch.config.fit} · {patch.config.position}
                </dd>
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">Radius</dt>
                <dd className="text-zinc-200">{patch.config.borderRadius}</dd>
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">Overlay</dt>
                <dd className="text-zinc-200">{patch.config.overlay}</dd>
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">CSS</dt>
                <dd className="truncate font-mono text-zinc-400" title={patch.generatedCss}>
                  {patch.generatedCss.replace(/;$/, '')}
                </dd>
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">In file</dt>
                <dd className="truncate font-mono text-zinc-200" title={patch.sourceFile}>
                  {patch.sourceFile}
                </dd>
              </div>
            </>
          )}
          {patch.action === 'replace' && (
            <>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">New file</dt>
                <dd className="truncate font-mono text-zinc-200" title={patch.newAssetPath}>
                  {patch.newAssetPath}
                </dd>
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">Reference</dt>
                <dd className="truncate font-mono text-zinc-200" title={patch.currentSourceValue}>
                  {patch.currentSourceValue}
                </dd>
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">Size</dt>
                <dd className="text-zinc-200">{formatBytes(patch.replacementBytes)}</dd>
              </div>
            </>
          )}
          {patch.action === 'placeholder' && (
            <>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">Inline label</dt>
                <dd className="text-zinc-200">{patch.placeholder.label}</dd>
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">Old URL</dt>
                <dd className="truncate font-mono text-zinc-400" title={patch.rawUrl}>
                  {patch.rawUrl}
                </dd>
              </div>
            </>
          )}
          {patch.action === 'remove' && (
            <>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">Old URL</dt>
                <dd className="truncate font-mono text-zinc-400" title={patch.rawUrl}>
                  {patch.rawUrl}
                </dd>
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-x-2">
                <dt className="uppercase tracking-wide text-zinc-500">In file</dt>
                <dd className="truncate font-mono text-zinc-200" title={patch.sourceFile}>
                  {patch.sourceFile}
                </dd>
              </div>
            </>
          )}
        </dl>
      </div>
      <button
        type="button"
        onClick={onReplaceAgain}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-violet-400 hover:bg-violet-500/10 hover:text-violet-100"
        data-testid="replace-again"
      >
        {patch.action === 'replace' ? 'Replace again' : 'Edit again'}
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Action area: dispatches to Replace / Remove / Placeholder form based on
 * a small chip row at the top. Lives below the section header.
 * -------------------------------------------------------------------------*/

interface ActionAreaProps {
  detection: ImageDetection;
  pendingFile: File | null;
  replacementBusy: boolean;
  brokenBusy: boolean;
  onPickFile: (file: File) => void;
  onCancel: () => void;
  onCancelBrokenAction: () => void;
  onApplyReplacement: () => void;
  onApplyBrokenAction: (action: 'remove' | 'placeholder') => void;
  webpReencodeEnabled: boolean;
  onToggleWebpReencode: (next: boolean) => void;
}

function ActionArea({
  detection, pendingFile, replacementBusy, brokenBusy,
  onPickFile, onCancel, onCancelBrokenAction, onApplyReplacement, onApplyBrokenAction,
  webpReencodeEnabled, onToggleWebpReencode,
}: ActionAreaProps) {
  const broken = isBroken(detection);
  // When we're showing the broken-image ops, default the action to Remove
  // (the most conservative operation). Otherwise default to Replace.
  const [pendingAction, setPendingAction] = useState<PendingAction>(
    broken ? 'remove' : 'replace',
  );

  // If the selected detection switches and the chip currently selected
  // becomes unavailable, fall back to the first available chip.
  const available = useMemo(() => ({
    replace: canReplace(detection),
    remove: canRemove(detection),
    placeholder: canPlaceholder(detection),
  }), [detection]);

  useEffect(() => {
    if (pendingAction === 'replace' && !available.replace) {
      setPendingAction(available.remove ? 'remove' : 'placeholder');
    } else if (pendingAction === 'remove' && !available.remove) {
      setPendingAction(available.placeholder ? 'placeholder' : 'replace');
    } else if (pendingAction === 'placeholder' && !available.placeholder) {
      setPendingAction(available.replace ? 'replace' : 'remove');
    }
  }, [available, pendingAction]);

  const noneAvailable = !available.replace && !available.remove && !available.placeholder;

  if (noneAvailable) {
    return (
      <p className="mt-2 text-xs text-amber-200/80" data-testid="action-unsupported">
        Replacement isn't supported yet for this reference type
        ({detection.sourceKind} {detection.sourceTag} {detection.sourceAttr}).
      </p>
    );
  }

  const summary = brokenSummary(detection);

  return (
    <div className="mt-2 space-y-3" data-testid="action-area">
      {broken && (
        <p className="text-[11px] text-amber-200/90" data-testid="broken-banner">
          {summary}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Actions">
        <ActionChip
          active={pendingAction === 'replace'}
          onClick={() => setPendingAction('replace')}
          disabled={!available.replace}
          testId="action-replace"
        >
          Replace
        </ActionChip>
        <ActionChip
          active={pendingAction === 'remove'}
          onClick={() => setPendingAction('remove')}
          disabled={!available.remove}
          tone="rose"
          testId="action-remove"
        >
          Remove
        </ActionChip>
        <ActionChip
          active={pendingAction === 'placeholder'}
          onClick={() => setPendingAction('placeholder')}
          disabled={!available.placeholder}
          tone="amber"
          testId="action-placeholder"
        >
          Placeholder
        </ActionChip>
      </div>
      {pendingAction === 'replace' && (
        <ReplacementForm
          pendingFile={pendingFile}
          busy={replacementBusy}
          onPickFile={onPickFile}
          onCancel={onCancel}
          onApply={onApplyReplacement}
          webpReencodeEnabled={webpReencodeEnabled}
          onToggleWebpReencode={onToggleWebpReencode}
        />
      )}
      {pendingAction === 'remove' && (
        <ConfirmAction
          busy={brokenBusy}
          onCancel={onCancelBrokenAction}
          onConfirm={() => onApplyBrokenAction('remove')}
          title="Remove this reference?"
          body={'The broken image ref will be deleted from its host file. CSS background colors are kept; for HTML the entire <img> tag is dropped. The change is recorded in MOCKUPSWAP_CHANGES.md.'}
          testId="confirm-remove"
          confirmLabel={brokenBusy ? 'Removing…' : 'Remove reference'}
        />
      )}
      {pendingAction === 'placeholder' && (
        <ConfirmAction
          busy={brokenBusy}
          onCancel={onCancelBrokenAction}
          onConfirm={() => onApplyBrokenAction('placeholder')}
          title="Insert a placeholder?"
          body={'The <img> tag will be replaced with a styled div labelled by the guessed type (e.g. "Hero Image"). Existing class/style/id/width/height are preserved.'}
          testId="confirm-placeholder"
          confirmLabel={brokenBusy ? 'Inserting…' : 'Insert placeholder'}
        />
      )}
    </div>
  );
}

function brokenSummary(detection: ImageDetection): string {
  if (detection.status === 'missing') {
    return "Image is missing from the project. Drop a replacement, remove the slot, or insert a placeholder so deploys don't show a broken icon.";
  }
  if (detection.status === 'remote' && detection.riskReason) {
    switch (detection.riskReason) {
      case 'manus':             return 'Hosted on a Manus-like domain. The reference will likely 403 or change origin after export.';
      case 'cdn':               return 'Hosted on a generic CDN. Hot-link protection or origin mismatch is likely after deploy.';
      case 'blob-self':         return 'This is an in-page blob URL (not a real asset). It cannot be exported.';
      case 'cross-origin-http': return 'Cross-origin HTTP. Static hosts can\'t guarantee the image is reachable at runtime.';
      case 'protocol-relative': return 'Protocol-relative URL. Browsers will hit your host, which may not cache the asset.';
    }
  }
  return 'This reference is broken or risky.';
}

interface ActionChipProps {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  tone?: 'rose' | 'amber';
  children: React.ReactNode;
  testId?: string;
}

function ActionChip({ active, disabled, onClick, tone, children, testId }: ActionChipProps) {
  let cls = 'rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors';
  if (disabled) {
    cls += ' cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-600 opacity-50';
  } else if (active) {
    cls += tone === 'rose'
      ? ' border-rose-500/60 bg-rose-500/15 text-rose-100'
      : tone === 'amber'
        ? ' border-amber-500/60 bg-amber-500/15 text-amber-100'
        : ' border-violet-500/60 bg-violet-500/15 text-violet-100';
  } else {
    cls += ' border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100';
  }
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      onClick={onClick}
      className={cls}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

interface ConfirmActionProps {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  testId?: string;
}

function ConfirmAction({ busy, onCancel, onConfirm, title, body, confirmLabel, testId }: ConfirmActionProps) {
  return (
    <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-3" data-testid={testId}>
      <p className="text-xs font-medium text-zinc-100">{title}</p>
      <p className="text-[11px] text-zinc-400">{body}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy}
          className="flex-1 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-500 disabled:cursor-wait disabled:opacity-60"
          data-testid="confirm-broken-action"
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-zinc-500 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

interface ReplacementFormProps {
  pendingFile: File | null;
  busy: boolean;
  onPickFile: (file: File) => void;
  onCancel: () => void;
  onApply: () => void;
  webpReencodeEnabled: boolean;
  onToggleWebpReencode: (next: boolean) => void;
}

function ReplacementForm({
  pendingFile, busy, onPickFile, onCancel, onApply,
  webpReencodeEnabled, onToggleWebpReencode,
}: ReplacementFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingFile) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(pendingFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  const acceptFile = useCallback((file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      // We don't surface the error here \u2014 the parent will receive the file
      // and decide. (Alerting now would feel intrusive.)
      return;
    }
    onPickFile(file);
  }, [onPickFile]);

  return (
    <div className="mt-2 space-y-3" data-testid="replacement-form">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGE_MIMES.join(',')}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          acceptFile(e.target.files?.[0]);
          e.target.value = '';
        }}
        className="sr-only"
        data-testid="replacement-file-input"
      />
      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-2 text-[11px] text-zinc-300 transition-colors hover:border-zinc-700">
        <input
          type="checkbox"
          checked={webpReencodeEnabled}
          onChange={(e) => onToggleWebpReencode(e.target.checked)}
          disabled={busy}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-violet-500 disabled:cursor-not-allowed"
          data-testid="webp-toggle"
        />
        <span className="min-w-0">
          <span className="block font-medium text-zinc-200">Re-encode as WebP</span>
          <span className="mt-0.5 block text-[10px] text-zinc-500">
            Shrinks PNG/JPG before insertion; non-eligible sources fall back to original bytes.
          </span>
        </span>
      </label>
      {!pendingFile ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e: DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            setHover(true);
          }}
          onDragLeave={() => setHover(false)}
          onDrop={(e: DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            setHover(false);
            acceptFile(e.dataTransfer.files?.[0]);
          }}
          aria-disabled={busy}
          className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed px-3 py-5 text-center transition-colors ${
            hover
              ? 'border-violet-400 bg-violet-500/10'
              : 'border-zinc-700 bg-zinc-950 hover:border-zinc-500 hover:bg-zinc-900'
          } ${busy ? 'opacity-60' : ''}`}
          data-testid="replacement-dropzone"
        >
          <p className="text-xs font-medium text-zinc-200">Drop replacement image</p>
          <p className="text-[11px] text-zinc-500">or click to choose \u2014 PNG, JPG, WebP, SVG, GIF</p>
        </div>
      ) : (
        <PendingPreview
          file={pendingFile}
          previewUrl={previewUrl}
          busy={busy}
          onCancel={onCancel}
          onApply={onApply}
        />
      )}
    </div>
  );
}

interface PendingPreviewProps {
  file: File;
  previewUrl: string | null;
  busy: boolean;
  onCancel: () => void;
  onApply: () => void;
}

function PendingPreview({
  file, previewUrl, busy, onCancel, onApply,
}: PendingPreviewProps) {
  return (
    <div className="space-y-2" data-testid="replacement-pending">
      {previewUrl ? (
        <div className="h-32 w-full overflow-hidden rounded-md bg-zinc-100 ring-1 ring-zinc-800">
          <img
            src={previewUrl}
            alt="Replacement preview"
            className="h-full w-full object-contain"
          />
        </div>
      ) : (
        <div className="flex h-32 w-full items-center justify-center rounded-md border border-dashed border-zinc-700 bg-zinc-950 text-[11px] text-zinc-500">
          Preview unavailable
        </div>
      )}
      <p className="truncate font-mono text-[11px] text-zinc-300" title={file.name}>{file.name}</p>
      <p className="text-[11px] text-zinc-500">{formatBytes(file.size)} \u00b7 {file.type || 'image'}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={busy}
          aria-busy={busy}
          className="flex-1 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-wait disabled:opacity-60"
          data-testid="apply-replacement"
        >
          {busy ? 'Applying\u2026' : 'Apply replacement'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-zinc-500 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
