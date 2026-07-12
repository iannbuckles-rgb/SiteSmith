import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import { applyEditorDelete, applyEditorEdit, applyEditorNudge, applyEditorReorder } from '../src/lib/editorPatch';
import { buildExport, buildReport } from '../src/lib/exportService';
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

  it('updates component metadata attributes without replacing nearby elements', async () => {
    const source = '<section><div class="card">One</div><div id="target" class="card">Two</div></section>';
    const targetStart = source.indexOf('<div id="target"');
    const project = makeProject({ 'index.html': source });

    const patch = await applyEditorEdit(project, {
      selection: {
        sourceFile: 'index.html',
        kind: 'element',
        tagName: 'div',
        label: 'Two',
        elementId: 'target',
        className: 'card',
        sourceStart: targetStart,
        sourceEnd: source.indexOf('>', targetStart) + 1,
        selectorHint: 'div#target.card',
      },
      edits: [
        { field: 'id', newValue: 'feature-card' },
        { field: 'role', newValue: 'region' },
        { field: 'aria-label', newValue: 'Featured card' },
      ],
    });

    expect(await zipText(project, 'index.html')).toBe(
      '<section><div class="card">One</div><div id="feature-card" class="card" role="region" aria-label="Featured card">Two</div></section>',
    );

    undoPatchById(project, patch);
    expect(await zipText(project, 'index.html')).toBe(source);
  });

  it('updates form input metadata and allows clearing the value attribute', async () => {
    const source = '<form><input name="email" type="email" value="old@example.com" placeholder="Email"></form>';
    const inputStart = source.indexOf('<input');
    const project = makeProject({ 'index.html': source });

    await applyEditorEdit(project, {
      selection: {
        sourceFile: 'index.html',
        kind: 'element',
        tagName: 'input',
        label: 'email',
        name: 'email',
        inputType: 'email',
        value: 'old@example.com',
        placeholder: 'Email',
        sourceStart: inputStart,
        sourceEnd: source.indexOf('>', inputStart) + 1,
        selectorHint: 'input',
      },
      edits: [
        { field: 'name', newValue: 'workEmail' },
        { field: 'type', newValue: 'text' },
        { field: 'value', newValue: '' },
        { field: 'placeholder', newValue: 'Work email' },
      ],
    });

    expect(await zipText(project, 'index.html')).toBe(
      '<form><input name="workEmail" type="text" value="" placeholder="Work email"></form>',
    );
  });

  it('writes textarea value edits as escaped text content', async () => {
    const source = '<form><textarea name="message" placeholder="Message">Old message</textarea></form>';
    const textareaStart = source.indexOf('<textarea');
    const project = makeProject({ 'index.html': source });

    const patch = await applyEditorEdit(project, {
      selection: {
        sourceFile: 'index.html',
        kind: 'element',
        tagName: 'textarea',
        label: 'Message',
        name: 'message',
        value: 'Old message',
        placeholder: 'Message',
        sourceStart: textareaStart,
        sourceEnd: source.indexOf('>', textareaStart) + 1,
        selectorHint: 'textarea',
      },
      edits: [{ field: 'value', newValue: 'New <safe> message' }],
    });

    expect(await zipText(project, 'index.html')).toBe(
      '<form><textarea name="message" placeholder="Message">New &lt;safe&gt; message</textarea></form>',
    );

    undoPatchById(project, patch);
    expect(await zipText(project, 'index.html')).toBe(source);
  });

  it('persists direct editor edits into the generated export zip', async () => {
    const source = '<main><section id="hero" aria-label="Old">Hero</section></main>';
    const project = makeProject({ 'index.html': source });
    const sectionStart = source.indexOf('<section');

    const patch = await applyEditorEdit(project, {
      selection: {
        sourceFile: 'index.html',
        kind: 'element',
        tagName: 'section',
        label: 'Hero',
        elementId: 'hero',
        ariaLabel: 'Old',
        sourceStart: sectionStart,
        sourceEnd: source.indexOf('>', sectionStart) + 1,
        selectorHint: 'section#hero',
      },
      edits: [
        { field: 'aria-label', newValue: 'Updated hero' },
        { field: 'role', newValue: 'banner' },
      ],
    });

    const exported = await buildExport(project, [patch], []);
    const zip = await JSZip.loadAsync(exported.blob);

    await expect(zip.file('index.html')?.async('text')).resolves.toBe(
      '<main><section id="hero" aria-label="Updated hero" role="banner">Hero</section></main>',
    );
    await expect(zip.file('MOCKUPSWAP_CHANGES.md')?.async('text')).resolves.toContain('Direct editor edits');
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

describe('applyEditorReorder', () => {
  it('moves a selected button after a sibling while preserving formatted lines', async () => {
    const source = '<form>\n  <button id="save">Save</button>\n  <button id="cancel">Cancel</button>\n</form>';
    const project = makeProject({ 'index.html': source });
    const saveStart = source.indexOf('<button id="save"');
    const cancelStart = source.indexOf('<button id="cancel"');

    const patch = await applyEditorReorder(project, {
      selection: {
        sourceFile: 'index.html',
        kind: 'text',
        tagName: 'button',
        label: 'Save',
        text: 'Save',
        elementId: 'save',
        sourceStart: saveStart,
        sourceEnd: source.indexOf('>', saveStart) + 1,
        selectorHint: 'button#save',
      },
      reference: {
        tagName: 'button',
        label: 'Cancel',
        sourceStart: cancelStart,
        sourceEnd: source.indexOf('>', cancelStart) + 1,
        selectorHint: 'button#cancel',
      },
      placement: 'after',
    });

    expect(patch.action).toBe('editor-reorder');
    expect(await zipText(project, 'index.html')).toBe(
      '<form>\n  <button id="cancel">Cancel</button>\n  <button id="save">Save</button>\n</form>',
    );

    undoPatchById(project, patch);
    expect(await zipText(project, 'index.html')).toBe(source);
  });

  it('moves a form field before a sibling element', async () => {
    const source = '<div>\n  <label>Email</label>\n  <input name="email">\n</div>';
    const project = makeProject({ 'index.html': source });
    const inputStart = source.indexOf('<input');
    const labelStart = source.indexOf('<label');

    const patch = await applyEditorReorder(project, {
      selection: {
        sourceFile: 'index.html',
        kind: 'element',
        tagName: 'input',
        label: 'email',
        sourceStart: inputStart,
        sourceEnd: source.indexOf('>', inputStart) + 1,
        selectorHint: 'input',
      },
      reference: {
        tagName: 'label',
        label: 'Email',
        sourceStart: labelStart,
        sourceEnd: source.indexOf('>', labelStart) + 1,
        selectorHint: 'label',
      },
      placement: 'before',
    });

    expect(await zipText(project, 'index.html')).toBe(
      '<div>\n  <input name="email">\n  <label>Email</label>\n</div>',
    );

    const report = buildReport([patch], []);
    expect(report).toContain('Direct editor reorders');
    expect(report).toContain('Placement');
    expect(report).toContain('before `label`');
  });
});

describe('applyEditorNudge', () => {
  it('nudges a form field with precise pixel translate and survives stale source-end markers', async () => {
    const source = '<form><input name="email" style="width: 200px"></form>';
    const project = makeProject({ 'index.html': source });
    const inputStart = source.indexOf('<input');
    const inputEnd = source.indexOf('>', inputStart) + 1;
    const selection: EditorSelection = {
      sourceFile: 'index.html',
      kind: 'element',
      tagName: 'input',
      label: 'email',
      sourceStart: inputStart,
      sourceEnd: inputEnd,
      selectorHint: 'input',
    };

    const first = await applyEditorNudge(project, {
      selection,
      deltaX: 1,
      deltaY: 0.25,
    });

    expect(first.action).toBe('editor-nudge');
    expect(await zipText(project, 'index.html')).toBe(
      '<form><input name="email" style="width: 200px; translate: 1px 0.25px"></form>',
    );

    const second = await applyEditorNudge(project, {
      selection,
      deltaX: -2,
      deltaY: 9.75,
    });

    expect(await zipText(project, 'index.html')).toBe(
      '<form><input name="email" style="width: 200px; translate: -1px 10px"></form>',
    );

    undoPatchById(project, second);
    expect(await zipText(project, 'index.html')).toBe(
      '<form><input name="email" style="width: 200px; translate: 1px 0.25px"></form>',
    );
    undoPatchById(project, first);
    expect(await zipText(project, 'index.html')).toBe(source);
  });

  it('reports keyboard editor moves in the export audit', async () => {
    const source = '<section id="card">Card</section>';
    const project = makeProject({ 'index.html': source });
    const patch = await applyEditorNudge(project, {
      selection: {
        sourceFile: 'index.html',
        kind: 'element',
        tagName: 'section',
        label: 'Card',
        elementId: 'card',
        sourceStart: 0,
        sourceEnd: '<section id="card">'.length,
        selectorHint: 'section#card',
      },
      deltaX: 10,
      deltaY: -1,
    });
    const report = buildReport([patch], []);

    expect(report).toContain('Direct editor moves');
    expect(report).toContain('x `10px`');
    expect(report).toContain('y `-1px`');
  });
});

describe('applyEditorDelete', () => {
  it('deletes the selected duplicate element by source range and undo restores it', async () => {
    const source = '<main>\n  <button>Keep</button>\n  <button>Delete</button>\n</main>';
    const deleteStart = source.lastIndexOf('<button>');
    const deleteEnd = deleteStart + '<button>'.length;
    const project = makeProject({ 'index.html': source });

    const patch = await applyEditorDelete(project, {
      sourceFile: 'index.html',
      kind: 'text',
      tagName: 'button',
      label: 'Delete',
      text: 'Delete',
      sourceStart: deleteStart,
      sourceEnd: deleteEnd,
      selectorHint: 'button',
    });

    expect(patch.action).toBe('editor-delete');
    expect(patch.removedSourceText).toContain('<button>Delete</button>');
    expect(await zipText(project, 'index.html')).toBe('<main>\n  <button>Keep</button>\n</main>');

    undoPatchById(project, patch);
    expect(await zipText(project, 'index.html')).toBe(source);
  });

  it('deletes a source-backed component and reports it in the export audit', async () => {
    const source = '<main><section class="hero"><h1>Hero</h1></section><section>Keep</section></main>';
    const sectionStart = source.indexOf('<section class="hero"');
    const project = makeProject({ 'index.html': source });

    const patch = await applyEditorDelete(project, {
      sourceFile: 'index.html',
      kind: 'element',
      tagName: 'section',
      label: 'hero',
      className: 'hero',
      sourceStart: sectionStart,
      sourceEnd: source.indexOf('>', sectionStart) + 1,
      selectorHint: 'section.hero',
    });
    const report = buildReport([patch], []);

    expect(await zipText(project, 'index.html')).toBe('<main><section>Keep</section></main>');
    expect(report).toContain('Direct editor deletions');
    expect(report).toContain('section.hero');
    expect(report).toContain('source-backed element deletion');
  });
});
