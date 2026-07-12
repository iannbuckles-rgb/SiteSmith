import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { SpIcon, FolderIcon, HistoryIcon, ImageIcon, PencilIcon } from './FileIcon';
import type { FileNode, ImageDetection, LeftPanelMode, LoadedProject, LogoCandidate, LogoHelperConfig } from '../types';
import { buildFileTree } from '../lib/fileTree';
import { deleteProjectRecord, listProjects, renameProjectRecord, type Checkpoint, type SavedProject } from '../lib/idb';
import { FileTree } from './FileTree';
import { ProjectSummaryCard } from './ProjectSummary';
import { UploadButton } from './UploadButton';
import { DetectedImagesList } from './DetectedImagesList';
import { ChangeHistoryPanel } from './ChangeHistoryPanel';
import type { LogoHelperSuccessSummary } from './LogoHelperPanel';
import { LogoHelperPanel } from './LogoHelperPanel';
import { ManualReplacePanel } from './ManualReplacePanel';
import { formatRelativeSavedAt } from '../lib/relativeTime';

interface LeftPanelProps {
  project: LoadedProject | null;
  isLoading: boolean;
  error: string | null;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  onUpload: (file: File) => void;
  onCancelLoading: () => void;
  onReload: () => void;
  detections: ImageDetection[];
  thumbnails: Map<string, string>;
  scanning: boolean;
  selectedDetectionKey: string | null;
  onSelectDetection: (key: string) => void;
  /** Tab toggle: image-detector workflow, logo-helper bulk workflow,
   *  fallback Manual Replace, or the change-history view. */
  mode: LeftPanelMode;
  onChangeMode: (mode: LeftPanelMode) => void;
  onOpenSavedProject: (id: string) => Promise<void> | void;
  onSavedProjectRenamed: (id: string, name: string) => void;
  onSavedProjectDeleted: (id: string) => void;
  logoCandidates: LogoCandidate[];
  logoScanning: boolean;
  logoHelperBusy: boolean;
  logoHelperError: string | null;
  logoHelperSuccess: LogoHelperSuccessSummary | null;
  onPickLogoFile: (file: File) => void;
  onClearLogoFile: () => void;
  onApplyLogoHelper: (config: LogoHelperConfig, file: File) => void;
  onResetLogoHelperSuccess: () => void;
  manualReplaceBusy: boolean;
  manualReplaceError: string | null;
  manualReplaceRecent: import('../types').AppliedPatch[];
  onApplyManualReplace: (input: {
    scope: string;
    searchText: string;
    replacementText: string;
    replaceAll: boolean;
    imageFile: File | null;
    customAssetFilename: string;
  }) => void;
  onUndoManualReplace: (patchId: string) => void;
  /** History panel props (driven by the unified undo reducer in App.tsx). */
  historyError: string | null;
  historyEntries: import('../types').AppliedPatch[];
  onUndoPatchById: (patchId: string) => void;
  onUndoLastChange: () => void;
  onUndoAll: () => void;
  onResetSelectedImage: () => void;
  onResetProject: () => void;
  checkpoints: Checkpoint[];
  checkpointsLoading: boolean;
  checkpointBusyId: string | null;
  checkpointSaveBusy: boolean;
  canSaveCheckpoint: boolean;
  onSaveCheckpoint: () => void;
  onRestoreCheckpoint: (id: string) => void;
  onDeleteCheckpoint: (id: string) => void;
  /** Used to gate Reset Selected Image; the History tab itself doesn't
   *  read from the ImageDetection state directly because that would
   *  couple two unrelated UI surfaces. */
  hasSelectedDetection: boolean;
  /** Bulk-replace wiring through DetectedImagesList. */
  folderBuckets: Array<{ dir: string; count: number }>;
  bulkFolder: string;
  bulkPendingFile: File | null;
  bulkBusy: boolean;
  scopedDetectionCount: number;
  onSetBulkFolder: (dir: string) => void;
  onPickBulkFile: (file: File) => void;
  onClearBulkFile: () => void;
  onAskBulkConfirm: () => void;
}

