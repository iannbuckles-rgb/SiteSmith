import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LeftPanel } from '../src/components/LeftPanel';
import { makeProject } from './helpers';
import type { LeftPanelMode, LoadedProject } from '../src/types';

describe('LeftPanel', () => {
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

  it('shows the upload target before a project is loaded', async () => {
    await render(leftPanel({ project: null }));

    expect(container.textContent).toContain('Upload a website');
    expect(container.querySelector('[data-testid="zip-input"]')).not.toBeNull();
  });

  it('does not keep the full upload target after a website is loaded', async () => {
    const project = makeProject({
      'index.html': '<img src="assets/hero.png">',
      'assets/hero.png': new Uint8Array([1, 2, 3]),
    });

    await render(leftPanel({ project }));

    expect(container.textContent).not.toContain('Upload a website');
    expect(container.querySelector('[data-testid="zip-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-summary"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="file-tree"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="bottom-mode-logos"]')?.textContent).toContain('Logos');
    expect(container.textContent).not.toContain('Logo Helper');
    expect(container.textContent).toContain('change project');
  });

  async function render(node: ReactElement): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(node);
    });
  }
});

function leftPanel({
  project,
  mode = 'images',
}: {
  project: LoadedProject | null;
  mode?: LeftPanelMode;
}): ReactElement {
  return (
    <LeftPanel
      project={project}
      isLoading={false}
      error={null}
      expanded={new Set()}
      selectedPath={null}
      onToggleFolder={vi.fn()}
      onSelectFile={vi.fn()}
      onUpload={vi.fn()}
      onCancelLoading={vi.fn()}
      onReload={vi.fn()}
      detections={[]}
      thumbnails={new Map()}
      scanning={false}
      selectedDetectionKey={null}
      onSelectDetection={vi.fn()}
      mode={mode}
      onChangeMode={vi.fn()}
      onOpenSavedProject={vi.fn()}
      onSavedProjectRenamed={vi.fn()}
      onSavedProjectDeleted={vi.fn()}
      logoCandidates={[]}
      logoScanning={false}
      logoHelperBusy={false}
      logoHelperError={null}
      logoHelperSuccess={null}
      onPickLogoFile={vi.fn()}
      onClearLogoFile={vi.fn()}
      onApplyLogoHelper={vi.fn()}
      onResetLogoHelperSuccess={vi.fn()}
      manualReplaceBusy={false}
      manualReplaceError={null}
      manualReplaceRecent={[]}
      onApplyManualReplace={vi.fn()}
      onUndoManualReplace={vi.fn()}
      historyError={null}
      historyEntries={[]}
      onUndoPatchById={vi.fn()}
      onUndoLastChange={vi.fn()}
      onUndoAll={vi.fn()}
      onResetSelectedImage={vi.fn()}
      onResetProject={vi.fn()}
      checkpoints={[]}
      checkpointsLoading={false}
      checkpointBusyId={null}
      checkpointSaveBusy={false}
      canSaveCheckpoint={false}
      onSaveCheckpoint={vi.fn()}
      onRestoreCheckpoint={vi.fn()}
      onDeleteCheckpoint={vi.fn()}
      hasSelectedDetection={false}
      folderBuckets={[]}
      bulkFolder="__all__"
      bulkPendingFile={null}
      bulkBusy={false}
      scopedDetectionCount={0}
      onSetBulkFolder={vi.fn()}
      onPickBulkFile={vi.fn()}
      onClearBulkFile={vi.fn()}
      onAskBulkConfirm={vi.fn()}
    />
  );
}
