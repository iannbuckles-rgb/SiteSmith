import { useMemo, type ReactNode } from 'react';

import type { CheckpointSummary } from '../lib/idb';
import type { AppliedPatch } from '../types';
import { formatBytes } from '../lib/fileTypes';
import { formatRelativeSavedAt } from '../lib/relativeTime';
import { DiffView } from './DiffView';

/* ----------------------------------------------------------------------------
 * Change History panel
 * --------------------------------------------------------------------------
 * Renders every applied patch in newest-first order, with the columns the
 * product spec asked for: action type, file changed, old path, new path,
 * timestamp. Each row has a per-row Undo button that drives the unified
 * `undoPatchById` reducer in App.tsx.
 *
 * Toolbar at the top exposes higher-level affordances:
 *   - Undo Last Change: pops the most recently applied patch.
 *   - Save checkpoint: stores the live zip + patch set under a label.
 *   - Reset Selected Image: drops every patch keyed against the
 *     currently-selected detection (replace / fit-style / remove /
 *     placeholder AND the namespaced `${id}#fit`). Manual-replace is
 *     deliberately excluded \u2014 the user has per-row Undo for those.
 *   - Reset Project: reloads the original zip and clears every UI surface.
 *
 * The panel never mutates the zip directly. Every undo path goes through
 * App.tsx so the preview index, the export state, and the patchesByKey
 * bookkeeping stay in lockstep.
 * -------------------------------------------------------------------------*/

interface ChangeHistoryPanelProps {
  error: string | null;
  entries: AppliedPatch[];
  /** Drives the disabled state for Reset Selected Image. The parent
   *  supplies this rather than reading the detection internally so the
   *  History tab stays decoupled from the rest of the left-panel state. */
  hasSelectedDetection: boolean;
  onUndoPatchById: (patchId: string) => void;
  onUndoLastChange: () => void;
  /** Reverse every patch in DESC chronological order. Surfaced as a
   *  toolbar button alongside Undo Last Change. */
  onUndoAll: () => void;
  onResetSelectedImage: () => void;
  onResetProject: () => void;
  checkpoints: CheckpointSummary[];
  checkpointsLoading: boolean;
  checkpointBusyId: string | null;
  checkpointSaveBusy: boolean;
  canSaveCheckpoint: boolean;
  onSaveCheckpoint: () => void;
  onRestoreCheckpoint: (id: string) => void;
  onDeleteCheckpoint: (id: string) => void;
}

