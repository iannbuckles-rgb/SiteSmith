import { describe, expect, it } from 'vitest';

import { applyEditorEdit } from '../src/lib/editorPatch';
import { buildReport } from '../src/lib/exportService';
import { undoPatchById } from '../src/lib/undoStack';
import type { EditorSelection } from '../src/lib/previewControls';
import { makeProject, zipText } from './helpers';

describe('applyEditorEdit', () => {
  it('patches the selected text by source range instead of replacing the first duplicate', async () => {
    const source = '<main><h1>Duplicate</h1><h1>Duplicate</h1></main>';
    const secondStart = source.lastIndexOf('<h1>');
    const secondEnd = secondStart + '<h1>'.length;
    const project = makeProject({ 'index.html': source });

    const selection: EditorSelection = {
      sourceFile: 'index.html',
      kind: 'text',
      tagName: 'h1',
      label: 'Duplicate',
      text: 'Duplicate',
      sourceStart: secondStart,
      sourceEnd: secondEnd,
      selectorHint: 'h1',
    };

    const patch = await applyEditorEdit(project, {
      selection,
      edits: [{ field: 'text', newValue: 'Second headline' }],
    });

    expect(patch.action).toBe('editor-edit');
    expect(await zipText(project, 'index.html')).toBe('<main><h1>Duplicate</h1><h1>Second headline</h1></main>');

    undoPatchById(project, patch);
    expect(await zipText(project, 'index.html')).toBe(source);
  });

  it('updates image attributes and style on the selected opening tag', async () => {
    const source = '<img src="hero.png" alt="Old" class="hero" style="border-radius: 4px">';
    const project = makeProject({ 'index.html': source, 'hero.png': new Uint8Array([1]) });
    const selection: EditorSelection = {
      sourceFile: 'index.html',
      kind: 'image',
      tagName: 'img',
      label: 'Old',
      src: 'hero.png',
      alt: 'Old',
      className: 'hero',
      style: 'border-radius: 4px',
      sourceStart: 0,
      sourceEnd: source.length,
      selectorHint: 'img.hero',
    };

    const patch = await applyEditorEdit(project, {
      selection,
      edits: [
        { field: 'alt', newValue: 'New hero' },
        { field: 'class', newValue: 'hero hero--wide' },
        { field: 'style', newValue: 'object-fit: cover' },
      ],
    });

    expect(await zipText(project, 'index.html')).toBe('<img src="hero.png" alt="New hero" class="hero hero--wide" style="object-fit: cover">');
    expect(patch.edits.map((edit) => edit.field)).toEqual(['alt', 'class', 'style']);
  });

  it('reports direct editor edits in the export audit', async () => {
    const source = '<a href="/old">Read more</a>';
    const project = makeProject({ 'index.html': source });
    const selection: EditorSelection = {
      sourceFile: 'index.html',
      kind: 'text',
      tagName: 'a',
      label: 'Read more',
      text: 'Read more',
      href: '/old',
      sourceStart: 0,
      sourceEnd: '<a href="/old">'.length,
      selectorHint: 'a',
    };

    const patch = await applyEditorEdit(project, {
      selection,
      edits: [{ field: 'href', newValue: '/new' }],
    });
    const report = buildReport([patch], []);

    expect(report).toContain('Direct editor edits');
    expect(report).toContain('`href`: `/old`');
    expect(report).toContain('`/new`');
  });
});