export function LeftPanel({
  project, isLoading, error,
  expanded, selectedPath,
  onToggleFolder, onSelectFile,
  onUpload, onCancelLoading, onReload,
  detections, thumbnails, scanning,
  selectedDetectionKey, onSelectDetection,
  mode, onChangeMode, onOpenSavedProject, onSavedProjectRenamed, onSavedProjectDeleted,
  logoCandidates, logoScanning,
  logoHelperBusy, logoHelperError, logoHelperSuccess,
  onPickLogoFile, onClearLogoFile, onApplyLogoHelper, onResetLogoHelperSuccess,
  manualReplaceBusy, manualReplaceError, manualReplaceRecent,
  onApplyManualReplace, onUndoManualReplace,
  historyError, historyEntries,
  onUndoPatchById, onUndoLastChange, onUndoAll, onResetSelectedImage, onResetProject,
  checkpoints, checkpointsLoading, checkpointBusyId, checkpointSaveBusy, canSaveCheckpoint,
  onSaveCheckpoint, onRestoreCheckpoint, onDeleteCheckpoint,
  hasSelectedDetection,
  folderBuckets, bulkFolder, bulkPendingFile, bulkBusy, scopedDetectionCount,
  onSetBulkFolder, onPickBulkFile, onClearBulkFile, onAskBulkConfirm,
}: LeftPanelProps) {
  const tree = useMemo<FileNode | null>(
    () => (project ? buildFileTree(project.entries) : null),
    [project],
  );
  const modeStatus = getModeStatus({
    mode,
    hasProject: project !== null,
    scanning,
    detectionCount: detections.length,
    logoScanning,
    logoCount: logoCandidates.length,
    manualChangeCount: manualReplaceRecent.length,
    historyChangeCount: historyEntries.length,
  });

  return (
    <aside className="flex h-full min-h-0 flex-col gap-3 overflow-hidden border-r border-zinc-800 bg-zinc-950 p-3">
      {!project && <UploadButton onFile={onUpload} disabled={isLoading} />}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-rose-700/60 bg-rose-900/30 px-3 py-2 text-xs text-rose-200"
        >
          {error}
        </div>
      )}

      {isLoading && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-300">
          <span className="min-w-0">
            <span className="mr-2 inline-block h-3 w-3 animate-pulse rounded-full bg-violet-400 align-middle" />
            Analyzing project…
          </span>
          <button
            type="button"
            onClick={onCancelLoading}
            className="shrink-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-0.5 text-[11px] font-medium text-zinc-200 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
            data-testid="loading-cancel"
          >
            Cancel
          </button>
        </div>
      )}

      {project && (
        <ProjectSummaryCard summary={project.summary} fileName={project.fileName} />
      )}

      {project && (
        <section className="flex min-h-[150px] basis-2/5 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50">
          <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              Files
            </h3>
            <button
              type="button"
              onClick={onReload}
              className="text-[11px] text-zinc-500 hover:text-violet-300"
              title="Upload a different project"
            >
              change project
            </button>
          </header>
          <div className="flex-1 overflow-auto px-1 py-1" data-testid="file-tree">
            {tree ? (
              <FileTree
                root={tree}
                selectedPath={selectedPath}
                expanded={expanded}
                onToggle={onToggleFolder}
                onSelect={onSelectFile}
              />
            ) : (
              <p className="px-2 py-2 text-xs text-zinc-500">No files.</p>
            )}
          </div>
        </section>
      )}

      <section
        className={`flex min-h-0 flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50 ${project ? 'basis-3/5' : 'flex-1'}`}
        data-testid="bottom-panel"
      >
        <header className="flex min-w-0 items-center gap-2 border-b border-zinc-800 px-3 py-2">
          <ModeTabs mode={mode} onChangeMode={onChangeMode} />
          <span className="ml-auto shrink-0 text-[11px] text-zinc-500">
            {modeStatus}
          </span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col px-2 py-2">
          {mode === 'projects' ? (
            <ProjectsPanel
              active={mode === 'projects'}
              onOpenProject={onOpenSavedProject}
              onRenamed={onSavedProjectRenamed}
              onDeleted={onSavedProjectDeleted}
            />
          ) : !project ? (
            <div className="flex h-full items-center justify-center rounded-md border border-dashed border-zinc-800 px-3 py-6 text-center text-xs text-zinc-500">
              Upload a zip or open a saved project from Projects.
            </div>
          ) : mode === 'images' ? (
            <DetectedImagesList
              detections={detections}
              thumbnails={thumbnails}
              scanning={scanning}
              selectedKey={selectedDetectionKey}
              onSelect={onSelectDetection}
              folderBuckets={folderBuckets}
              bulkFolder={bulkFolder}
              bulkPendingFile={bulkPendingFile}
              bulkBusy={bulkBusy}
              scopedDetectionCount={scopedDetectionCount}
              onSetBulkFolder={onSetBulkFolder}
              onPickBulkFile={onPickBulkFile}
              onClearBulkFile={onClearBulkFile}
              onAskBulkConfirm={onAskBulkConfirm}
            />
          ) : mode === 'logos' ? (
            <LogoHelperPanel
              candidates={logoCandidates}
              scanning={logoScanning}
              busy={logoHelperBusy}
              error={logoHelperError}
              successSummary={logoHelperSuccess}
              onPickFile={onPickLogoFile}
              onClearFile={onClearLogoFile}
              onApply={onApplyLogoHelper}
              onResetSuccess={onResetLogoHelperSuccess}
            />
          ) : mode === 'manual' ? (
            <ManualReplacePanel
              project={project}
              busy={manualReplaceBusy}
              error={manualReplaceError}
              recent={manualReplaceRecent}
              onApply={onApplyManualReplace}
              onUndo={onUndoManualReplace}
            />
          ) : (
            <ChangeHistoryPanel
              error={historyError}
              entries={historyEntries}
              hasSelectedDetection={hasSelectedDetection}
              onUndoPatchById={onUndoPatchById}
              onUndoLastChange={onUndoLastChange}
              onUndoAll={onUndoAll}
              onResetSelectedImage={onResetSelectedImage}
              onResetProject={onResetProject}
              checkpoints={checkpoints}
              checkpointsLoading={checkpointsLoading}
              checkpointBusyId={checkpointBusyId}
              checkpointSaveBusy={checkpointSaveBusy}
              canSaveCheckpoint={canSaveCheckpoint}
              onSaveCheckpoint={onSaveCheckpoint}
              onRestoreCheckpoint={onRestoreCheckpoint}
              onDeleteCheckpoint={onDeleteCheckpoint}
            />
          )}
        </div>
      </section>
    </aside>
  );
}

