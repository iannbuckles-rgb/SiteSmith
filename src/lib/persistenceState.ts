/** The recovery-session state shown in the top bar. */
export type PersistenceStatus = 'dirty' | 'saving' | 'saved' | 'at-risk';

export interface PersistenceState {
  status: PersistenceStatus;
  /** Monotonic autosave generation used to reject stale async completions. */
  generation: number;
}

export type PersistenceEvent =
  | { type: 'reset'; generation: number }
  | { type: 'dirty'; generation: number }
  | { type: 'saving'; generation: number }
  | { type: 'saved'; generation: number }
  | { type: 'failed'; generation: number };

export const INITIAL_PERSISTENCE_STATE: Readonly<PersistenceState> = Object.freeze({
  status: 'saved',
  generation: 0,
});

/**
 * Strict autosave state machine. A generation must become dirty before it can
 * save, and only that generation's in-flight save may complete. This makes a
 * late success/failure from superseded asynchronous work a no-op.
 */
export function reducePersistenceState(
  state: PersistenceState,
  event: PersistenceEvent,
): PersistenceState {
  if (event.generation < state.generation) return state;

  if (event.type === 'reset') {
    return { status: 'saved', generation: event.generation };
  }

  if (event.type === 'dirty') {
    if (state.status === 'dirty' && state.generation === event.generation) return state;
    return { status: 'dirty', generation: event.generation };
  }

  if (event.generation !== state.generation) return state;

  if (event.type === 'saving') {
    return state.status === 'dirty'
      ? { status: 'saving', generation: event.generation }
      : state;
  }

  if (state.status !== 'saving') return state;
  return {
    status: event.type === 'saved' ? 'saved' : 'at-risk',
    generation: event.generation,
  };
}

export function shouldWarnBeforeUnload(status: PersistenceStatus): boolean {
  return status !== 'saved';
}

/** Browser-standard beforeunload signal; browsers supply their own dialog text. */
export function preventUnsavedUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}
