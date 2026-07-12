import type { AppliedPatch, EditorAppliedEdit, EditorEditField, LoadedProject } from '../types';
import type { EditorReorderTarget, EditorSelection } from './previewControls';

export interface ApplyEditorEditInput {
  selection: EditorSelection;
  edits: Array<{
    field: EditorEditField;
    newValue: string;
    oldValue?: string;
  }>;
}

export interface ApplyEditorReorderInput {
  selection: EditorSelection;
  reference: EditorReorderTarget;
  placement: 'before' | 'after';
}

type EditorEditPatch = Extract<AppliedPatch, { action: 'editor-edit' }>;
type EditorReorderPatch = Extract<AppliedPatch, { action: 'editor-reorder' }>;
type EditorDeletePatch = Extract<AppliedPatch, { action: 'editor-delete' }>;

type OpenTagRange = {
  start: number;
  end: number;
};

type ElementRange = OpenTagRange;

type ReorderLocator = {
  tagName: string;
  label?: string;
  text?: string;
  sourceStart?: number;
  sourceEnd?: number;
  src?: string;
  alt?: string;
  href?: string;
  elementId?: string;
  className?: string;
};

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const ATTR_BY_FIELD: Partial<Record<EditorEditField, string>> = {
  src: 'src',
  alt: 'alt',
  href: 'href',
  class: 'class',
  style: 'style',
};

export async function applyEditorEdit(
  project: LoadedProject,
  input: ApplyEditorEditInput,
): Promise<EditorEditPatch> {
  const normalizedEdits = normalizeEdits(input.selection, input.edits);
  if (normalizedEdits.length === 0) {
    throw new Error('No editor changes to apply.');
  }

  const zipFile = project.zip.file(input.selection.sourceFile);
  if (!zipFile) {
    throw new Error(`Source file "${input.selection.sourceFile}" not found in archive.`);
  }

  const previousSourceText = await zipFile.async('text');
  const tagName = input.selection.tagName.toLowerCase();
  const openingRange = locateOpeningTag(previousSourceText, input.selection);
  let currentSourceText = previousSourceText;
  let currentOpenStart = openingRange.start;
  let currentOpenEnd = openingRange.end;

  const attributeEdits = normalizedEdits.filter((edit) => edit.field !== 'text');
  for (const edit of attributeEdits) {
    const attr = ATTR_BY_FIELD[edit.field];
    if (!attr) continue;
    if ((attr === 'src' || attr === 'href') && edit.newValue.trim().length === 0) {
      throw new Error(`${attr} cannot be empty.`);
    }
    const opening = currentSourceText.slice(currentOpenStart, currentOpenEnd);
    const nextOpening = setAttribute(opening, attr, edit.newValue, attr === 'class' || attr === 'style');
    if (nextOpening !== opening) {
      currentSourceText = currentSourceText.slice(0, currentOpenStart)
        + nextOpening
        + currentSourceText.slice(currentOpenEnd);
      currentOpenEnd = currentOpenStart + nextOpening.length;
    }
  }

  const textEdit = normalizedEdits.find((edit) => edit.field === 'text');
  if (textEdit) {
    if (VOID_TAGS.has(tagName)) {
      throw new Error(`<${tagName}> cannot contain editable text.`);
    }
    const inner = findElementInnerRange(currentSourceText, tagName, currentOpenEnd);
    const escaped = escapeHtmlText(textEdit.newValue);
    currentSourceText = currentSourceText.slice(0, inner.start)
      + escaped
      + currentSourceText.slice(inner.end);
  }

  if (currentSourceText === previousSourceText) {
    throw new Error('The selected element did not change.');
  }

  project.zip.file(input.selection.sourceFile, currentSourceText);

  return {
    id: `editor:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    action: 'editor-edit',
    sourceFile: input.selection.sourceFile,
    target: {
      kind: input.selection.kind,
      tagName: input.selection.tagName,
      label: input.selection.label,
      selectorHint: input.selection.selectorHint,
      sourceStart: input.selection.sourceStart,
      sourceEnd: input.selection.sourceEnd,
    },
    edits: normalizedEdits,
    appliedAt: Date.now(),
    previousSourceText,
    currentSourceText,
  };
}

export async function applyEditorReorder(
  project: LoadedProject,
  input: ApplyEditorReorderInput,
): Promise<EditorReorderPatch> {
  if (input.selection.sourceFile.trim().length === 0) {
    throw new Error('Selected element does not have a source file.');
  }
  if (input.placement !== 'before' && input.placement !== 'after') {
    throw new Error('Unsupported reorder placement.');
  }

  const zipFile = project.zip.file(input.selection.sourceFile);
  if (!zipFile) {
    throw new Error(`Source file "${input.selection.sourceFile}" not found in archive.`);
  }

  const previousSourceText = await zipFile.async('text');
  const sourceOpen = locateOpeningTag(previousSourceText, input.selection);
  const referenceOpen = locateOpeningTag(previousSourceText, input.reference);
  const sourceElement = findElementRange(previousSourceText, input.selection.tagName.toLowerCase(), sourceOpen);
  const referenceElement = findElementRange(previousSourceText, input.reference.tagName.toLowerCase(), referenceOpen);
  const sourceRange = expandRangeForMove(previousSourceText, sourceElement);
  const referenceRange = expandRangeForMove(previousSourceText, referenceElement);

  if (rangesOverlap(sourceRange, referenceRange)) {
    throw new Error('Selected element and reorder target overlap.');
  }

  const movingText = previousSourceText.slice(sourceRange.start, sourceRange.end);
  const withoutMoving = previousSourceText.slice(0, sourceRange.start)
    + previousSourceText.slice(sourceRange.end);
  const removedLength = sourceRange.end - sourceRange.start;
  const adjustedReference = referenceRange.start > sourceRange.start
    ? {
      start: referenceRange.start - removedLength,
      end: referenceRange.end - removedLength,
    }
    : referenceRange;
  const insertAt = input.placement === 'before'
    ? adjustedReference.start
    : adjustedReference.end;
  const currentSourceText = withoutMoving.slice(0, insertAt)
    + movingText
    + withoutMoving.slice(insertAt);

  if (currentSourceText === previousSourceText) {
    throw new Error('The selected element is already in that position.');
  }

  project.zip.file(input.selection.sourceFile, currentSourceText);

  return {
    id: `editor-reorder:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    action: 'editor-reorder',
    sourceFile: input.selection.sourceFile,
    target: {
      kind: input.selection.kind,
      tagName: input.selection.tagName,
      label: input.selection.label,
      selectorHint: input.selection.selectorHint,
      sourceStart: input.selection.sourceStart,
      sourceEnd: input.selection.sourceEnd,
    },
    reference: {
      tagName: input.reference.tagName,
      label: input.reference.label,
      selectorHint: input.reference.selectorHint,
      sourceStart: input.reference.sourceStart,
      sourceEnd: input.reference.sourceEnd,
    },
    placement: input.placement,
    appliedAt: Date.now(),
    previousSourceText,
    currentSourceText,
  };
}