function getModeStatus({
  mode,
  hasProject,
  scanning,
  detectionCount,
  logoScanning,
  logoCount,
  manualChangeCount,
  historyChangeCount,
}: {
  mode: LeftPanelMode;
  hasProject: boolean;
  scanning: boolean;
  detectionCount: number;
  logoScanning: boolean;
  logoCount: number;
  manualChangeCount: number;
  historyChangeCount: number;
}): string {
  if (mode === 'projects') return 'library';
  if (!hasProject) return 'no project';
  if (mode === 'images') return scanning ? 'scanning...' : `${detectionCount}`;
  if (mode === 'logos') return logoScanning ? 'scanning...' : `${logoCount} logos`;
  const count = mode === 'manual' ? manualChangeCount : historyChangeCount;
  return `${count} change${count === 1 ? '' : 's'}`;
}

interface ModeTabsProps {
  mode: LeftPanelMode;
  onChangeMode: (mode: LeftPanelMode) => void;
}

function ModeTabs({ mode, onChangeMode }: ModeTabsProps) {
  return (
    <div
      className="grid min-w-0 flex-1 grid-cols-5 gap-1"
      role="tablist"
      aria-label="Project tools"
    >
      <ModeTab
        active={mode === 'images'}
        onClick={() => onChangeMode('images')}
        testId="bottom-mode-images"
        icon={<ImageIcon className="h-3.5 w-3.5" />}
        label="Images"
      />
      <ModeTab
        active={mode === 'logos'}
        onClick={() => onChangeMode('logos')}
        testId="bottom-mode-logos"
        icon={<SpIcon className="h-3.5 w-3.5" />}
        label="Logos"
      />
      <ModeTab
        active={mode === 'manual'}
        onClick={() => onChangeMode('manual')}
        testId="bottom-mode-manual"
        icon={<PencilIcon className="h-3.5 w-3.5" />}
        label="Manual"
      />
      <ModeTab
        active={mode === 'history'}
        onClick={() => onChangeMode('history')}
        testId="bottom-mode-history"
        icon={<HistoryIcon className="h-3.5 w-3.5" />}
        label="History"
      />
      <ModeTab
        active={mode === 'projects'}
        onClick={() => onChangeMode('projects')}
        testId="bottom-mode-projects"
        icon={<FolderIcon className="h-3.5 w-3.5" />}
        label="Projects"
      />
    </div>
  );
}

