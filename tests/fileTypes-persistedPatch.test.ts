import { describe, expect, it } from 'vitest';

import {
  getCategory,
  IMAGE_FILE_ACCEPT,
  isRecognizedProjectFile,
  isSupportedImageFile,
  PROJECT_FILE_ACCEPT,
} from '../src/lib/fileTypes';
import { guessMimeType } from '../src/lib/mime';
import { readPersistedPatches } from '../src/lib/persistedPatch';

describe('image file input contract', () => {
  it('accepts known image extensions when the browser omits the MIME type', () => {
    expect(isSupportedImageFile({ name: 'brand.SVG', type: '' })).toBe(true);
    expect(isSupportedImageFile({ name: 'favicon.ico', type: 'application/octet-stream' })).toBe(true);
    expect(getCategory('mockup.BMP')).toBe('image');
  });

  it('rejects non-images and exposes MIME plus extension picker hints', () => {
    expect(isSupportedImageFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
    expect(IMAGE_FILE_ACCEPT).toContain('image/svg+xml');
    expect(IMAGE_FILE_ACCEPT).toContain('.svg');
  });

  it('classifies modern image, source, style, and font formats consistently', () => {
    expect(getCategory('hero.APNG')).toBe('image');
    expect(getCategory('photo.tiff')).toBe('image');
    expect(getCategory('app.tsx')).toBe('js');
    expect(getCategory('theme.scss')).toBe('css');
    expect(getCategory('collection.ttc')).toBe('font');
    expect(isSupportedImageFile({ name: 'photo.heic', type: '' })).toBe(true);
  });

  it('recognizes framework, data, media, runtime, and extensionless project files', () => {
    expect(isRecognizedProjectFile({ name: 'Card.vue', type: '' })).toBe(true);
    expect(isRecognizedProjectFile({ name: 'config.yaml', type: '' })).toBe(true);
    expect(isRecognizedProjectFile({ name: 'intro.mov', type: '' })).toBe(true);
    expect(isRecognizedProjectFile({ name: 'module.wasm', type: '' })).toBe(true);
    expect(isRecognizedProjectFile({ name: 'render.py', type: '' })).toBe(true);
    expect(isRecognizedProjectFile({ name: 'scene.glb', type: '' })).toBe(true);
    expect(isRecognizedProjectFile({ name: 'Dockerfile', type: '' })).toBe(true);
    expect(isRecognizedProjectFile({ name: 'opaque', type: 'application/octet-stream' })).toBe(false);
    expect(PROJECT_FILE_ACCEPT).toContain('.tar.gz');
    expect(PROJECT_FILE_ACCEPT).toContain('.tsx');
  });

  it('serves expanded assets and source with specific MIME types', () => {
    expect(guessMimeType('hero.jxl')).toBe('image/jxl');
    expect(guessMimeType('component.tsx')).toBe('text/tsx;charset=utf-8');
    expect(guessMimeType('audio.opus')).toBe('audio/opus');
    expect(guessMimeType('font.ttc')).toBe('font/collection');
    expect(guessMimeType('scene.glb')).toBe('model/gltf-binary');
    expect(guessMimeType('render.py')).toBe('text/x-python;charset=utf-8');
    expect(guessMimeType('Card.vue')).toBe('text/plain;charset=utf-8');
    expect(guessMimeType('server.scala')).toBe('text/plain;charset=utf-8');
    expect(guessMimeType('Dockerfile')).toBe('text/plain;charset=utf-8');
  });
});

describe('persisted patch validation', () => {
  const validRemove = {
    id: 'index.html::img::src::missing.png',
    action: 'remove',
    sourceFile: 'index.html',
    sourceKind: 'html',
    sourceTag: 'img',
    sourceAttr: 'src',
    rawUrl: 'missing.png',
    currentSourceValue: '',
    appliedAt: 1,
    previousSourceText: '<img src="missing.png">',
    currentSourceText: '',
  };

  it('reads both current envelopes and legacy direct rows', () => {
    expect(readPersistedPatches([{ id: validRemove.id, patch: validRemove }, validRemove])).toHaveLength(2);
  });

  it('drops unknown actions and structurally incomplete rows', () => {
    expect(readPersistedPatches([
      { id: 'bad-action', action: 'execute-script', appliedAt: 1 },
      { ...validRemove, id: 'missing-snapshot', previousSourceText: undefined },
      null,
    ])).toEqual([]);
  });

  it('accepts every current patch variant only when its required payload is present', () => {
    const snapshots = { previousSourceText: 'before', currentSourceText: 'after' };
    const detection = {
      sourceFile: 'index.html',
      sourceKind: 'html',
      sourceTag: 'img',
      sourceAttr: 'src',
      rawUrl: 'old.png',
    };
    const target = { kind: 'image', tagName: 'img', label: 'Hero' };
    const rows = [
      {
        id: 'replace', action: 'replace', appliedAt: 1, ...detection, ...snapshots,
        currentSourceValue: './new.png', newAssetPath: 'new.png', originalAssetPath: 'old.png', replacementBytes: 20,
      },
      {
        id: 'fit', action: 'fit-style', appliedAt: 2, ...detection, ...snapshots,
        generatedCss: 'object-fit: cover',
        config: { fit: 'cover', position: 'center', borderRadius: 'none', overlay: 'none' },
      },
      validRemove,
      {
        id: 'placeholder', action: 'placeholder', appliedAt: 3, ...detection, ...snapshots,
        currentSourceValue: '<div>Hero</div>', placeholder: { label: 'Hero' },
      },
      {
        id: 'manual', action: 'manual-replace', appliedAt: 4,
        targetScope: 'index.html', searchText: 'old', replacementText: 'new', replaceAll: true,
        matchCount: 1, filesTouched: 1,
        modifiedFiles: [{ path: 'index.html', previousSourceText: 'old', currentText: 'new' }],
      },
      {
        id: 'edit', action: 'editor-edit', appliedAt: 5, sourceFile: 'index.html', target, ...snapshots,
        edits: [{ field: 'alt', oldValue: 'Old', newValue: 'New' }],
      },
      {
        id: 'reorder', action: 'editor-reorder', appliedAt: 6, sourceFile: 'index.html', target, ...snapshots,
        reference: { tagName: 'p', label: 'Caption' }, placement: 'after',
      },
      {
        id: 'nudge', action: 'editor-nudge', appliedAt: 7, sourceFile: 'index.html', target, ...snapshots,
        deltaX: 1, deltaY: 2, translateX: 3, translateY: 4, previousStyle: '', currentStyle: 'translate: 3px 4px',
      },
      {
        id: 'delete', action: 'editor-delete', appliedAt: 8, sourceFile: 'index.html', target, ...snapshots,
        removedSourceText: '<img>',
      },
    ];

    expect(readPersistedPatches(rows).map((patch) => patch.action)).toEqual([
      'replace', 'fit-style', 'remove', 'placeholder', 'manual-replace',
      'editor-edit', 'editor-reorder', 'editor-nudge', 'editor-delete',
    ]);
    expect(readPersistedPatches([
      { ...rows[5], edits: [{ field: 'not-a-field', oldValue: '', newValue: '' }] },
      { ...rows[7], deltaX: Number.NaN },
    ])).toEqual([]);
  });
});
