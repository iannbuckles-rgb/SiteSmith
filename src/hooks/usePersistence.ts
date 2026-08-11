import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

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
  type CheckpointSummary,
  type PersistedSelection,
  type PersistedSession,
  type PersistedTheme,
  type SaveSessionOutcome,
} from '../lib/idb';
import {
  INITIAL_PERSISTENCE_STATE,
  preventUnsavedUnload,
  reducePersistenceState,
  shouldWarnBeforeUnload,
  type PersistenceStatus,
} from '../lib/persistenceState';
import { readPersistedPatches } from '../lib/persistedPatch';
import type { AppliedPatch, LoadedProject, LeftPanelMode } from '../types';

// ---------------------------------------------------------------------------
// Constants (moved from App.tsx)
// ---------------------------------------------------------------------------

const SAVE_DEBOUNCE_MS = 1000;

const PERSISTENCE_QUOTA_WARNING_TITLE =
  "Couldn't save your session — this browser is out of storage.";
const PERSISTENCE_ERROR_WARNING_TITLE = "Couldn't save your recovery session.";
const PERSISTENCE_WARNING_DETAIL =
  'Your changes are safe in memory, but closing or refreshing this tab can lose them. Export your zip to keep them.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Restore-banner context captured on boot. */
export type RestoreBanner = {
  meta: {
    fileName: string;
    totalFiles: number;
    htmlFiles: number;
    cssFiles: number;
    jsFiles: number;
    imageFiles: number;
    totalSize: number;
  };
  selection: PersistedSelection | null;
  patchCount: number;
  mutatedZipBlob: Blob;
  originalZipBlob: Blob | null;
};

type PersistedProjectSnapshot = Omit<PersistedSession, 'schemaVersion' | 'savedAt'>;

