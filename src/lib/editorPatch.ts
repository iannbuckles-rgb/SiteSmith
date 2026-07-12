import type { AppliedPatch, EditorAppliedEdit, EditorEditField, LoadedProject } from '../types';
import type { EditorSelection } from './previewControls';

export interface ApplyEditorEditInput {
  selection: EditorSelection;
  edits: Array<{
    field: EditorEditField;
    newValue: string;
    oldValue?: string;
  }>;
}

type EditorEditPatch = Extract<AppliedPatch, { action: 'editor-edit' }>;

type OpenTagRange = {
  start: number;
  end: number;
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

function locateOpeningTag(source: string, selection: EditorSelection): OpenTagRange {
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
  selection: EditorSelection,
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
