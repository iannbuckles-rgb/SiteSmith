import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { CenterPanel } from './components/CenterPanel';
import { DialogShell } from './components/DialogShell';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LeftPanel } from './components/LeftPanel';
import type { LogoHelperSuccessSummary } from './components/LogoHelperPanel';
import { RightPanel } from './components/RightPanel';
import type { EditorReorderTarget, EditorSelection, PreviewHistoryState, PreviewMode, PreviewViewport } from './lib/previewControls';
import { applyPlaceholder, applyRemove, applyReplacement } from './lib/assetReplacer';
import { bulkReplace } from './lib/bulkReplace';
import { createAbortError, isAbortError, throwIfAborted } from './lib/cancellation';
import { applyEditorEdit, applyEditorReorder } from './lib/editorPatch';
import { applyFitStyleToCss, applyFitStyleToImg } from './lib/fitStyles';
import {
  clearSession,
  deleteCheckpoint,
  listCheckpoints,
  loadCheckpoint,
  loadProjectRecord,
  loadSession,
  saveCheckpoint,
  saveProjectRecord,
  saveSession,
  type Checkpoint,
  type PersistedSelection,
  type PersistedSession,
  type PersistedTheme,
} from './lib/idb';
import { detectImages } from './lib/imageDetector';
import { applyLogoHelper } from './lib/logoHelper';
import { applyManualReplace, undoManualReplace } from './lib/manualReplace';
import { undoPatchById } from './lib/undoStack';
import { type PreviewIndex } from './lib/previewService';
import { buildPreview } from './lib/previewServer';
import { getProjectWorkerClient } from './lib/projectWorkerClient';
import { resolveAgainst } from './lib/urlResolver';
import { WorkerZipArchive } from './lib/workerZipArchive';
import type {
  AppliedPatch,
  ExportState,
  ExportSummary,
  EditorEditField,
  ImageDetection,
  ImageFitConfig,
  LeftPanelMode,
  LoadedProject,
  LogoCandidate,
  LogoHelperConfig,
  ZipEntryMeta,
} from './types';
import { IDLE_PHASE, type Phase } from './lib/progress';
import { TopBarProgress } from './components/TopBarProgress';
import { Toast, type ToastData } from './components/Toast';
import { formatBytes } from './lib/fileTypes';

/** Cap concurrent thumbnail reads to keep memory bounded. */
const THUMBNAIL_CONCURRENCY = 4;
/** Cap total thumbnails loaded — beyond this we still display cards, just
 *  without previews, to avoid pegging the renderer. */
const THUMBNAIL_CAP = 60;

/** postMessage type for nav events emitted by the iframe script. */
const NAV_MESSAGE_TYPE = 'mockswap:navigate';
const TEXT_EDIT_MESSAGE_TYPE = 'mockswap:text-edit';
const SELECT_MESSAGE_TYPE = 'mockswap:select-element';
const REORDER_MESSAGE_TYPE = 'mockswap:reorder-element';

/** Save-to-IndexedDB debounce window. Big zips take ~60–80 ms to blob; we
 *  batch rapid mutations (chip clicks, typed searches) so 1 s is safe. */
const SAVE_DEBOUNCE_MS = 1000;

/** Auto-fade duration for transient Toast cards. Long enough that the
 *  user reads "Saved 47% on disk" once, short enough that idle screens
 *  don't pile up. Picked up by the global expiry timer in App.tsx
 *  (250 ms tick) — the value is whole seconds because precision below
 *  one tick is wasteful. */
const TOAST_AUTO_DISMISS_MS = 6000;
const PERSISTENCE_WARNING_TITLE = "Couldn't save your session — this browser is out of storage.";
const PERSISTENCE_WARNING_DETAIL = 'Your changes are safe in memory but a refresh will lose them. Export your zip to keep them.';
const DEFAULT_LARGE_ZIP_WARNING_BYTES = 150 * 1024 * 1024;
const LARGE_ZIP_WARNING_BYTES = parseLargeZipThreshold(import.meta.env.VITE_LARGE_ZIP_WARNING_BYTES);

/**
 * Restore-banner context captured on boot. The "blobs" are loaded from IDB
 * once and reused; rehydrating the project is a separate step that the
 * user can opt into via the banner's Restore button.
 */
type RestoreBanner = {
  meta: { fileName: string; totalFiles: number; htmlFiles: number; cssFiles: number; jsFiles: number; imageFiles: number; totalSize: number };
  selection: PersistedSelection | null;
  patchCount: number;
  mutatedZipBlob: Blob;
  originalZipBlob: Blob | null;
};

type PersistedProjectSnapshot = Omit<PersistedSession, 'schemaVersion' | 'savedAt'>;

/** A bulk-replace confirmation presented as a small modal in App.tsx.
 *  The dialog blocks the rest of the UI via a backdrop while it's open. */
type BulkConfirm = {
  dir: string;
  fileName: string;
  detectionCount: number;
  preview: Array<{ key: string; rawUrl: string; sourceFile: string }>;
};

type ResponsivePane = 'left' | 'preview' | 'right';
type OnboardingKind = 'upload' | 'restore';
type OnboardingRun = {
  id: number;
  kind: OnboardingKind;
  controller: AbortController;
};

const RESPONSIVE_PANES: Array<{ id: ResponsivePane; label: string }> = [
  { id: 'left', label: 'Files' },
  { id: 'preview', label: 'Preview' },
  { id: 'right', label: 'Tools' },
];

const THEME_STORAGE_KEY = 'mockswap:theme';

