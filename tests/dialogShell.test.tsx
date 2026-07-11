import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DialogShell } from '../src/components/DialogShell';

describe('DialogShell', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
  });

  it('traps focus, closes on Escape, and restores focus to the opener', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root = createRoot(container);
      root.render(<DialogHarness onClose={onClose} />);
    });

    const opener = button('opener');
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await act(async () => {
      opener.click();
    });

    const cancel = button('dialog-cancel');
    const apply = button('dialog-apply');
    expect(document.activeElement).toBe(cancel);

    apply.focus();
    dispatchDialogKey('Tab');
    expect(document.activeElement).toBe(cancel);

    cancel.focus();
    dispatchDialogKey('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(apply);

    dispatchDialogKey('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="test-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  function button(testId: string): HTMLButtonElement {
    const el = container.querySelector(`[data-testid="${testId}"]`);
    if (!(el instanceof HTMLButtonElement)) throw new Error(`${testId} button missing`);
    return el;
  }
});

function DialogHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => {
    onClose();
    setOpen(false);
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-testid="opener">
        Open
      </button>
      {open && (
        <DialogShell titleId="test-dialog-title" testId="test-dialog" onClose={close}>
          <h2 id="test-dialog-title">Confirm</h2>
          <button type="button" data-testid="dialog-cancel">
            Cancel
          </button>
          <button type="button" data-testid="dialog-apply">
            Apply
          </button>
        </DialogShell>
      )}
    </>
  );
}

function dispatchDialogKey(key: string, init: KeyboardEventInit = {}): void {
  const target = document.activeElement;
  if (!target) throw new Error('No active element');
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }));
  });
}
