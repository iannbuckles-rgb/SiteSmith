import type { AppliedPatch, EditorEditField, ImageSourceKind } from '../types';

const IMAGE_SOURCE_KINDS = new Set<ImageSourceKind>(['html', 'css', 'manifest']);
const EDITOR_FIELDS = new Set<EditorEditField>([
  'text', 'src', 'alt', 'href', 'target', 'rel', 'title', 'id', 'class',
  'style', 'role', 'aria-label', 'name', 'type', 'value', 'placeholder',
]);

/**
 * Convert IDB's deliberately-unknown patch payloads into the live union.
 * Older snapshots may contain either `{ id, patch }` envelopes or direct patch
 * objects. Malformed rows are ignored instead of being allowed to crash undo,
 * history, or export after a restore.
 */
export function readPersistedPatches(raw: unknown): AppliedPatch[] {
  if (!Array.isArray(raw)) return [];
  const patches: AppliedPatch[] = [];
  for (const entry of raw) {
    const candidate = isRecord(entry) && 'patch' in entry ? entry.patch : entry;
    if (isAppliedPatch(candidate)) patches.push(candidate);
  }
  return patches;
}

export function isAppliedPatch(value: unknown): value is AppliedPatch {
  if (!isRecord(value) || !hasString(value, 'id') || !hasFiniteNumber(value, 'appliedAt')) return false;

  switch (value.action) {
    case 'replace':
      return hasDetectionBase(value)
        && hasSourceSnapshots(value)
        && hasString(value, 'currentSourceValue')
        && hasString(value, 'newAssetPath')
        && hasString(value, 'originalAssetPath')
        && hasFiniteNumber(value, 'replacementBytes');
    case 'fit-style':
      return hasDetectionBase(value)
        && hasSourceSnapshots(value)
        && hasString(value, 'generatedCss')
        && isRecord(value.config)
        && hasString(value.config, 'fit')
        && hasString(value.config, 'position')
        && hasString(value.config, 'borderRadius')
        && hasString(value.config, 'overlay');
    case 'remove':
      return hasDetectionBase(value)
        && hasSourceSnapshots(value)
        && hasString(value, 'currentSourceValue');
    case 'placeholder':
      return hasDetectionBase(value)
        && hasSourceSnapshots(value)
        && hasString(value, 'currentSourceValue')
        && isRecord(value.placeholder)
        && hasString(value.placeholder, 'label');
    case 'manual-replace':
      return hasString(value, 'targetScope')
        && hasString(value, 'searchText')
        && hasString(value, 'replacementText')
        && typeof value.replaceAll === 'boolean'
        && hasFiniteNumber(value, 'matchCount')
        && hasFiniteNumber(value, 'filesTouched')
        && Array.isArray(value.modifiedFiles)
        && value.modifiedFiles.every(isModifiedFile);
    case 'editor-edit':
      return hasEditorBase(value)
        && Array.isArray(value.edits)
        && value.edits.length > 0
        && value.edits.every(isEditorEdit);
    case 'editor-reorder':
      return hasEditorBase(value)
        && isEditorTarget(value.reference, false)
        && (value.placement === 'before' || value.placement === 'after');
    case 'editor-nudge':
      return hasEditorBase(value)
        && hasFiniteNumber(value, 'deltaX')
        && hasFiniteNumber(value, 'deltaY')
        && hasFiniteNumber(value, 'translateX')
        && hasFiniteNumber(value, 'translateY')
        && hasString(value, 'previousStyle')
        && hasString(value, 'currentStyle');
    case 'editor-delete':
      return hasEditorBase(value) && hasString(value, 'removedSourceText');
    default:
      return false;
  }
}

function hasDetectionBase(value: Record<string, unknown>): boolean {
  return hasString(value, 'sourceFile')
    && IMAGE_SOURCE_KINDS.has(value.sourceKind as ImageSourceKind)
    && hasString(value, 'sourceTag')
    && hasString(value, 'sourceAttr')
    && hasString(value, 'rawUrl');
}

function hasEditorBase(value: Record<string, unknown>): boolean {
  return hasString(value, 'sourceFile')
    && hasSourceSnapshots(value)
    && isEditorTarget(value.target, true);
}

function hasSourceSnapshots(value: Record<string, unknown>): boolean {
  return hasString(value, 'previousSourceText') && hasString(value, 'currentSourceText');
}

function isEditorTarget(value: unknown, requireKind: boolean): boolean {
  if (!isRecord(value) || !hasString(value, 'tagName') || !hasString(value, 'label')) return false;
  return !requireKind || value.kind === 'text' || value.kind === 'image' || value.kind === 'element';
}

function isEditorEdit(value: unknown): boolean {
  return isRecord(value)
    && EDITOR_FIELDS.has(value.field as EditorEditField)
    && hasString(value, 'oldValue')
    && hasString(value, 'newValue');
}

function isModifiedFile(value: unknown): boolean {
  return isRecord(value)
    && hasString(value, 'path')
    && hasString(value, 'previousSourceText')
    && hasString(value, 'currentText');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

function hasFiniteNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'number' && Number.isFinite(value[key]);
}
