import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock idb.ts — prevents real IndexedDB calls. All functions return default
// safe values; individual tests override with mockResolvedValue/mockRejectedValue.
// ---------------------------------------------------------------------------
vi.mock('../src/lib/idb', () => ({
  loadSession: vi.fn(),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  saveProjectRecord: vi.fn(),
  loadProjectRecord: vi.fn(),
  saveCheckpoint: vi.fn(),
  loadCheckpoint: vi.fn(),
  deleteCheckpoint: vi.fn(),
  listCheckpoints: vi.fn(),
}));

import {
  loadSession as _loadSession,
  saveSession as _saveSession,
  clearSession as _clearSession,
  saveProjectRecord as _saveProjectRecord,
  loadProjectRecord as _loadProjectRecord,
  saveCheckpoint as _saveCheckpoint,
  loadCheckpoint as _loadCheckpoint,
  deleteCheckpoint as _deleteCheckpoint,
  listCheckpoints as _listCheckpoints,
} from '../src/lib/idb';

import { usePersistence } from '../src/hooks/usePersistence';
import type { LoadedProject, LeftPanelMode } from '../src/types';

// Narrow to mock types.
const loadSession = vi.mocked(_loadSession);
const saveSession = vi.mocked(_saveSession);
const clearSession = vi.mocked(_clearSession);
const saveProjectRecord = vi.mocked(_saveProjectRecord);
const loadProjectRecord = vi.mocked(_loadProjectRecord);
const saveCheckpoint = vi.mocked(_saveCheckpoint);
const loadCheckpoint = vi.mocked(_loadCheckpoint);
const deleteCheckpoint = vi.mocked(_deleteCheckpoint);
const listCheckpoints = vi.mocked(_listCheckpoints);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubProject(overrides: Partial<LoadedProject> = {}): LoadedProject {
  return {
    fileName: 'test.zip',
    zip: {
      file: vi.fn(),
      generateAsync: vi.fn().mockResolvedValue(new Blob(['fake-zip'])),
    } as unknown as LoadedProject['zip'],
    entries: [
      { name: 'index.html', path: 'index.html', isDirectory: false, size: 100, category: 'html' },
    ],
    summary: { totalFiles: 1, totalSize: 100, htmlFiles: 1, cssFiles: 0, jsFiles: 0, imageFiles: 0 },
    ...overrides,
  };
}

function defaults() {
  const pushToast = vi.fn(() => 'toast-1');
  const dismissToast = vi.fn();
  return {
    project: null as LoadedProject | null,
    projectMutationBusy: false,
    currentPagePath: 'index.html',
    selectedDetectionKey: null as string | null,
    leftPanelMode: 'images' as LeftPanelMode,
    expanded: new Set<string>(),
    theme: 'dark' as const,
    originalBlob: null as Blob | null,
    restoring: false,
    pushToast,
    dismissToast,
    flushPendingEditorWrites: vi.fn(() => Promise.resolve()),
    onRehydrate: vi.fn(() => Promise.resolve()),
    onDismissRestore: vi.fn(),
    onReleaseWorker: vi.fn(),
    onSetHistoryError: vi.fn(),
    onSetTheme: vi.fn(),
    patchesByKeyRef: { current: new Map() } as React.MutableRefObject<Map<string, any>>,
    archiveMutationVersionRef: { current: 0 } as React.MutableRefObject<number>,
  };
}

function stubBlob(size = 5): Blob {
  return new Blob([new Uint8Array(size)]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // All IDB mocks default to safe returns.
  loadSession.mockResolvedValue(null);
  saveSession.mockResolvedValue('ok');
  clearSession.mockResolvedValue(undefined);
  saveProjectRecord.mockResolvedValue('ok');
  loadProjectRecord.mockResolvedValue(null);
  saveCheckpoint.mockResolvedValue('ok');
  loadCheckpoint.mockResolvedValue(null);
  deleteCheckpoint.mockResolvedValue(undefined);
  listCheckpoints.mockResolvedValue([]);
});