export async function applyEditorDelete(
  project: LoadedProject,
  selection: EditorSelection,
): Promise<EditorDeletePatch> {
  if (selection.sourceFile.trim().length === 0) {
    throw new Error('Selected element does not have a source file.');
  }

  const zipFile = project.zip.file(selection.sourceFile);
  if (!zipFile) {
    throw new Error(`Source file "${selection.sourceFile}" not found in archive.`);
  }

  const previousSourceText = await zipFile.async('text');
  const openingRange = locateOpeningTag(previousSourceText, selection);
  const elementRange = findElementRange(previousSourceText, selection.tagName.toLowerCase(), openingRange);
  const deleteRange = expandRangeForMove(previousSourceText, elementRange);
  const removedSourceText = previousSourceText.slice(deleteRange.start, deleteRange.end);
  const currentSourceText = previousSourceText.slice(0, deleteRange.start)
    + previousSourceText.slice(deleteRange.end);

  if (currentSourceText === previousSourceText || removedSourceText.trim().length === 0) {
    throw new Error('The selected element could not be deleted.');
  }

  project.zip.file(selection.sourceFile, currentSourceText);

  return {
    id: `editor-delete:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    action: 'editor-delete',
    sourceFile: selection.sourceFile,
    target: {
      kind: selection.kind,
      tagName: selection.tagName,
      label: selection.label,
      selectorHint: selection.selectorHint,
      sourceStart: selection.sourceStart,
      sourceEnd: selection.sourceEnd,
    },
    removedSourceText,
    appliedAt: Date.now(),
    previousSourceText,
    currentSourceText,
  };
}

function normalizeEdits(
  selection: EditorSelection,
  edits: ApplyEditorEditInput['edits'],
): EditorAppliedEdit[] {
  const currentValues: Record<EditorEditField, string> = {
    text: selection.text ?? '',
    src: selection.src ?? '',
    alt: selection.alt ?? '',
    href: selection.href ?? '',
    class: selection.className ?? '',
    style: selection.style ?? '',
  };
  const out: EditorAppliedEdit[] = [];
  for (const edit of edits) {
    const oldValue = edit.oldValue ?? currentValues[edit.field] ?? '';
    const newValue = edit.field === 'text'
      ? edit.newValue.trim()
      : edit.newValue.trim();
    if (oldValue.trim() === newValue.trim()) continue;
    out.push({ field: edit.field, oldValue, newValue });
  }
  return out;
}

function locateOpeningTag(source: string, selection: ReorderLocator): OpenTagRange {
  const tagName = selection.tagName.toLowerCase();
  if (
    typeof selection.sourceStart === 'number'
    && typeof selection.sourceEnd === 'number'
    && selection.sourceStart >= 0
    && selection.sourceEnd > selection.sourceStart
    && selection.sourceEnd <= source.length
  ) {
    const candidate = source.slice(selection.sourceStart, selection.sourceEnd);
    if (isOpeningTagFor(candidate, tagName)) {
      return { start: selection.sourceStart, end: selection.sourceEnd };
    }
  }

  const byAttribute = findTagByAttribute(source, tagName, selection);
  if (byAttribute) return byAttribute;

  const byText = findTagByText(source, tagName, selection.text ?? selection.label);
  if (byText) return byText;

  throw new Error('Could not locate the selected element in the source file. Reload the preview and select it again.');
}

function findTagByAttribute(
  source: string,
  tagName: string,
  selection: ReorderLocator,
): OpenTagRange | null {
  const attrCandidates: Array<[string, string | undefined]> = [
    ['src', selection.src],
    ['href', selection.href],
    ['alt', selection.alt],
    ['id', selection.elementId],
    ['class', selection.className],
  ];
  const ranges = findOpeningTags(source, tagName);
  for (const [attr, value] of attrCandidates) {
    if (!value) continue;
    for (const range of ranges) {
      const open = source.slice(range.start, range.end);
      if ((readAttribute(open, attr) ?? '') === value) return range;
    }
  }
  return null;
}

function findElementRange(source: string, tagName: string, opening: OpenTagRange): ElementRange {
  const tag = readTagAt(source, opening.start);
  if (!tag || tag.closing || tag.name !== tagName) {
    throw new Error('Could not locate the selected element in the source file. Reload the preview and select it again.');
  }
  if (tag.selfClosing || VOID_TAGS.has(tag.name)) {
    return { start: opening.start, end: opening.end };
  }
  const close = findClosingTagRange(source, tagName, opening.end);
  return { start: opening.start, end: close.end };
}

function findClosingTagRange(source: string, tagName: string, openEnd: number): OpenTagRange {
  let depth = 1;
  let index = openEnd;
  while (index < source.length) {
    const next = source.indexOf('<', index);
    if (next === -1) break;
    const tag = readTagAt(source, next);
    if (!tag) {
      index = next + 1;
      continue;
    }
    if (tag.name === tagName) {
      if (tag.closing) {
        depth -= 1;
        if (depth === 0) return { start: tag.start, end: tag.end };
      } else if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) {
        depth += 1;
      }
    }
    index = tag.end;
  }
  throw new Error(`Could not find the closing </${tagName}> tag for the selected element.`);
}

function expandRangeForMove(source: string, range: ElementRange): ElementRange {
  const lineStart = source.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1;
  const hasOnlyIndentBefore = source.slice(lineStart, range.start).trim().length === 0;
  if (!hasOnlyIndentBefore) return range;

  let end = range.end;
  while (end < source.length && source[end] !== '\n' && /\s/.test(source[end] ?? '')) {
    end += 1;
  }
  if (source[end] === '\n') end += 1;
  return { start: lineStart, end };
}

function rangesOverlap(a: ElementRange, b: ElementRange): boolean {
  return a.start < b.end && b.start < a.end;
}

function findTagByText(source: string, tagName: string, text: string | undefined): OpenTagRange | null {
  const needle = (text ?? '').trim();
  if (!needle || VOID_TAGS.has(tagName)) return null;
  for (const range of findOpeningTags(source, tagName)) {
    try {
      const inner = findElementInnerRange(source, tagName, range.end);
      const visible = stripTags(source.slice(inner.start, inner.end)).replace(/\s+/g, ' ').trim();
      if (visible === needle) return range;
    } catch {
      // Keep scanning other candidate tags.
    }
  }
  return null;
}

function findOpeningTags(source: string, tagName: string): OpenTagRange[] {
  const ranges: OpenTagRange[] = [];
  let index = 0;
  while (index < source.length) {
    const next = source.indexOf('<', index);
    if (next === -1) break;
    const tag = readTagAt(source, next);
    if (!tag) {
      index = next + 1;
      continue;
    }
    if (!tag.closing && tag.name === tagName) {
      ranges.push({ start: tag.start, end: tag.end });
    }
    index = tag.end;
  }
  return ranges;
}

function findElementInnerRange(source: string, tagName: string, openEnd: number): { start: number; end: number } {
  let depth = 1;
  let index = openEnd;
  while (index < source.length) {
    const next = source.indexOf('<', index);
    if (next === -1) break;
    const tag = readTagAt(source, next);
    if (!tag) {
      index = next + 1;
      continue;
    }
    if (tag.name === tagName) {
      if (tag.closing) {
        depth -= 1;
        if (depth === 0) return { start: openEnd, end: tag.start };
      } else if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) {
        depth += 1;
      }
    }
    index = tag.end;
  }
  throw new Error(`Could not find the closing </${tagName}> tag for the selected element.`);
}

function setAttribute(opening: string, attrName: string, rawValue: string, removeWhenEmpty: boolean): string {
  const value = rawValue.trim();
  const attrRe = new RegExp(`\\s${escapeRegExp(attrName)}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>` + '`' + `]+))?`, 'i');
  const existing = opening.match(attrRe);
  if (!value && removeWhenEmpty) {
    return existing ? opening.replace(attrRe, '') : opening;
  }
  const replacement = ` ${attrName}="${escapeAttribute(value)}"`;
  if (existing) return opening.replace(attrRe, replacement);
  const insertAt = opening.endsWith('/>') ? opening.length - 2 : opening.length - 1;
  return opening.slice(0, insertAt) + replacement + opening.slice(insertAt);
}

function readAttribute(opening: string, attrName: string): string | null {
  const attrRe = new RegExp(`\\s${escapeRegExp(attrName)}(?:\\s*=\\s*("[^"]*"|'[^']*'|[^\\s"'=<>` + '`' + `]+))?`, 'i');
  const match = opening.match(attrRe);
  if (!match) return null;
  const raw = match[1];
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return unescapeAttribute(raw.slice(1, -1));
  }
  return unescapeAttribute(raw);
}

function isOpeningTagFor(value: string, tagName: string): boolean {
  const tag = readTagAt(value, 0);
  return !!tag && !tag.closing && tag.name === tagName && tag.start === 0 && tag.end === value.length;
}

function readTagAt(source: string, start: number): null | {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
} {
  if (source[start] !== '<') return null;
  const next = source[start + 1];
  if (!next || next === '!' || next === '?') return null;
  let pos = start + 1;
  let closing = false;
  if (source[pos] === '/') {
    closing = true;
    pos += 1;
  }
  while (/\s/.test(source[pos] ?? '')) pos += 1;
  const nameStart = pos;
  while (/[A-Za-z0-9:-]/.test(source[pos] ?? '')) pos += 1;
  if (pos === nameStart) return null;
  const name = source.slice(nameStart, pos).toLowerCase();
  const end = findTagEnd(source, pos);
  if (end === -1) return null;
  const beforeClose = source.slice(start, end).replace(/\s+$/g, '');
  return {
    start,
    end: end + 1,
    name,
    closing,
    selfClosing: beforeClose.endsWith('/'),
  };
}

function findTagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;');
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
