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

function makeTar(name: string, entries: Record<string, string>): File {
  const encoder = new TextEncoder();
  const chunks: BlobPart[] = [];
  const writeText = (target: Uint8Array, offset: number, value: string) => {
    target.set(encoder.encode(value), offset);
  };
  const writeOctal = (target: Uint8Array, offset: number, width: number, value: number) => {
    writeText(target, offset, `${value.toString(8).padStart(width - 1, '0')}\0`);
  };

  for (const [path, content] of Object.entries(entries)) {
    const data = encoder.encode(content);
    const header = new Uint8Array(512);
    writeText(header, 0, path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = '0'.charCodeAt(0);
    writeText(header, 257, 'ustar\0');
    writeText(header, 263, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeText(header, 148, `${checksum.toString(8).padStart(6, '0')}\0 `);
    chunks.push(header, data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return new File(chunks, name, { type: 'application/x-tar' });
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

  it('accepts ZIP archives by signature when the filename has no extension', async () => {
    const zip = new JSZip();
    zip.file('index.html', '<h1>Signature</h1>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File([bytes.slice().buffer as ArrayBuffer], 'website-download', { type: 'application/octet-stream' });

    const result = await normalizeFileList(asFileList([file]));
    expect(result.kind).toBe('zip');
    if (result.kind === 'zip') expect(result.file).toBe(file);
  });

  it('unpacks TAR projects, strips their shared root, and repacks them as ZIP', async () => {
    const tar = makeTar('portfolio.tar', {
      'portfolio/index.html': '<img src="assets/hero.apng">',
      'portfolio/assets/hero.apng': 'image-bytes',
      'portfolio/src/App.tsx': 'export default function App() {}',
    });

    const result = await normalizeFileList(asFileList([tar]));
    expect(result.kind).toBe('packed');
    if (result.kind !== 'packed') throw new Error('expected packed');
    expect(result.file.name).toBe('portfolio.zip');
    expect(result.fileCount).toBe(3);
    expect(await pathsInside(result.file)).toEqual([
      'assets/hero.apng',
      'index.html',
      'src/App.tsx',
    ]);
  });

  it('decompresses TGZ projects when the browser gzip stream API is available', async () => {
    if (typeof CompressionStream === 'undefined' || typeof ReadableStream === 'undefined') return;
    const tar = makeTar('site.tar', { 'site/index.html': '<h1>TGZ</h1>' });
    const tarBytes = new Uint8Array(await tar.arrayBuffer());
    const tarStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(tarBytes);
        controller.close();
      },
    });
    const compressor = new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>;
    const compressed = tarStream.pipeThrough(compressor);
    const gzipBytes = await new Response(compressed).arrayBuffer();
    const tgz = new File([gzipBytes], 'site.tgz', { type: 'application/gzip' });
    Object.defineProperty(tgz, 'stream', {
      value: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(gzipBytes));
          controller.close();
        },
      }),
    });

    const result = await normalizeFileList(asFileList([tgz]));
    if (result.kind !== 'packed') throw new Error('expected packed');
    expect(result.file.name).toBe('site.zip');
    expect(await pathsInside(result.file)).toEqual(['index.html']);
  });

  it('accepts framework source and preserves unknown companion assets', async () => {
    const files = [
      makeFile('App.tsx', 'export const App = () => <img src="./model.bin" />'),
      new File(['opaque'], 'model.bin', { type: 'application/octet-stream' }),
    ];
    const result = await normalizeFileList(asFileList(files));
    if (result.kind !== 'packed') throw new Error('expected packed');
    expect(await pathsInside(result.file)).toEqual(['App.tsx', 'model.bin']);
  });

  it('rejects unsafe and case-colliding loose paths before packaging', async () => {
    const unsafe = makeFile('index.html', 'x', 'site/../index.html');
    await expect(normalizeFileList(asFileList([unsafe]))).rejects.toThrow(/unsafe parent path/i);

    const duplicates = [
      makeFile('Logo.svg', '<svg/>', 'site/images/Logo.svg'),
      makeFile('logo.svg', '<svg/>', 'site/images/logo.svg'),
    ];
    await expect(normalizeFileList(asFileList(duplicates))).rejects.toThrow(/letter case/i);
  });

  it('reports unsupported archive formats precisely', async () => {
    const rar = new File(['not-a-rar'], 'site.rar', { type: 'application/vnd.rar' });
    await expect(normalizeFileList(asFileList([rar]))).rejects.toThrow(/ZIP, TAR, TAR\.GZ, or TGZ/i);
  });

  it('rejects a selection with no recognizable web files', async () => {
    const files = [makeFile('notes', 'plain', 'stuff/notes')];
    await expect(normalizeFileList(asFileList(files))).rejects.toThrow(/no recognizable web files/i);
  });
});