export default function App() {
  const [project, setProject] = useState<LoadedProject | null>(null);
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [originalBlob, setOriginalBlob] = useState<Blob | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [detections, setDetections] = useState<ImageDetection[]>([]);
  const [scanning, setScanning] = useState(false);
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const [selectedDetectionKey, setSelectedDetectionKey] = useState<string | null>(null);

  // Logo Helper state.
  const [logoCandidates, setLogoCandidates] = useState<LogoCandidate[]>([]);
  const [logoScanning, setLogoScanning] = useState(false);
  const [logoHelperBusy, setLogoHelperBusy] = useState(false);
  const [logoHelperError, setLogoHelperError] = useState<string | null>(null);
  const [logoHelperSuccess, setLogoHelperSuccess] = useState<LogoHelperSuccessSummary | null>(null);

  const [preview, setPreview] = useState<PreviewIndex | null>(null);
  const [previewBuilding, setPreviewBuilding] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [currentPagePath, setCurrentPagePath] = useState<string>('');
  const [previewRevision, setPreviewRevision] = useState(0);

  // Preview-toolbar state. Viewport / zoom are user-pinned preferences
  // that survive across edits; fullscreen is a transient overlay mode.
  const [previewViewport, setPreviewViewport] = useState<PreviewViewport>('full');
  const [previewZoom, setPreviewZoom] = useState<number>(1);
  const [previewHistory, setPreviewHistory] = useState<PreviewHistoryState>({ pages: [], index: -1 });
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('preview');
  const [editorSelection, setEditorSelection] = useState<EditorSelection | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // Editing / replacement state.
  const [patchesByKey, setPatchesByKey] = useState<Map<string, AppliedPatch>>(new Map());
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [replacementBusy, setReplacementBusy] = useState(false);
  const [replacementError, setReplacementError] = useState<string | null>(null);
  const [brokenBusy, setBrokenBusy] = useState(false);
  const [brokenError, setBrokenError] = useState<string | null>(null);
  const [fitStyleBusy, setFitStyleBusy] = useState(false);
  const [fitStyleError, setFitStyleError] = useState<string | null>(null);

  // Export.
  const [exportState, setExportState] = useState<ExportState>('idle');
  const [exportSummary, setExportSummary] = useState<ExportSummary | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Manual Replace.
  const [manualReplaceBusy, setManualReplaceBusy] = useState(false);
  const [manualReplaceError, setManualReplaceError] = useState<string | null>(null);

  // History / Undo panel error slot.
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [leftPanelMode, setLeftPanelMode] = useState<LeftPanelMode>('images');

  // Responsive shell state. Mobile shows one pane at a time; tablet keeps
  // files + preview visible and opens the right-side tools as a drawer.
  const [activeMobilePane, setActiveMobilePane] = useState<ResponsivePane>('left');
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [theme, setTheme] = useState<PersistedTheme>(() => readStoredTheme());

  // Persistence + restore banner.
  const [restoreBanner, setRestoreBanner] = useState<RestoreBanner | null>(null);
  const [restoring, setRestoring] = useState(false);

  // Folder scoping for bulk replace.
  const [bulkFolder, setBulkFolder] = useState<string>('__all__');
  const [bulkPendingFile, setBulkPendingFile] = useState<File | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<BulkConfirm | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [undoAllConfirmOpen, setUndoAllConfirmOpen] = useState(false);

  // WebP re-encoder opt-in. Defaults OFF — users must check the toggle.
  const [webpReencode, setWebpReencode] = useState(false);

  /**
   * Single source-of-truth for the TopBar progress widget. Every async
   * path that flips this to a non-idle kind MUST also reset to `idle`
   * in a `finally` block so the widget never gets stuck. Upload and
   * restore keep this in "detecting" while the worker parses and scans.
   */
  const [busyPhase, setBusyPhase] = useState<Phase>(IDLE_PHASE);

  /**
   * User-visible notifications surfaced via `<ToastViewport>`.
   * Newest at the end, expired cards reaped by a single 250 ms tick so
   * transient toasts share one timer (no per-card setTimeout fleet). Each card
   * manages its own fade-out locally so the reaper never races the
   * mount/unmount cycle.
   */
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const [saveAtRisk, setSaveAtRisk] = useState(false);
  const [projectSaveBusy, setProjectSaveBusy] = useState(false);
  const [activeProjectRecordId, setActiveProjectRecordId] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);
  const [checkpointSaveBusy, setCheckpointSaveBusy] = useState(false);
  const [checkpointBusyId, setCheckpointBusyId] = useState<string | null>(null);
  const [checkpointRestoreTarget, setCheckpointRestoreTarget] = useState<Checkpoint | null>(null);
  const saveFailureToastShownRef = useRef(false);
  const saveFailureToastIdRef = useRef<string | null>(null);

  const pushToast = useCallback((toast: Omit<ToastData, 'id' | 'expiresAt'> & { autoDismiss?: boolean }) => {
    const id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const { autoDismiss = true, ...toastData } = toast;
    setToasts((prev) => [
      ...prev,
      { ...toastData, id, expiresAt: autoDismiss ? Date.now() + TOAST_AUTO_DISMISS_MS : null },
    ]);
    return id;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => (prev.some((t) => t.id === id) ? prev.filter((t) => t.id !== id) : prev));
  }, []);

  const markSessionSaveOk = useCallback(() => {
    setSaveAtRisk(false);
    saveFailureToastShownRef.current = false;
    if (saveFailureToastIdRef.current) {
      dismissToast(saveFailureToastIdRef.current);
      saveFailureToastIdRef.current = null;
    }
  }, [dismissToast]);

  const markSessionSaveFailed = useCallback(() => {
    setSaveAtRisk(true);
    if (saveFailureToastShownRef.current) return;
    saveFailureToastShownRef.current = true;
    saveFailureToastIdRef.current = pushToast({
      kind: 'warning',
      title: PERSISTENCE_WARNING_TITLE,
      detail: PERSISTENCE_WARNING_DETAIL,
      autoDismiss: false,
    });
  }, [pushToast]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage is best-effort; IndexedDB session persistence below
      // still carries the preference when project state can be saved.
    }
  }, [theme]);

  const handleToggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  // Refs into state used inside the postMessage listener.
  const previewRef = useRef<PreviewIndex | null>(null);
  useEffect(() => { previewRef.current = preview; }, [preview]);

  // Refs that mirror state so the navigation / history / open-popup
  // callbacks can use the latest values without having to re-create on
  // every render (or stale-close over a value that's mid-update). React
  // guarantees the ref is set after the previous commit, so reading
  // during a click handler always reflects the last rendered state.
  const currentPagePathRef = useRef<string>('');
  useEffect(() => { currentPagePathRef.current = currentPagePath; }, [currentPagePath]);
  const previewHistoryRef = useRef<PreviewHistoryState>({ pages: [], index: -1 });
  useEffect(() => { previewHistoryRef.current = previewHistory; }, [previewHistory]);
  const workerProjectIdRef = useRef<string | null>(null);
  const activeOnboardingRef = useRef<OnboardingRun | null>(null);
  const nextOnboardingRunIdRef = useRef(1);
  const projectRecordIdRef = useRef<string | null>(null);
  const projectRecordNameRef = useRef<string | null>(null);

  const updateProjectRecordIdentity = useCallback((id: string | null, name: string | null) => {
    projectRecordIdRef.current = id;
    projectRecordNameRef.current = name;
    setActiveProjectRecordId(id);
  }, []);

  const refreshCheckpoints = useCallback(async (projectId: string | null = projectRecordIdRef.current) => {
    if (!projectId) {
      setCheckpoints([]);
      setCheckpointsLoading(false);
      return;
    }
    setCheckpointsLoading(true);
    try {
      const next = await listCheckpoints(projectId);
      if (projectRecordIdRef.current === projectId) setCheckpoints(next);
    } finally {
      if (projectRecordIdRef.current === projectId) setCheckpointsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCheckpoints(activeProjectRecordId);
  }, [activeProjectRecordId, refreshCheckpoints]);

  const releaseWorkerProject = useCallback(() => {
    const projectId = workerProjectIdRef.current;
    if (!projectId) return;
    workerProjectIdRef.current = null;
    void getProjectWorkerClient().disposeProject(projectId);
  }, []);

  const beginOnboardingRun = useCallback((kind: OnboardingKind): OnboardingRun => {
    activeOnboardingRef.current?.controller.abort();
    const run: OnboardingRun = {
      id: nextOnboardingRunIdRef.current++,
      kind,
      controller: new AbortController(),
    };
    activeOnboardingRef.current = run;
    return run;
  }, []);

  const ensureOnboardingActive = useCallback((run: OnboardingRun): void => {
    throwIfAborted(run.controller.signal);
    if (activeOnboardingRef.current?.id !== run.id) throw createAbortError();
  }, []);

  const clearOnboardingRun = useCallback((run: OnboardingRun): boolean => {
    if (activeOnboardingRef.current?.id !== run.id) return false;
    activeOnboardingRef.current = null;
    return true;
  }, []);

  const handleCancelOnboarding = useCallback(() => {
    const run = activeOnboardingRef.current;
    if (!run) return;
    run.controller.abort();
    activeOnboardingRef.current = null;
    setIsLoading(false);
    setRestoring(false);
    setScanning(false);
    setLogoScanning(false);
    setBusyPhase(IDLE_PHASE);
    setError(null);
    if (!project) setActiveMobilePane('left');
  }, [project]);

  // ------------------------------------------------------------------------
  // Derived state
  // ------------------------------------------------------------------------

  const liveEntries = useMemo<ZipEntryMeta[]>(() => {
    if (!project) return [];
    const indexed = new Map<string, ZipEntryMeta>();
    for (const e of project.entries) indexed.set(e.path, e);
    for (const patch of patchesByKey.values()) {
      let newAssetPath: string | undefined;
      let size = 0;
      if (patch.action === 'replace') {
        newAssetPath = patch.newAssetPath;
        size = patch.replacementBytes;
      } else if (patch.action === 'manual-replace') {
        newAssetPath = patch.newAssetPath;
        size = patch.replacementBytes ?? 0;
      }
      if (!newAssetPath) continue;
      indexed.set(newAssetPath, {
        name: newAssetPath.split('/').pop() ?? newAssetPath,
        path: newAssetPath,
        isDirectory: false,
        size,
        category: 'image',
      });
    }
    return Array.from(indexed.values()).sort((a, b) => a.path.localeCompare(b.path));
  }, [project, patchesByKey]);

  const liveProject = useMemo<LoadedProject | null>(() => {
    if (!project) return null;
    return { ...project, entries: liveEntries };
  }, [project, liveEntries]);

  // Active = visible Images panel list = original detections minus already-patched.
  const activeDetections = useMemo<ImageDetection[]>(() => {
    if (patchesByKey.size === 0) return detections;
    return detections.filter((d) => {
      const id = `${d.sourceFile}::${d.sourceTag}::${d.sourceAttr}::${d.rawUrl}`;
      if (patchesByKey.has(id)) return false;
      for (const k of patchesByKey.keys()) {
        if (k.startsWith(id + '#')) return false;
      }
      return true;
    });
  }, [detections, patchesByKey]);

  // Folder buckets: group activeDetections by dirname(sourceFile). The
  // resulting list is shown as a chip row above the status filter chips.
  const folderBuckets = useMemo<Array<{ dir: string; count: number }>>(() => {
    const map = new Map<string, number>();
    for (const d of activeDetections) {
      const dir = dirnameOf(d.sourceFile);
      map.set(dir, (map.get(dir) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => a.dir.localeCompare(b.dir));
  }, [activeDetections]);

  // Scoped subset of activeDetections based on bulkFolder. Drives both
  // the visible list AND the "Apply to N" count when the user has
  // dropped a replacement.
  const scopedDetections = useMemo<ImageDetection[]>(() => {
    if (bulkFolder === '__all__') return activeDetections;
    return activeDetections.filter((d) => dirnameOf(d.sourceFile) === bulkFolder);
  }, [activeDetections, bulkFolder]);

  const selectedDetection: ImageDetection | null = useMemo(() => {
    if (!selectedDetectionKey) return null;
    return activeDetections.find((d) => `${d.sourceFile}|${d.rawUrl}` === selectedDetectionKey) ?? null;
  }, [activeDetections, selectedDetectionKey]);

  const selectedAppliedPatch: AppliedPatch | null = useMemo(() => {
    if (!selectedDetectionKey) return null;
    const sep = selectedDetectionKey.indexOf('|');
    if (sep === -1) return null;
    const sourceFile = selectedDetectionKey.slice(0, sep);
    const rawUrl = selectedDetectionKey.slice(sep + 1);
    let best: AppliedPatch | null = null;
    for (const p of patchesByKey.values()) {
      if (p.action === 'manual-replace' || p.action === 'editor-edit' || p.action === 'editor-reorder') continue;
      if (p.sourceFile !== sourceFile || p.rawUrl !== rawUrl) continue;
      if (!best || p.appliedAt > best.appliedAt) best = p;
    }
    return best;
  }, [patchesByKey, selectedDetectionKey]);

  const selectedThumbnail: string | undefined = useMemo(() => {
    if (!selectedDetection || selectedDetection.status !== 'ok' || !selectedDetection.resolvedPath) {
      return undefined;
    }
    return thumbnails.get(selectedDetection.resolvedPath);
  }, [selectedDetection, thumbnails]);

  const historyEntries = useMemo<AppliedPatch[]>(
    () => Array.from(patchesByKey.values()).sort((a, b) => b.appliedAt - a.appliedAt),
    [patchesByKey],
  );

  const manualReplaceRecent = useMemo(
    () => Array.from(patchesByKey.values())
      .filter((p) => p.action === 'manual-replace')
      .sort((a, b) => b.appliedAt - a.appliedAt),
    [patchesByKey],
  );

  // ------------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------------

  const handleUpload = useCallback(async (file: File) => {
    const run = beginOnboardingRun('upload');
    const client = getProjectWorkerClient();
    const previousWorkerProjectId = workerProjectIdRef.current;
    let parsedProjectId: string | null = null;
    setIsLoading(true);
    setScanning(true);
    setLogoScanning(true);
    setBusyPhase({ kind: 'detecting', startedAt: Date.now() });
    setError(null);
    setSelectedDetectionKey(null);
    setExportState('idle');
    setExportSummary(null);
    setExportError(null);
    setBulkPendingFile(null);
    setBulkConfirm(null);
    setRestoreBanner(null);
    if (file.size > LARGE_ZIP_WARNING_BYTES) {
      pushToast({
        kind: 'warning',
        title: 'Large zip detected',
        detail: `${formatBytes(file.size)} exceeds the ${formatBytes(LARGE_ZIP_WARNING_BYTES)} soft limit. MockupSwap will keep working, but detection and export can take longer.`,
      });
    }
    try {
      const parsed = await client.parseProject(file, {
        signal: run.controller.signal,
        terminateWorkerOnAbort: previousWorkerProjectId === null,
      });
      parsedProjectId = parsed.projectId;
      ensureOnboardingActive(run);
      const next: LoadedProject = {
        fileName: parsed.fileName,
        zip: new WorkerZipArchive(parsed.projectId, client, parsed.entries),
        entries: parsed.entries,
        summary: parsed.summary,
      };
      const detections = await detectImages(next.zip, next.entries, { signal: run.controller.signal });
      ensureOnboardingActive(run);
      workerProjectIdRef.current = parsed.projectId;
      parsedProjectId = null;
      if (previousWorkerProjectId && previousWorkerProjectId !== parsed.projectId) {
        void client.disposeProject(previousWorkerProjectId);
      }
      setProject(next);
      setDetections(detections);
      setLogoCandidates(parsed.logoCandidates);
      setOriginalFile(file);
      // Capture the original blob so a Reset Project can also rehydrate
      // even WITHOUT the in-memory File (e.g. after a manual "reload"
      // from the browser tab's URL bar).
      originalBlobRef.current = file;
      setOriginalBlob(file);
      const firstHtml = next.entries.find((e) => !e.isDirectory && e.category === 'html');
      setSelectedPath(firstHtml?.path ?? null);
      setExpanded(new Set());
      setBulkFolder('__all__');
      setActiveMobilePane('preview');
      setRightDrawerOpen(false);
    } catch (err) {
      if (parsedProjectId) void client.disposeProject(parsedProjectId);
      if (isAbortError(err) || run.controller.signal.aborted || activeOnboardingRef.current?.id !== run.id) return;
      const message = err instanceof Error ? err.message : 'Failed to read zip file.';
      setError(message);
      if (!project) {
        setProject(null);
        setOriginalFile(null);
        setOriginalBlob(null);
        setSelectedPath(null);
        setExpanded(new Set());
        setActiveMobilePane('left');
        setDetections([]);
        setLogoCandidates([]);
      }
    } finally {
      if (clearOnboardingRun(run)) {
        setIsLoading(false);
        setScanning(false);
        setLogoScanning(false);
        setBusyPhase(IDLE_PHASE);
      }
    }
  }, [beginOnboardingRun, clearOnboardingRun, ensureOnboardingActive, project, pushToast]);

  const handleUploadNewProject = useCallback((file: File) => {
    updateProjectRecordIdentity(null, null);
    void handleUpload(file);
  }, [handleUpload, updateProjectRecordIdentity]);

  /**
   * Same as handleUpload but used by Rehydrate on the restore banner. We
   * avoid calling setCurrentPagePath with a synchronously-computed fallback
   * because doing so between `setProject(...)` and the awaited `buildPreview`
   * resolution would let a concurrent `navigateToPage` (e.g. an interaction
   * the user kicks off while restore is still loading) push a now-unavailable
   * path onto history. We just seed the ref + state from `priorSelection`
   * and let the preview-rebuild useEffect's path-preserving functional
   * updater settle the path once the new index has landed.
   */
  const rehydrateFromBlob = useCallback(async (blob: Blob, original: Blob | null, priorMeta: {
    fileName: string; totalFiles: number; htmlFiles: number; cssFiles: number; jsFiles: number; imageFiles: number; totalSize: number;
  }, priorPatches: AppliedPatch[], priorSelection: PersistedSelection | null, priorExpanded: Set<string>) => {
    const run = beginOnboardingRun('restore');
    const client = getProjectWorkerClient();
    const previousWorkerProjectId = workerProjectIdRef.current;
    let parsedProjectId: string | null = null;
    setRestoring(true);
    setScanning(true);
    setLogoScanning(true);
    setBusyPhase({ kind: 'detecting', startedAt: Date.now() });
    setError(null);
    try {
      const fakeFile = blobToFileShim(blob, priorMeta.fileName);
      const parsed = await client.parseProject(fakeFile, {
        signal: run.controller.signal,
        terminateWorkerOnAbort: previousWorkerProjectId === null,
      });
      parsedProjectId = parsed.projectId;
      ensureOnboardingActive(run);
      const next: LoadedProject = {
        fileName: parsed.fileName,
        zip: new WorkerZipArchive(parsed.projectId, client, parsed.entries),
        entries: parsed.entries,
        summary: parsed.summary,
      };
      const detections = await detectImages(next.zip, next.entries, { signal: run.controller.signal });
      ensureOnboardingActive(run);
      workerProjectIdRef.current = parsed.projectId;
      parsedProjectId = null;
      if (previousWorkerProjectId && previousWorkerProjectId !== parsed.projectId) {
        void client.disposeProject(previousWorkerProjectId);
      }
      // Re-stamp ids: patchesByKey is keyed by stable patch ids; the
      // parsed archive does not care about them, so we simply re-seed
      // the Map and let the restored UI state pick them back up.
      setProject(next);
      setDetections(detections);
      setLogoCandidates(parsed.logoCandidates);
      setOriginalFile(original ? blobToFileShim(original, priorMeta.fileName) : fakeFile);
      originalBlobRef.current = original;
      setOriginalBlob(original);
      const patches: Map<string, AppliedPatch> = new Map();
      for (const p of priorPatches) patches.set(p.id, p);
      setPatchesByKey(patches);
      setSelectedDetectionKey(priorSelection?.selectedDetectionKey ?? null);
      if (priorSelection?.currentPagePath) {
        // Mirror onto the ref so the preview-rebuild effect's functional
        // path-updater can read it as the previous "current" page when the
        // new index finishes resolving.
        currentPagePathRef.current = priorSelection.currentPagePath;
        setCurrentPagePath(priorSelection.currentPagePath);
      }
      setExpanded(priorExpanded);
      setLeftPanelMode(priorSelection?.leftPanelMode ?? 'images');
      setRestoreBanner(null);
      setActiveMobilePane('preview');
      setRightDrawerOpen(false);
    } catch (err) {
      if (parsedProjectId) void client.disposeProject(parsedProjectId);
      if (isAbortError(err) || run.controller.signal.aborted || activeOnboardingRef.current?.id !== run.id) return;
      setError(err instanceof Error ? err.message : 'Failed to restore session.');
    } finally {
      if (clearOnboardingRun(run)) {
        setRestoring(false);
        setScanning(false);
        setLogoScanning(false);
        setBusyPhase(IDLE_PHASE);
      }
    }
  }, [beginOnboardingRun, clearOnboardingRun, ensureOnboardingActive]);

  const handleRestoreSession = useCallback(() => {
    if (!restoreBanner) return;
    const priorPatchesRaw = restoreMutatedZipArrayRef.current ?? [];
    const priorPatches = persistedPatchesToApplied(priorPatchesRaw);
    void rehydrateFromBlob(
      restoreBanner.mutatedZipBlob,
      restoreBanner.originalZipBlob,
      restoreBanner.meta,
      priorPatches,
      restoreBanner.selection,
      new Set(restoreBanner.selection?.expandedFolders ?? []),
    );
  }, [restoreBanner, rehydrateFromBlob]);

  const handleDismissRestore = useCallback(() => {
    const run = activeOnboardingRef.current;
    if (run?.kind === 'restore') {
      run.controller.abort();
      activeOnboardingRef.current = null;
      setRestoring(false);
      setScanning(false);
      setLogoScanning(false);
      setBusyPhase(IDLE_PHASE);
    }
    setRestoreBanner(null);
    restoreMutatedZipArrayRef.current = null;
    releaseWorkerProject();
    void clearSession();
  }, [releaseWorkerProject]);

  const handleOpenSavedProject = useCallback(async (id: string) => {
    const record = await loadProjectRecord(id);
    if (!record || !record.mutatedZipBlob) {
      pushToast({
        kind: 'warning',
        title: "Couldn't open project.",
        detail: 'The saved project record could not be found.',
      });
      return;
    }
    updateProjectRecordIdentity(record.id, record.name);
    if (isPersistedTheme(record.theme)) setTheme(record.theme);
    await rehydrateFromBlob(
      record.mutatedZipBlob,
      record.originalZipBlob ?? null,
      record.projectMeta ?? {
        fileName: 'saved-project.zip',
        totalFiles: 0,
        htmlFiles: 0,
        cssFiles: 0,
        jsFiles: 0,
        imageFiles: 0,
        totalSize: 0,
      },
      persistedPatchesToApplied(record.patches),
      record.selection,
      new Set(record.selection?.expandedFolders ?? []),
    );
  }, [pushToast, rehydrateFromBlob, updateProjectRecordIdentity]);

  const handleSavedProjectRenamed = useCallback((id: string, name: string) => {
    if (projectRecordIdRef.current !== id) return;
    projectRecordNameRef.current = name;
  }, []);

  const handleSavedProjectDeleted = useCallback((id: string) => {
    if (projectRecordIdRef.current !== id) return;
    updateProjectRecordIdentity(null, null);
  }, [updateProjectRecordIdentity]);

  // Bucket holding the un-rehydrated patches array, captured alongside
  // the banner so handleRestoreSession can reseed patchesByKey from it.
  const restoreMutatedZipArrayRef = useRef<Array<unknown> | null>(null);

  // Local copy of the File blob used by handleUpload so a later
  // "Reset Project" can re-trigger the parse without re-reading the
  // File from a browser file-picker. Already covered by setOriginalFile
  // but we also retain the raw Blob so the IDB save can persist it.
  const originalBlobRef = useRef<Blob | null>(null);

  const buildCurrentSelection = useCallback((): PersistedSelection => ({
    currentPagePath,
    selectedDetectionKey,
    leftPanelMode,
    expandedFolders: Array.from(expanded),
  }), [currentPagePath, selectedDetectionKey, leftPanelMode, expanded]);

  const buildCurrentProjectSnapshot = useCallback(async (): Promise<PersistedProjectSnapshot | null> => {
    if (!project) return null;
    const mutatedZipBlob = await project.zip.generateAsync({ type: 'blob', compression: 'STORE' });
    // patchesByKey Map → JSON-safe Array
    const patches = Array.from(patchesByKey.entries()).map(([id, patch]) => ({ id, patch }));
    const selection = buildCurrentSelection();
    return {
      projectMeta: {
        fileName: project.fileName,
        totalFiles: project.summary.totalFiles,
        totalSize: project.summary.totalSize,
        htmlFiles: project.summary.htmlFiles,
        cssFiles: project.summary.cssFiles,
        jsFiles: project.summary.jsFiles,
        imageFiles: project.summary.imageFiles,
      },
      mutatedZipBlob,
      // saveSession's parameter is `originalZipBlob`; the React
      // state holds the same Blob under `originalBlob`.
      originalZipBlob: originalBlob,
      patches,
      selection,
      theme,
    };
  }, [project, patchesByKey, buildCurrentSelection, originalBlob, theme]);

  const saveProjectToLibrary = useCallback(async (mode: 'save' | 'save-as'): Promise<string | null> => {
    if (!project || projectSaveBusy) return null;
    const reuseExisting = mode === 'save' && projectRecordIdRef.current !== null;
    const id = reuseExisting ? projectRecordIdRef.current! : createProjectRecordId();
    let name = reuseExisting ? (projectRecordNameRef.current ?? project.fileName) : '';
    if (!reuseExisting) {
      const prompted = window.prompt(mode === 'save-as' ? 'Save project as' : 'Save project', project.fileName);
      if (prompted === null) return null;
      name = prompted.trim() || project.fileName;
    }

    setProjectSaveBusy(true);
    try {
      const snapshot = await buildCurrentProjectSnapshot();
      if (!snapshot) return null;
      const outcome = await saveProjectRecord({
        ...snapshot,
        id,
        name,
        savedAt: Date.now(),
      });
      if (outcome === 'ok') {
        updateProjectRecordIdentity(id, name);
        pushToast({
          kind: 'success',
          title: 'Project saved',
          detail: `${name} saved to Projects.`,
        });
        return id;
      } else if (outcome === 'quota-exceeded') {
        pushToast({
          kind: 'warning',
          title: "Couldn't save project — browser storage is full.",
          detail: 'Export your zip or delete saved projects to free up space.',
          autoDismiss: false,
        });
      } else {
        pushToast({
          kind: 'warning',
          title: "Couldn't save project.",
          detail: 'Your edits are still in memory. Export your zip to keep them.',
          autoDismiss: false,
        });
      }
      return null;
    } catch (err) {
      pushToast({
        kind: 'warning',
        title: "Couldn't save project.",
        detail: err instanceof Error ? err.message : 'Your edits are still in memory. Export your zip to keep them.',
        autoDismiss: false,
      });
      return null;
    } finally {
      setProjectSaveBusy(false);
    }
  }, [project, projectSaveBusy, buildCurrentProjectSnapshot, pushToast, updateProjectRecordIdentity]);

  const handleSaveProject = useCallback(() => {
    void saveProjectToLibrary('save');
  }, [saveProjectToLibrary]);

  const handleSaveProjectAs = useCallback(() => {
    void saveProjectToLibrary('save-as');
  }, [saveProjectToLibrary]);

  const handleSaveCheckpoint = useCallback(async () => {
    if (!project || checkpointSaveBusy || projectSaveBusy) return;
    setHistoryError(null);

    let projectId = projectRecordIdRef.current;
    if (!projectId) {
      projectId = await saveProjectToLibrary('save');
      if (!projectId) return;
    }

    const defaultLabel = `Checkpoint ${new Date().toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
    const prompted = window.prompt('Checkpoint label', defaultLabel);
    if (prompted === null) return;
    const label = prompted.trim() || defaultLabel;

    setCheckpointSaveBusy(true);
    try {
      const snapshot = await buildCurrentProjectSnapshot();
      if (!snapshot?.mutatedZipBlob) return;
      const checkpoint: Checkpoint = {
        id: createCheckpointId(),
        projectId,
        label,
        savedAt: Date.now(),
        mutatedZipBlob: snapshot.mutatedZipBlob,
        patches: snapshot.patches,
      };
      const outcome = await saveCheckpoint(checkpoint);
      if (outcome === 'ok') {
        await refreshCheckpoints(projectId);
        pushToast({
          kind: 'success',
          title: 'Checkpoint saved',
          detail: `${label} added to History.`,
        });
      } else if (outcome === 'quota-exceeded') {
        setHistoryError("Couldn't save checkpoint — browser storage is full.");
      } else {
        setHistoryError("Couldn't save checkpoint. Your current edits are still in memory.");
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to save checkpoint.');
    } finally {
      setCheckpointSaveBusy(false);
    }
  }, [
    project,
    checkpointSaveBusy,
    projectSaveBusy,
    saveProjectToLibrary,
    buildCurrentProjectSnapshot,
    refreshCheckpoints,
    pushToast,
  ]);

  const handleRequestRestoreCheckpoint = useCallback(async (id: string) => {
    setCheckpointBusyId(`restore:${id}`);
    setHistoryError(null);
    try {
      const checkpoint = await loadCheckpoint(id);
      if (!checkpoint?.mutatedZipBlob) {
        setHistoryError('Checkpoint could not be loaded.');
        return;
      }
      setCheckpointRestoreTarget(checkpoint);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to load checkpoint.');
    } finally {
      setCheckpointBusyId(null);
    }
  }, []);

  const handleCancelRestoreCheckpoint = useCallback(() => {
    setCheckpointRestoreTarget(null);
  }, []);

  const handleConfirmRestoreCheckpoint = useCallback(async () => {
    const checkpoint = checkpointRestoreTarget;
    if (!checkpoint) return;
    setCheckpointRestoreTarget(null);
    setCheckpointBusyId(`restore:${checkpoint.id}`);
    setHistoryError(null);
    try {
      const parent = await loadProjectRecord(checkpoint.projectId);
      if (!parent?.originalZipBlob) {
        setHistoryError('The saved project is missing its original zip, so this checkpoint cannot be restored safely.');
        return;
      }
      const currentSelection = buildCurrentSelection();
      const restoreSelection: PersistedSelection = {
        ...currentSelection,
        selectedDetectionKey: null,
        leftPanelMode: 'history',
      };
      await rehydrateFromBlob(
        checkpoint.mutatedZipBlob,
        parent.originalZipBlob,
        parent.projectMeta ?? {
          fileName: parent.name || 'saved-project.zip',
          totalFiles: 0,
          htmlFiles: 0,
          cssFiles: 0,
          jsFiles: 0,
          imageFiles: 0,
          totalSize: 0,
        },
        persistedPatchesToApplied(checkpoint.patches),
        restoreSelection,
        new Set(restoreSelection.expandedFolders),
      );
      updateProjectRecordIdentity(parent.id, parent.name);
      await refreshCheckpoints(parent.id);
      pushToast({
        kind: 'success',
        title: 'Checkpoint restored',
        detail: `${checkpoint.label} is now the live project state.`,
      });
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to restore checkpoint.');
    } finally {
      setCheckpointBusyId(null);
    }
  }, [
    checkpointRestoreTarget,
    buildCurrentSelection,
    rehydrateFromBlob,
    updateProjectRecordIdentity,
    refreshCheckpoints,
    pushToast,
  ]);

  const handleDeleteCheckpoint = useCallback(async (id: string) => {
    const checkpoint = checkpoints.find((item) => item.id === id);
    if (checkpoint && !window.confirm(`Delete checkpoint "${checkpoint.label}"?`)) return;
    setCheckpointBusyId(`delete:${id}`);
    setHistoryError(null);
    try {
      await deleteCheckpoint(id);
      await refreshCheckpoints(projectRecordIdRef.current);
      if (checkpointRestoreTarget?.id === id) setCheckpointRestoreTarget(null);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : 'Failed to delete checkpoint.');
    } finally {
      setCheckpointBusyId(null);
    }
  }, [checkpoints, checkpointRestoreTarget, refreshCheckpoints]);

  const handleExport = useCallback(async () => {
    if (!project || exportState === 'busy') return;
    setExportState('busy');
    setExportError(null);
    // Capture startedAt once so the TopBar label's elapsed-time keeps
    // ticking monotonic across every onProgress update. Without this,
    // each percent-tick would also reset the visible duration to zero.
    const startedAt = Date.now();
    setBusyPhase({ kind: 'exporting', progress: 0, startedAt });
    try {
      const patches = Array.from(patchesByKey.values());
      const exportResult = project.zip instanceof WorkerZipArchive
        ? await getProjectWorkerClient().buildExport({
          projectId: project.zip.projectId,
          fileName: project.fileName,
          patches,
          detections,
          mutations: await project.zip.snapshotMutations(),
          onProgress: (percent) => {
            setBusyPhase({
              kind: 'exporting',
              progress: percent,
              startedAt,
            });
          },
        })
        : await (await import('./lib/exportService')).buildExport(
          project,
          patches,
          detections,
          {
            onProgress: (metadata) => {
              setBusyPhase({
                kind: 'exporting',
                progress: metadata.percent,
                startedAt,
              });
            },
          },
        );
      const { blob, filename, reportText, fileCount } = exportResult;
      const { downloadBlob } = await import('./lib/exportService');
      downloadBlob(blob, filename);
      const brokenCount = detections.filter((d) => d.status === 'missing').length;
      const remoteCount = detections.filter((d) => d.status === 'remote').length;
      const replacementCount = patches.filter((p) => p.action === 'replace').length;
      const removedCount = patches.filter((p) => p.action === 'remove').length;
      const placeholderCount = patches.filter((p) => p.action === 'placeholder').length;
      setExportSummary({
        filename,
        zipSizeBytes: blob.size,
        replacementCount,
        brokenCount,
        remoteCount,
        fileCount,
        reportText,
        removedCount,
        placeholderCount,
      });
      setExportState('success');
      pushToast({
        kind: 'success',
        title: 'Export complete',
        detail: `${filename} downloaded (${formatBytes(blob.size)}).`,
      });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
      setExportState('error');
    } finally {
      // Always clear the TopBar widget — even on success / error / abort.
      // The export-related state atoms setExportState / setExportError
      // retain their out-of-band semantic independent of this one.
      setBusyPhase({ kind: 'idle' });
    }
  }, [project, exportState, patchesByKey, detections, pushToast]);

  const handleExportAgain = useCallback(() => {
    setExportState('idle');
    setExportSummary(null);
    setExportError(null);
  }, []);

  const handleToggleFolder = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const handleSelectDetection = useCallback((key: string) => {
    setSelectedDetectionKey(key);
    setActiveMobilePane('right');
  }, []);

  /**
   * Centralised navigation: any path change (dropdown, in-iframe link
   * click via the injected navScript, refresh of a stale path) routes
   * through here so history stays consistent. Truncating forward
   * history on a new branch mirrors browser convention: go back, then
   * pick a fresh sibling, and the stale forward entries drop.
   *
   * The ref is updated EAGERLY (before any setState) so a second call
   * landing in the same synchronous tick sees the new path and the
   * early-return fires. Without this, two clicks committing in the
   * same React batch would BOTH pass the early-return (refs only
   * update after the render commit) and double-push `path` to
   * history.
   */
  const navigateToPage = useCallback((path: string) => {
    if (!path || path === currentPagePathRef.current) return;
    currentPagePathRef.current = path;
    setEditorSelection(null);
    setEditorError(null);
    setCurrentPagePath(path);
    setPreviewHistory((prev) => {
      const curIdx = prev.index;
      // Truncate any forward history (we’re branching from the past).
      const truncated = (curIdx >= 0 && curIdx < prev.pages.length - 1)
        ? prev.pages.slice(0, curIdx + 1)
        : prev.pages;
      return { pages: [...truncated, path], index: truncated.length };
    });
    setPreviewKey((k) => k + 1);
  }, []);

  // Mirror the eager-ref pattern used in navigateToPage: by writing the
  // ref synchronously alongside the setState calls, a second navigation
  // call landing in the same tick (e.g. user mashing the back button)
  // sees the updated path and the navigateToPage early-return fires
  // before a duplicate history push could land.
  const handleNavigateBack = useCallback(() => {
    const cur = previewHistoryRef.current;
    if (cur.index <= 0) return;
    const newIndex = cur.index - 1;
    const target = cur.pages[newIndex];
    if (!target) return;
    currentPagePathRef.current = target;
    setCurrentPagePath(target);
    setPreviewHistory({ pages: cur.pages, index: newIndex });
    setPreviewKey((k) => k + 1);
  }, []);

  const handleNavigateForward = useCallback(() => {
    const cur = previewHistoryRef.current;
    if (cur.index >= cur.pages.length - 1) return;
    const newIndex = cur.index + 1;
    const target = cur.pages[newIndex];
    if (!target) return;
    currentPagePathRef.current = target;
    setCurrentPagePath(target);
    setPreviewHistory({ pages: cur.pages, index: newIndex });
    setPreviewKey((k) => k + 1);
  }, []);

  // Alt+←/→ step through preview page history. These shortcuts are
  // advertised in the toolbar tooltips, so wire them globally here.
  // Ignored while typing in a field or when the project has no pages.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) {
        return;
      }
      if (!previewRef.current || previewRef.current.htmlPaths.length === 0) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') handleNavigateBack();
      else handleNavigateForward();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleNavigateBack, handleNavigateForward]);

  const handleChangeViewport = useCallback((vp: PreviewViewport) => {
    setPreviewViewport(vp);
  }, []);

  const handleChangeZoom = useCallback((z: number) => {
    // Clamp to a sane range so an outlier value can’t disable the
    // preview (defensive — the dropdown only offers ZOOM_PRESETS).
    if (!Number.isFinite(z)) return;
    const clamped = Math.min(2, Math.max(0.25, z));
    setPreviewZoom(clamped);
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    setPreviewFullscreen((v) => !v);
  }, []);

  const handleExitFullscreen = useCallback(() => {
    setPreviewFullscreen(false);
  }, []);

  const handleChangePreviewMode = useCallback((mode: PreviewMode) => {
    setPreviewMode(mode);
    setEditorError(null);
    if (mode === 'preview') {
      setEditorSelection(null);
    }
  }, []);

  /**
   * Pop the current page out into a real browser window. The blob URL
   * stays valid as long as this tab is alive (the blob is owned by
   * this document; the popup inherits the same browsing context group).
   * `noopener,noreferrer` strips the opener reference so the popup
   * can’t reach back into the editor via `window.opener`.
   */
  const handleOpenInNewTab = useCallback(() => {
    const index = previewRef.current;
    if (!index) return;
    const cur = currentPagePathRef.current;
    const target = (cur && index.urls.get(cur)) || index.primaryUrl;
    if (!target) return;
    window.open(target, '_blank', 'noopener,noreferrer');
  }, []);

  const handleRefreshPreview = useCallback(() => {
    setPreviewKey((k) => k + 1);
  }, []);

  const handlePickReplacementFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      setReplacementError(
        `"${file.name}" isn't an image. Only image files (PNG, JPG, WebP, GIF, SVG) can be used as replacements.`,
      );
      return;
    }
    setReplacementError(null);
    setPendingFile(file);
  }, []);

  const handleCancelReplacement = useCallback(() => {
    setPendingFile(null);
    setReplacementError(null);
  }, []);

  const handleToggleWebpReencode = useCallback((next: boolean) => {
    setWebpReencode(next);
  }, []);

  const handleApplyReplacement = useCallback(async () => {
    if (replacementBusy || bulkBusy) return;
    if (!project || !pendingFile || !selectedDetection) return;
    setReplacementBusy(true);
    setReplacementError(null);
    try {
      // OPTIONAL WebP re-encode. We honour `webpReencode` only if the
      // user opted in AND the source is a PNG/JPEG (the only supported
      // types per imageReencoder.ts). On fallback we keep the original
      // bytes — the surfacing is in replacementError text when applicable
      // but we DON'T block the apply: a "didn't re-encode" outcome is not
      // a hard error, just a diagnostic.
      let workingBytes: Uint8Array;
      let workingName: string;
      let reencoded = false;
      let fallbackNote: string | null = null;
      if (webpReencode) {
        const { reencodeToWebP, rewriteExtensionToWebp } = await import('./lib/imageReencoder');
        const result = await reencodeToWebP(pendingFile);
        if (result.reencoded) {
          workingBytes = await blobToBytes(result.blob);
          workingName = rewriteExtensionToWebp(pendingFile.name);
          reencoded = true;
        } else {
          workingBytes = await blobToBytes(result.blob);
          workingName = pendingFile.name;
          fallbackNote = result.fallbackReason ?? 're-encode skipped';
        }
      } else {
        workingBytes = new Uint8Array(await pendingFile.arrayBuffer());
        workingName = pendingFile.name;
      }

      const id = `${selectedDetection.sourceFile}::${selectedDetection.sourceTag}::${selectedDetection.sourceAttr}::${selectedDetection.rawUrl}`;
      const prev = patchesByKey.get(id);
      const prevSourceValue = prev?.action === 'replace' ? prev.currentSourceValue : undefined;

      const patch = await applyReplacement(project, selectedDetection, {
        bytes: workingBytes,
        filename: workingName,
        reencoded,
        previousSourceValue: prevSourceValue,
      });

      setPatchesByKey((map) => {
        const next = new Map(map);
        next.set(patch.id, patch);
        return next;
      });
      setPendingFile(null);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
      if (fallbackNote) {
        setReplacementError(`Re-encode skipped: ${fallbackNote}. Original bytes used.`);
      }
      if (reencoded) {
        // Positive feedback surface. We only push on the success branch
        // (re-encoded bytes actually landed). Fallback is surfaced
        // inline via the existing `replacementError` slot, so the user
        // sees one message per event — not two.
        const originalSize = pendingFile.size;
        const newSize = workingBytes.byteLength;
        // Clamp at 99% — a 100% reading would imply zero-byte savings,
        // which contradicts `result.reencoded === true` (the lib's
        // shrinkage gate already guarantees newSize < originalSize).
        const savedPct = Math.max(1, Math.min(99, Math.round((1 - newSize / originalSize) * 100)));
        pushToast({
          kind: 'success',
          title: `Saved ${savedPct}% on disk`,
          detail: `${workingName} · ${formatBytes(originalSize)} → ${formatBytes(newSize)}`,
        });
      }
    } catch (err) {
      setReplacementError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplacementBusy(false);
    }
  }, [replacementBusy, bulkBusy, project, pendingFile, selectedDetection, patchesByKey, webpReencode]);

  // ------------------------------------------------------------------------
  // Undo / Reset handlers
  // ------------------------------------------------------------------------

  /** TOPOLOGICAL-CORRECT per-row undo. Walks every per-detection patch
   *  (NOT manual-replace) whose `sourceFile` matches the named patch AND
   *  whose `appliedAt >= patch.appliedAt`. We sort DESC by appliedAt and
   *  call undoPatchById on each. This guarantees the file lands back
   *  in its pre-X state even after a later fit-style / replace / remove
   *  / placeholder patched the same sourceFile.
   *
   *  Manual-replace patches don't participate in this cascade: their
   *  pre-state is the modifiedFiles[] snapshot (per-file), and rolling
   *  one back should not silently wipe unrelated manual text edits that
   *  just happen to share the same sourceFile.
   */
  const handleUndoPatchById = useCallback((patchId: string) => {
    if (!project) return;
    const target = patchesByKey.get(patchId);
    if (!target) return;
    // Manual-replace: single atomic undo.
    if (target.action === 'manual-replace') {
      try {
        undoManualReplace(project, target);
        setPatchesByKey((map) => {
          const next = new Map(map);
          next.delete(patchId);
          return next;
        });
        setHistoryError(null);
        setPreviewRevision((r) => r + 1);
        setPreviewKey((k) => k + 1);
        setExportState('idle');
        setExportSummary(null);
        setExportError(null);
      } catch (err) {
        setHistoryError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    // Compute the cascade window.
    //
    // PREVIOUSLY this filter dropped every manual-replace patch up-front,
    // which silently corrupted state: if a manual-replace patch M had been
    // applied AFTER the target patch T on the same sourceFile, per-row
    // undo of T would write T's previousSourceText over the live file,
    // wiping M's edits — but M remained in patchesByKey with stale text.
    //
    // The corrected cascade INCLUDES manual-replace patches whose
    // modifiedFiles[] touches target.sourceFile AND applied AFTER target.
    // Each cascade entry's own previousSourceText was captured at apply
    // against the file's state-as-it-then-stood — so reverting in DESC
    // appliedAt order returns the file to its pre-T state.
    const touchesTargetSourceFile = (p: AppliedPatch): boolean => {
      if (p.action === 'manual-replace') {
        return Array.isArray(p.modifiedFiles)
          && p.modifiedFiles.some((m) => m.path === target.sourceFile);
      }
      return p.sourceFile === target.sourceFile;
    };
    const cascade = Array.from(patchesByKey.values())
      .filter((p) => touchesTargetSourceFile(p) && p.appliedAt >= target.appliedAt)
      .sort((a, b) => b.appliedAt - a.appliedAt);
    try {
      for (const p of cascade) undoPatchById(project, p);
      setPatchesByKey((map) => {
        const next = new Map(map);
        for (const p of cascade) next.delete(p.id);
        return next;
      });
      setHistoryError(null);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    }
  }, [project, patchesByKey]);

  const handleUndoLastChange = useCallback(() => {
    if (!project || patchesByKey.size === 0) return;
    let latest: AppliedPatch | null = null;
    for (const p of patchesByKey.values()) {
      if (!latest || p.appliedAt > latest.appliedAt) latest = p;
    }
    if (latest) handleUndoPatchById(latest.id);
  }, [project, patchesByKey, handleUndoPatchById]);

  /** Walk every patch in DESC appliedAt order and reverse-undo it. This
   *  is the "Undo All" affordance — topologically safe because each
   *  patch's `previousSourceText` was captured at apply time. */
  const handleUndoAll = useCallback(() => {
    if (!project || patchesByKey.size === 0) return;
    const sorted = Array.from(patchesByKey.values()).sort((a, b) => b.appliedAt - a.appliedAt);
    try {
      for (const p of sorted) undoPatchById(project, p);
      setPatchesByKey(new Map());
      setHistoryError(null);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    }
  }, [project, patchesByKey]);

  const handleRequestUndoAll = useCallback(() => {
    if (patchesByKey.size === 0) return;
    setUndoAllConfirmOpen(true);
  }, [patchesByKey.size]);

  const handleCancelUndoAll = useCallback(() => {
    setUndoAllConfirmOpen(false);
  }, []);

  const handleConfirmUndoAll = useCallback(() => {
    setUndoAllConfirmOpen(false);
    handleUndoAll();
  }, [handleUndoAll]);

  const handleResetSelectedImage = useCallback(() => {
    if (!project || !selectedDetection) return;
    const baseId = `${selectedDetection.sourceFile}::${selectedDetection.sourceTag}::${selectedDetection.sourceAttr}::${selectedDetection.rawUrl}`;
    // Reset only the per-detection patches (replace / fit-style / remove
    // / placeholder) for THIS detection; manual-replace patches (which
    // target text selected by user search, not by detection position)
    // don't participate unless they happened to touch the same sourceFile.
    // handleUndoPatchById handles the manual-replace case with the same
    // cascade logic, so users who want to undo them should reach for
    // that path or "Undo Last Change".
    const related = Array.from(patchesByKey.values())
      .filter((p) => p.action !== 'manual-replace' && p.action !== 'editor-edit' && p.action !== 'editor-reorder')
      .filter((p) => p.id === baseId || p.id.startsWith(baseId + '#'))
      .sort((a, b) => b.appliedAt - a.appliedAt);
    if (related.length === 0) {
      setHistoryError('No patches to reset for the selected image.');
      return;
    }
    try {
      for (const p of related) undoPatchById(project, p);
      setPatchesByKey((map) => {
        const next = new Map(map);
        for (const p of related) next.delete(p.id);
        return next;
      });
      setHistoryError(null);
      setSelectedDetectionKey(null);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    }
  }, [project, selectedDetection, patchesByKey]);

  const handleResetProject = useCallback(() => {
    if (!originalFile) {
      setHistoryError('No original zip is remembered for this session.');
      return;
    }
    setResetConfirmOpen(true);
  }, [originalFile]);

  const handleCancelResetProject = useCallback(() => {
    setResetConfirmOpen(false);
  }, []);

  const handleConfirmResetProject = useCallback(() => {
    if (!originalFile) {
      setResetConfirmOpen(false);
      setHistoryError('No original zip is remembered for this session.');
      return;
    }
    setResetConfirmOpen(false);
    void handleUpload(originalFile);
    setHistoryError(null);
    setLeftPanelMode('images');
    setPatchesByKey(new Map());
    setBulkPendingFile(null);
    setBulkConfirm(null);
  }, [originalFile, handleUpload]);

  const handleReplaceAgain = useCallback(() => {
    const ref = selectedDetection ?? (selectedAppliedPatch as AppliedPatch | null);
    if (ref && !('action' in ref && (ref.action === 'manual-replace' || ref.action === 'editor-edit' || ref.action === 'editor-reorder'))) {
      const refAsDetection = ref as Exclude<typeof ref, Extract<typeof ref, { action: 'manual-replace' | 'editor-edit' | 'editor-reorder' }>>;
      const id = `${refAsDetection.sourceFile}::${refAsDetection.sourceTag}::${refAsDetection.sourceAttr}::${refAsDetection.rawUrl}`;
      handleUndoPatchById(id);
      handleUndoPatchById(`${id}#fit`);
      setSelectedDetectionKey(null);
    }
    setPendingFile(null);
    setReplacementError(null);
    setBrokenError(null);
    setFitStyleError(null);
  }, [selectedDetection, selectedAppliedPatch, handleUndoPatchById]);

  const handleCancelBrokenAction = useCallback(() => {
    setBrokenError(null);
  }, []);

  const handleApplyBrokenAction = useCallback(async (action: 'remove' | 'placeholder') => {
    if (brokenBusy) return;
    if (!project || !selectedDetection) return;
    setBrokenBusy(true);
    setBrokenError(null);
    try {
      const id = `${selectedDetection.sourceFile}::${selectedDetection.sourceTag}::${selectedDetection.sourceAttr}::${selectedDetection.rawUrl}`;
      const patch = action === 'remove'
        ? await applyRemove(project, selectedDetection)
        : await applyPlaceholder(project, selectedDetection);
      setPatchesByKey((map) => {
        const next = new Map(map);
        next.set(id, patch);
        return next;
      });
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
    } catch (err) {
      setBrokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrokenBusy(false);
    }
  }, [brokenBusy, project, selectedDetection, patchesByKey]);

  // ------------------------------------------------------------------------
  // Fit & style
  // ------------------------------------------------------------------------

  const handleApplyFitStyle = useCallback(async (config: ImageFitConfig) => {
    if (fitStyleBusy) return;
    if (!project || !selectedDetection) return;
    setFitStyleBusy(true);
    setFitStyleError(null);
    try {
      const zipFile = project.zip.file(selectedDetection.sourceFile);
      if (!zipFile) throw new Error(`Source file "${selectedDetection.sourceFile}" not found in archive.`);
      const sourceText = await zipFile.async('text');
      const result = selectedDetection.sourceKind === 'css'
        ? applyFitStyleToCss(sourceText, selectedDetection, config)
        : applyFitStyleToImg(sourceText, selectedDetection, config);
      if (!result.changed) {
        throw new Error('Could not find the URL in the source file. Was the file already modified?');
      }
      project.zip.file(selectedDetection.sourceFile, result.sourceText);

      const id = `${selectedDetection.sourceFile}::${selectedDetection.sourceTag}::${selectedDetection.sourceAttr}::${selectedDetection.rawUrl}`;
      const fitKey = `${id}#fit`;
      const patch: AppliedPatch = {
        id: fitKey,
        sourceFile: selectedDetection.sourceFile,
        sourceKind: selectedDetection.sourceKind,
        sourceTag: selectedDetection.sourceTag,
        sourceAttr: selectedDetection.sourceAttr,
        rawUrl: selectedDetection.rawUrl,
        action: 'fit-style',
        config,
        generatedCss: result.generatedCss,
        appliedAt: Date.now(),
        previousSourceText: sourceText,
        currentSourceText: result.sourceText,
      };
      setPatchesByKey((map) => {
        const next = new Map(map);
        next.set(fitKey, patch);
        return next;
      });
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
    } catch (err) {
      setFitStyleError(err instanceof Error ? err.message : String(err));
    } finally {
      setFitStyleBusy(false);
    }
  }, [fitStyleBusy, project, selectedDetection]);

  const handleResetFitStyle = useCallback(() => {
    if (!selectedDetection) return;
    const id = `${selectedDetection.sourceFile}::${selectedDetection.sourceTag}::${selectedDetection.sourceAttr}::${selectedDetection.rawUrl}`;
    handleUndoPatchById(`${id}#fit`);
  }, [selectedDetection, handleUndoPatchById]);

  // ------------------------------------------------------------------------
  // Logo Helper
  // ------------------------------------------------------------------------

  const handlePickLogoFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      setLogoHelperError(`"${file.name}" isn't an image. Only image files (PNG, JPG, WebP, SVG, GIF) can be used as a logo.`);
      return;
    }
    setLogoHelperError(null);
    setLogoHelperSuccess(null);
  }, []);

  const handleClearLogoFile = useCallback(() => {
    setLogoHelperError(null);
  }, []);

  const handleApplyLogoHelper = useCallback(async (config: LogoHelperConfig, file: File) => {
    if (!project || logoHelperBusy) return;
    setLogoHelperBusy(true);
    setLogoHelperError(null);
    try {
      const { patches } = await applyLogoHelper(project, logoCandidates, file, config);
      if (patches.length === 0) {
        throw new Error('No changes were applied. Check that selected targets exist in this project.');
      }
      setPatchesByKey((map) => {
        const next = new Map(map);
        for (const patch of patches) next.set(patch.id, patch);
        return next;
      });
      const textInjected = patches.some(
        (p) => p.action === 'replace' && (p.injectedTextBlock?.startsWith('<span') === true),
      );
      setLogoHelperSuccess({
        appliedAt: patches[0].appliedAt,
        targets: Array.from(config.targets),
        headerMode: config.headerMode,
        businessName: config.businessName.trim(),
        patchCount: patches.length,
        filesTouched: Array.from(new Set(patches.flatMap((p) => p.action !== 'manual-replace' ? [p.sourceFile] : []))),
        textInjected,
      });
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
    } catch (err) {
      setLogoHelperError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogoHelperBusy(false);
    }
  }, [project, logoHelperBusy, logoCandidates]);

  const handleResetLogoHelperSuccess = useCallback(() => {
    setLogoHelperSuccess(null);
    setLogoHelperError(null);
  }, []);

  const handleSetLeftPanelMode = useCallback((m: LeftPanelMode) => {
    setLeftPanelMode(m);
  }, []);

  // ------------------------------------------------------------------------
  // Manual Replace
  // ------------------------------------------------------------------------

  const handleApplyManualReplace = useCallback(async (input: {
    scope: string;
    searchText: string;
    replacementText: string;
    replaceAll: boolean;
    imageFile: File | null;
    customAssetFilename: string;
  }) => {
    if (!project || manualReplaceBusy) return;
    setManualReplaceBusy(true);
    setManualReplaceError(null);
    try {
      const { patch } = await applyManualReplace(project, input);
      setPatchesByKey((map) => {
        const next = new Map(map);
        next.set(patch.id, patch);
        return next;
      });
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
    } catch (err) {
      setManualReplaceError(err instanceof Error ? err.message : String(err));
    } finally {
      setManualReplaceBusy(false);
    }
  }, [project, manualReplaceBusy]);

  const handleUndoManualReplace = useCallback((patchId: string) => {
    if (!project) return;
    const patch = patchesByKey.get(patchId);
    if (!patch || patch.action !== 'manual-replace') return;
    try {
      undoManualReplace(project, patch);
      setPatchesByKey((map) => {
        const next = new Map(map);
        next.delete(patchId);
        return next;
      });
      setManualReplaceError(null);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
    } catch (err) {
      setManualReplaceError(err instanceof Error ? err.message : String(err));
    }
  }, [project, patchesByKey]);

  const handleApplyPreviewTextEdit = useCallback(async (input: {
    sourceFile: string;
    oldText: string;
    newText: string;
    tagName?: string;
    label?: string;
    sourceStart?: number;
    sourceEnd?: number;
    selectorHint?: string;
  }) => {
    if (!project) return;
    const oldText = input.oldText.trim();
    const newText = input.newText.trim();
    if (!oldText || !newText || oldText === newText) return;
    if (!project.entries.some((entry) => !entry.isDirectory && entry.path === input.sourceFile)) return;
    setManualReplaceError(null);
    try {
      const patch = input.tagName
        ? await applyEditorEdit(project, {
          selection: {
            sourceFile: input.sourceFile,
            kind: 'text',
            tagName: input.tagName,
            label: input.label ?? oldText,
            text: oldText,
            sourceStart: input.sourceStart,
            sourceEnd: input.sourceEnd,
            selectorHint: input.selectorHint,
          },
          edits: [{ field: 'text', oldValue: oldText, newValue: newText }],
        })
        : (await applyManualReplace(project, {
          scope: input.sourceFile,
          searchText: oldText,
          replacementText: newText,
          replaceAll: false,
          imageFile: null,
          customAssetFilename: '',
        })).patch;
      setPatchesByKey((map) => {
        const next = new Map(map);
        next.set(patch.id, patch);
        return next;
      });
      setEditorSelection((current) => current?.sourceFile === input.sourceFile && current.kind === 'text'
        ? { ...current, text: newText, label: newText }
        : current);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
      pushToast({
        kind: 'success',
        title: 'Preview text updated',
        detail: `${input.sourceFile} changed and is ready to export.`,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setManualReplaceError(detail);
      setPreviewKey((k) => k + 1);
      pushToast({
        kind: 'warning',
        title: "Couldn't save preview text edit",
        detail,
      });
    }
  }, [project, pushToast]);

  const handleClearEditorSelection = useCallback(() => {
    setEditorSelection(null);
    setEditorError(null);
  }, []);

  const handleApplyEditorText = useCallback(async (newText: string) => {
    if (!project || editorBusy || !editorSelection || editorSelection.kind !== 'text') return;
    const oldText = (editorSelection.text ?? '').trim();
    const replacementText = newText.trim();
    if (!oldText || !replacementText || oldText === replacementText) return;
    setEditorBusy(true);
    setEditorError(null);
    try {
      const patch = await applyEditorEdit(project, {
        selection: editorSelection,
        edits: [{ field: 'text', oldValue: oldText, newValue: replacementText }],
      });
      setPatchesByKey((map) => {
        const next = new Map(map);
        next.set(patch.id, patch);
        return next;
      });
      setEditorSelection((current) => current && current.kind === 'text'
        ? { ...current, text: replacementText, label: replacementText }
        : current);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
      pushToast({
        kind: 'success',
        title: 'Editor text updated',
        detail: `${editorSelection.sourceFile} changed and is ready to export.`,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setEditorError(detail);
      pushToast({
        kind: 'warning',
        title: "Couldn't apply editor text change",
        detail,
      });
    } finally {
      setEditorBusy(false);
    }
  }, [project, editorBusy, editorSelection, pushToast]);

  const handleApplyEditorField = useCallback(async (field: Exclude<EditorEditField, 'text'>, value: string) => {
    if (!project || editorBusy || !editorSelection) return;
    if (field === 'src' && editorSelection.kind !== 'image') return;
    if (field === 'alt' && editorSelection.kind !== 'image') return;
    if ((field === 'src' || field === 'href') && value.trim().length === 0) return;
    const nextValue = value.trim();
    const currentValue = editorFieldValue(editorSelection, field).trim();
    if (nextValue === currentValue) return;
    setEditorBusy(true);
    setEditorError(null);
    try {
      const patch = await applyEditorEdit(project, {
        selection: editorSelection,
        edits: [{ field, oldValue: currentValue, newValue: nextValue }],
      });
      setPatchesByKey((map) => {
        const next = new Map(map);
        next.set(patch.id, patch);
        return next;
      });
      setEditorSelection((current) => updateEditorSelectionField(current, field, nextValue));
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
      pushToast({
        kind: 'success',
        title: `Editor ${editorFieldLabel(field)} updated`,
        detail: `${editorSelection.sourceFile} changed and is ready to export.`,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setEditorError(detail);
      pushToast({
        kind: 'warning',
        title: `Couldn't update editor ${editorFieldLabel(field)}`,
        detail,
      });
    } finally {
      setEditorBusy(false);
    }
  }, [project, editorBusy, editorSelection, pushToast]);

  const handleApplyEditorImageFile = useCallback(async (file: File) => {
    if (!project || editorBusy || !editorSelection || editorSelection.kind !== 'image') return;
    if (!file.type.startsWith('image/')) {
      setEditorError(`"${file.name}" isn't an image. Choose a PNG, JPG, WebP, GIF, SVG, AVIF, BMP, or icon file.`);
      return;
    }
    const rawUrl = (editorSelection.src ?? '').trim();
    if (!rawUrl) {
      setEditorError('Selected image does not expose a source URL that can be replaced.');
      return;
    }
    setEditorBusy(true);
    setEditorError(null);
    try {
      const resolved = resolveAgainst(editorSelection.sourceFile, rawUrl);
      const detection: ImageDetection = {
        rawUrl,
        resolvedPath: resolved.resolvedPath ?? '',
        type: 'unknown',
        status: resolved.isRemote ? 'remote' : (resolved.resolvedPath ? 'ok' : 'missing'),
        sourceKind: 'html',
        sourceFile: editorSelection.sourceFile,
        sourceTag: 'img',
        sourceAttr: 'src',
      };
      const id = `${detection.sourceFile}::${detection.sourceTag}::${detection.sourceAttr}::${detection.rawUrl}`;
      const prev = patchesByKey.get(id);
      const prevSourceValue = prev?.action === 'replace' ? prev.currentSourceValue : undefined;
      const patch = await applyReplacement(project, detection, file, prevSourceValue);
      setPatchesByKey((map) => {
        const next = new Map(map);
        next.set(patch.id, patch);
        return next;
      });
      setEditorSelection((current) => current && current.kind === 'image'
        ? { ...current, src: patch.currentSourceValue, label: current.alt || file.name }
        : current);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
      pushToast({
        kind: 'success',
        title: 'Editor image replaced',
        detail: `${file.name} was copied into the project zip.`,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setEditorError(detail);
      pushToast({
        kind: 'warning',
        title: "Couldn't replace selected image",
        detail,
      });
    } finally {
      setEditorBusy(false);
    }
  }, [project, editorBusy, editorSelection, patchesByKey, pushToast]);

  const handleApplyEditorReorder = useCallback(async (
    selection: EditorSelection,
    reference: EditorReorderTarget,
    placement: 'before' | 'after',
  ) => {
    if (!project || editorBusy) return;
    if (!project.entries.some((entry) => !entry.isDirectory && entry.path === selection.sourceFile)) return;
    setEditorBusy(true);
    setEditorError(null);
    try {
      const patch = await applyEditorReorder(project, {
        selection,
        reference,
        placement,
      });
      setPatchesByKey((map) => {
        const next = new Map(map);
        next.set(patch.id, patch);
        return next;
      });
      setEditorSelection(null);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      setExportState('idle');
      setExportSummary(null);
      setExportError(null);
      pushToast({
        kind: 'success',
        title: 'Editor element reordered',
        detail: `${selection.sourceFile} changed and is ready to export.`,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setEditorError(detail);
      setPreviewKey((k) => k + 1);
      pushToast({
        kind: 'warning',
        title: "Couldn't reorder selected element",
        detail,
      });
    } finally {
      setEditorBusy(false);
    }
  }, [project, editorBusy, pushToast]);

  const handleMoveEditorSelection = useCallback((
    placement: 'before' | 'after',
    reference: EditorReorderTarget,
  ) => {
    if (!editorSelection) return;
    void handleApplyEditorReorder(editorSelection, reference, placement);
  }, [editorSelection, handleApplyEditorReorder]);

  // ------------------------------------------------------------------------
  // Bulk replace handlers
  // ------------------------------------------------------------------------

  const handlePickBulkFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      setHistoryError(`"${file.name}" isn't an image. Bulk replace needs an image file.`);
      return;
    }
    setBulkPendingFile(file);
    setHistoryError(null);
  }, []);

  const handleClearBulkFile = useCallback(() => {
    setBulkPendingFile(null);
    setBulkConfirm(null);
  }, []);

  const handleSetBulkFolder = useCallback((dir: string) => {
    setBulkFolder(dir);
  }, []);

  const handleAskBulkConfirm = useCallback(() => {
    if (!project || !bulkPendingFile || scopedDetections.length === 0) return;
    setBulkConfirm({
      dir: bulkFolder,
      fileName: bulkPendingFile.name,
      detectionCount: scopedDetections.length,
      preview: scopedDetections.slice(0, 8).map((d) => ({
        key: `${d.sourceFile}|${d.rawUrl}`,
        rawUrl: d.rawUrl,
        sourceFile: d.sourceFile,
      })),
    });
  }, [project, bulkPendingFile, scopedDetections, bulkFolder]);

  const handleCancelBulkConfirm = useCallback(() => {
    setBulkConfirm(null);
  }, []);

  const handleRunBulkConfirm = useCallback(async () => {
    if (!project || !bulkPendingFile || scopedDetections.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkConfirm(null);
    setHistoryError(null);
    // Capture the total up-front so the TopBar widget shows "replacing
    // 0/16 → hero.png" immediately — without the loop starting. Updates
    // get fed via `onProgress` below.
    const total = scopedDetections.length;
    const fileName = bulkPendingFile.name;
    setBusyPhase({ kind: 'bulk-replacing', done: 0, total, fileName });
    try {
      const result = await bulkReplace({
        project,
        detections: scopedDetections,
        replacement: bulkPendingFile,
        // Per-detection asset filename gets a -N suffix automatically; we
        // also append the asset path to the same buffer.
        nameForAsset: (_det, idx) => {
          const safe = bulkPendingFile.name.replace(/\.[^./]+$/, '') || 'asset';
          const ext = bulkPendingFile.name.match(/\.[^./]+$/)?.[0] || '';
          return `${safe}-${idx + 1}${ext}`;
        },
        onProgress: (done, reportedTotal) => {
          setBusyPhase({
            kind: 'bulk-replacing',
            done,
            total: reportedTotal,
            fileName,
          });
        },
      });
      if (result.kind === 'done') {
        setPatchesByKey((map) => {
          const next = new Map(map);
          for (const p of result.patches) next.set(p.id, p);
          return next;
        });
        setBulkPendingFile(null);
        setPreviewRevision((r) => r + 1);
        setPreviewKey((k) => k + 1);
        setExportState('idle');
        setExportSummary(null);
        setExportError(null);
      } else if (result.kind === 'rolled-back') {
        // partial state was already undone by the bulkReplace lib; the
        // success-path branches above kept us narrow on `result.kind`
        // so this branch is known to carry failedAt / error /
        // rolledBackFromPatchIds.
        const failedDetection = result.failedAt;
        setHistoryError(
          `Bulk replace rolled back after failing on ${failedDetection.rawUrl} (in ${failedDetection.sourceFile}): ${result.error}. ${result.rolledBackFromPatchIds.length} earlier patches were undone.`,
        );
        setBulkPendingFile(null);
        setPreviewRevision((r) => r + 1);
        setPreviewKey((k) => k + 1);
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
      // Always clear the TopBar widget — even on rollback / thrown error.
      // The bulkReplace lib handles the per-file rewind internally; this
      // is purely the UI's bookkeeping.
      setBusyPhase({ kind: 'idle' });
    }
  }, [project, bulkPendingFile, scopedDetections, bulkBusy]);

  // ------------------------------------------------------------------------
  // Project reload / wipe
  // ------------------------------------------------------------------------

  const handleReload = useCallback(() => {
    activeOnboardingRef.current?.controller.abort();
    activeOnboardingRef.current = null;
    releaseWorkerProject();
    updateProjectRecordIdentity(null, null);
    setCheckpoints([]);
    setCheckpointsLoading(false);
    setCheckpointSaveBusy(false);
    setCheckpointBusyId(null);
    setCheckpointRestoreTarget(null);
    setProject(null);
    setOriginalFile(null);
    setOriginalBlob(null);
    originalBlobRef.current = null;
    setSelectedPath(null);
    setSelectedDetectionKey(null);
    setDetections([]);
    setLogoCandidates([]);
    setThumbnails(new Map());
    setPreview(null);
    setCurrentPagePath('');
    setExpanded(new Set());
    setError(null);
    setPatchesByKey(new Map());
    setPendingFile(null);
    setReplacementError(null);
    setBrokenError(null);
    setLogoHelperError(null);
    setLogoHelperSuccess(null);
    setFitStyleError(null);
    setManualReplaceError(null);
    setHistoryError(null);
    setLeftPanelMode('images');
    setPreviewRevision(0);
    setExportState('idle');
    setExportSummary(null);
    setExportError(null);
    setBulkFolder('__all__');
    setBulkPendingFile(null);
    setBulkConfirm(null);
    setResetConfirmOpen(false);
    setUndoAllConfirmOpen(false);
    setRestoreBanner(null);
    setIsLoading(false);
    setRestoring(false);
    setScanning(false);
    setLogoScanning(false);
    setBusyPhase(IDLE_PHASE);
    // Tool-bar state is also cleared so the next project starts from
    // a known baseline rather than inheriting tooling choices from
    // the previous archive.
    setPreviewHistory({ pages: [], index: -1 });
    setPreviewFullscreen(false);
    setPreviewMode('preview');
    setEditorSelection(null);
    setEditorBusy(false);
    setEditorError(null);
    setActiveMobilePane('left');
    setRightDrawerOpen(false);
    // Viewport / zoom are user preferences, kept across reloads so
    // sticky workflows (e.g. "always preview at tablet width") keep
    // working without re-toggling.
    restoreMutatedZipArrayRef.current = null;
    void clearSession();
  }, [releaseWorkerProject, updateProjectRecordIdentity]);

  // ------------------------------------------------------------------------
  // Persistence effects (debounced saveSession + on-boot loadSession)
  // ------------------------------------------------------------------------

  // On boot: load any persisted session and surface the restore banner.
  // Empty `[]` deps so this runs once per app load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const snapshot = await loadSession();
      if (cancelled || !snapshot) return;
      if (isPersistedTheme(snapshot.theme)) setTheme(snapshot.theme);
      if (!snapshot.mutatedZipBlob) return;
      const banner: RestoreBanner = {
        meta: snapshot.projectMeta ?? {
          fileName: 'previous-session.zip',
          totalFiles: 0,
          htmlFiles: 0,
          cssFiles: 0,
          jsFiles: 0,
          imageFiles: 0,
          totalSize: 0,
        },
        selection: snapshot.selection,
        patchCount: snapshot.patches.length,
        mutatedZipBlob: snapshot.mutatedZipBlob,
        originalZipBlob: snapshot.originalZipBlob,
      };
      restoreMutatedZipArrayRef.current = snapshot.patches;
      setRestoreBanner(banner);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return () => releaseWorkerProject();
  }, [releaseWorkerProject]);

  // Debounced save: only when we have an actual project (otherwise the
  // banner-load effect would fire on first render with no data and pull
  // a stale entry back).
  useEffect(() => {
    if (!project) {
      markSessionSaveOk();
      return;
    }
    const handle = window.setTimeout(async () => {
      try {
        const snapshot = await buildCurrentProjectSnapshot();
        if (!snapshot) return;
        const saveOutcome = await saveSession(snapshot);
        if (saveOutcome === 'ok') {
          markSessionSaveOk();
        } else {
          markSessionSaveFailed();
        }
      } catch {
        markSessionSaveFailed();
      }
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [project, buildCurrentProjectSnapshot, markSessionSaveOk, markSessionSaveFailed]);

  // ------------------------------------------------------------------------
  // Preview / thumbnails effects
  // ------------------------------------------------------------------------

  // Reaper for the Toast viewport. A single 250 ms interval walks the
  // current toast list and drops any whose `expiresAt` is in the past.
  // Returning the same array from the setter when nothing changed is
  // the documented React trick to skip the resulting re-render; we lean
  // on it so an empty viewport doesn't tick forever.
  useEffect(() => {
    const handle = window.setInterval(() => {
      const now = Date.now();
      setToasts((prev) => {
        const filtered = prev.filter((t) => t.expiresAt === null || t.expiresAt > now);
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 250);
    return () => window.clearInterval(handle);
  }, []);

  useEffect(() => {
    const createdUrls: string[] = [];
    let cancelled = false;
    if (!project) {
      setPreview(null);
      setCurrentPagePath('');
      setPreviewBuilding(false);
      setPreviewHistory({ pages: [], index: -1 });
      return;
    }
    setPreviewBuilding(true);
    setPreview(null);
    // Don't reset currentPagePath eagerly — the awaited rebuild
    // below reconciliates whether the previously-active page still
    // exists in the regenerated index and, if it does, preserves
    // BOTH the path and the history stack (otherwise every edit
    // would dump the user's navigation breadcrumbs).
    (async () => {
      const index = await buildPreview(project, liveEntries);
      if (cancelled) return;
      for (const url of index.urls.values()) createdUrls.push(url);
      setPreview(index);
      setCurrentPagePath((cur) => {
        if (cur && index.urls.has(cur)) return cur;
        return index.primaryPath;
      });
      setPreviewHistory((prev) => {
        const cur = currentPagePathRef.current;
        const stillExists = !!cur && index.urls.has(cur);
        if (stillExists && prev.pages.length > 0 && prev.pages.includes(cur as string)) {
          // Keep the stack; snap `index` to wherever `cur` lives now.
          return { pages: prev.pages, index: prev.pages.indexOf(cur as string) };
        }
        // Page was renamed / removed OR this is the initial load —
        // reset history to a single-entry stack anchored on the live
        // page (initial load: primaryPath; after a rename: primary).
        const nextPath = stillExists ? (cur as string) : index.primaryPath;
        if (!nextPath) return { pages: [], index: -1 };
        return { pages: [nextPath], index: 0 };
      });
      setPreviewBuilding(false);
    })();
    return () => {
      cancelled = true;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [project, previewRevision, liveEntries]);

  useEffect(() => {
    const createdUrls: string[] = [];
    let cancelled = false;
    if (!project || detections.length === 0) {
      setThumbnails(new Map());
      return;
    }
    const uniquePaths: string[] = [];
    const seen = new Set<string>();
    for (const d of detections) {
      if (d.status !== 'ok' || !d.resolvedPath) continue;
      if (seen.has(d.resolvedPath)) continue;
      seen.add(d.resolvedPath);
      uniquePaths.push(d.resolvedPath);
      if (uniquePaths.length >= THUMBNAIL_CAP) break;
    }
    const zip = project.zip;
    setThumbnails(new Map());
    (async () => {
      const built = new Map<string, string>();
      for (let i = 0; i < uniquePaths.length; i += THUMBNAIL_CONCURRENCY) {
        if (cancelled) return;
        const batch = uniquePaths.slice(i, i + THUMBNAIL_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (path) => {
            if (cancelled) return null;
            const file = zip.file(path);
            if (!file) return null;
            try {
              const blob = await file.async('blob');
              if (cancelled) return null;
              const url = URL.createObjectURL(blob);
              createdUrls.push(url);
              return [path, url] as const;
            } catch {
              return null;
            }
          }),
        );
        if (cancelled) {
          for (const r of results) if (r) URL.revokeObjectURL(r[1]);
          return;
        }
        for (const r of results) {
          if (!r) continue;
          built.set(r[0], r[1]);
        }
        setThumbnails(new Map(built));
      }
    })();
    return () => {
      cancelled = true;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [project, detections]);

  useEffect(() => {
    setPendingFile(null);
    setReplacementError(null);
    setBrokenError(null);
  }, [selectedDetectionKey]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const type = (data as { type?: string }).type;
      if (type === SELECT_MESSAGE_TYPE) {
        const payload = data as Partial<EditorSelection>;
        if (
          payload &&
          (payload.kind === 'text' || payload.kind === 'image' || payload.kind === 'element') &&
          typeof payload.sourceFile === 'string' &&
          typeof payload.tagName === 'string' &&
          typeof payload.label === 'string'
        ) {
          setEditorSelection({
            sourceFile: payload.sourceFile,
            kind: payload.kind,
            tagName: payload.tagName,
            label: payload.label,
            text: typeof payload.text === 'string' ? payload.text : undefined,
            src: typeof payload.src === 'string' ? payload.src : undefined,
            alt: typeof payload.alt === 'string' ? payload.alt : undefined,
            href: typeof payload.href === 'string' ? payload.href : undefined,
            elementId: typeof payload.elementId === 'string' ? payload.elementId : undefined,
            className: typeof payload.className === 'string' ? payload.className : undefined,
            style: typeof payload.style === 'string' ? payload.style : undefined,
            sourceStart: typeof payload.sourceStart === 'number' ? payload.sourceStart : undefined,
            sourceEnd: typeof payload.sourceEnd === 'number' ? payload.sourceEnd : undefined,
            hasElementChildren: typeof payload.hasElementChildren === 'boolean' ? payload.hasElementChildren : undefined,
            selectorHint: typeof payload.selectorHint === 'string' ? payload.selectorHint : undefined,
            moveBeforeTarget: readEditorReorderTarget(payload.moveBeforeTarget),
            moveAfterTarget: readEditorReorderTarget(payload.moveAfterTarget),
          });
          setEditorError(null);
          setActiveMobilePane('right');
          setRightDrawerOpen(true);
        }
        return;
      }
      if (type === TEXT_EDIT_MESSAGE_TYPE) {
        const payload = data as {
          sourceFile?: unknown;
          oldText?: unknown;
          newText?: unknown;
          tagName?: unknown;
          label?: unknown;
          sourceStart?: unknown;
          sourceEnd?: unknown;
          selectorHint?: unknown;
        };
        if (
          typeof payload.sourceFile === 'string' &&
          typeof payload.oldText === 'string' &&
          typeof payload.newText === 'string'
        ) {
          void handleApplyPreviewTextEdit({
            sourceFile: payload.sourceFile,
            oldText: payload.oldText,
            newText: payload.newText,
            tagName: typeof payload.tagName === 'string' ? payload.tagName : undefined,
            label: typeof payload.label === 'string' ? payload.label : undefined,
            sourceStart: typeof payload.sourceStart === 'number' ? payload.sourceStart : undefined,
            sourceEnd: typeof payload.sourceEnd === 'number' ? payload.sourceEnd : undefined,
            selectorHint: typeof payload.selectorHint === 'string' ? payload.selectorHint : undefined,
          });
        }
        return;
      }
      if (type === REORDER_MESSAGE_TYPE) {
        const payload = data as {
          sourceFile?: unknown;
          selection?: unknown;
          reference?: unknown;
          placement?: unknown;
        };
        const selection = readEditorSelection(payload.selection, payload.sourceFile);
        const reference = readEditorReorderTarget(payload.reference);
        if (
          selection &&
          reference &&
          (payload.placement === 'before' || payload.placement === 'after')
        ) {
          void handleApplyEditorReorder(selection, reference, payload.placement);
        }
        return;
      }
      if (type !== NAV_MESSAGE_TYPE) return;
      const href = (data as { href?: unknown }).href;
      const sourceFile = (data as { sourceFile?: unknown }).sourceFile;
      if (typeof href !== 'string' || typeof sourceFile !== 'string') return;
      const r = resolveAgainst(sourceFile, href);
      if (r.isRemote || !r.resolvedPath) return;
      const index = previewRef.current;
      if (!index) return;
      const target = index.urls.get(r.resolvedPath);
      if (!target) return;
      // Route through the history-aware navigator so the link click
      // shows up in the back/forward stack. Without this, navigating
      // via a page-dropdown would overwrite history; with it, every
      // path change — whether from a click, dropdown, or programmatic
      // jump — stays consistent.
      navigateToPage(r.resolvedPath);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigateToPage, handleApplyPreviewTextEdit, handleApplyEditorReorder]);

  useEffect(() => {
    if (!rightDrawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setRightDrawerOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rightDrawerOpen]);

  // ------------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------------

  return (
    <div
      className="theme-app-root flex h-screen w-full max-w-full flex-col overflow-hidden bg-zinc-950 text-zinc-100"
      data-theme={theme}
      data-testid="app-root"
    >
      <TopBar
        project={project}
        progress={busyPhase}
        saveAtRisk={saveAtRisk}
        projectSaveBusy={projectSaveBusy}
        theme={theme}
        onSaveProject={handleSaveProject}
        onSaveProjectAs={handleSaveProjectAs}
        onToggleTheme={handleToggleTheme}
        onCancelOnboarding={handleCancelOnboarding}
      />
      {restoreBanner && !project && (
        <RestoreBanner
          banner={restoreBanner}
          restoring={restoring}
          onRestore={handleRestoreSession}
          onDismiss={handleDismissRestore}
        />
      )}
      <MobilePaneTabs
        activePane={activeMobilePane}
        onChange={setActiveMobilePane}
      />
      <div className="hidden min-w-0 items-center justify-end border-b border-zinc-800 bg-zinc-950 px-3 py-2 md:flex xl:hidden">
        <button
          type="button"
          onClick={() => setRightDrawerOpen(true)}
          aria-expanded={rightDrawerOpen}
          aria-controls="right-tools-drawer"
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          data-testid="right-drawer-toggle"
        >
          Tools
        </button>
      </div>
      {rightDrawerOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 hidden bg-zinc-950/70 md:block xl:hidden"
          onClick={() => setRightDrawerOpen(false)}
          aria-label="Close tools panel"
          data-testid="right-drawer-backdrop"
        />
      )}
      <div
        className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(280px,320px)_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)_320px]"
        data-testid="responsive-shell"
      >
        <div
          className={`${activeMobilePane === 'left' ? 'block' : 'hidden'} h-full min-h-0 min-w-0 md:block`}
          data-testid="left-pane-shell"
        >
          <LeftPanel
            project={project}
            isLoading={isLoading}
            error={error}
            expanded={expanded}
            selectedPath={selectedPath}
            onToggleFolder={handleToggleFolder}
            onSelectFile={handleSelectFile}
            onUpload={handleUploadNewProject}
            onCancelLoading={handleCancelOnboarding}
            onReload={handleReload}
            detections={activeDetections}
            thumbnails={thumbnails}
            scanning={scanning}
            selectedDetectionKey={selectedDetectionKey}
            onSelectDetection={handleSelectDetection}
            mode={leftPanelMode}
            onChangeMode={handleSetLeftPanelMode}
            onOpenSavedProject={handleOpenSavedProject}
            onSavedProjectRenamed={handleSavedProjectRenamed}
            onSavedProjectDeleted={handleSavedProjectDeleted}
            logoCandidates={logoCandidates}
            logoScanning={logoScanning}
            logoHelperBusy={logoHelperBusy}
            logoHelperError={logoHelperError}
            logoHelperSuccess={logoHelperSuccess}
            onPickLogoFile={handlePickLogoFile}
            onClearLogoFile={handleClearLogoFile}
            onApplyLogoHelper={(c, f) => void handleApplyLogoHelper(c, f)}
            onResetLogoHelperSuccess={handleResetLogoHelperSuccess}
            manualReplaceBusy={manualReplaceBusy}
            manualReplaceError={manualReplaceError}
            manualReplaceRecent={manualReplaceRecent}
            onApplyManualReplace={(input) => void handleApplyManualReplace(input)}
            onUndoManualReplace={handleUndoManualReplace}
            historyError={historyError}
            historyEntries={historyEntries}
            onUndoPatchById={handleUndoPatchById}
            onUndoLastChange={handleUndoLastChange}
            onUndoAll={handleRequestUndoAll}
            onResetSelectedImage={handleResetSelectedImage}
            onResetProject={handleResetProject}
            checkpoints={checkpoints}
            checkpointsLoading={checkpointsLoading}
            checkpointBusyId={checkpointBusyId}
            checkpointSaveBusy={checkpointSaveBusy}
            canSaveCheckpoint={project !== null && !isLoading && !projectSaveBusy}
            onSaveCheckpoint={handleSaveCheckpoint}
            onRestoreCheckpoint={handleRequestRestoreCheckpoint}
            onDeleteCheckpoint={handleDeleteCheckpoint}
            hasSelectedDetection={selectedDetection !== null}
            folderBuckets={folderBuckets}
            bulkFolder={bulkFolder}
            bulkPendingFile={bulkPendingFile}
            bulkBusy={bulkBusy}
            scopedDetectionCount={scopedDetections.length}
            onSetBulkFolder={handleSetBulkFolder}
            onPickBulkFile={handlePickBulkFile}
            onClearBulkFile={handleClearBulkFile}
            onAskBulkConfirm={handleAskBulkConfirm}
          />
        </div>
        <div
          className={`${activeMobilePane === 'preview' ? 'block' : 'hidden'} h-full min-h-0 min-w-0 border-x border-zinc-900 md:block`}
          data-testid="preview-pane-shell"
        >
          <ErrorBoundary
            title="Preview stopped rendering"
            description="The preview panel crashed, but the rest of the editor is still available. Reload to rebuild the view, or start fresh if a saved session keeps causing the crash."
            className="flex h-full w-full min-w-0 items-center justify-center bg-zinc-950 p-4 text-zinc-100"
          >
            <CenterPanel
              project={liveProject}
              preview={preview}
              previewBuilding={previewBuilding}
              previewKey={previewKey}
              currentPagePath={currentPagePath}
              onSelectPage={navigateToPage}
              onRefresh={handleRefreshPreview}
              viewport={previewViewport}
              onChangeViewport={handleChangeViewport}
              zoom={previewZoom}
              onChangeZoom={handleChangeZoom}
              history={previewHistory}
              onNavigateBack={handleNavigateBack}
              onNavigateForward={handleNavigateForward}
              fullscreen={previewFullscreen}
              onToggleFullscreen={handleToggleFullscreen}
              onExitFullscreen={handleExitFullscreen}
              onOpenInNewTab={handleOpenInNewTab}
              mode={previewMode}
              onChangeMode={handleChangePreviewMode}
              editCount={patchesByKey.size}
            />
          </ErrorBoundary>
        </div>
        <div
          id="right-tools-drawer"
          className={`${activeMobilePane === 'right' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col bg-zinc-950 md:fixed md:inset-y-0 md:right-0 md:z-50 md:w-[min(360px,calc(100vw-2rem))] md:max-w-full md:shadow-2xl ${rightDrawerOpen ? 'md:flex' : 'md:hidden'} xl:static xl:z-auto xl:flex xl:w-auto xl:max-w-none xl:shadow-none`}
          data-testid="right-pane-shell"
        >
          <div className="hidden shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-2 md:flex xl:hidden">
            <h2 className="text-sm font-semibold text-zinc-100">Tools</h2>
            <button
              type="button"
              onClick={() => setRightDrawerOpen(false)}
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-200 transition-colors hover:border-zinc-500 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
              data-testid="right-drawer-close"
            >
              Close
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <RightPanel
              selectedDetection={selectedDetection}
              thumbnail={selectedThumbnail}
              appliedPatch={selectedAppliedPatch}
              pendingFile={pendingFile}
              busy={replacementBusy}
              brokenBusy={brokenBusy}
              error={replacementError}
              brokenError={brokenError}
              onPickReplacementFile={handlePickReplacementFile}
              onCancelReplacement={handleCancelReplacement}
              onApplyReplacement={() => void handleApplyReplacement()}
              onApplyBrokenAction={(a) => void handleApplyBrokenAction(a)}
              onCancelBrokenAction={handleCancelBrokenAction}
              onReplaceAgain={handleReplaceAgain}
              exportState={exportState}
              exportSummary={exportSummary}
              exportError={exportError}
              canExport={project !== null && !isLoading}
              onExport={() => void handleExport()}
              onExportAgain={handleExportAgain}
              fitStyleBusy={fitStyleBusy}
              fitStyleError={fitStyleError}
              onApplyFitStyle={(c) => void handleApplyFitStyle(c)}
              onResetFitStyle={handleResetFitStyle}
              webpReencodeEnabled={webpReencode}
              onToggleWebpReencode={handleToggleWebpReencode}
              mode={previewMode}
              editorSelection={editorSelection}
              editorBusy={editorBusy}
              editorError={editorError}
              onApplyEditorText={(value) => void handleApplyEditorText(value)}
              onApplyEditorField={(field, value) => void handleApplyEditorField(field, value)}
              onApplyEditorImageFile={(file) => void handleApplyEditorImageFile(file)}
              onMoveEditorSelection={handleMoveEditorSelection}
              onClearEditorSelection={handleClearEditorSelection}
            />
          </div>
        </div>
      </div>
      {bulkConfirm && (
        <BulkConfirmModal
          confirm={bulkConfirm}
          onCancel={handleCancelBulkConfirm}
          onConfirm={() => void handleRunBulkConfirm()}
        />
      )}
      {resetConfirmOpen && (
        <ResetProjectConfirmModal
          onCancel={handleCancelResetProject}
          onConfirm={handleConfirmResetProject}
        />
      )}
      {undoAllConfirmOpen && (
        <UndoAllConfirmModal
          count={patchesByKey.size}
          onCancel={handleCancelUndoAll}
          onConfirm={handleConfirmUndoAll}
        />
      )}
      {checkpointRestoreTarget && (
        <CheckpointRestoreConfirmModal
          checkpoint={checkpointRestoreTarget}
          onCancel={handleCancelRestoreCheckpoint}
          onConfirm={() => void handleConfirmRestoreCheckpoint()}
        />
      )}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Responsive shell controls
// ---------------------------------------------------------------------------

function MobilePaneTabs({
  activePane,
  onChange,
}: {
  activePane: ResponsivePane;
  onChange: (pane: ResponsivePane) => void;
}) {
  return (
    <div
      className="border-b border-zinc-800 bg-zinc-950 px-2 py-2 md:hidden"
      data-testid="mobile-pane-tabs"
    >
      <div
        className="grid min-w-0 grid-cols-3 gap-1 rounded-lg border border-zinc-800 bg-zinc-900/70 p-1"
        role="tablist"
        aria-label="Editor panes"
      >
        {RESPONSIVE_PANES.map((pane) => {
          const active = pane.id === activePane;
          return (
            <button
              key={pane.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(pane.id)}
              className={`min-w-0 rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
                active
                  ? 'bg-violet-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
              }`}
              data-testid={`mobile-pane-${pane.id}`}
            >
              <span className="block truncate">{pane.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast viewport (fixed bottom-right stack)
// ---------------------------------------------------------------------------

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-label="Notifications"
      data-testid="toast-viewport"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Restore banner (boot-time)
// ---------------------------------------------------------------------------

function RestoreBanner({
  banner,
  restoring,
  onRestore,
  onDismiss,
}: {
  banner: RestoreBanner;
  restoring: boolean;
  onRestore: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="border-b border-violet-700/40 bg-violet-950/40 px-4 py-2 text-xs text-violet-100">
      <div className="mx-auto flex max-w-screen-2xl items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 inline-block h-2 w-2 rounded-full bg-violet-400" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Previous session found — <span className="font-mono">{banner.meta.fileName}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-violet-200/80">
            {banner.patchCount} change{banner.patchCount === 1 ? '' : 's'} saved ·{' '}
            {banner.meta.totalFiles} files · {banner.meta.htmlFiles} html ·{' '}
            {banner.meta.cssFiles} css · {banner.meta.imageFiles} images
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onRestore}
            disabled={restoring}
            aria-busy={restoring}
            data-testid="restore-session-button"
            className="rounded-md border border-violet-500/60 bg-violet-700/30 px-2.5 py-1 text-xs font-medium text-violet-100 transition-colors hover:border-violet-400 hover:bg-violet-700/50 disabled:opacity-50"
          >
            {restoring ? 'Restoring…' : 'Restore'}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs font-medium text-zinc-200 transition-colors hover:border-rose-500/50 hover:text-rose-200"
            data-testid="dismiss-restore-button"
          >
            Start fresh
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk confirm modal
// ---------------------------------------------------------------------------

function BulkConfirmModal({
  confirm,
  onCancel,
  onConfirm,
}: {
  confirm: BulkConfirm;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell
      titleId="bulk-confirm-title"
      testId="bulk-confirm-modal"
      onClose={onCancel}
    >
      <h3 id="bulk-confirm-title" className="text-sm font-semibold text-zinc-100">
        Apply <span className="font-mono text-violet-200">{confirm.fileName}</span> to {confirm.detectionCount} {confirm.detectionCount === 1 ? 'image' : 'images'}?
      </h3>
      <p className="mt-2 text-xs text-zinc-400">
        Folder: <span className="font-mono text-zinc-200">{confirm.dir}</span>
      </p>
      {confirm.preview.length > 0 && (
        <ul className="mt-2 max-h-40 space-y-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 text-[11px] font-mono text-zinc-300">
          {confirm.preview.map((p) => (
            <li key={p.key} className="truncate" title={p.sourceFile}>
              {p.rawUrl} <span className="text-zinc-500">· {p.sourceFile}</span>
            </li>
          ))}
          {confirm.detectionCount > confirm.preview.length && (
            <li className="text-zinc-500">… and {confirm.detectionCount - confirm.preview.length} more</li>
          )}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-zinc-500">
        Each image gets its own asset entry; later edits can revert any one individually via the History tab. If any apply fails, MockupSwap rolls back previous patches so the project zip stays consistent.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          data-testid="bulk-confirm-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          data-testid="bulk-confirm-apply"
        >
          Apply to {confirm.detectionCount}
        </button>
      </div>
    </DialogShell>
  );
}

function ResetProjectConfirmModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell
      titleId="reset-project-title"
      testId="reset-project-modal"
      onClose={onCancel}
    >
      <h3 id="reset-project-title" className="text-sm font-semibold text-zinc-100">
        Reset project?
      </h3>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
        This reverts every change applied in this session and reloads the original zip.
        Your uploaded source file is remembered for this session.
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Export first if you want to keep the current edits.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          data-testid="reset-project-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          data-testid="reset-project-confirm"
        >
          Reset project
        </button>
      </div>
    </DialogShell>
  );
}

function UndoAllConfirmModal({
  count,
  onCancel,
  onConfirm,
}: {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell
      titleId="undo-all-title"
      testId="undo-all-modal"
      onClose={onCancel}
    >
      <h3 id="undo-all-title" className="text-sm font-semibold text-zinc-100">
        Undo all patches?
      </h3>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
        This reverts {count} {count === 1 ? 'patch' : 'patches'} in newest-first order and returns the project to its post-upload state.
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Reset Project still reloads the original zip if you need a full restart.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          data-testid="undo-all-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          data-testid="undo-all-confirm"
        >
          Undo all
        </button>
      </div>
    </DialogShell>
  );
}

function CheckpointRestoreConfirmModal({
  checkpoint,
  onCancel,
  onConfirm,
}: {
  checkpoint: Checkpoint;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const patchCount = checkpoint.patches.length;
  return (
    <DialogShell
      titleId="checkpoint-restore-title"
      testId="checkpoint-restore-modal"
      onClose={onCancel}
    >
      <h3 id="checkpoint-restore-title" className="text-sm font-semibold text-zinc-100">
        Restore checkpoint?
      </h3>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
        This replaces the live project state with <span className="font-medium text-zinc-200">{checkpoint.label}</span>.
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        {patchCount} {patchCount === 1 ? 'patch' : 'patches'} will be restored from this saved version.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:border-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          data-testid="checkpoint-restore-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          data-testid="checkpoint-restore-confirm"
        >
          Restore
        </button>
      </div>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------
// Tiny helpers — promoted to module scope so they're not reallocated per render
// ---------------------------------------------------------------------------

function readStoredTheme(): PersistedTheme {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPersistedTheme(raw) ? raw : 'dark';
  } catch {
    return 'dark';
  }
}

function isPersistedTheme(value: unknown): value is PersistedTheme {
  return value === 'dark' || value === 'light';
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return '(root)';
  // Keep trailing slash so distinct roots compare unequal under Set dedup.
  return path.slice(0, idx + 1);
}

function parseLargeZipThreshold(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_LARGE_ZIP_WARNING_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LARGE_ZIP_WARNING_BYTES;
}

function createProjectRecordId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return `project-${randomUUID.call(globalThis.crypto)}`;
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createCheckpointId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return `checkpoint-${randomUUID.call(globalThis.crypto)}`;
  return `checkpoint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function persistedPatchesToApplied(raw: Array<unknown>): AppliedPatch[] {
  const patches: AppliedPatch[] = [];
  for (const entry of raw) {
    const candidate = isObjectRecord(entry) && 'patch' in entry ? entry.patch : entry;
    if (isAppliedPatch(candidate)) patches.push(candidate);
  }
  return patches;
}

function isAppliedPatch(value: unknown): value is AppliedPatch {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && typeof value.action === 'string';
}

function readEditorSelection(value: unknown, sourceFileHint: unknown): EditorSelection | null {
  if (!isObjectRecord(value)) return null;
  const kind = value.kind;
  const sourceFile = typeof value.sourceFile === 'string'
    ? value.sourceFile
    : typeof sourceFileHint === 'string'
      ? sourceFileHint
      : null;
  if (
    sourceFile === null ||
    (kind !== 'text' && kind !== 'image' && kind !== 'element') ||
    typeof value.tagName !== 'string' ||
    typeof value.label !== 'string'
  ) {
    return null;
  }
  return {
    sourceFile,
    kind,
    tagName: value.tagName,
    label: value.label,
    text: typeof value.text === 'string' ? value.text : undefined,
    src: typeof value.src === 'string' ? value.src : undefined,
    alt: typeof value.alt === 'string' ? value.alt : undefined,
    href: typeof value.href === 'string' ? value.href : undefined,
    elementId: typeof value.elementId === 'string' ? value.elementId : undefined,
    className: typeof value.className === 'string' ? value.className : undefined,
    style: typeof value.style === 'string' ? value.style : undefined,
    sourceStart: typeof value.sourceStart === 'number' ? value.sourceStart : undefined,
    sourceEnd: typeof value.sourceEnd === 'number' ? value.sourceEnd : undefined,
    hasElementChildren: typeof value.hasElementChildren === 'boolean' ? value.hasElementChildren : undefined,
    selectorHint: typeof value.selectorHint === 'string' ? value.selectorHint : undefined,
  };
}

function readEditorReorderTarget(value: unknown): EditorReorderTarget | undefined {
  if (!isObjectRecord(value)) return undefined;
  if (typeof value.tagName !== 'string' || typeof value.label !== 'string') return undefined;
  return {
    tagName: value.tagName,
    label: value.label,
    sourceStart: typeof value.sourceStart === 'number' ? value.sourceStart : undefined,
    sourceEnd: typeof value.sourceEnd === 'number' ? value.sourceEnd : undefined,
    selectorHint: typeof value.selectorHint === 'string' ? value.selectorHint : undefined,
  };
}

type EditableEditorField = Exclude<EditorEditField, 'text'>;

function editorFieldValue(selection: EditorSelection, field: EditableEditorField): string {
  switch (field) {
    case 'src':
      return selection.src ?? '';
    case 'alt':
      return selection.alt ?? '';
    case 'href':
      return selection.href ?? '';
    case 'class':
      return selection.className ?? '';
    case 'style':
      return selection.style ?? '';
  }
}

function updateEditorSelectionField(
  selection: EditorSelection | null,
  field: EditableEditorField,
  value: string,
): EditorSelection | null {
  if (!selection) return selection;
  switch (field) {
    case 'src':
      return selection.kind === 'image'
        ? { ...selection, src: value, label: selection.alt || value.split(/[/?#]/).filter(Boolean).pop() || 'Image' }
        : selection;
    case 'alt':
      return selection.kind === 'image'
        ? { ...selection, alt: value, label: value || selection.src?.split(/[/?#]/).filter(Boolean).pop() || 'Image' }
        : selection;
    case 'href':
      return { ...selection, href: value };
    case 'class':
      return { ...selection, className: value, selectorHint: buildSelectorHint(selection.tagName, selection.elementId, value) };
    case 'style':
      return { ...selection, style: value };
  }
}

function editorFieldLabel(field: EditableEditorField): string {
  switch (field) {
    case 'src':
      return 'image source';
    case 'alt':
      return 'alt text';
    case 'href':
      return 'link';
    case 'class':
      return 'classes';
    case 'style':
      return 'inline style';
  }
}

function buildSelectorHint(tagName: string, id: string | undefined, className: string): string {
  let out = tagName.toLowerCase();
  if (id) out += `#${id}`;
  const classes = className.trim().split(/\s+/).filter(Boolean).slice(0, 3);
  if (classes.length > 0) out += `.${classes.join('.')}`;
  return out;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/** Bridge a Blob into a File-like surface that the project worker accepts.
 *  We construct a real File when available, and fall back to a duck-typed
 *  Blob with a name so restored sessions keep their original filename. */
function blobToFileShim(blob: Blob, name: string): File {
  if (typeof File !== 'undefined') {
    return new File([blob], name, { type: 'application/zip' });
  }
  Object.defineProperty(blob, 'name', { value: name });
  Object.defineProperty(blob, 'lastModified', { value: Date.now() });
  Object.defineProperty(blob, 'webkitRelativePath', { value: '' });
  // Older test/browser surfaces may lack File while still accepting Blob
  // uploads through JSZip and structured clone.
  return blob as File;
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function TopBar({
  project,
  progress,
  saveAtRisk,
  projectSaveBusy,
  theme,
  onSaveProject,
  onSaveProjectAs,
  onToggleTheme,
  onCancelOnboarding,
}: {
  project: LoadedProject | null;
  progress: Phase;
  saveAtRisk: boolean;
  projectSaveBusy: boolean;
  theme: PersistedTheme;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onToggleTheme: () => void;
  onCancelOnboarding: () => void;
}) {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const canSaveProject = project !== null && !projectSaveBusy;

  return (
    <header className="flex min-w-0 items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 backdrop-blur sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <img
          src="/ms-logo.png"
          alt=""
          aria-hidden="true"
          className="h-7 w-7 shrink-0 rounded-md object-contain"
        />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold leading-tight text-zinc-100">MockupSwap</h1>
          <p className="hidden truncate text-[11px] leading-tight text-zinc-500 sm:block">
            Local browser tool for swapping images in website mockups
          </p>
        </div>
      </div>
      <div className="ml-auto flex max-w-[58vw] min-w-0 items-center justify-end gap-2 text-[11px] text-zinc-500">
        {project ? (
          <span className="min-w-0 max-w-full truncate rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">
            {project.fileName}
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5">
            no project loaded
          </span>
        )}
        {project && saveAtRisk && (
          <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-950/60 px-2 py-0.5 font-medium text-amber-200">
            save at risk
          </span>
        )}
        <TopBarProgress
          phase={progress}
          onCancel={progress.kind === 'detecting' ? onCancelOnboarding : undefined}
        />
        {project && (
          <>
            <button
              type="button"
              onClick={onSaveProject}
              disabled={!canSaveProject}
              aria-busy={projectSaveBusy}
              title="Save project to Projects"
              className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
              data-testid="save-project-button"
            >
              {projectSaveBusy ? 'Saving…' : 'Save project'}
            </button>
            <button
              type="button"
              onClick={onSaveProjectAs}
              disabled={!canSaveProject}
              title="Save project as a new Projects record"
              className="hidden shrink-0 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] font-medium text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 sm:inline-flex"
              data-testid="save-project-as-button"
            >
              Save as
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onToggleTheme}
          aria-pressed={theme === 'light'}
          title={`Switch to ${nextTheme} theme`}
          className="shrink-0 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          data-testid="theme-toggle"
        >
          {theme === 'dark' ? 'Dark' : 'Light'}
        </button>
      </div>
    </header>
  );
}
