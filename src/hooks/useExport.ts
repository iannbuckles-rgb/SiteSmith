import { useCallback, useState } from 'react';
import type { AppliedPatch, ExportState, ExportSummary, ImageDetection, LoadedProject } from '../types';
import { formatBytes } from '../lib/fileTypes';
import { getProjectWorkerClient } from '../lib/projectWorkerClient';
import { WorkerZipArchive } from '../lib/workerZipArchive';
import type { Phase } from '../lib/progress';

export interface UseExportInput {
  project: LoadedProject | null;
  patchesByKeyRef: { current: Map<string, AppliedPatch> };
  detections: ImageDetection[];
  flushPendingEditorWrites: () => Promise<void>;
  projectMutationBusy: boolean;
  pushToast: (toast: {
    kind: 'success' | 'warning' | 'error';
    title: string;
    detail: string;
    autoDismiss?: boolean;
  }) => string;
  setBusyPhase: (phase: Phase) => void;
}

export interface UseExportResult {
  exportState: ExportState;
  exportSummary: ExportSummary | null;
  exportError: string | null;
  handleExport: () => Promise<void>;
  handleExportAgain: () => void;
  resetExport: () => void;
}

export function useExport(input: UseExportInput): UseExportResult {
  const {
    project,
    patchesByKeyRef,
    detections,
    flushPendingEditorWrites,
    projectMutationBusy,
    pushToast,
    setBusyPhase,
  } = input;

  const [exportState, setExportState] = useState<ExportState>('idle');
  const [exportSummary, setExportSummary] = useState<ExportSummary | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const resetExport = useCallback(() => {
    setExportState('idle');
    setExportSummary(null);
    setExportError(null);
  }, []);

  const handleExport = useCallback(async () => {
    if (!project || exportState === 'busy') return;
    if (projectMutationBusy) {
      pushToast({
        kind: 'warning',
        title: 'Export is waiting on an edit',
        detail: 'Let the current editor change finish, then export again so the zip includes it.',
      });
      return;
    }
    setExportState('busy');
    setExportError(null);
    const startedAt = Date.now();
    setBusyPhase({ kind: 'exporting', progress: 0, startedAt });
    try {
      await flushPendingEditorWrites();
      const patches = Array.from(patchesByKeyRef.current.values());
      const exportResult = project.zip instanceof WorkerZipArchive
        ? await getProjectWorkerClient().buildExport({
          projectId: project.zip.projectId,
          fileName: project.fileName,
          patches,
          detections,
          mutations: await project.zip.snapshotMutations(),
          onProgress: (percent: number) => {
            setBusyPhase({ kind: 'exporting', progress: percent, startedAt });
          },
        })
        : await (await import('../lib/exportService')).buildExport(project, patches, detections, {
          onProgress: (metadata) => {
            setBusyPhase({ kind: 'exporting', progress: metadata.percent, startedAt });
          },
        });
      const { blob, filename, reportText, fileCount } = exportResult;
      const { downloadBlob } = await import('../lib/exportService');
      downloadBlob(blob, filename);
      const brokenCount = detections.filter((d) => d.status === 'missing').length;
      const remoteCount = detections.filter((d) => d.status === 'remote').length;
      const replacementCount = patches.filter((p) => p.action === 'replace').length;
      const removedCount = patches.filter((p) => p.action === 'remove').length;
      const placeholderCount = patches.filter((p) => p.action === 'placeholder').length;
      setExportSummary({
        filename,
        zipSizeBytes: blob.size,
        replacementCount,
        brokenCount,
        remoteCount,
        fileCount,
        reportText,
        removedCount,
        placeholderCount,
      });
      setExportState('success');
      pushToast({
        kind: 'success',
        title: 'Export complete',
        detail: `${filename} downloaded (${formatBytes(blob.size)}).`,
      });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
      setExportState('error');
    } finally {
      setBusyPhase({ kind: 'idle' });
    }
  }, [project, exportState, projectMutationBusy, flushPendingEditorWrites, detections, patchesByKeyRef, pushToast, setBusyPhase]);

  const handleExportAgain = useCallback(() => {
    setExportState('idle');
    setExportSummary(null);
    setExportError(null);
  }, []);

  return {
    exportState,
    exportSummary,
    exportError,
    handleExport,
    handleExportAgain,
    resetExport,
  };
}
