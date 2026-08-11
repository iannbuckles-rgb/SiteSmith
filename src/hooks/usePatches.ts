import { useCallback, useState } from 'react';
import type {
  AppliedPatch,
  ImageDetection,
  ImageFitConfig,
  LeftPanelMode,
  LoadedProject,
  LogoCandidate,
  LogoHelperConfig,
} from '../types';
import type { LogoHelperSuccessSummary } from '../components/LogoHelperPanel';
import { applyPlaceholder, applyRemove, applyReplacement } from '../lib/assetReplacer';
import { bulkReplace } from '../lib/bulkReplace';
import { applyFitStyleToCss, applyFitStyleToImg } from '../lib/fitStyles';
import { applyLogoHelper } from '../lib/logoHelper';
import { applyManualReplace, undoManualReplace } from '../lib/manualReplace';
import { undoPatchById } from '../lib/undoStack';
import { formatBytes, isSupportedImageFile } from '../lib/fileTypes';
import { type Phase } from '../lib/progress';

type BulkConfirm = {
  dir: string;
  fileName: string;
  detectionCount: number;
  preview: Array<{ key: string; rawUrl: string; sourceFile: string }>;
};

/** Stable key for deduplicating detections and patch ids. */
function detectionKey(d: { sourceFile: string; sourceTag: string; sourceAttr: string; rawUrl: string }): string {
  return `${d.sourceFile}::${d.sourceTag}::${d.sourceAttr}::${d.rawUrl}`;
}

export interface UsePatchesParams {
  project: LoadedProject | null;
  selectedDetection: ImageDetection | null;
  detections: ImageDetection[];
  scopedDetections: ImageDetection[];
  logoCandidates: LogoCandidate[];
  originalFile: File | null;
  patchesByKeyRef: React.MutableRefObject<Map<string, AppliedPatch>>;
  archiveMutationVersionRef: React.MutableRefObject<number>;
  pushToast: (toast: {
    kind: 'success' | 'warning' | 'error';
    title: string;
    detail: string;
    autoDismiss?: boolean;
  }) => string;
  resetExport: () => void;
  handleUpload: (file: File) => Promise<void>;
  setPreviewRevision: React.Dispatch<React.SetStateAction<number>>;
  setPreviewKey: (updater: (k: number) => number) => void;
  setBusyPhase: React.Dispatch<React.SetStateAction<Phase>>;
  setSelectedDetectionKey: React.Dispatch<React.SetStateAction<string | null>>;
  setLeftPanelMode: React.Dispatch<React.SetStateAction<LeftPanelMode>>;
}

export interface UsePatchesResult {
  /** Core patch state (exposed for derived-state useMemos in App.tsx). */
  patchesByKey: Map<string, AppliedPatch>;

  /** State updaters that need external callers (rehydrate, persistence). */
  updatePatchesByKey: (updater: (current: Map<string, AppliedPatch>) => Map<string, AppliedPatch>) => void;
  replacePatchesByKey: (next: Map<string, AppliedPatch>) => void;

  // --- Replacement ---
  pendingFile: File | null;
  replacementBusy: boolean;
  replacementError: string | null;
  webpReencode: boolean;
  handlePickReplacementFile: (file: File) => void;
  handleCancelReplacement: () => void;
  handleToggleWebpReencode: (next: boolean) => void;
  handleApplyReplacement: () => Promise<void>;
  handleReplaceAgain: () => void;

  // --- Broken / Placeholder ---
  brokenBusy: boolean;
  brokenError: string | null;
  handleApplyBrokenAction: (action: 'remove' | 'placeholder') => Promise<void>;
  handleCancelBrokenAction: () => void;

  // --- Fit-Style ---
  fitStyleBusy: boolean;
  fitStyleError: string | null;
  handleApplyFitStyle: (config: ImageFitConfig) => Promise<void>;
  handleResetFitStyle: () => void;

