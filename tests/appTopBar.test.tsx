import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppTopBar } from '../src/components/AppTopBar';
import type { PersistenceStatus } from '../src/lib/persistenceState';
import type { LoadedProject } from '../src/types';

const PROJECT = {
  fileName: 'site.zip',
  entries: [],
  summary: {
    totalFiles: 1,
    totalSize: 10,
    htmlFiles: 1,
    cssFiles: 0,
    jsFiles: 0,
    imageFiles: 0,
  },
  zip: {},
} as unknown as LoadedProject;

describe('AppTopBar persistence status', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each([
    ['dirty', 'Unsaved'],
    ['saving', 'Saving…'],
    ['saved', 'Saved'],
    ['at-risk', 'Save at risk'],
  ] satisfies Array<[PersistenceStatus, string]>)('renders %s precisely', async (status, label) => {
    await render(status, PROJECT);
    const badge = container.querySelector('[data-testid="persistence-status"]');
    expect(badge?.textContent).toBe(label);
    expect(badge?.getAttribute('data-state')).toBe(status);
  });

  it('omits session status when no project is active', async () => {
    await render('saved', null);
    expect(container.querySelector('[data-testid="persistence-status"]')).toBeNull();
  });

  async function render(status: PersistenceStatus, project: LoadedProject | null): Promise<void> {
    await act(async () => {
      root.render(
        <AppTopBar
          project={project}
          progress={{ kind: 'idle' }}
          persistenceStatus={status}
          projectSaveBusy={false}
          projectMutationBusy={false}
          theme="dark"
          onSaveProject={vi.fn()}
          onSaveProjectAs={vi.fn()}
          onToggleTheme={vi.fn()}
          onCancelOnboarding={vi.fn()}
        />,
      );
    });
  }
});
