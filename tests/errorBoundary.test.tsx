import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { clearSession } from '../src/lib/idb';

vi.mock('../src/lib/idb', () => ({
  clearSession: vi.fn().mockResolvedValue(undefined),
}));

function BrokenPanel(): ReactElement {
  throw new Error('malformed persisted patch');
}

describe('ErrorBoundary', () => {
  const reload = vi.fn();
  let container: HTMLDivElement;
  let root: Root | null;
  let preventExpectedRenderError: (event: ErrorEvent) => void;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(clearSession).mockClear();
    reload.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    preventExpectedRenderError = (event: ErrorEvent) => {
      if (event.error instanceof Error && event.error.message === 'malformed persisted patch') {
        event.preventDefault();
      }
    };
    window.addEventListener('error', preventExpectedRenderError);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container.remove();
    window.removeEventListener('error', preventExpectedRenderError);
    vi.restoreAllMocks();
  });

  it('renders fallback UI with error details instead of crashing the test tree', async () => {
    await renderIntoContainer(
      <ErrorBoundary title="Panel crashed">
        <BrokenPanel />
      </ErrorBoundary>,
    );

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain('Panel crashed');
    expect(container.textContent).toContain('Error details');
    expect(container.textContent).toContain('malformed persisted patch');
  });

  it('clears persisted session before reloading when starting fresh', async () => {
    await renderIntoContainer(
      <ErrorBoundary reloadPage={reload}>
        <BrokenPanel />
      </ErrorBoundary>,
    );

    const button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === 'Start fresh');
    if (!(button instanceof HTMLButtonElement)) throw new Error('Start fresh button missing');

    await act(async () => {
      button.click();
    });

    expect(clearSession).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  async function renderIntoContainer(node: ReactNode): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(node);
    });
  }
});