export function ChangeHistoryPanel({
  error, entries, hasSelectedDetection,
  onUndoPatchById, onUndoLastChange, onUndoAll, onResetSelectedImage, onResetProject,
  checkpoints, checkpointsLoading, checkpointBusyId, checkpointSaveBusy, canSaveCheckpoint,
  onSaveCheckpoint, onRestoreCheckpoint, onDeleteCheckpoint,
}: ChangeHistoryPanelProps) {
  // Reverse-chronological order. Sorted in App.tsx already but we sort
  // again defensively so the panel can be dropped into a different
  // surface (e.g. a dev-tools drawer) without state-shape surprises.
  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.appliedAt - a.appliedAt),
    [entries],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="history-panel">
      <Toolbar
        canUndoLast={sorted.length > 0}
        canResetSelected={hasSelectedDetection && sorted.some((p) => p.action !== 'manual-replace' && p.action !== 'editor-edit' && p.action !== 'editor-reorder' && p.action !== 'editor-nudge' && p.action !== 'editor-delete')}
        onUndoLastChange={onUndoLastChange}
        onUndoAll={onUndoAll}
        onResetSelectedImage={onResetSelectedImage}
        onResetProject={onResetProject}
        canSaveCheckpoint={canSaveCheckpoint}
        checkpointSaveBusy={checkpointSaveBusy}
        onSaveCheckpoint={onSaveCheckpoint}
      />

      <CheckpointTimeline
        checkpoints={checkpoints}
        loading={checkpointsLoading}
        busyId={checkpointBusyId}
        onRestore={onRestoreCheckpoint}
        onDelete={onDeleteCheckpoint}
      />

      {error && (
        <div
          role="alert"
          className="rounded-md border border-rose-700/60 bg-rose-900/30 px-3 py-2 text-xs text-rose-200"
          data-testid="history-error"
        >
          {error}
        </div>
      )}

      {sorted.length === 0 ? (
        <p className="px-1 py-2 text-[11px] text-zinc-500" data-testid="history-empty">
          No changes yet. Apply a replacement, fit-style tweak, remove, or
          placeholder \u2014 every action lands here with a per-row Undo.
        </p>
      ) : (
        <ol className="min-h-0 flex-1 space-y-2 overflow-auto pr-1" data-testid="history-list">
          {sorted.map((patch) => (
            <HistoryRow
              key={patch.id}
              patch={patch}
              onUndo={() => onUndoPatchById(patch.id)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

interface ToolbarProps {
  canUndoLast: boolean;
  canResetSelected: boolean;
  onUndoLastChange: () => void;
  onUndoAll: () => void;
  onResetSelectedImage: () => void;
  onResetProject: () => void;
  canSaveCheckpoint: boolean;
  checkpointSaveBusy: boolean;
  onSaveCheckpoint: () => void;
}

function Toolbar({
  canUndoLast, canResetSelected,
  onUndoLastChange, onUndoAll, onResetSelectedImage, onResetProject,
  canSaveCheckpoint, checkpointSaveBusy, onSaveCheckpoint,
}: ToolbarProps) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="history-toolbar">
      <button
        type="button"
        onClick={onUndoLastChange}
        disabled={!canUndoLast}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-violet-400 hover:bg-violet-500/10 hover:text-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="undo-last-change"
        title="Reverts the most recently applied change"
      >
        Undo Last Change
      </button>
      <button
        type="button"
        onClick={() => {
          if (!canUndoLast) return;
          onUndoAll();
        }}
        disabled={!canUndoLast}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-amber-400 hover:bg-amber-500/10 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="undo-all-patches"
        title="Reverts every patch in newest-first order. Faster than per-row Undo for many changes."
      >
        Undo All Patches
      </button>
      <button
        type="button"
        onClick={onSaveCheckpoint}
        disabled={!canSaveCheckpoint || checkpointSaveBusy}
        aria-busy={checkpointSaveBusy}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="save-checkpoint"
        title="Saves the current project version to the checkpoint timeline"
      >
        {checkpointSaveBusy ? 'Saving checkpoint…' : 'Save checkpoint'}
      </button>
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          onClick={onResetSelectedImage}
          disabled={!canResetSelected}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[11px] font-medium text-zinc-200 transition-colors hover:border-amber-400 hover:bg-amber-500/10 hover:text-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="reset-selected-image"
          title="Reverts every patch tied to the selected image"
        >
          Reset Selected
        </button>
        <button
          type="button"
          onClick={onResetProject}
          className="rounded-md border border-rose-700/60 bg-rose-950/40 px-2 py-1.5 text-[11px] font-medium text-rose-200 transition-colors hover:border-rose-400 hover:bg-rose-500/15 hover:text-rose-100"
          data-testid="reset-project"
          title="Reloads the original zip and discards every change"
        >
          Reset Project
        </button>
      </div>
    </div>
  );
}

function CheckpointTimeline({
  checkpoints,
  loading,
  busyId,
  onRestore,
  onDelete,
}: {
  checkpoints: CheckpointSummary[];
  loading: boolean;
  busyId: string | null;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="checkpoint-timeline">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-zinc-200">Checkpoints</h4>
        {loading && <span className="text-[11px] text-zinc-500">Loading…</span>}
      </div>
      {loading ? (
        <p className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-[11px] text-zinc-500">
          Loading checkpoints…
        </p>
      ) : checkpoints.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-800 px-3 py-3 text-center text-[11px] text-zinc-500">
          No checkpoints yet.
        </p>
      ) : (
        <ol className="max-h-44 space-y-2 overflow-auto pr-1">
          {checkpoints.map((checkpoint) => {
            const rowBusy = busyId?.endsWith(`:${checkpoint.id}`) ?? false;
            const patchCount = checkpoint.patches.length;
            return (
              <li
                key={checkpoint.id}
                className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-[11px]"
                data-testid="checkpoint-row"
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-zinc-100" title={checkpoint.label}>
                    {checkpoint.label}
                  </p>
                  <p className="mt-1 text-zinc-400">
                    {formatRelativeSavedAt(checkpoint.savedAt)} · {patchCount} patch{patchCount === 1 ? '' : 'es'}
                  </p>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <CheckpointActionButton
                    onClick={() => onRestore(checkpoint.id)}
                    disabled={rowBusy}
                    testId="checkpoint-restore"
                  >
                    Restore
                  </CheckpointActionButton>
                  <CheckpointActionButton
                    onClick={() => onDelete(checkpoint.id)}
                    disabled={rowBusy}
                    danger
                    testId="checkpoint-delete"
                  >
                    Delete
                  </CheckpointActionButton>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function CheckpointActionButton({
  children,
  disabled,
  danger = false,
  onClick,
  testId,
}: {
  children: ReactNode;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
  testId: string;
}) {
  const cls = danger
    ? 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-rose-500/60 hover:text-rose-200'
    : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${cls}`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

interface HistoryRowProps {
  patch: AppliedPatch;
  onUndo: () => void;
}

function HistoryRow({ patch, onUndo }: HistoryRowProps) {
  const meta = describePatch(patch);
  const sourcePair = sourceTextPairFor(patch);
  return (
    <li
      className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2.5 text-[11px]"
      data-testid="history-row"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${meta.actionTone}`}
              data-testid="history-action-type"
            >
              {meta.actionType}
            </span>
            {patch.action === 'replace' && patch.newAssetReencoded && (
              <span className="rounded-md border border-violet-700/40 bg-violet-950/30 px-1.5 py-0.5 text-[10px] font-medium text-violet-200" title="This asset was re-encoded as WebP on apply">
                WebP
              </span>
            )}
            <span className="text-zinc-500" title={patch.appliedAt ? new Date(patch.appliedAt).toString() : ''}>
              {formatTimestamp(patch.appliedAt)}
            </span>
          </div>
          <div className="space-y-0.5">
            <div className="grid grid-cols-[64px_1fr] items-baseline gap-x-1.5">
              <dt className="uppercase tracking-wide text-zinc-500">File</dt>
              <dd className="truncate font-mono text-zinc-200" title={meta.file}>
                {meta.file}
              </dd>
            </div>
            <div className="grid grid-cols-[64px_1fr] items-baseline gap-x-1.5">
              <dt className="uppercase tracking-wide text-zinc-500">Old</dt>
              <dd className="truncate font-mono text-zinc-400" title={meta.oldPath}>
                {meta.oldPath || <span className="text-zinc-600">\u2014</span>}
              </dd>
            </div>
            <div className="grid grid-cols-[64px_1fr] items-baseline gap-x-1.5">
              <dt className="uppercase tracking-wide text-zinc-500">New</dt>
              <dd className="truncate font-mono text-zinc-200" title={meta.newPath}>
                {meta.newPath || <span className="text-zinc-600">\u2014</span>}
              </dd>
            </div>
            {meta.extra && (
              <div className="grid grid-cols-[64px_1fr] items-baseline gap-x-1.5">
                <dt className="uppercase tracking-wide text-zinc-500">Notes</dt>
                <dd className="truncate text-zinc-400" title={meta.extra}>
                  {meta.extra}
                </dd>
              </div>
            )}
          </div>
          {sourcePair && <DiffView before={sourcePair.before} after={sourcePair.after} fileLabel={meta.file} />}
        </div>
        <button
          type="button"
          onClick={onUndo}
          className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-200 transition-colors hover:border-violet-400 hover:bg-violet-500/10 hover:text-violet-100"
          data-testid="history-row-undo"
          title={`Reverts this ${meta.actionType.toLowerCase()}`}
        >
          Undo
        </button>
      </div>
    </li>
  );
}

/**
 * Returns the {before, after} source-text pair for a single AppliedPatch
 * so the inline DiffView component can render it. For single-file
 * variants we read previousSourceText + currentSourceText directly. For
 * manual-replace we collapse modifiedFiles[] into a unified virtual diff
 * (because the user changes potentially-many files in one apply, we
 * prefer to summarise the FIRST touched file and link-by-name the
 * others in the meta.extra string — they don't all fit on one diff card).
 */
function sourceTextPairFor(patch: AppliedPatch): { before: string; after: string } | null {
  if (patch.action === 'replace' || patch.action === 'fit-style' || patch.action === 'remove' || patch.action === 'placeholder' || patch.action === 'editor-edit' || patch.action === 'editor-reorder' || patch.action === 'editor-nudge' || patch.action === 'editor-delete') {
    return { before: patch.previousSourceText, after: patch.currentSourceText };
  }
  if (patch.action === 'manual-replace' && patch.modifiedFiles.length > 0) {
    const first = patch.modifiedFiles[0];
    return { before: first.previousSourceText, after: first.currentText };
  }
  return null;
}

interface PatchMeta {
  actionType: string;
  actionTone: string;
  file: string;
  oldPath: string;
  newPath: string;
  extra?: string;
}

function describePatch(patch: AppliedPatch): PatchMeta {
  switch (patch.action) {
    case 'replace':
      return {
        actionType: 'Replace image',
        actionTone: 'border-emerald-700/40 bg-emerald-950/30 text-emerald-200',
        file: patch.sourceFile,
        oldPath: patch.rawUrl,
        newPath: `${patch.newAssetPath} \u00b7 ${formatBytes(patch.replacementBytes)}`,
      };
    case 'fit-style':
      return {
        actionType: 'Fit & style',
        actionTone: 'border-violet-700/40 bg-violet-950/30 text-violet-200',
        file: patch.sourceFile,
        oldPath: patch.rawUrl,
        newPath: patch.generatedCss.replace(/;\s*$/, '').trim(),
        extra: `fit=${patch.config.fit} \u00b7 pos=${patch.config.position} \u00b7 radius=${patch.config.borderRadius} \u00b7 overlay=${patch.config.overlay}`,
      };
    case 'remove':
      return {
        actionType: 'Remove reference',
        actionTone: 'border-rose-700/40 bg-rose-950/30 text-rose-200',
        file: patch.sourceFile,
        oldPath: patch.rawUrl,
        newPath: '',
        extra: `${patch.sourceTag}${patch.sourceAttr && patch.sourceAttr !== patch.sourceTag ? '\u00b7' + patch.sourceAttr : ''}`,
      };
    case 'placeholder':
      return {
        actionType: 'Placeholder',
        actionTone: 'border-amber-700/40 bg-amber-950/30 text-amber-200',
        file: patch.sourceFile,
        oldPath: patch.rawUrl,
        newPath: `placeholder div: ${patch.placeholder.label}`,
      };
    case 'manual-replace': {
      const first = patch.modifiedFiles[0];
      const oldOrSearch = (first?.path ?? patch.targetScope);
      const truncatedSearch = patch.searchText.length > 80
        ? patch.searchText.slice(0, 77) + '\u2026'
        : patch.searchText;
      const truncatedRef = patch.replacementText.length > 80
        ? patch.replacementText.slice(0, 77) + '\u2026'
        : patch.replacementText;
      return {
        actionType: 'Manual find/replace',
        actionTone: 'border-zinc-700 bg-zinc-900 text-zinc-200',
        // For manual-replace, "file changed" shows the FIRST touched file
        // (or the all-scope banner); the count of additional files is in
        // the Notes column so the row doesn't have to truncate.
        file: patch.targetScope === 'all-source-files'
          ? `All editable files (${patch.filesTouched})`
          : (oldOrSearch ?? patch.targetScope),
        oldPath: `\u201c${truncatedSearch}\u201d`,
        newPath: `\u201c${truncatedRef}\u201d`,
        extra: `${patch.replaceAll ? 'replace all' : 'replace once'} \u00b7 ${patch.matchCount} match${patch.matchCount === 1 ? '' : 'es'}`
          + (patch.newAssetPath ? ` \u00b7 asset: ${patch.newAssetPath}` : '')
          + (patch.filesTouched > 1 && patch.targetScope !== 'all-source-files'
            ? ` \u00b7 +${patch.filesTouched - 1} more file${patch.filesTouched - 1 === 1 ? '' : 's'}`
            : ''),
      };
    }
    case 'editor-edit': {
      const first = patch.edits[0];
      const oldValue = first ? clipForMeta(first.oldValue) : '';
      const newValue = first ? clipForMeta(first.newValue) : '';
      return {
        actionType: 'Editor edit',
        actionTone: 'border-sky-700/40 bg-sky-950/30 text-sky-200',
        file: patch.sourceFile,
        oldPath: first ? `${first.field}: "${oldValue}"` : '',
        newPath: first ? `${first.field}: "${newValue}"` : '',
        extra: `${patch.target.selectorHint ?? patch.target.tagName} · ${patch.edits.length} field${patch.edits.length === 1 ? '' : 's'}`,
      };
    }
    case 'editor-reorder':
      return {
        actionType: 'Editor reorder',
        actionTone: 'border-cyan-700/40 bg-cyan-950/30 text-cyan-200',
        file: patch.sourceFile,
        oldPath: patch.target.selectorHint ?? patch.target.label,
        newPath: `${patch.placement} ${patch.reference.selectorHint ?? patch.reference.label}`,
        extra: `${patch.target.tagName} moved ${patch.placement} ${patch.reference.tagName}`,
      };
    case 'editor-nudge':
      return {
        actionType: 'Editor move',
        actionTone: 'border-teal-700/40 bg-teal-950/30 text-teal-200',
        file: patch.sourceFile,
        oldPath: patch.target.selectorHint ?? patch.target.label,
        newPath: `translate(${formatDelta(patch.translateX)}, ${formatDelta(patch.translateY)})`,
        extra: `${patch.target.tagName} nudged ${formatDelta(patch.deltaX)}, ${formatDelta(patch.deltaY)}`,
      };
    case 'editor-delete':
      return {
        actionType: 'Editor delete',
        actionTone: 'border-rose-700/40 bg-rose-950/30 text-rose-200',
        file: patch.sourceFile,
        oldPath: patch.target.selectorHint ?? patch.target.label,
        newPath: '',
        extra: `${patch.target.tagName} removed from source`,
      };
  }
}

function formatDelta(value: number): string {
  return `${value}px`;
}

function clipForMeta(text: string): string {
  return text.length <= 80 ? text : text.slice(0, 77) + '\u2026';
}

function formatTimestamp(appliedAt: number): string {
  const d = new Date(appliedAt);
  // Compact local time. Stable across sessions because Date is locale-aware.
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
