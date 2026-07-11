import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { normalizeFileList } from '../src/lib/projectInput';

/** Build a File carrying an optional directory-picker relative path. */
function makeFile(name: string, content: string, relativePath?: string): File {
  const file = new File([content], name, { type: 'text/plain' });
  if (relativePath) {
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  }
  return file;
}

/** jsdom has no real FileList; a File[] is structurally sufficient here. */
function asFileList(files: File[]): FileList {
  return files as unknown as FileList;
}

async function pathsInside(zipFile: File): Promise<string[]> {
  const zip = await JSZip.loadAsync(await zipFile.arrayBuffer());
  return Object.values(zip.files)
    .filter((f) => !f.dir)
    .map((f) => f.name)
    .sort();
}

describe('projectInput.normalizeFileList', () => {
  it('passes a single .zip through untouched (no repack)', async () => {
    const zip = makeFile('site.zip', 'PK-not-really-but-name-matters');
    const result = await normalizeFileList(asFileList([zip]));
    expect(result.kind).toBe('zip');
    if (result.kind === 'zip') expect(result.file).toBe(zip);
  });

  it('packs loose web files into a zip named after the single file', async () => {
    const html = makeFile('index.html', '<h1>hi</h1>');
    const result = await normalizeFileList(asFileList([html]));
    expect(result.kind).toBe('packed');
    if (result.kind !== 'packed') throw new Error('expected packed');
    expect(result.file.name).toBe('index.zip');
    expect(await pathsInside(result.file)).toEqual(['index.html']);
  });

  it('strips a shared top-level folder from a directory selection', async () => {
    const files = [
      makeFile('index.html', '<h1>hi</h1>', 'my-site/index.html'),
      makeFile('app.css', 'body{}', 'my-site/assets/app.css'),
    ];
    const result = await normalizeFileList(asFileList(files));
    expect(result.kind).toBe('packed');
    if (result.kind !== 'packed') throw new Error('expected packed');
    expect(result.file.name).toBe('my-site.zip');
    expect(await pathsInside(result.file)).toEqual(['assets/app.css', 'index.html']);
  });

  it('drops OS junk before packing', async () => {
    const files = [
      makeFile('index.html', '<h1>hi</h1>', 'site/index.html'),
      makeFile('.DS_Store', 'junk', 'site/.DS_Store'),
      makeFile('icon.png', 'x', 'site/__MACOSX/icon.png'),
    ];
    const result = await normalizeFileList(asFileList(files));
    if (result.kind !== 'packed') throw new Error('expected packed');
    expect(await pathsInside(result.file)).toEqual(['index.html']);
    expect(result.fileCount).toBe(1);
  });

  it('rejects a selection with no recognizable web files', async () => {
    const files = [makeFile('notes', 'plain', 'stuff/notes')];
    await expect(normalizeFileList(asFileList(files))).rejects.toThrow(/no recognizable web files/i);
  });
});