  // --- Manual Replace ---
  manualReplaceBusy: boolean;
  manualReplaceError: string | null;
  handleApplyManualReplace: (input: {
    scope: string;
    searchText: string;
    replacementText: string;
    replaceAll: boolean;
    imageFile: File | null;
    customAssetFilename: string;
  }) => Promise<void>;

  // --- Logo Helper ---
  logoHelperBusy: boolean;
  logoHelperError: string | null;
  logoHelperSuccess: LogoHelperSuccessSummary | null;
  handlePickLogoFile: (file: File) => void;
  handleClearLogoFile: () => void;
  handleApplyLogoHelper: (config: LogoHelperConfig, file: File) => Promise<void>;
  handleResetLogoHelperSuccess: () => void;

  // --- Bulk Replace ---
  bulkFolder: string;
  bulkPendingFile: File | null;
  bulkConfirm: BulkConfirm | null;
  bulkBusy: boolean;
  handlePickBulkFile: (file: File) => void;
  handleClearBulkFile: () => void;
  handleSetBulkFolder: (dir: string) => void;
  handleAskBulkConfirm: () => void;
  handleCancelBulkConfirm: () => void;
  handleRunBulkConfirm: () => Promise<void>;

  // --- Undo / Reset ---
  historyError: string | null;
  undoAllConfirmOpen: boolean;
  resetConfirmOpen: boolean;
  handleUndoPatchById: (patchId: string) => void;
  handleUndoLastChange: () => void;
  handleRequestUndoAll: () => void;
  handleCancelUndoAll: () => void;
  handleConfirmUndoAll: () => void;
  handleResetSelectedImage: () => void;
  handleResetProject: () => void;
  handleCancelResetProject: () => void;
  handleConfirmResetProject: () => void;
}

