import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock previewServer — factory mock prevents the real module (and its
// WorkerZipArchive → ProjectWorkerClient → new Worker() chain) from loading.
// ---------------------------------------------------------------------------
vi.mock('../src/lib/previewServer', () => ({
  buildPreview: vi.fn(),
  disposePreview: vi.fn(),
}));

import { usePreview } from '../src/hooks/usePreview';
import { buildPreview as _buildPreview, disposePreview as _disposePreview } from '../src/lib/previewServer';
import type { LoadedProject, ZipEntryMeta } from '../src/types';
import type { PreviewIndex } from '../src/lib/previewService';

// Narrow types to mock functions so .mockResolvedValue / .mockRejectedValue typecheck.
const buildPreview = vi.mocked(_buildPreview);
const disposePreview = vi.mocked(_disposePreview);

// ---------------------------------------------------------------------------
// Helpers — create ONCE per test, outside renderHook, for stable references.
// ---------------------------------------------------------------------------

function stubEntries(): ZipEntryMeta[] {
  return [
    { name: 'index.html', path: 'index.html', isDirectory: false, size: 100, category: 'html' },
    { name: 'style.css', path: 'style.css', isDirectory: false, size: 200, category: 'css' },
  ];
}

function stubProject(overrides: Partial<LoadedProject> = {}): LoadedProject {
  return {
    fileName: 'test.zip',
    zip: {
      file: vi.fn().mockReturnValue({ async: vi.fn().mockResolvedValue('<html></html>') }),
      generateAsync: vi.fn().mockResolvedValue(new Blob()),
    } as unknown as LoadedProject['zip'],
    entries: stubEntries(),
    summary: { totalFiles: 2, totalSize: 300, htmlFiles: 1, cssFiles: 1, jsFiles: 0, imageFiles: 0 },
    ...overrides,
  };
}

function stubPreviewIndex(overrides: Partial<PreviewIndex> = {}): PreviewIndex {
  return {
    urls: new Map([['index.html', 'blob:test']]),
    htmlPaths: ['index.html'],
    primaryPath: 'index.html',
    primaryUrl: 'blob:test',
    mode: 'compatibility',
    cacheName: null,
    diagnostics: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  buildPreview.mockResolvedValue(stubPreviewIndex());
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePreview', () => {
  // -----------------------------------------------------------------------
  // Build failure — buildPreview rejects
  // -----------------------------------------------------------------------
  describe('build failure', () => {
    it('populates previewRuntimeDiagnostics on buildPreview rejection', async () => {
      buildPreview.mockRejectedValue(new Error('Simulated build failure'));

      const project = stubProject();
      const entries = stubEntries();
      const { result } = renderHook(() =>
        usePreview({ project, liveEntries: entries, previewRevision: 0 }),
      );

      await waitFor(() => {
        expect(result.current.previewRuntimeDiagnostics.length).toBeGreaterThan(0);
      });

      const diag = result.current.previewRuntimeDiagnostics[0];
      expect(diag.level).toBe('error');
      expect(diag.message).toContain('Preview build failed');
      expect(diag.message).toContain('Simulated build failure');
      expect(result.current.previewBuilding).toBe(false);
      expect(result.current.preview).toBeNull();
    });

    it('ignores DOMException AbortError', async () => {
      buildPreview.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      const project = stubProject();
      const entries = stubEntries();
      const { result } = renderHook(() =>
        usePreview({ project, liveEntries: entries, previewRevision: 0 }),
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(result.current.previewRuntimeDiagnostics).toHaveLength(0);
    });

    it('adds diagnostic for non-DOMException AbortError (only DOMException is special-cased)', async () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      buildPreview.mockRejectedValue(err);

      const project = stubProject();
      const entries = stubEntries();
      const { result } = renderHook(() =>
        usePreview({ project, liveEntries: entries, previewRevision: 0 }),
      );

      await waitFor(() => {
        expect(result.current.previewRuntimeDiagnostics.length).toBeGreaterThan(0);
      });
      expect(result.current.previewRuntimeDiagnostics[0].message).toContain('Aborted');
    });

    it('sets previewBuilding false in finally after rejection', async () => {
      buildPreview.mockRejectedValue(new Error('fail'));

      const project = stubProject();
      const entries = stubEntries();
      const { result } = renderHook(() =>
        usePreview({ project, liveEntries: entries, previewRevision: 0 }),
      );

      await waitFor(() => {
        expect(result.current.previewBuilding).toBe(false);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Build cancellation
  // -----------------------------------------------------------------------
  describe('build cancellation', () => {
    it('cancels in-flight build when previewRevision changes', async () => {
      let resolveBuild: ((v: PreviewIndex) => void) | undefined;
      const hangingPromise = new Promise<PreviewIndex>((resolve) => {
        resolveBuild = resolve;
      });
      buildPreview.mockReturnValueOnce(hangingPromise);

      const project = stubProject();
      const entries = stubEntries();
      const { result, rerender } = renderHook(
        ({ revision }: { revision: number }) =>
          usePreview({ project, liveEntries: entries, previewRevision: revision }),
        { initialProps: { revision: 0 } },
      );

      await waitFor(() => {
        expect(result.current.previewBuilding).toBe(true);
      });

      // Bump revision → triggers controller.abort() on previous effect.
      rerender({ revision: 1 });

      await waitFor(() => {
        expect(result.current.previewBuilding).toBe(true);
      });

      resolveBuild!(stubPreviewIndex());
    });

    it('disposes stale preview index on cleanup', async () => {
      const firstIndex = stubPreviewIndex({ primaryPath: 'index.html' });
      const secondIndex = stubPreviewIndex({ primaryPath: 'about.html' });

      buildPreview
        .mockResolvedValueOnce(firstIndex)
        .mockResolvedValueOnce(secondIndex);

      const project = stubProject();
      const entries = stubEntries();
      const { result, rerender } = renderHook(
        ({ revision }: { revision: number }) =>
          usePreview({ project, liveEntries: entries, previewRevision: revision }),
        { initialProps: { revision: 0 } },
      );

      await waitFor(() => {
        expect(result.current.preview?.primaryPath).toBe('index.html');
      });

      rerender({ revision: 1 });

      await waitFor(() => {
        expect(disposePreview).toHaveBeenCalledWith(firstIndex);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Build success
  // -----------------------------------------------------------------------
  describe('build success', () => {
    it('sets preview index after successful build', async () => {
      buildPreview.mockResolvedValue(stubPreviewIndex());

      const project = stubProject();
      const entries = stubEntries();
      const { result } = renderHook(() =>
        usePreview({ project, liveEntries: entries, previewRevision: 0 }),
      );

      await waitFor(() => {
        expect(result.current.preview).not.toBeNull();
      });

      expect(result.current.preview!.primaryPath).toBe('index.html');
      expect(result.current.previewBuilding).toBe(false);
    });

    it('sets currentPagePath to primaryPath on first build', async () => {
      buildPreview.mockResolvedValue(stubPreviewIndex({ primaryPath: 'index.html' }));

      const project = stubProject();
      const entries = stubEntries();
      const { result } = renderHook(() =>
        usePreview({ project, liveEntries: entries, previewRevision: 0 }),
      );

      await waitFor(() => {
        expect(result.current.currentPagePath).toBe('index.html');
      });
    });

    it('preserves currentPagePath across rebuilds if still in new index', async () => {
      const sharedMap = new Map([['index.html', 'blob:index'], ['about.html', 'blob:about']]);
      buildPreview
        .mockResolvedValueOnce(stubPreviewIndex({ urls: sharedMap, primaryPath: 'index.html' }))
        .mockResolvedValueOnce(stubPreviewIndex({ urls: sharedMap, primaryPath: 'index.html' }));

      const project = stubProject();
      const entries = stubEntries();
      const { result, rerender } = renderHook(
        ({ revision }: { revision: number }) =>
          usePreview({ project, liveEntries: entries, previewRevision: revision }),
        { initialProps: { revision: 0 } },
      );

      await waitFor(() => {
        expect(result.current.preview).not.toBeNull();
      });

      act(() => { result.current.navigateToPage('about.html'); });
      expect(result.current.currentPagePath).toBe('about.html');

      rerender({ revision: 1 });

      await waitFor(() => {
        expect(result.current.preview).not.toBeNull();
      });
      expect(result.current.currentPagePath).toBe('about.html');
    });
  });

  // -----------------------------------------------------------------------
  // Null project
  // -----------------------------------------------------------------------
  describe('null project', () => {
    it('returns null preview and does not build', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      expect(result.current.preview).toBeNull();
      expect(result.current.previewBuilding).toBe(false);
      expect(buildPreview).not.toHaveBeenCalled();
    });

    it('navigateToPage with empty path returns early', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.navigateToPage(''); });
      expect(result.current.currentPagePath).toBe('');
    });

    it('handleNavigateBack with no history returns early', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.handleNavigateBack(); });
      expect(result.current.previewHistory.pages).toEqual([]);
    });

    it('handleNavigateForward with no history returns early', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.handleNavigateForward(); });
      expect(result.current.previewHistory.pages).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Viewport and zoom
  // -----------------------------------------------------------------------
  describe('viewport and zoom', () => {
    it('handleChangeViewport updates viewport', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.handleChangeViewport('tablet'); });
      expect(result.current.previewViewport).toBe('tablet');
    });

    it('handleChangeZoom clamps values', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.handleChangeZoom(0.1); });
      expect(result.current.previewZoom).toBe(0.25);
      act(() => { result.current.handleChangeZoom(3); });
      expect(result.current.previewZoom).toBe(2);
      act(() => { result.current.handleChangeZoom(1.5); });
      expect(result.current.previewZoom).toBe(1.5);
    });

    it('handleChangeZoom ignores non-finite values', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.handleChangeZoom(Infinity); });
      expect(result.current.previewZoom).toBe(1);
      act(() => { result.current.handleChangeZoom(NaN); });
      expect(result.current.previewZoom).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Fullscreen
  // -----------------------------------------------------------------------
  describe('fullscreen', () => {
    it('handleToggleFullscreen toggles', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      expect(result.current.previewFullscreen).toBe(false);
      act(() => { result.current.handleToggleFullscreen(); });
      expect(result.current.previewFullscreen).toBe(true);
      act(() => { result.current.handleToggleFullscreen(); });
      expect(result.current.previewFullscreen).toBe(false);
    });

    it('handleExitFullscreen sets false', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.handleToggleFullscreen(); });
      expect(result.current.previewFullscreen).toBe(true);
      act(() => { result.current.handleExitFullscreen(); });
      expect(result.current.previewFullscreen).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Preview mode
  // -----------------------------------------------------------------------
  describe('preview mode', () => {
    it('switches mode and clears editor state on preview', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.handleChangePreviewMode('editor'); });
      expect(result.current.previewMode).toBe('editor');
      act(() => { result.current.handleChangePreviewMode('preview'); });
      expect(result.current.previewMode).toBe('preview');
      expect(result.current.editorSelection).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Refresh
  // -----------------------------------------------------------------------
  describe('handleRefreshPreview', () => {
    it('increments previewKey', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      const initialKey = result.current.previewKey;
      act(() => { result.current.handleRefreshPreview(); });
      expect(result.current.previewKey).toBe(initialKey + 1);
    });
  });

  // -----------------------------------------------------------------------
  // Open in new tab
  // -----------------------------------------------------------------------
  describe('handleOpenInNewTab', () => {
    it('no-ops when there is no preview index', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.handleOpenInNewTab(); });
      expect(openSpy).not.toHaveBeenCalled();
      openSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Setter exports
  // -----------------------------------------------------------------------
  describe('setter exports', () => {
    it('exposes setEditorBusy', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.setEditorBusy(true); });
      expect(result.current.editorBusy).toBe(true);
      act(() => { result.current.setEditorBusy(false); });
      expect(result.current.editorBusy).toBe(false);
    });

    it('exposes setEditorError', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.setEditorError('err'); });
      expect(result.current.editorError).toBe('err');
      act(() => { result.current.setEditorError(null); });
      expect(result.current.editorError).toBeNull();
    });

    it('exposes setCurrentPagePath', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.setCurrentPagePath('about.html'); });
      expect(result.current.currentPagePath).toBe('about.html');
    });

    it('exposes setPreviewKey updater', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      act(() => { result.current.setPreviewKey((k) => k + 5); });
      expect(result.current.previewKey).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // Refs
  // -----------------------------------------------------------------------
  describe('previewRef and currentPagePathRef', () => {
    it('exposes stable refs', () => {
      const { result } = renderHook(() =>
        usePreview({ project: null, liveEntries: [], previewRevision: 0 }),
      );
      expect(result.current.previewRef).toBeDefined();
      expect(result.current.previewRef.current).toBeNull();
      expect(result.current.currentPagePathRef).toBeDefined();
      expect(result.current.currentPagePathRef.current).toBe('');
    });
  });
});
