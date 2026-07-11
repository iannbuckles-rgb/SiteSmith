import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { applyRemove, applyReplacement } from '../src/lib/assetReplacer';
import { buildExport } from '../src/lib/exportService';
import { undoPatchById } from '../src/lib/undoStack';
import { htmlImgDetection, makeProject, zipText } from './helpers';

describe('jsdom zip apply flows', () => {
  it('round-trips replace then export through an in-memory JSZip', async () => {
    const source = '<!doctype html><img src="images/hero.png" alt="Hero">';
    const project = makeProject({
      'index.html': source,
      'images/hero.png': new Uint8Array([0]),
    });

    const patch = await applyReplacement(project, htmlImgDetection(), {
      bytes: new Uint8Array([9, 8, 7]),
      filename: 'Hero.png',
    });
    const exported = await buildExport(project, [patch], []);
    const exportedZip = await JSZip.loadAsync(await exported.blob.arrayBuffer());
    const html = await exportedZip.file('index.html')?.async('text');
    const report = await exportedZip.file('MOCKUPSWAP_CHANGES.md')?.async('text');
    const asset = await exportedZip.file('assets/mockups/hero.png')?.async('uint8array');

    expect(html).toBe('<!doctype html><img src="./assets/mockups/hero.png" alt="Hero">');
    expect(html).not.toContain('blob:');
    expect(asset).toEqual(new Uint8Array([9, 8, 7]));
    expect(report).toContain('Images replaced');
  });

  it('round-trips remove then undo through an in-memory JSZip export', async () => {
    const source = '<!doctype html><main><img src="missing.png" alt="Missing"></main>';
    const project = makeProject({ 'index.html': source });

    const patch = await applyRemove(project, htmlImgDetection({
      rawUrl: 'missing.png',
      resolvedPath: 'missing.png',
      status: 'missing',
    }));
    expect(await zipText(project, 'index.html')).not.toContain('<img');

    undoPatchById(project, patch);
    const exported = await buildExport(project, [], []);
    const exportedZip = await JSZip.loadAsync(await exported.blob.arrayBuffer());

    expect(await exportedZip.file('index.html')?.async('text')).toBe(source);
  });
});