export function usePatches(params: UsePatchesParams): UsePatchesResult {
  const {
    project,
    selectedDetection,
    logoCandidates,
    originalFile,
    patchesByKeyRef,
    archiveMutationVersionRef,
    pushToast,
    resetExport,
    handleUpload,
    setPreviewRevision,
    setPreviewKey,
    setBusyPhase,
    setSelectedDetectionKey,
    setLeftPanelMode,
  } = params;

  // --- State ---

  const [patchesByKey, setPatchesByKey] = useState<Map<string, AppliedPatch>>(new Map());
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [replacementBusy, setReplacementBusy] = useState(false);
  const [replacementError, setReplacementError] = useState<string | null>(null);
  const [brokenBusy, setBrokenBusy] = useState(false);
  const [brokenError, setBrokenError] = useState<string | null>(null);
  const [fitStyleBusy, setFitStyleBusy] = useState(false);
  const [fitStyleError, setFitStyleError] = useState<string | null>(null);
  const [manualReplaceBusy, setManualReplaceBusy] = useState(false);
  const [manualReplaceError, setManualReplaceError] = useState<string | null>(null);
  const [logoHelperBusy, setLogoHelperBusy] = useState(false);
  const [logoHelperError, setLogoHelperError] = useState<string | null>(null);
  const [logoHelperSuccess, setLogoHelperSuccess] = useState<LogoHelperSuccessSummary | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [bulkFolder, setBulkFolder] = useState<string>('__all__');
  const [bulkPendingFile, setBulkPendingFile] = useState<File | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<BulkConfirm | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [undoAllConfirmOpen, setUndoAllConfirmOpen] = useState(false);
  const [webpReencode, setWebpReencode] = useState(false);

  // --- State updaters ---

  const updatePatchesByKey = useCallback((updater: (current: Map<string, AppliedPatch>) => Map<string, AppliedPatch>) => {
    archiveMutationVersionRef.current += 1;
    setPatchesByKey((current) => {
      const next = updater(current);
      patchesByKeyRef.current = next;
      return next;
    });
  }, [archiveMutationVersionRef, patchesByKeyRef]);

  const replacePatchesByKey = useCallback((next: Map<string, AppliedPatch>) => {
    patchesByKeyRef.current = next;
    archiveMutationVersionRef.current += 1;
    setPatchesByKey(next);
  }, [archiveMutationVersionRef, patchesByKeyRef]);

  // --- Replacement handlers ---

  const handlePickReplacementFile = useCallback((file: File) => {
    if (!isSupportedImageFile(file)) {
      setReplacementError(
        `"${file.name}" isn't a recognized image. Choose a standard raster, vector, icon, or modern web image file.`,
      );
      return;
    }
    setReplacementError(null);
    setPendingFile(file);
  }, []);

  const handleCancelReplacement = useCallback(() => {
    setPendingFile(null);
    setReplacementError(null);
  }, []);

  const handleToggleWebpReencode = useCallback((next: boolean) => {
    setWebpReencode(next);
  }, []);

  const handleApplyReplacement = useCallback(async () => {
    if (replacementBusy || bulkBusy) return;
    if (!project || !pendingFile || !selectedDetection) return;
    setReplacementBusy(true);
    setReplacementError(null);
    try {
      let workingBytes: Uint8Array;
      let workingName: string;
      let reencoded = false;
      let fallbackNote: string | null = null;
      if (webpReencode) {
        const { reencodeToWebP, rewriteExtensionToWebp } = await import('../lib/imageReencoder');
        const result = await reencodeToWebP(pendingFile);
        if (result.reencoded) {
          workingBytes = await blobToBytes(result.blob);
          workingName = rewriteExtensionToWebp(pendingFile.name);
          reencoded = true;
        } else {
          workingBytes = await blobToBytes(result.blob);
          workingName = pendingFile.name;
          fallbackNote = result.fallbackReason ?? 're-encode skipped';
        }
      } else {
        workingBytes = new Uint8Array(await pendingFile.arrayBuffer());
        workingName = pendingFile.name;
      }

      const id = detectionKey(selectedDetection);
      const prev = patchesByKey.get(id);
      const prevSourceValue = prev?.action === 'replace' ? prev.currentSourceValue : undefined;

      const patch = await applyReplacement(project, selectedDetection, {
        bytes: workingBytes,
        filename: workingName,
        reencoded,
        previousSourceValue: prevSourceValue,
      });

      updatePatchesByKey((map) => {
        const next = new Map(map);
        next.set(patch.id, patch);
        return next;
      });
      setPendingFile(null);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      resetExport();

      if (fallbackNote) {
        setReplacementError(`Re-encode skipped: ${fallbackNote}. Original bytes used.`);
      }
      if (reencoded) {
        const originalSize = pendingFile.size;
        const newSize = workingBytes.byteLength;
        const savedPct = Math.max(1, Math.min(99, Math.round((1 - newSize / originalSize) * 100)));
        pushToast({
          kind: 'success',
          title: `Saved ${savedPct}% on disk`,
          detail: `${workingName} \u00b7 ${formatBytes(originalSize)} \u2192 ${formatBytes(newSize)}`,
        });
      }
    } catch (err) {
      setReplacementError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplacementBusy(false);
    }
  }, [replacementBusy, bulkBusy, project, pendingFile, selectedDetection, patchesByKey, webpReencode, updatePatchesByKey, setPreviewRevision, setPreviewKey, resetExport, pushToast]);

  // --- Broken / Placeholder handlers ---

  const handleCancelBrokenAction = useCallback(() => {
    setBrokenError(null);
  }, []);

  const handleApplyBrokenAction = useCallback(async (action: 'remove' | 'placeholder') => {
    if (brokenBusy) return;
    if (!project || !selectedDetection) return;
    setBrokenBusy(true);
    setBrokenError(null);
    try {
      const id = detectionKey(selectedDetection);
      const patch = action === 'remove'
        ? await applyRemove(project, selectedDetection)
        : await applyPlaceholder(project, selectedDetection);
      updatePatchesByKey((map) => {
        const next = new Map(map);
        next.set(id, patch);
        return next;
      });
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      resetExport();
    } catch (err) {
      setBrokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBrokenBusy(false);
    }
  }, [brokenBusy, project, selectedDetection, updatePatchesByKey, setPreviewRevision, setPreviewKey, resetExport]);

  // --- Fit-Style handlers ---

  const handleApplyFitStyle = useCallback(async (config: ImageFitConfig) => {
    if (fitStyleBusy) return;
    if (!project || !selectedDetection) return;
    setFitStyleBusy(true);
    setFitStyleError(null);
    try {
      const zipFile = project.zip.file(selectedDetection.sourceFile);
      if (!zipFile) throw new Error(`Source file "${selectedDetection.sourceFile}" not found in archive.`);
      const sourceText = await zipFile.async('text');
      const result = selectedDetection.sourceKind === 'css'
        ? applyFitStyleToCss(sourceText, selectedDetection, config)
        : applyFitStyleToImg(sourceText, selectedDetection, config);
      if (!result.changed) {
        throw new Error('Could not find the URL in the source file. Was the file already modified?');
      }
      project.zip.file(selectedDetection.sourceFile, result.sourceText);

      const id = detectionKey(selectedDetection);
      const fitKey = `${id}#fit`;
      const patch: AppliedPatch = {
        id: fitKey,
        sourceFile: selectedDetection.sourceFile,
        sourceKind: selectedDetection.sourceKind,
        sourceTag: selectedDetection.sourceTag,
        sourceAttr: selectedDetection.sourceAttr,
        rawUrl: selectedDetection.rawUrl,
        action: 'fit-style',
        config,
        generatedCss: result.generatedCss,
        appliedAt: Date.now(),
        previousSourceText: sourceText,
        currentSourceText: result.sourceText,
      };
      updatePatchesByKey((map) => {
        const next = new Map(map);
        next.set(fitKey, patch);
        return next;
      });
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      resetExport();
    } catch (err) {
      setFitStyleError(err instanceof Error ? err.message : String(err));
    } finally {
      setFitStyleBusy(false);
    }
  }, [fitStyleBusy, project, selectedDetection, updatePatchesByKey, setPreviewRevision, setPreviewKey, resetExport]);

  // --- Manual Replace ---

  const handleApplyManualReplace = useCallback(async (input: {
    scope: string;
    searchText: string;
    replacementText: string;
    replaceAll: boolean;
    imageFile: File | null;
    customAssetFilename: string;
  }) => {
    if (!project || manualReplaceBusy) return;
    setManualReplaceBusy(true);
    setManualReplaceError(null);
    try {
      const { patch } = await applyManualReplace(project, input);
      updatePatchesByKey((map) => {
        const next = new Map(map);
        next.set(patch.id, patch);
        return next;
      });
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      resetExport();
    } catch (err) {
      setManualReplaceError(err instanceof Error ? err.message : String(err));
    } finally {
      setManualReplaceBusy(false);
    }
  }, [project, manualReplaceBusy, updatePatchesByKey, setPreviewRevision, setPreviewKey, resetExport]);

  // --- Logo Helper ---

  const handlePickLogoFile = useCallback((file: File) => {
    if (!isSupportedImageFile(file)) {
      setLogoHelperError(`"${file.name}" isn't a recognized image. Choose a raster, vector, icon, or modern web image file.`);
      return;
    }
    setLogoHelperError(null);
    setLogoHelperSuccess(null);
  }, []);

  const handleClearLogoFile = useCallback(() => {
    setLogoHelperError(null);
  }, []);

  const handleApplyLogoHelper = useCallback(async (config: LogoHelperConfig, file: File) => {
    if (!project || logoHelperBusy) return;
    setLogoHelperBusy(true);
    setLogoHelperError(null);
    try {
      const { patches } = await applyLogoHelper(project, logoCandidates, file, config);
      if (patches.length === 0) {
        throw new Error('No changes were applied. Check that selected targets exist in this project.');
      }
      updatePatchesByKey((map) => {
        const next = new Map(map);
        for (const p of patches) next.set(p.id, p);
        return next;
      });
      const textInjected = patches.some(
        (p) => p.action === 'replace' && (p.injectedTextBlock?.startsWith('<span') === true),
      );
      setLogoHelperSuccess({
        appliedAt: patches[0].appliedAt,
        targets: Array.from(config.targets),
        headerMode: config.headerMode,
        businessName: config.businessName.trim(),
        patchCount: patches.length,
        filesTouched: Array.from(new Set(patches.flatMap((p) => p.action !== 'manual-replace' ? [p.sourceFile] : []))),
        textInjected,
      });
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      resetExport();
    } catch (err) {
      setLogoHelperError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogoHelperBusy(false);
    }
  }, [project, logoHelperBusy, logoCandidates, updatePatchesByKey, setPreviewRevision, setPreviewKey, resetExport]);

  const handleResetLogoHelperSuccess = useCallback(() => {
    setLogoHelperSuccess(null);
    setLogoHelperError(null);
  }, []);

  // --- Undo / Reset ---

  const handleUndoPatchById = useCallback((patchId: string) => {
    if (!project) return;
    const target = patchesByKey.get(patchId);
    if (!target) return;
    // Manual-replace: single atomic undo.
    if (target.action === 'manual-replace') {
      try {
        undoManualReplace(project, target);
        updatePatchesByKey((map) => {
          const next = new Map(map);
          next.delete(patchId);
          return next;
        });
        setHistoryError(null);
        setPreviewRevision((r) => r + 1);
        setPreviewKey((k) => k + 1);
        resetExport();
      } catch (err) {
        setHistoryError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    // Compute the cascade window.
    const touchesTargetSourceFile = (p: AppliedPatch): boolean => {
      if (p.action === 'manual-replace') {
        return Array.isArray(p.modifiedFiles)
          && p.modifiedFiles.some((m) => m.path === target.sourceFile);
      }
      return p.sourceFile === target.sourceFile;
    };
    const cascade = Array.from(patchesByKey.values())
      .filter((p) => touchesTargetSourceFile(p) && p.appliedAt >= target.appliedAt)
      .sort((a, b) => b.appliedAt - a.appliedAt);
    try {
      for (const p of cascade) undoPatchById(project, p);
      updatePatchesByKey((map) => {
        const next = new Map(map);
        for (const p of cascade) next.delete(p.id);
        return next;
      });
      setHistoryError(null);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      resetExport();
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    }
  }, [project, patchesByKey, updatePatchesByKey, setPreviewRevision, setPreviewKey, resetExport]);

  // Now that handleUndoPatchById is defined, fix handleResetFitStyle:
  // We'll use a separate version that references it.
  // (This is resolved at the bottom of the hook.)

  const handleUndoLastChange = useCallback(() => {
    if (!project || patchesByKey.size === 0) return;
    let latest: AppliedPatch | null = null;
    for (const p of patchesByKey.values()) {
      if (!latest || p.appliedAt > latest.appliedAt) latest = p;
    }
    if (latest) handleUndoPatchById(latest.id);
  }, [project, patchesByKey, handleUndoPatchById]);

  const handleUndoAll = useCallback(() => {
    if (!project || patchesByKey.size === 0) return;
    const sorted = Array.from(patchesByKey.values()).sort((a, b) => b.appliedAt - a.appliedAt);
    try {
      for (const p of sorted) undoPatchById(project, p);
      replacePatchesByKey(new Map());
      setHistoryError(null);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      resetExport();
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    }
  }, [project, patchesByKey, replacePatchesByKey, setPreviewRevision, setPreviewKey, resetExport]);

  const handleRequestUndoAll = useCallback(() => {
    if (patchesByKey.size === 0) return;
    setUndoAllConfirmOpen(true);
  }, [patchesByKey.size]);

  const handleCancelUndoAll = useCallback(() => {
    setUndoAllConfirmOpen(false);
  }, []);

  const handleConfirmUndoAll = useCallback(() => {
    setUndoAllConfirmOpen(false);
    handleUndoAll();
  }, [handleUndoAll]);

  const handleResetSelectedImage = useCallback(() => {
    if (!project || !selectedDetection) return;
    const baseId = detectionKey(selectedDetection);
    const related = Array.from(patchesByKey.values())
      .filter((p) => p.action !== 'manual-replace' && p.action !== 'editor-edit' && p.action !== 'editor-reorder' && p.action !== 'editor-nudge' && p.action !== 'editor-delete')
      .filter((p) => p.id === baseId || p.id.startsWith(baseId + '#'))
      .sort((a, b) => b.appliedAt - a.appliedAt);
    if (related.length === 0) {
      setHistoryError('No patches to reset for the selected image.');
      return;
    }
    try {
      for (const p of related) undoPatchById(project, p);
      updatePatchesByKey((map) => {
        const next = new Map(map);
        for (const p of related) next.delete(p.id);
        return next;
      });
      setHistoryError(null);
      setSelectedDetectionKey(null);
      setPreviewRevision((r) => r + 1);
      setPreviewKey((k) => k + 1);
      resetExport();
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    }
  }, [project, selectedDetection, patchesByKey, updatePatchesByKey, setSelectedDetectionKey, setPreviewRevision, setPreviewKey, resetExport]);

  const handleReplaceAgain = useCallback(() => {
    if (!selectedDetection) return;
    const id = detectionKey(selectedDetection);
    handleUndoPatchById(id);
    handleUndoPatchById(`${id}#fit`);
    setSelectedDetectionKey(null);
    setPendingFile(null);
    setReplacementError(null);
    setBrokenError(null);
    setFitStyleError(null);
  }, [selectedDetection, handleUndoPatchById, setSelectedDetectionKey]);

  const handleResetProject = useCallback(() => {
    if (!originalFile) {
      setHistoryError('No original zip is remembered for this session.');
      return;
    }
    setResetConfirmOpen(true);
  }, [originalFile]);

  const handleCancelResetProject = useCallback(() => {
    setResetConfirmOpen(false);
  }, []);

  const handleConfirmResetProject = useCallback(() => {
    if (!originalFile) {
      setResetConfirmOpen(false);
      setHistoryError('No original zip is remembered for this session.');
      return;
    }
    setResetConfirmOpen(false);
    void handleUpload(originalFile);
    setHistoryError(null);
    setLeftPanelMode('images');
    replacePatchesByKey(new Map());
    setBulkPendingFile(null);
    setBulkConfirm(null);
  }, [originalFile, handleUpload, setLeftPanelMode, replacePatchesByKey]);

  // --- Bulk Replace ---

  const handlePickBulkFile = useCallback((file: File) => {
    if (!isSupportedImageFile(file)) {
      setHistoryError(`"${file.name}" isn't an image. Bulk replace needs an image file.`);
      return;
    }
    setBulkPendingFile(file);
    setHistoryError(null);
  }, []);

  const handleClearBulkFile = useCallback(() => {
    setBulkPendingFile(null);
    setBulkConfirm(null);
  }, []);

  const handleSetBulkFolder = useCallback((dir: string) => {
    setBulkFolder(dir);
  }, []);

  const handleAskBulkConfirm = useCallback(() => {
    if (!project || !bulkPendingFile || params.scopedDetections.length === 0) return;
    setBulkConfirm({
      dir: bulkFolder,
      fileName: bulkPendingFile.name,
      detectionCount: params.scopedDetections.length,
      preview: params.scopedDetections.slice(0, 8).map((d) => ({
        key: detectionKey(d),
        rawUrl: d.rawUrl,
        sourceFile: d.sourceFile,
      })),
    });
  }, [project, bulkPendingFile, params.scopedDetections, bulkFolder]);

  const handleCancelBulkConfirm = useCallback(() => {
    setBulkConfirm(null);
  }, []);

  const handleRunBulkConfirm = useCallback(async () => {
    if (!project || !bulkPendingFile || params.scopedDetections.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkConfirm(null);
    setHistoryError(null);
    const total = params.scopedDetections.length;
    const fileName = bulkPendingFile.name;
    setBusyPhase({ kind: 'bulk-replacing', done: 0, total, fileName });
    try {
      const result = await bulkReplace({
        project,
        detections: params.scopedDetections,
        replacement: bulkPendingFile,
        nameForAsset: (_det, idx) => {
          const safe = bulkPendingFile.name.replace(/\.[^./]+$/, '') || 'asset';
          const ext = bulkPendingFile.name.match(/\.[^./]+$/)?.[0] || '';
          return `${safe}-${idx + 1}${ext}`;
        },
        onProgress: (done, reportedTotal) => {
          setBusyPhase({
            kind: 'bulk-replacing',
            done,
            total: reportedTotal,
            fileName,
          });
        },
      });
      if (result.kind === 'done') {
        updatePatchesByKey((map) => {
          const next = new Map(map);
          for (const p of result.patches) next.set(p.id, p);
          return next;
        });
        setBulkPendingFile(null);
        setPreviewRevision((r) => r + 1);
        setPreviewKey((k) => k + 1);
        resetExport();
        pushToast({
          kind: 'success',
          title: 'Bulk replace finished',
          detail: `${result.patches.length} image${result.patches.length !== 1 ? 's' : ''} replaced.`,
        });
      } else if (result.kind === 'rolled-back') {
        const failedDetection = result.failedAt;
        setHistoryError(
          `Bulk replace rolled back after failing on ${failedDetection.rawUrl} (in ${failedDetection.sourceFile}): ${result.error}. ${result.rolledBackFromPatchIds.length} earlier patches were undone.`,
        );
        setBulkPendingFile(null);
        setPreviewRevision((r) => r + 1);
        setPreviewKey((k) => k + 1);
      }
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
      setBusyPhase({ kind: 'idle' });
    }
  }, [project, bulkPendingFile, bulkBusy, params.scopedDetections, updatePatchesByKey, setBusyPhase, setPreviewRevision, setPreviewKey, resetExport, pushToast]);

  // --- Re-resolve handleResetFitStyle with actual handleUndoPatchById ---
  const handleResetFitStyleResolved = useCallback(() => {
    if (!selectedDetection) return;
    const id = detectionKey(selectedDetection);
    handleUndoPatchById(`${id}#fit`);
  }, [selectedDetection, handleUndoPatchById]);

  return {
    patchesByKey,
    updatePatchesByKey,
    replacePatchesByKey,

    pendingFile,
    replacementBusy,
    replacementError,
    webpReencode,
    handlePickReplacementFile,
    handleCancelReplacement,
    handleToggleWebpReencode,
    handleApplyReplacement,
    handleReplaceAgain,

    brokenBusy,
    brokenError,
    handleApplyBrokenAction,
    handleCancelBrokenAction,

    fitStyleBusy,
    fitStyleError,
    handleApplyFitStyle,
    handleResetFitStyle: handleResetFitStyleResolved,

    manualReplaceBusy,
    manualReplaceError,
    handleApplyManualReplace,

    logoHelperBusy,
    logoHelperError,
    logoHelperSuccess,
    handlePickLogoFile,
    handleClearLogoFile,
    handleApplyLogoHelper,
    handleResetLogoHelperSuccess,

    bulkFolder,
    bulkPendingFile,
    bulkConfirm,
    bulkBusy,
    handlePickBulkFile,
    handleClearBulkFile,
    handleSetBulkFolder,
    handleAskBulkConfirm,
    handleCancelBulkConfirm,
    handleRunBulkConfirm,

    historyError,
    undoAllConfirmOpen,
    resetConfirmOpen,
    handleUndoPatchById,
    handleUndoLastChange,
    handleRequestUndoAll,
    handleCancelUndoAll,
    handleConfirmUndoAll,
    handleResetSelectedImage,
    handleResetProject,
    handleCancelResetProject,
    handleConfirmResetProject,
  };
}

/** Small helper – same as App.tsx's blobToBytes. */
async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
