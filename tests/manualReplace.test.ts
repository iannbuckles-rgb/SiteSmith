import { describe, expect, it } from 'vitest';

import {
  ALL_SCOPE,
  applyManualReplace,
  editableEntries,
  isEditableExtension,
  planManualReplace,
} from '../src/lib/manualReplace';
import { undoPatchById } from '../src/lib/undoStack';
import { makeProject, zipText } from './helpers';

describe('manualReplace', () => {
  it('uses the shared text-source contract for expanded languages and templates', () => {
    expect(isEditableExtension('Component.astro')).toBe(true);
    expect(isEditableExtension('server.py')).toBe(true);
    expect(isEditableExtension('theme.sass')).toBe(true);
    expect(isEditableExtension('Dockerfile')).toBe(true);
    expect(isEditableExtension('scene.glb')).toBe(false);
    expect(isEditableExtension('photo.heic')).toBe(false);
    expect(editableEntries([
      { path: 'scene.glb', name: 'scene.glb' },
      { path: 'src/server.py', name: 'server.py' },
      { path: 'Dockerfile', name: 'Dockerfile' },
    ])).toEqual([
      { path: 'Dockerfile', name: 'Dockerfile' },
      { path: 'src/server.py', name: 'server.py' },
    ]);
  });

  it('supports replace-once and replace-all in a single file', async () => {
    const onceProject = makeProject({ 'index.html': '<h1>Brand</h1><p>Brand</p>' });
    const once = await applyManualReplace(onceProject, {
      scope: 'index.html',
      searchText: 'Brand',
      replacementText: 'Acme',
      replaceAll: false,
    });

    expect(await zipText(onceProject, 'index.html')).toBe('<h1>Acme</h1><p>Brand</p>');
    expect(once.patch.action).toBe('manual-replace');
    if (once.patch.action !== 'manual-replace') throw new Error('Expected manual-replace patch');
    expect(once.patch.matchCount).toBe(1);

    const allProject = makeProject({ 'index.html': '<h1>Brand</h1><p>Brand</p>' });
    const all = await applyManualReplace(allProject, {
      scope: 'index.html',
      searchText: 'Brand',
      replacementText: 'Acme',
      replaceAll: true,
    });

    expect(await zipText(allProject, 'index.html')).toBe('<h1>Acme</h1><p>Acme</p>');
    expect(all.patch.action).toBe('manual-replace');
    if (all.patch.action !== 'manual-replace') throw new Error('Expected manual-replace patch');
    expect(all.patch.matchCount).toBe(2);
  });

  it('plans and applies multi-file scope with per-file snapshot undo', async () => {
    const project = makeProject({
      'index.html': '<h1>Brand</h1><p>Brand</p>',
      'styles/site.css': '.logo::before{content:"Brand"}',
      'images/logo.png': new Uint8Array([1]),
    });

    const plan = await planManualReplace(project, ALL_SCOPE, 'Brand', true);
    expect(plan.totalMatches).toBe(3);
    expect(plan.files.map((file) => file.path)).toEqual(['index.html', 'styles/site.css']);

    const { patch } = await applyManualReplace(project, {
      scope: ALL_SCOPE,
      searchText: 'Brand',
      replacementText: 'Acme',
      replaceAll: true,
    });

    expect(patch.action).toBe('manual-replace');
    if (patch.action !== 'manual-replace') throw new Error('Expected manual-replace patch');
    expect(patch.filesTouched).toBe(2);
    expect(patch.modifiedFiles).toEqual([
      expect.objectContaining({ path: 'index.html', previousSourceText: '<h1>Brand</h1><p>Brand</p>' }),
      expect.objectContaining({ path: 'styles/site.css', previousSourceText: '.logo::before{content:"Brand"}' }),
    ]);
    expect(await zipText(project, 'index.html')).toContain('Acme');
    expect(await zipText(project, 'styles/site.css')).toContain('Acme');

    undoPatchById(project, patch);
    expect(await zipText(project, 'index.html')).toBe('<h1>Brand</h1><p>Brand</p>');
    expect(await zipText(project, 'styles/site.css')).toBe('.logo::before{content:"Brand"}');
  });

  it('throws on no match and rolls back any uploaded asset write', async () => {
    const project = makeProject({ 'index.html': '<h1>Brand</h1>' });

    await expect(applyManualReplace(project, {
      scope: 'index.html',
      searchText: 'Missing',
      replacementText: 'Acme',
      replaceAll: true,
      imageFile: new File([new Uint8Array([1, 2])], 'Logo.PNG', { type: 'image/png' }),
    })).rejects.toThrow('Search text was not found');

    expect(project.zip.file('assets/mockups/logo.png')).toBeNull();
    expect(await zipText(project, 'index.html')).toBe('<h1>Brand</h1>');
  });
});
