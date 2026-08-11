import { useCallback, useRef } from 'react';

import { createAbortError, throwIfAborted } from '../lib/cancellation';
import { IDLE_PHASE, type Phase } from '../lib/progress';
import type { WorkspacePane } from '../components/WorkspaceShell';
import type { LoadedProject } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OnboardingKind = 'upload' | 'restore';

export type OnboardingRun = {
  id: number;
  kind: OnboardingKind;
  controller: AbortController;
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface UseProjectOnboardingInputs {
  /** Current project (null = no project loaded). */
  project: LoadedProject | null;
  /** State setters reset by handleCancelOnboarding. */
  setIsLoading: (v: boolean) => void;
  setRestoring: (v: boolean) => void;
  setScanning: (v: boolean) => void;
  setLogoScanning: (v: boolean) => void;
  setBusyPhase: React.Dispatch<React.SetStateAction<Phase>>;
  setError: (e: string | null) => void;
  setActiveMobilePane: (pane: WorkspacePane) => void;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface UseProjectOnboardingOutputs {
  /** Ref that tracks the currently-active onboarding run. */
  activeOnboardingRef: React.MutableRefObject<OnboardingRun | null>;
  /** Start a new onboarding run, aborting any prior one. */
  beginOnboardingRun: (kind: OnboardingKind) => OnboardingRun;
  /** Throw if the run has been aborted or superseded. */
  ensureOnboardingActive: (run: OnboardingRun) => void;
  /** Clear the active run if it matches the given run. Returns true if cleared. */
  clearOnboardingRun: (run: OnboardingRun) => boolean;
  /** Cancel the current onboarding run and reset loading state. */
  handleCancelOnboarding: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useProjectOnboarding(
  inputs: UseProjectOnboardingInputs,
): UseProjectOnboardingOutputs {
  const {
    project,
    setIsLoading,
    setRestoring,
    setScanning,
    setLogoScanning,
    setBusyPhase,
    setError,
    setActiveMobilePane,
  } = inputs;

  const activeOnboardingRef = useRef<OnboardingRun | null>(null);
  const nextOnboardingRunIdRef = useRef(1);

  const beginOnboardingRun = useCallback(
    (kind: OnboardingKind): OnboardingRun => {
      activeOnboardingRef.current?.controller.abort();
      const run: OnboardingRun = {
        id: nextOnboardingRunIdRef.current++,
        kind,
        controller: new AbortController(),
      };
      activeOnboardingRef.current = run;
      return run;
    },
    [],
  );

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
  }, [project, setIsLoading, setRestoring, setScanning, setLogoScanning, setBusyPhase, setError, setActiveMobilePane]);

  return {
    activeOnboardingRef,
    beginOnboardingRun,
    ensureOnboardingActive,
    clearOnboardingRun,
    handleCancelOnboarding,
  };
}