/** Toast helper — subset of what App provides. */
type PushToast = (toast: {
  kind: 'success' | 'warning' | 'error';
  title: string;
  detail: string;
  autoDismiss?: boolean;
}) => string;
type DismissToast = (id: string) => void;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface UsePersistenceInputs {
  /** The currently loaded project. */
  project: LoadedProject | null;
  /** Whether any mutation is in-flight. */
  projectMutationBusy: boolean;
  /** Reactive values for building a PersistedSelection. */
  currentPagePath: string;
  selectedDetectionKey: string | null;
  leftPanelMode: LeftPanelMode;
  expanded: Set<string>;
  /** Current theme. */
  theme: PersistedTheme;
  /** Original zip blob (for snapshot building). */
  originalBlob: Blob | null;
  /** Refs into App-level state. */
  patchesByKeyRef: React.MutableRefObject<Map<string, AppliedPatch>>;
  archiveMutationVersionRef: React.MutableRefObject<number>;
  /** Toast helpers. */
  pushToast: PushToast;
  dismissToast: DismissToast;
  /** Editor flush before snapshot. */
  flushPendingEditorWrites: () => Promise<void>;
  /** Callbacks for cross-cutting App-level concerns. */
  onRehydrate: (
    blob: Blob,
    original: Blob | null,
    meta: RestoreBanner['meta'],
    patches: AppliedPatch[],
    selection: PersistedSelection | null,
    expanded: Set<string>,
  ) => Promise<void>;
  onDismissRestore: () => void;
  /** Whether a restore/rehydrate is in progress (owned by App). */
  restoring: boolean;
  onReleaseWorker: () => void;
  onSetHistoryError: (err: string | null) => void;
  onSetTheme: (theme: PersistedTheme) => void;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface UsePersistenceOutputs {
  persistenceStatus: PersistenceStatus;
  projectSaveBusy: boolean;
  activeProjectRecordId: string | null;
  checkpoints: CheckpointSummary[];
  checkpointsLoading: boolean;
  checkpointSaveBusy: boolean;
  checkpointBusyId: string | null;
  checkpointRestoreTarget: Checkpoint | null;
  restoreBanner: RestoreBanner | null;
  restoring: boolean;
  /** Dismiss the restore banner (called by App on upload / reload). */
  clearRestoreBanner: () => void;
  /** Update or clear the active project record identity (called by App on upload / reload). */
  updateProjectRecordIdentity: (id: string | null, name: string | null) => void;
  handleSaveProject: () => void;
  handleSaveProjectAs: () => void;
  handleSaveCheckpoint: () => Promise<void>;
  handleRequestRestoreCheckpoint: (id: string) => Promise<void>;
  handleCancelRestoreCheckpoint: () => void;
  handleConfirmRestoreCheckpoint: () => Promise<void>;
  handleDeleteCheckpoint: (id: string) => Promise<void>;
  handleRestoreSession: () => void;
  handleDismissRestore: () => void;
  handleOpenSavedProject: (id: string) => Promise<void>;
  handleSavedProjectRenamed: (id: string, name: string) => void;
  handleSavedProjectDeleted: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPersistedTheme(value: unknown): value is PersistedTheme {
  return value === 'dark' || value === 'light';
}

function createProjectRecordId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function')
    return `project-${randomUUID.call(globalThis.crypto)}`;
  return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createCheckpointId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function')
    return `checkpoint-${randomUUID.call(globalThis.crypto)}`;
  return `checkpoint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function persistedPatchesToApplied(
  raw: Array<{ id: string; patch: unknown }>,
): AppliedPatch[] {
  return readPersistedPatches(raw) as AppliedPatch[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePersistence(inputs: UsePersistenceInputs): UsePersistenceOutputs {
  const {
    project,
    projectMutationBusy,
    currentPagePath,
    selectedDetectionKey,
    leftPanelMode,
    expanded,
    theme,
    originalBlob,
    patchesByKeyRef,
    archiveMutationVersionRef,
    pushToast,
    dismissToast,
    flushPendingEditorWrites,
    onRehydrate,
    onDismissRestore,
    restoring,
    onReleaseWorker,
    onSetHistoryError,
    onSetTheme,
  } = inputs;

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  const [restoreBanner, setRestoreBanner] = useState<RestoreBanner | null>(null);
  const [persistenceState, dispatchPersistence] = useReducer(
    reducePersistenceState,
    INITIAL_PERSISTENCE_STATE,
  );
  const [projectSaveBusy, setProjectSaveBusy] = useState(false);
  const [activeProjectRecordId, setActiveProjectRecordId] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [checkpointsLoading, setCheckpointsLoading] = useState(false);
  const [checkpointSaveBusy, setCheckpointSaveBusy] = useState(false);
  const [checkpointBusyId, setCheckpointBusyId] = useState<string | null>(null);
  const [checkpointRestoreTarget, setCheckpointRestoreTarget] = useState<Checkpoint | null>(null);

  // -----------------------------------------------------------------------
  // Internal refs
  // -----------------------------------------------------------------------

  const saveFailureToastShownRef = useRef(false);
  const saveFailureToastIdRef = useRef<string | null>(null);
  const sessionSaveGenerationRef = useRef(0);
  const snapshotBlobCacheRef = useRef<{
    zip: LoadedProject['zip'];
    mutationVersion: number;
    blob: Blob;
  } | null>(null);
  const restoreMutatedZipArrayRef = useRef<Array<{ id: string; patch: unknown }> | null>(null);
  const projectRecordIdRef = useRef<string | null>(null);
  const projectRecordNameRef = useRef<string | null>(null);

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  const markSessionSaveOk = useCallback(() => {
    saveFailureToastShownRef.current = false;
    if (saveFailureToastIdRef.current) {
      dismissToast(saveFailureToastIdRef.current);
      saveFailureToastIdRef.current = null;
    }
  }, [dismissToast]);

  const markSessionSaveFailed = useCallback(
    (outcome: Exclude<SaveSessionOutcome, 'ok'>) => {
      if (saveFailureToastShownRef.current) return;
      saveFailureToastShownRef.current = true;
      saveFailureToastIdRef.current = pushToast({
        kind: 'warning',
        title:
          outcome === 'quota-exceeded'
            ? PERSISTENCE_QUOTA_WARNING_TITLE
            : PERSISTENCE_ERROR_WARNING_TITLE,
        detail: PERSISTENCE_WARNING_DETAIL,
        autoDismiss: false,
      });
    },
    [pushToast],
  );

  const updateProjectRecordIdentity = useCallback(
    (id: string | null, name: string | null) => {
      projectRecordIdRef.current = id;
      projectRecordNameRef.current = name;
      setActiveProjectRecordId(id);
    },
    [],
  );

  const refreshCheckpoints = useCallback(
    async (projectId: string | null = projectRecordIdRef.current) => {
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
    },
    [],
  );

  useEffect(() => {
    void refreshCheckpoints(activeProjectRecordId);
  }, [activeProjectRecordId, refreshCheckpoints]);

  const buildCurrentSelection = useCallback(
    (): PersistedSelection => ({
      currentPagePath,
      selectedDetectionKey,
      leftPanelMode,
      expandedFolders: Array.from(expanded),
    }),
    [currentPagePath, selectedDetectionKey, leftPanelMode, expanded],
  );

  const buildCurrentProjectSnapshot = useCallback(async (): Promise<PersistedProjectSnapshot | null> => {
    if (!project) return null;
    await flushPendingEditorWrites();
    const mutationVersion = archiveMutationVersionRef.current;
    const cached = snapshotBlobCacheRef.current;
    const mutatedZipBlob =
      cached?.zip === project.zip && cached.mutationVersion === mutationVersion
        ? cached.blob
        : await project.zip.generateAsync({ type: 'blob', compression: 'STORE' });
    if (archiveMutationVersionRef.current !== mutationVersion) {
      throw new Error(
        'The project changed while its snapshot was being prepared. Save again after the current edit finishes.',
      );
    }
    snapshotBlobCacheRef.current = { zip: project.zip, mutationVersion, blob: mutatedZipBlob };
    const patches = Array.from(patchesByKeyRef.current.entries()).map(([id, patch]) => ({
      id,
      patch,
    }));
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
      originalZipBlob: originalBlob,
      patches,
      selection,
      theme,
    };
  }, [
    project,
    flushPendingEditorWrites,
    buildCurrentSelection,
    originalBlob,
    theme,
    archiveMutationVersionRef,
    patchesByKeyRef,
  ]);

  // -----------------------------------------------------------------------
  // saveProjectToLibrary
  // -----------------------------------------------------------------------

  const saveProjectToLibrary = useCallback(
    async (mode: 'save' | 'save-as'): Promise<string | null> => {
      if (!project || projectSaveBusy) return null;
      if (projectMutationBusy) {
        pushToast({
          kind: 'warning',
          title: 'Save is waiting on an edit',
          detail:
            'Let the current editor change finish, then save again so the project record matches the zip.',
        });
        return null;
      }
      const reuseExisting = mode === 'save' && projectRecordIdRef.current !== null;
      const id = reuseExisting ? projectRecordIdRef.current! : createProjectRecordId();
      let name = reuseExisting
        ? (projectRecordNameRef.current ?? project.fileName)
        : '';
      if (!reuseExisting) {
        const prompted = window.prompt(
          mode === 'save-as' ? 'Save project as' : 'Save project',
          project.fileName,
        );
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
          detail:
            err instanceof Error
              ? err.message
              : 'Your edits are still in memory. Export your zip to keep them.',
          autoDismiss: false,
        });
        return null;
      } finally {
        setProjectSaveBusy(false);
      }
    },
    [
      project,
      projectSaveBusy,
      projectMutationBusy,
      buildCurrentProjectSnapshot,
      pushToast,
      updateProjectRecordIdentity,
    ],
  );

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const handleSaveProject = useCallback(() => {
    void saveProjectToLibrary('save');
  }, [saveProjectToLibrary]);

  const handleSaveProjectAs = useCallback(() => {
    void saveProjectToLibrary('save-as');
  }, [saveProjectToLibrary]);

  const handleSaveCheckpoint = useCallback(async () => {
    if (!project || checkpointSaveBusy || projectSaveBusy) return;
    if (projectMutationBusy) {
      onSetHistoryError(
        'Let the current editor change finish before saving a checkpoint.',
      );
      return;
    }
    onSetHistoryError(null);

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
        onSetHistoryError(
          "Couldn't save checkpoint — browser storage is full.",
        );
      } else {
        onSetHistoryError(
          "Couldn't save checkpoint. Your current edits are still in memory.",
        );
      }
    } catch (err) {
      onSetHistoryError(
        err instanceof Error ? err.message : 'Failed to save checkpoint.',
      );
    } finally {
      setCheckpointSaveBusy(false);
    }
  }, [
    project,
    checkpointSaveBusy,
    projectSaveBusy,
    projectMutationBusy,
    saveProjectToLibrary,
    buildCurrentProjectSnapshot,
    refreshCheckpoints,
    pushToast,
    onSetHistoryError,
  ]);

  const handleRequestRestoreCheckpoint = useCallback(
    async (id: string) => {
      setCheckpointBusyId(`restore:${id}`);
      onSetHistoryError(null);
      try {
        const checkpoint = await loadCheckpoint(id);
        if (!checkpoint?.mutatedZipBlob) {
          onSetHistoryError('Checkpoint could not be loaded.');
          return;
        }
        setCheckpointRestoreTarget(checkpoint);
      } catch (err) {
        onSetHistoryError(
          err instanceof Error ? err.message : 'Failed to load checkpoint.',
        );
      } finally {
        setCheckpointBusyId(null);
      }
    },
    [onSetHistoryError],
  );

  const handleCancelRestoreCheckpoint = useCallback(() => {
    setCheckpointRestoreTarget(null);
  }, []);

  const handleConfirmRestoreCheckpoint = useCallback(async () => {
    const checkpoint = checkpointRestoreTarget;
    if (!checkpoint) return;
    setCheckpointRestoreTarget(null);
    setCheckpointBusyId(`restore:${checkpoint.id}`);
    onSetHistoryError(null);
    try {
      const parent = await loadProjectRecord(checkpoint.projectId);
      if (!parent?.originalZipBlob) {
        onSetHistoryError(
          'The saved project is missing its original zip, so this checkpoint cannot be restored safely.',
        );
        return;
      }
      const currentSelection = buildCurrentSelection();
      const restoreSelection: PersistedSelection = {
        ...currentSelection,
        selectedDetectionKey: null,
        leftPanelMode: 'history',
      };
      await onRehydrate(
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
      onSetHistoryError(
        err instanceof Error ? err.message : 'Failed to restore checkpoint.',
      );
    } finally {
      setCheckpointBusyId(null);
    }
  }, [
    checkpointRestoreTarget,
    buildCurrentSelection,
    onRehydrate,
    updateProjectRecordIdentity,
    refreshCheckpoints,
    pushToast,
    onSetHistoryError,
  ]);

  const handleDeleteCheckpoint = useCallback(
    async (id: string) => {
      const checkpoint = checkpoints.find((item) => item.id === id);
      if (
        checkpoint &&
        !window.confirm(`Delete checkpoint "${checkpoint.label}"?`)
      )
        return;
      setCheckpointBusyId(`delete:${id}`);
      onSetHistoryError(null);
      try {
        await deleteCheckpoint(id);
        await refreshCheckpoints(projectRecordIdRef.current);
        if (checkpointRestoreTarget?.id === id) setCheckpointRestoreTarget(null);
      } catch (err) {
        onSetHistoryError(
          err instanceof Error ? err.message : 'Failed to delete checkpoint.',
        );
      } finally {
        setCheckpointBusyId(null);
      }
    },
    [checkpoints, checkpointRestoreTarget, refreshCheckpoints, onSetHistoryError],
  );

  const handleRestoreSession = useCallback(() => {
    if (!restoreBanner) return;
    const priorPatchesRaw = restoreMutatedZipArrayRef.current ?? [];
    const priorPatches = persistedPatchesToApplied(priorPatchesRaw);
    void onRehydrate(
      restoreBanner.mutatedZipBlob,
      restoreBanner.originalZipBlob,
      restoreBanner.meta,
      priorPatches,
      restoreBanner.selection,
      new Set(restoreBanner.selection?.expandedFolders ?? []),
    );
  }, [restoreBanner, onRehydrate]);

  const clearRestoreBanner = useCallback(() => {
    setRestoreBanner(null);
    restoreMutatedZipArrayRef.current = null;
  }, []);

  const handleDismissRestore = useCallback(() => {
    onDismissRestore();
    onReleaseWorker();
    setRestoreBanner(null);
    restoreMutatedZipArrayRef.current = null;
    void clearSession();
  }, [onDismissRestore, onReleaseWorker]);

  const handleOpenSavedProject = useCallback(
    async (id: string) => {
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
      if (isPersistedTheme(record.theme)) onSetTheme(record.theme);
      await onRehydrate(
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
    },
    [pushToast, onRehydrate, updateProjectRecordIdentity, onSetTheme],
  );

  const handleSavedProjectRenamed = useCallback(
    (id: string, name: string) => {
      if (projectRecordIdRef.current !== id) return;
      projectRecordNameRef.current = name;
    },
    [],
  );

  const handleSavedProjectDeleted = useCallback(
    (id: string) => {
      if (projectRecordIdRef.current !== id) return;
      updateProjectRecordIdentity(null, null);
    },
    [updateProjectRecordIdentity],
  );

  // -----------------------------------------------------------------------
  // Effects
  // -----------------------------------------------------------------------

  // Boot: load persisted session and surface restore banner.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const snapshot = await loadSession();
      if (cancelled || !snapshot) return;
      if (isPersistedTheme(snapshot.theme)) onSetTheme(snapshot.theme);
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
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced autosave.
  useEffect(() => {
    const generation = ++sessionSaveGenerationRef.current;
    if (!project) {
      dispatchPersistence({ type: 'reset', generation });
      markSessionSaveOk();
      return;
    }
    dispatchPersistence({ type: 'dirty', generation });
    const handle = window.setTimeout(async () => {
      if (sessionSaveGenerationRef.current !== generation) return;
      dispatchPersistence({ type: 'saving', generation });
      try {
        const snapshot = await buildCurrentProjectSnapshot();
        if (!snapshot) return;
        if (sessionSaveGenerationRef.current !== generation) return;
        const saveOutcome = await saveSession(snapshot);
        if (sessionSaveGenerationRef.current !== generation) return;
        if (saveOutcome === 'ok') {
          dispatchPersistence({ type: 'saved', generation });
          markSessionSaveOk();
        } else {
          dispatchPersistence({ type: 'failed', generation });
          markSessionSaveFailed(saveOutcome);
        }
      } catch {
        if (sessionSaveGenerationRef.current === generation) {
          dispatchPersistence({ type: 'failed', generation });
          markSessionSaveFailed('error');
        }
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
      if (sessionSaveGenerationRef.current === generation) {
        sessionSaveGenerationRef.current += 1;
      }
    };
  }, [project, buildCurrentProjectSnapshot, markSessionSaveOk, markSessionSaveFailed]);

  // Unload warning.
  useEffect(() => {
    if (!project || !shouldWarnBeforeUnload(persistenceState.status)) return;
    window.addEventListener('beforeunload', preventUnsavedUnload);
    return () => window.removeEventListener('beforeunload', preventUnsavedUnload);
  }, [project, persistenceState.status]);

  // -----------------------------------------------------------------------
  // Return
  // -----------------------------------------------------------------------

  return {
    persistenceStatus: persistenceState.status,
    projectSaveBusy,
    activeProjectRecordId,
    checkpoints,
    checkpointsLoading,
    checkpointSaveBusy,
    checkpointBusyId,
    checkpointRestoreTarget,
    restoreBanner,
    restoring,
    clearRestoreBanner,
    updateProjectRecordIdentity,
    handleSaveProject,
    handleSaveProjectAs,
    handleSaveCheckpoint,
    handleRequestRestoreCheckpoint,
    handleCancelRestoreCheckpoint,
    handleConfirmRestoreCheckpoint,
    handleDeleteCheckpoint,
    handleRestoreSession,
    handleDismissRestore,
    handleOpenSavedProject,
    handleSavedProjectRenamed,
    handleSavedProjectDeleted,
  };
}
