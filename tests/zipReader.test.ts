import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { loadZipFromFile } from '../src/lib/zipReader';

async function zipFile(name: string, entries: Record<string, string>): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type: 'application/zip' });
}

describe('zipReader.loadZipFromFile', () => {
  it('classifies expanded source and asset families in direct ZIP uploads', async () => {
    const project = await loadZipFromFile(await zipFile('site.zip', {
      'index.xhtml': '<html/>',
      'styles/theme.scss': '.hero{}',
      'src/App.tsx': 'export const App = 1',
      'images/hero.jxl': 'image',
      'fonts/site.ttc': 'font',
      'video/intro.mov': 'video',
    }));

    expect(project.summary).toMatchObject({
      totalFiles: 6,
      htmlFiles: 1,
      cssFiles: 1,
      jsFiles: 1,
      imageFiles: 1,
    });
    expect(project.entries.find((entry) => entry.path === 'fonts/site.ttc')?.category).toBe('font');
    expect(project.entries.find((entry) => entry.path === 'video/intro.mov')?.category).toBe('other');
  });

  it('returns a clear error for invalid or empty archives', async () => {
    const invalid = new File(['not a zip'], 'broken.zip', { type: 'application/zip' });
    await expect(loadZipFromFile(invalid)).rejects.toThrow(/valid, unencrypted ZIP/i);

    const empty = await zipFile('empty.zip', {});
    await expect(loadZipFromFile(empty)).rejects.toThrow(/no usable website files/i);
  });

  it('rejects traversal and case-colliding archive paths', async () => {
    const traversal = await zipFile('unsafe.zip', { '../index.html': '<h1>unsafe</h1>' });
    await expect(loadZipFromFile(traversal)).rejects.toThrow(/unsafe parent path/i);

    const collision = await zipFile('collision.zip', {
      'images/Logo.svg': '<svg/>',
      'images/logo.svg': '<svg/>',
    });
    await expect(loadZipFromFile(collision)).rejects.toThrow(/letter case/i);
  });
});
