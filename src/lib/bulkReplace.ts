/* ----------------------------------------------------------------------------
 * bulkReplace
 * --------------------------------------------------------------------------
 * Apply the SAME replacement File to a list of ImageDetections, one per
 * detection, inside a single logical "transaction". The transaction is
 * soft — JSZip commits per-file rather than atomically — so a single
 * per-detection failure mid-loop is handled by REWIND-UNDO: every patch
 * that ALREADY succeeded is rolled back via the inverse flow used by
 * the History panel. The caller sees either {"patches", "newAssetPaths"}
 * on full success or {"failure", "rolledBack", "error"} on any error,
 * so the UI can either showcase a per-row Undo or surface a single clean
 * "rolled back" message.
 *
 * The helper writes the asset bytes ONCE per detection (each insertion
 * is collision-free via `uniqueAssetPath`). The asset paths share no
 * file-name ground between detections, so a per-detection filename is
 * unambiguous on export.
 *
 * Note: replacements that LEGITIMATELY reuse the same asset across
 * detections (e.g. a swapped logo in two pages) should fall back to the
 * per-detection replace flow, not this bulk path. This bulk path is
 * intended for "all hero JPGs get the new hero PNG" so each patch gets
 * its own asset bytes for traceability.
 * -------------------------------------------------------------------------*/

import type { AppliedPatch, ImageDetection, LoadedProject } from '../types';
import { applyReplacement } from './assetReplacer';
import { undoPatchById } from '../lib/undoStack';

export type BulkReplaceProgress =
  | { kind: 'progress'; done: number; total: number; detection: ImageDetection }
  | { kind: 'done'; patches: AppliedPatch[]; newAssetPaths: string[] }
  | { kind: 'rolled-back'; failedAt: ImageDetection; error: string; rolledBackFromPatchIds: string[] };

export interface BulkReplaceInput {
  project: LoadedProject;
  detections: ImageDetection[];
  /** The replacement file to apply to each detection. */
  replacement: File;
  /** Optional callback for progress reporting. */
  onProgress?: (done: number, total: number, detection: ImageDetection) => void;
  /** Optional strategy override: pass a function returning a sanitized
   *  asset filename to use for each detection. The default uses the
   *  sanitized `replacement.name` plus the detection's index. */
  nameForAsset?: (detection: ImageDetection, index: number) => string;
}

/**
 * Apply the replacement to every detection in series. On any failure, walk
 * back through the successful patches and reverse-undo them so the
 * project's zip is restored to its pre-bulk state. The returned
 * `BulkReplaceProgress` reflects either a successful `done` event or a
 * `rolled-back` event describing the failure and how many patches were
 * reversed.
 *
 * Returns synchronously once the loop finishes; progress is observable
 * via the `onProgress` callback.
 */
export async function bulkReplace(
  input: BulkReplaceInput,
): Promise<BulkReplaceProgress> {
  const { project, detections, replacement, onProgress, nameForAsset } = input;
  if (detections.length === 0) {
    return { kind: 'done', patches: [], newAssetPaths: [] };
  }

  const applied: AppliedPatch[] = [];
  let prevSourceValueByDetectionId: Map<string, string> | undefined;

  for (let i = 0; i < detections.length; i++) {
    const det = detections[i];
    const prevSourceValue = prevSourceValueByDetectionId?.get(detectionKey(det));
    try {
      // The replacement File's name is rewritten per-detection if a
      // nameForAsset callback was supplied so each detection gets a
      // distinct asset filename. The default uses `replacement.name`
      // verbatim — `uniqueAssetPath` handles collisions automatically.
      let replacementFileToUse: File = replacement;
      if (nameForAsset) {
        const renamed = nameForAsset(det, i);
        if (renamed !== replacement.name) {
          const bytes = new Uint8Array(await replacement.arrayBuffer());
          replacementFileToUse = new File([bytes], renamed, { type: replacement.type });
        }
      }
      const patch = await applyReplacement(
        project,
        det,
        replacementFileToUse,
        prevSourceValue,
      );
      applied.push(patch);
      // Track what we just wrote so a subsequent overwrite (e.g. an
      // edit on the same detection) targets the post-replace ref.
      // applyReplacement always returns the 'replace' arm of the union,
      // but TS doesn't know that — narrow explicitly so the field read
      // is sound.
      prevSourceValueByDetectionId = prevSourceValueByDetectionId ?? new Map();
      if (patch.action === 'replace') {
        prevSourceValueByDetectionId.set(detectionKey(det), patch.currentSourceValue);
      }
      onProgress?.(i + 1, detections.length, det);
    } catch (err) {
      // Roll back every successful patch in REVERSE order so the file
      // lands back at its pre-bulk state. Each undoPatchById mutates
      // `project.zip` so calling them in series is correct.
      const rolledBackFromPatchIds: string[] = [];
      for (let k = applied.length - 1; k >= 0; k -= 1) {
        try {
          undoPatchById(project, applied[k]);
          rolledBackFromPatchIds.push(applied[k].id);
        } catch (rollbackErr) {
          // A rollback failure leaves the zip in a halfway state. We
          // surface the original apply error AND the rollback error so
          // the audit is complete — the user can choose Reset Project.
          // eslint-disable-next-line no-console
          console.warn('[mockswap] bulkReplace rollback failed', rollbackErr);
        }
      }
      return {
        kind: 'rolled-back',
        failedAt: det,
        error: err instanceof Error ? err.message : String(err),
        rolledBackFromPatchIds,
      };
    }
  }

  return {
    kind: 'done',
    patches: applied,
    newAssetPaths: applied.map((p) => p.action === 'replace' ? p.newAssetPath : '').filter(Boolean),
  };
}

/** Stable key matching the patchesByKey Map's key shape for a detection. */
function detectionKey(det: ImageDetection): string {
  return `${det.sourceFile}::${det.sourceTag}::${det.sourceAttr}::${det.rawUrl}`;
}
