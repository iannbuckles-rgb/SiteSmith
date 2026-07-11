import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TopBarProgress } from '../src/components/TopBarProgress';

describe('TopBarProgress', () => {
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

  it('shows a cancel action for active website analysis', async () => {
    const onCancel = vi.fn();
    await render(
      <TopBarProgress
        phase={{ kind: 'detecting', startedAt: Date.now() }}
        onCancel={onCancel}
      />,
    );

    const cancel = button('top-bar-progress-cancel');
    expect(container.textContent).toContain('analyzing project');

    await act(async () => {
      cancel.click();
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not render when idle', async () => {
    await render(<TopBarProgress phase={{ kind: 'idle' }} />);

    expect(container.querySelector('[data-testid="top-bar-progress"]')).toBeNull();
  });

  async function render(node: React.ReactNode): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(node);
    });
  }

  function button(testId: string): HTMLButtonElement {
    const el = container.querySelector(`[data-testid="${testId}"]`);
    if (!(el instanceof HTMLButtonElement)) throw new Error(`${testId} button missing`);
    return el;
  }
});
