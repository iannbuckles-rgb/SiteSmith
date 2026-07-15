import { describe, expect, it, vi } from 'vitest';

import {
  INITIAL_PERSISTENCE_STATE,
  preventUnsavedUnload,
  reducePersistenceState,
  shouldWarnBeforeUnload,
} from '../src/lib/persistenceState';

describe('persistence state machine', () => {
  it('moves an active generation through dirty, saving, and saved', () => {
    const dirty = reducePersistenceState(INITIAL_PERSISTENCE_STATE, {
      type: 'dirty',
      generation: 1,
    });
    expect(dirty).toEqual({ status: 'dirty', generation: 1 });

    const saving = reducePersistenceState(dirty, { type: 'saving', generation: 1 });
    expect(saving).toEqual({ status: 'saving', generation: 1 });

    expect(reducePersistenceState(saving, { type: 'saved', generation: 1 }))
      .toEqual({ status: 'saved', generation: 1 });
  });

  it('moves a failed active save to at-risk', () => {
    const dirty = reducePersistenceState(INITIAL_PERSISTENCE_STATE, {
      type: 'dirty',
      generation: 2,
    });
    const saving = reducePersistenceState(dirty, { type: 'saving', generation: 2 });

    expect(reducePersistenceState(saving, { type: 'failed', generation: 2 }))
      .toEqual({ status: 'at-risk', generation: 2 });
  });

  it('ignores stale or out-of-order async completions', () => {
    const newerDirty = { status: 'dirty' as const, generation: 4 };
    expect(reducePersistenceState(newerDirty, { type: 'saved', generation: 3 }))
      .toBe(newerDirty);
    expect(reducePersistenceState(newerDirty, { type: 'saved', generation: 4 }))
      .toBe(newerDirty);
    expect(reducePersistenceState(newerDirty, { type: 'saving', generation: 5 }))
      .toBe(newerDirty);
  });

  it('resets after the project is cleared even when an older save finishes later', () => {
    const saving = { status: 'saving' as const, generation: 7 };
    const reset = reducePersistenceState(saving, { type: 'reset', generation: 8 });
    expect(reset).toEqual({ status: 'saved', generation: 8 });
    expect(reducePersistenceState(reset, { type: 'failed', generation: 7 })).toBe(reset);
  });

  it('warns on unload for every state that can lose recovery data', () => {
    expect(shouldWarnBeforeUnload('saved')).toBe(false);
    expect(shouldWarnBeforeUnload('dirty')).toBe(true);
    expect(shouldWarnBeforeUnload('saving')).toBe(true);
    expect(shouldWarnBeforeUnload('at-risk')).toBe(true);

    const preventDefault = vi.fn();
    const event = { preventDefault, returnValue: 'unchanged' } as unknown as BeforeUnloadEvent;
    preventUnsavedUnload(event);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe('');
  });
});
