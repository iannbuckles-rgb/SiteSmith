import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useProjectOnboarding } from '../src/hooks/useProjectOnboarding';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubSetters() {
  return {
    setIsLoading: vi.fn(),
    setRestoring: vi.fn(),
    setScanning: vi.fn(),
    setLogoScanning: vi.fn(),
    setBusyPhase: vi.fn(),
    setError: vi.fn(),
    setActiveMobilePane: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useProjectOnboarding', () => {
  describe('beginOnboardingRun', () => {
    it('creates a run with a unique id and controller', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run = result.current.beginOnboardingRun('upload');
      });

      expect(run.id).toBeGreaterThan(0);
      expect(run!.kind).toBe('upload');
      expect(run!.controller.signal.aborted).toBe(false);
      expect(result.current.activeOnboardingRef.current).toBe(run);
    });

    it('assigns incrementing ids', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run1: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      let run2: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;

      act(() => {
        run1 = result.current.beginOnboardingRun('upload');
      });
      act(() => {
        run2 = result.current.beginOnboardingRun('restore');
      });

      expect(run2.id).toBe(run1.id + 1);
    });

    it('aborts the previous run when a new one begins', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run1: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run1 = result.current.beginOnboardingRun('upload');
      });

      expect(run1.controller.signal.aborted).toBe(false);

      act(() => {
        result.current.beginOnboardingRun('restore');
      });

      expect(run1!.controller.signal.aborted).toBe(true);
    });
  });

  describe('ensureOnboardingActive', () => {
    it('does not throw for the active run', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run = result.current.beginOnboardingRun('upload');
      });

      expect(() => {
        act(() => {
          result.current.ensureOnboardingActive(run);
        });
      }).not.toThrow();
    });

    it('throws when the run has been aborted', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run = result.current.beginOnboardingRun('upload');
      });

      run.controller.abort();

      expect(() => {
        act(() => {
          result.current.ensureOnboardingActive(run);
        });
      }).toThrow();
    });

    it('throws when a newer run has begun (superseded)', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run1: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run1 = result.current.beginOnboardingRun('upload');
      });

      act(() => {
        result.current.beginOnboardingRun('restore');
      });

      // run1 is superseded — ensureOnboardingActive should throw
      expect(() => {
        act(() => {
          result.current.ensureOnboardingActive(run1);
        });
      }).toThrow();
    });
  });

  describe('clearOnboardingRun', () => {
    it('returns true and clears ref for the active run', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run = result.current.beginOnboardingRun('upload');
      });

      let cleared: boolean = false;
      act(() => {
        cleared = result.current.clearOnboardingRun(run);
      });

      expect(cleared).toBe(true);
      expect(result.current.activeOnboardingRef.current).toBeNull();
    });

    it('returns false for a stale run', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run1: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run1 = result.current.beginOnboardingRun('upload');
      });

      let run2: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run2 = result.current.beginOnboardingRun('restore');
      });

      let cleared: boolean = false;
      act(() => {
        cleared = result.current.clearOnboardingRun(run1);
      });

      expect(cleared).toBe(false);
      expect(result.current.activeOnboardingRef.current).toBe(run2); // still run2
    });

    it('returns false when no run is active', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run = result.current.beginOnboardingRun('upload');
      });

      // Clear it first
      act(() => {
        result.current.clearOnboardingRun(run);
      });

      // Try to clear again
      let cleared: boolean = false;
      act(() => {
        cleared = result.current.clearOnboardingRun(run);
      });

      expect(cleared).toBe(false);
    });
  });

  describe('handleCancelOnboarding', () => {
    it('resets all loading state when cancelling', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      // Begin a run first
      act(() => {
        result.current.beginOnboardingRun('upload');
      });

      act(() => {
        result.current.handleCancelOnboarding();
      });

      expect(setters.setIsLoading).toHaveBeenCalledWith(false);
      expect(setters.setRestoring).toHaveBeenCalledWith(false);
      expect(setters.setScanning).toHaveBeenCalledWith(false);
      expect(setters.setLogoScanning).toHaveBeenCalledWith(false);
      expect(setters.setError).toHaveBeenCalledWith(null);
      expect(setters.setBusyPhase).toHaveBeenCalledWith(expect.objectContaining({ kind: 'idle' }));
    });

    it('sets activeMobilePane to left when no project', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      act(() => {
        result.current.beginOnboardingRun('upload');
      });

      act(() => {
        result.current.handleCancelOnboarding();
      });

      expect(setters.setActiveMobilePane).toHaveBeenCalledWith('left');
    });

    it('does NOT set activeMobilePane when project exists', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: { fileName: 'test.zip' } as any,
          ...setters,
        }),
      );

      act(() => {
        result.current.beginOnboardingRun('upload');
      });

      act(() => {
        result.current.handleCancelOnboarding();
      });

      expect(setters.setActiveMobilePane).not.toHaveBeenCalledWith('left');
    });

    it('aborts the active run controller', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run = result.current.beginOnboardingRun('upload');
      });

      const signalSpy = vi.spyOn(run.controller, 'abort');

      act(() => {
        result.current.handleCancelOnboarding();
      });

      expect(signalSpy).toHaveBeenCalled();
    });

    it('no-ops when no run is active', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      expect(() => {
        act(() => {
          result.current.handleCancelOnboarding();
        });
      }).not.toThrow();

      // No state should change since nothing was active
      expect(setters.setIsLoading).not.toHaveBeenCalled();
      expect(setters.setRestoring).not.toHaveBeenCalled();
    });

    it('clears the active ref after cancel', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      act(() => {
        result.current.beginOnboardingRun('upload');
      });

      expect(result.current.activeOnboardingRef.current).not.toBeNull();

      act(() => {
        result.current.handleCancelOnboarding();
      });

      expect(result.current.activeOnboardingRef.current).toBeNull();
    });
  });

  describe('restore kind', () => {
    it('creates a restore run', () => {
      const setters = stubSetters();
      const { result } = renderHook(() =>
        useProjectOnboarding({
          project: null,
          ...setters,
        }),
      );

      let run: ReturnType<typeof result.current.beginOnboardingRun> = undefined!;
      act(() => {
        run = result.current.beginOnboardingRun('restore');
      });

      expect(run.kind).toBe('restore');
    });
  });
});
