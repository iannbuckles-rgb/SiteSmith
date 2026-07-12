/* ----------------------------------------------------------------------------
 * undoStack
 * --------------------------------------------------------------------------
 * Pure-function reducer that mutates a `LoadedProject`'s zip to revert a
 * single `AppliedPatch`. Lives in a lib module (rather than inside
 * `App.tsx`) so the bulk-replace helper and any future tooling can call
 * the SAME undo primitive, keeping the project zip's restore semantics
 * in one place. The function's contract:
 *
 *   - Mutates `project.zip` IN PLACE (no return value carries the new
 *     zip; callers continue to hold the same `project` reference).
 *   - For each `AppliedPatch.action`:
 *       replace          — overwrite sourceFile with previousSourceText;
 *                          drop newAssetPath from the zip.
 *       manual-replace   — restore every modifiedFiles[].path to its
 *                          previousSourceText; drop newAssetPath.
 *       fit-style        — overwrite sourceFile with previousSourceText.
 *       remove           — overwrite sourceFile with previousSourceText.
 *       placeholder      — overwrite sourceFile with previousSourceText.
 *       editor-edit      — overwrite sourceFile with previousSourceText.
 *       editor-reorder   — overwrite sourceFile with previousSourceText.
 *   - Idempotent: re-applying on a zip that's already restored is a
 *     harmless write of the same bytes.
 *   - Best-effort on asset removal: a failure throws so the caller can
 *     surface it via the History panel's `historyError` slot.
 *
 * Why this lives in a lib: keeps the "what is an undo?" decision in
 * exactly one module. Bulk-replace's rollback path and App.tsx's
 * handleUndoPatchById both call it; any future "Undo & re-edit" or
 * "Test undo before applying" feature joins the same dispatcher.
 * -------------------------------------------------------------------------*/

import type { AppliedPatch, LoadedProject } from '../types';
import { undoManualReplace } from './manualReplace';

/**
 * Restore the project zip to its state JUST BEFORE `patch` was applied.
 * Throws if the patch type is unexpected (defensive — every variant in
 * the `AppliedPatch` union is handled, so this is purely for future
 * expansion safety).
 */
export function undoPatchById(project: LoadedProject, patch: AppliedPatch): void {
  switch (patch.action) {
    case 'replace': {
      project.zip.file(patch.sourceFile, patch.previousSourceText);
      if (patch.newAssetPath) {
        project.zip.remove(patch.newAssetPath);
      }
      return;
    }
    case 'manual-replace': {
      undoManualReplace(project, patch);
      return;
    }
    case 'fit-style':
    case 'remove':
    case 'placeholder':
    case 'editor-edit':
    case 'editor-reorder': {
      project.zip.file(patch.sourceFile, patch.previousSourceText);
      return;
    }
  }
}

/**
 * Walk every patch in REVERSE chronological order and undo each one.
 * Returns the list of patch ids that were successfully rolled back so
 * the caller can surface a count to the user. Used by the History
 * panel's "Undo All" affordance.
 *
 * Topologically safe because each patch's `previousSourceText` was
 * captured at the moment of apply against the file state as it then
 * stood; rolling back in DESC `appliedAt` order returns the zip to its
 * pre-pre-state.
 */
export function undoMany(project: LoadedProject, patches: AppliedPatch[]): string[] {
  const sorted = [...patches].sort((a, b) => b.appliedAt - a.appliedAt);
  const rolledBack: string[] = [];
  for (const patch of sorted) {
    try {
      undoPatchById(project, patch);
      rolledBack.push(patch.id);
    } catch (err) {
      // Continue the rollback loop even if one fails — surface what we
      // already rolled back, and let the next caller see the partial
      // failure via `historyError`. A typical cause is a manual-replace
      // asset that no longer exists in the zip (e.g. user manually
      // evicted a file), but we still want to roll back the text part.
      // eslint-disable-next-line no-console
      console.warn('[mockswap] undoMany: rollback step failed', patch.id, err);
    }
  }
  return rolledBack;
}