// Silence the console.warn emitted by usePersistence internals.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePersistence', () => {
  // =====================================================================
  // Session save / restore banner
  // =====================================================================
  describe('restore banner (boot session)', () => {
    it('shows restore banner when loadSession returns a valid session', async () => {
      const mutatedBlob = stubBlob();
      loadSession.mockResolvedValue({
        schemaVersion: 1,
        savedAt: Date.now(),
        projectMeta: {
          fileName: 'previous-session.zip',
          totalFiles: 3, totalSize: 500, htmlFiles: 2, cssFiles: 1, jsFiles: 0, imageFiles: 0,
        },
        mutatedZipBlob: mutatedBlob,
        originalZipBlob: null,
        patches: [],
        selection: null,
        theme: 'dark',
      });

      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      await waitFor(() => {
        expect(result.current.restoreBanner).not.toBeNull();
      });

      const banner = result.current.restoreBanner!;
      expect(banner.meta.fileName).toBe('previous-session.zip');
      expect(banner.patchCount).toBe(0);
      expect(banner.mutatedZipBlob).toBe(mutatedBlob);
    });

    it('does not show restore banner when loadSession returns null', async () => {
      loadSession.mockResolvedValue(null);

      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      // Give the boot effect time to settle.
      await new Promise((r) => setTimeout(r, 50));
      expect(result.current.restoreBanner).toBeNull();
    });

    it('does not show banner when session has no mutatedZipBlob', async () => {
      loadSession.mockResolvedValue({
        schemaVersion: 1,
        savedAt: Date.now(),
        projectMeta: null,
        mutatedZipBlob: null,
        originalZipBlob: null,
        patches: [],
        selection: null,
      });

      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      await new Promise((r) => setTimeout(r, 50));
      expect(result.current.restoreBanner).toBeNull();
    });

    it('handleRestoreSession calls onRehydrate with banner data', async () => {
      const mutatedBlob = stubBlob();
      loadSession.mockResolvedValue({
        schemaVersion: 1,
        savedAt: Date.now(),
        projectMeta: { fileName: 'x.zip', totalFiles: 1, totalSize: 10, htmlFiles: 1, cssFiles: 0, jsFiles: 0, imageFiles: 0 },
        mutatedZipBlob: mutatedBlob,
        originalZipBlob: null,
        patches: [],
        selection: { currentPagePath: 'x.html', selectedDetectionKey: null, leftPanelMode: 'images' as LeftPanelMode, expandedFolders: ['dir'] },
        theme: 'light',
      });

      const onRehydrate = vi.fn(() => Promise.resolve());
      const d = { ...defaults(), onRehydrate };
      const { result } = renderHook(() => usePersistence(d));

      await waitFor(() => {
        expect(result.current.restoreBanner).not.toBeNull();
      });

      act(() => { result.current.handleRestoreSession(); });

      await waitFor(() => {
        expect(onRehydrate).toHaveBeenCalledTimes(1);
      });

      const callArgs = onRehydrate.mock.calls[0] as unknown[];
      expect(callArgs[0]).toBe(mutatedBlob);
      expect(callArgs[1]).toBeNull();
      const meta = callArgs[2] as { fileName: string };
      expect(meta.fileName).toBe('x.zip');
      expect(callArgs[3]).toEqual([]);
      const sel = callArgs[4] as { currentPagePath: string } | null;
      expect(sel?.currentPagePath).toBe('x.html');
      const exp = callArgs[5] as Set<string>;
      expect(exp.has('dir')).toBe(true);
    });

    it('handleRestoreSession no-ops when there is no banner', () => {
      const onRehydrate = vi.fn();
      const d = { ...defaults(), onRehydrate };
      const { result } = renderHook(() => usePersistence(d));

      act(() => { result.current.handleRestoreSession(); });
      expect(onRehydrate).not.toHaveBeenCalled();
    });

    it('handleDismissRestore clears the banner and calls cleanup', async () => {
      loadSession.mockResolvedValue({
        schemaVersion: 1, savedAt: Date.now(),
        projectMeta: { fileName: 'x.zip', totalFiles: 1, totalSize: 10, htmlFiles: 1, cssFiles: 0, jsFiles: 0, imageFiles: 0 },
        mutatedZipBlob: stubBlob(), originalZipBlob: null, patches: [], selection: null,
      });

      const onDismissRestore = vi.fn();
      const onReleaseWorker = vi.fn();
      const d = { ...defaults(), onDismissRestore, onReleaseWorker };
      const { result } = renderHook(() => usePersistence(d));

      await waitFor(() => {
        expect(result.current.restoreBanner).not.toBeNull();
      });

      act(() => { result.current.handleDismissRestore(); });

      expect(onDismissRestore).toHaveBeenCalledTimes(1);
      expect(onReleaseWorker).toHaveBeenCalledTimes(1);
      expect(clearSession).toHaveBeenCalledTimes(1);
      expect(result.current.restoreBanner).toBeNull();
    });

    it('clearRestoreBanner resets banner without side effects', async () => {
      loadSession.mockResolvedValue({
        schemaVersion: 1, savedAt: Date.now(),
        projectMeta: { fileName: 'x.zip', totalFiles: 1, totalSize: 10, htmlFiles: 1, cssFiles: 0, jsFiles: 0, imageFiles: 0 },
        mutatedZipBlob: stubBlob(), originalZipBlob: null, patches: [], selection: null,
      });

      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      await waitFor(() => {
        expect(result.current.restoreBanner).not.toBeNull();
      });

      act(() => { result.current.clearRestoreBanner(); });
      expect(result.current.restoreBanner).toBeNull();
      // clearRestoreBanner does NOT call onDismissRestore or clearSession.
      expect(d.onDismissRestore).not.toHaveBeenCalled();
      expect(clearSession).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // Session save (debounced autosave + persistence state)
  // =====================================================================
  describe('session autosave', () => {
    it('transitions persistence state: dirty → saving → saved', async () => {
      saveSession.mockResolvedValue('ok');

      const project = stubProject();
      const d = { ...defaults(), project };
      const { result } = renderHook(() => usePersistence(d));

      // Immediately dirty (sync).
      await waitFor(() => {
        expect(result.current.persistenceStatus).toBe('dirty');
      });

      // After debounce + async save → saved.
      await waitFor(() => {
        expect(result.current.persistenceStatus).toBe('saved');
      }, { timeout: 3000 });
    });

    it('transitions to at-risk when saveSession fails', async () => {
      saveSession.mockResolvedValue('quota-exceeded');

      const project = stubProject();
      const d = { ...defaults(), project };
      const { result } = renderHook(() => usePersistence(d));

      await waitFor(() => {
        expect(result.current.persistenceStatus).toBe('at-risk');
      }, { timeout: 3000 });
    });

    it('resets to saved when project becomes null', async () => {
      const base = defaults();
      const { result, rerender } = renderHook<
        ReturnType<typeof usePersistence>,
        { project: LoadedProject | null }
      >(
        ({ project }) => usePersistence({ ...base, project }),
        { initialProps: { project: stubProject() } },
      );

      await waitFor(() => {
        expect(result.current.persistenceStatus).toBe('dirty');
      });

      rerender({ project: null });

      await waitFor(() => {
        expect(result.current.persistenceStatus).toBe('saved');
      });
    });
  });

  // =====================================================================
  // Checkpoint lifecycle
  // =====================================================================
  describe('checkpoint lifecycle', () => {
    it('refreshCheckpoints fetches and sets checkpoints list', async () => {
      const checkpointSummaries = [
        { id: 'cp-1', projectId: 'proj-1', label: 'Checkpoint 1', savedAt: 10, patches: [] },
        { id: 'cp-2', projectId: 'proj-1', label: 'Checkpoint 2', savedAt: 20, patches: [] },
      ];
      listCheckpoints.mockResolvedValue(checkpointSummaries);

      // Need an active project record to trigger refresh.
      const d = { ...defaults() };
      const { result } = renderHook(() => usePersistence(d));

      // Simulate setting a project record id.
      act(() => { result.current.updateProjectRecordIdentity('proj-1', 'My Project'); });

      await waitFor(() => {
        expect(result.current.checkpointsLoading).toBe(false);
      });

      expect(result.current.checkpoints).toEqual(checkpointSummaries);
    });

    it('clears checkpoints when project record id is null', () => {
      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      act(() => { result.current.updateProjectRecordIdentity(null, null); });
      expect(result.current.checkpoints).toEqual([]);
    });

    it('handleRequestRestoreCheckpoint loads checkpoint and sets restore target', async () => {
      const cp = {
        id: 'cp-1', projectId: 'proj-1', label: 'My Cp', savedAt: 10,
        mutatedZipBlob: stubBlob(), patches: [],
      };
      loadCheckpoint.mockResolvedValue(cp);

      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      await act(async () => {
        await result.current.handleRequestRestoreCheckpoint('cp-1');
      });

      expect(result.current.checkpointRestoreTarget).toEqual(cp);
      expect(loadCheckpoint).toHaveBeenCalledWith('cp-1');
    });

    it('handleRequestRestoreCheckpoint sets error when checkpoint not found', async () => {
      loadCheckpoint.mockResolvedValue(null);

      const onSetHistoryError = vi.fn();
      const d = { ...defaults(), onSetHistoryError };
      const { result } = renderHook(() => usePersistence(d));

      await act(async () => {
        await result.current.handleRequestRestoreCheckpoint('cp-1');
      });

      expect(onSetHistoryError).toHaveBeenCalledWith('Checkpoint could not be loaded.');
      expect(result.current.checkpointRestoreTarget).toBeNull();
    });

    it('handleCancelRestoreCheckpoint clears restore target', async () => {
      const cp = { id: 'cp-1', projectId: 'proj-1', label: 'My Cp', savedAt: 10, mutatedZipBlob: stubBlob(), patches: [] };
      loadCheckpoint.mockResolvedValue(cp);

      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      await act(async () => { await result.current.handleRequestRestoreCheckpoint('cp-1'); });
      expect(result.current.checkpointRestoreTarget).not.toBeNull();

      act(() => { result.current.handleCancelRestoreCheckpoint(); });
      expect(result.current.checkpointRestoreTarget).toBeNull();
    });

    it('handleConfirmRestoreCheckpoint no-ops when no target set', async () => {
      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      await act(async () => { await result.current.handleConfirmRestoreCheckpoint(); });
      // Should complete without calling loadProjectRecord (nothing to restore).
      expect(loadProjectRecord).not.toHaveBeenCalled();
    });

    it('handleDeleteCheckpoint deletes and refreshes list', async () => {
      window.confirm = vi.fn(() => true);
      listCheckpoints.mockResolvedValue([]);

      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      act(() => { result.current.updateProjectRecordIdentity('proj-1', 'P'); });

      await waitFor(() => { expect(result.current.checkpointsLoading).toBe(false); });

      await act(async () => {
        await result.current.handleDeleteCheckpoint('cp-1');
      });

      expect(deleteCheckpoint).toHaveBeenCalledWith('cp-1');
    });

    it('handleDeleteCheckpoint aborts when confirm returns false', async () => {
      window.confirm = vi.fn(() => false);
      // Seed a checkpoint in the list so the confirm prompt fires.
      listCheckpoints.mockResolvedValue([
        { id: 'cp-1', projectId: 'proj-1', label: 'Cp', savedAt: 10, patches: [] },
      ]);

      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));
      act(() => { result.current.updateProjectRecordIdentity('proj-1', 'P'); });
      await waitFor(() => { expect(result.current.checkpointsLoading).toBe(false); });

      await act(async () => {
        await result.current.handleDeleteCheckpoint('cp-1');
      });

      expect(deleteCheckpoint).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // Project save
  // =====================================================================
  describe('project save', () => {
    it('handleSaveProject calls saveProjectToLibrary with "save" mode', async () => {
      // Mock window.prompt to return a name.
      window.prompt = vi.fn(() => 'My Saved Project');

      const project = stubProject();
      const d = { ...defaults(), project };
      const { result } = renderHook(() => usePersistence(d));

      await act(async () => {
        result.current.handleSaveProject();
      });

      // Wait for async save to complete.
      await waitFor(() => {
        expect(saveProjectRecord).toHaveBeenCalled();
      });
    });

    it('handleSaveProjectAs calls saveProjectToLibrary with "save-as" mode', async () => {
      window.prompt = vi.fn(() => 'New Name');

      const project = stubProject();
      const d = { ...defaults(), project };
      const { result } = renderHook(() => usePersistence(d));

      await act(async () => {
        result.current.handleSaveProjectAs();
      });

      await waitFor(() => {
        expect(saveProjectRecord).toHaveBeenCalled();
      });
    });

    it('handleSaveProject returns early when prompt is cancelled', async () => {
      window.prompt = vi.fn(() => null);

      const project = stubProject();
      const d = { ...defaults(), project };
      const { result } = renderHook(() => usePersistence(d));

      await act(async () => {
        result.current.handleSaveProject();
      });

      // No save should happen if prompt returns null (first-time save).
      await new Promise((r) => setTimeout(r, 100));
      expect(saveProjectRecord).not.toHaveBeenCalled();
    });

    it('no-ops when project is null', () => {
      const d = defaults(); // project is null
      const { result } = renderHook(() => usePersistence(d));

      act(() => { result.current.handleSaveProject(); });
      expect(saveProjectRecord).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // Project record identity
  // =====================================================================
  describe('project record identity', () => {
    it('updateProjectRecordIdentity sets activeProjectRecordId', () => {
      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      act(() => { result.current.updateProjectRecordIdentity('proj-abc', 'My Zip'); });
      expect(result.current.activeProjectRecordId).toBe('proj-abc');
    });

    it('handleSavedProjectRenamed updates name when id matches', () => {
      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      act(() => { result.current.updateProjectRecordIdentity('proj-abc', 'Old'); });
      act(() => { result.current.handleSavedProjectRenamed('proj-abc', 'New'); });
      // No observable state change — just an internal ref update.
      // Verify it doesn't throw.
      expect(result.current.activeProjectRecordId).toBe('proj-abc');
    });

    it('handleSavedProjectRenamed no-ops when id does not match', () => {
      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      act(() => { result.current.updateProjectRecordIdentity('proj-abc', 'Old'); });
      act(() => { result.current.handleSavedProjectRenamed('proj-xyz', 'New'); });
      // Should not change the active id.
      expect(result.current.activeProjectRecordId).toBe('proj-abc');
    });

    it('handleSavedProjectDeleted clears identity when id matches', () => {
      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      act(() => { result.current.updateProjectRecordIdentity('proj-abc', 'Name'); });
      act(() => { result.current.handleSavedProjectDeleted('proj-abc'); });
      expect(result.current.activeProjectRecordId).toBeNull();
    });

    it('handleSavedProjectDeleted no-ops when id does not match', () => {
      const d = defaults();
      const { result } = renderHook(() => usePersistence(d));

      act(() => { result.current.updateProjectRecordIdentity('proj-abc', 'Name'); });
      act(() => { result.current.handleSavedProjectDeleted('proj-xyz'); });
      expect(result.current.activeProjectRecordId).toBe('proj-abc');
    });
  });
});
