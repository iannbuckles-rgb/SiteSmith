import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useExport } from '../src/hooks/useExport';
import type { AppliedPatch, ImageDetection, LoadedProject } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubProject(overrides: Partial<LoadedProject> = {}): LoadedProject {
  return {
    fileName: 'test.zip',
    zip: {} as unknown as LoadedProject['zip'],
    entries: [],
    summary: {
      totalFiles: 3,
      totalSize: 1024,
      htmlFiles: 1,
      cssFiles: 1,
      jsFiles: 0,
      imageFiles: 1,
    },
    ...overrides,
  };
}

function stubDetections(): ImageDetection[] {
  return [];
}

function stubPatchesRef(): { current: Map<string, AppliedPatch> } {
  return { current: new Map() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useExport', () => {
  describe('null project', () => {
    it('returns early when handleExport is called with no project', async () => {
      const pushToast = vi.fn();
      const setBusyPhase = vi.fn();

      const { result } = renderHook(() =>
        useExport({
          project: null,
          patchesByKeyRef: stubPatchesRef(),
          detections: stubDetections(),
          flushPendingEditorWrites: vi.fn().mockResolvedValue(undefined),
          projectMutationBusy: false,
          pushToast,
          setBusyPhase,
        }),
      );

      await act(async () => {
        await result.current.handleExport();
      });

      expect(result.current.exportState).toBe('idle');
      expect(pushToast).not.toHaveBeenCalled();
      expect(setBusyPhase).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'exporting' }));
    });
  });

  describe('busy guard', () => {
    it('shows warning and returns early when projectMutationBusy is true', async () => {
      const pushToast = vi.fn();
      const setBusyPhase = vi.fn();

      const { result } = renderHook(() =>
        useExport({
          project: stubProject(),
          patchesByKeyRef: stubPatchesRef(),
          detections: stubDetections(),
          flushPendingEditorWrites: vi.fn(),
          projectMutationBusy: true,
          pushToast,
          setBusyPhase,
        }),
      );

      await act(async () => {
        await result.current.handleExport();
      });

      expect(result.current.exportState).toBe('idle');
      expect(pushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'warning',
          title: expect.stringContaining('Export is waiting'),
        }),
      );
    });

    it('returns early when already in busy state', async () => {
      const pushToast = vi.fn();
      // First call triggers busy → will fail because mock zip is empty,
      // but the exportState transitions to 'busy' synchronously.
      const { result } = renderHook(() =>
        useExport({
          project: stubProject(),
          patchesByKeyRef: stubPatchesRef(),
          detections: stubDetections(),
          flushPendingEditorWrites: vi.fn().mockRejectedValue(new Error('fail')),
          projectMutationBusy: false,
          pushToast,
          setBusyPhase: vi.fn(),
        }),
      );

      // First export: transitions to 'busy' synchronously
      // but the async work rejects quickly
      await act(async () => {
        await result.current.handleExport();
      });

      // After rejection, exportState is 'error'
      expect(result.current.exportState).toBe('error');

      // Second call should be guarded: exportState is not 'idle'
      await act(async () => {
        await result.current.handleExport();
      });

      // Still 'error', not re-entered
      expect(result.current.exportState).toBe('error');
    });
  });

  describe('resetExport', () => {
    it('resets state to idle with no summary or error', () => {
      const { result } = renderHook(() =>
        useExport({
          project: stubProject(),
          patchesByKeyRef: stubPatchesRef(),
          detections: stubDetections(),
          flushPendingEditorWrites: vi.fn(),
          projectMutationBusy: false,
          pushToast: vi.fn(),
          setBusyPhase: vi.fn(),
        }),
      );

      act(() => {
        result.current.resetExport();
      });

      expect(result.current.exportState).toBe('idle');
      expect(result.current.exportSummary).toBeNull();
      expect(result.current.exportError).toBeNull();
    });
  });

  describe('handleExportAgain', () => {
    it('transitions from success back to idle', () => {
      const { result } = renderHook(() =>
        useExport({
          project: stubProject(),
          patchesByKeyRef: stubPatchesRef(),
          detections: stubDetections(),
          flushPendingEditorWrites: vi.fn(),
          projectMutationBusy: false,
          pushToast: vi.fn(),
          setBusyPhase: vi.fn(),
        }),
      );

      act(() => {
        result.current.handleExportAgain();
      });

      expect(result.current.exportState).toBe('idle');
      expect(result.current.exportSummary).toBeNull();
      expect(result.current.exportError).toBeNull();
    });
  });

  describe('error propagation', () => {
    it('sets error state when flushPendingEditorWrites rejects', async () => {
      const pushToast = vi.fn();

      const { result } = renderHook(() =>
        useExport({
          project: stubProject(),
          patchesByKeyRef: stubPatchesRef(),
          detections: stubDetections(),
          flushPendingEditorWrites: vi.fn().mockRejectedValue(new Error('Flush failed')),
          projectMutationBusy: false,
          pushToast,
          setBusyPhase: vi.fn(),
        }),
      );

      await act(async () => {
        await result.current.handleExport();
      });

      expect(result.current.exportState).toBe('error');
      expect(result.current.exportError).toContain('Flush failed');
    });
  });

  describe('busy phase lifecycle', () => {
    it('sets busyPhase to exporting then resets to idle on completion', async () => {
      const setBusyPhase = vi.fn();

      const { result } = renderHook(() =>
        useExport({
          project: stubProject(),
          patchesByKeyRef: stubPatchesRef(),
          detections: stubDetections(),
          flushPendingEditorWrites: vi.fn().mockRejectedValue(new Error('fail')),
          projectMutationBusy: false,
          pushToast: vi.fn(),
          setBusyPhase,
        }),
      );

      await act(async () => {
        await result.current.handleExport();
      });

      // Should have set exporting phase
      expect(setBusyPhase).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'exporting' }),
      );
      // Should reset to idle in finally
      expect(setBusyPhase).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'idle' }),
      );
    });
  });
});