interface ModeTabProps {
  active: boolean;
  onClick: () => void;
  testId?: string;
  icon: ReactNode;
  label: string;
}

function ModeTab({ active, onClick, testId, icon, label }: ModeTabProps) {
  const cls = active
    ? 'border-violet-500/60 bg-violet-500/15 text-violet-100'
    : 'border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-7 min-w-0 items-center justify-center rounded-md border transition-colors ${cls}`}
      data-testid={testId}
    >
      <span className={active ? 'text-violet-200' : 'text-zinc-500'}>{icon}</span>
      <span className="sr-only">{label}</span>
    </button>
  );
}

interface ProjectsPanelProps {
  active: boolean;
  onOpenProject: (id: string) => Promise<void> | void;
  onRenamed: (id: string, name: string) => void;
  onDeleted: (id: string) => void;
}

function ProjectsPanel({ active, onOpenProject, onRenamed, onDeleted }: ProjectsPanelProps) {
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listProjects());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  const handleOpen = useCallback(async (project: SavedProject) => {
    setBusyId(`open:${project.id}`);
    setError(null);
    try {
      await onOpenProject(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open project.');
    } finally {
      setBusyId(null);
    }
  }, [onOpenProject]);

  const handleRename = useCallback(async (project: SavedProject) => {
    const nextName = window.prompt('Rename project', project.name);
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;
    setBusyId(`rename:${project.id}`);
    setError(null);
    try {
      await renameProjectRecord(project.id, trimmed);
      onRenamed(project.id, trimmed);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename project.');
    } finally {
      setBusyId(null);
    }
  }, [onRenamed, refresh]);

  const handleDelete = useCallback(async (project: SavedProject) => {
    if (!window.confirm(`Delete "${project.name}"?`)) return;
    setBusyId(`delete:${project.id}`);
    setError(null);
    try {
      await deleteProjectRecord(project.id);
      onDeleted(project.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete project.');
    } finally {
      setBusyId(null);
    }
  }, [onDeleted, refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="projects-panel">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-zinc-200">Saved projects</h4>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-50"
          data-testid="projects-refresh"
        >
          Refresh
        </button>
      </div>
      {error && (
        <div className="rounded-md border border-rose-700/60 bg-rose-950/40 px-2 py-1.5 text-[11px] text-rose-200" role="alert">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <p className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-3 text-xs text-zinc-500">
            Loading projects…
          </p>
        ) : projects.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">
            No saved projects yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {projects.map((project) => {
              const patchCount = project.patches.length;
              const fileName = project.projectMeta?.fileName ?? 'project.zip';
              const rowBusy = busyId?.endsWith(`:${project.id}`) ?? false;
              return (
                <li
                  key={project.id}
                  className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2"
                  data-testid="saved-project-row"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-zinc-100" title={project.name}>
                      {project.name}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-zinc-500" title={fileName}>
                      {fileName}
                    </p>
                    <p className="mt-1 text-[11px] text-zinc-400">
                      {patchCount} patch{patchCount === 1 ? '' : 'es'} · {formatRelativeSavedAt(project.savedAt)}
                    </p>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <ProjectActionButton
                      onClick={() => void handleOpen(project)}
                      disabled={rowBusy}
                      testId="saved-project-open"
                    >
                      Open
                    </ProjectActionButton>
                    <ProjectActionButton
                      onClick={() => void handleRename(project)}
                      disabled={rowBusy}
                      testId="saved-project-rename"
                    >
                      Rename
                    </ProjectActionButton>
                    <ProjectActionButton
                      onClick={() => void handleDelete(project)}
                      disabled={rowBusy}
                      danger
                      testId="saved-project-delete"
                    >
                      Delete
                    </ProjectActionButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProjectActionButton({
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
