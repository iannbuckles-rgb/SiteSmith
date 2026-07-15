import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits } from '../src/lib/archiveLimits';
import { loadZipFromFile } from '../src/lib/zipReader';

async function zipFile(
  name: string,
  entries: Record<string, string>,
  compression: 'STORE' | 'DEFLATE' = 'STORE',
): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression });
  return new File([bytes.slice().buffer as ArrayBuffer], name, { type: 'application/zip' });
}

function limits(overrides: Partial<ArchiveLimits>): ArchiveLimits {
  return { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
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

  it('enforces compressed input, entry-count, and expanded-byte limits', async () => {
    const input = await zipFile('input.zip', { 'index.html': '<h1>safe</h1>' });
    await expect(loadZipFromFile(input, limits({ maxInputBytes: input.size - 1 })))
      .rejects.toMatchObject({ code: 'input-bytes' });

    const entries = await zipFile('entries.zip', {
      'a.html': 'a',
      'b.css': 'b',
      'c.js': 'c',
    });
    await expect(loadZipFromFile(entries, limits({ maxEntries: 2 })))
      .rejects.toMatchObject({ code: 'entries' });

    const expanded = await zipFile('expanded.zip', {
      'a.html': '123456',
      'b.css': '123456',
    });
    await expect(loadZipFromFile(expanded, limits({ maxExpandedBytes: 10 })))
      .rejects.toMatchObject({ code: 'expanded-bytes' });
  });

  it('enforces compression ratio, text-source size, and UTF-8 path limits', async () => {
    const compressed = await zipFile('compressed.zip', {
      'payload.bin': 'A'.repeat(4_096),
    }, 'DEFLATE');
    await expect(loadZipFromFile(compressed, limits({
      compressionRatioFloorBytes: 1,
      maxCompressionRatio: 2,
    }))).rejects.toMatchObject({ code: 'compression-ratio' });

    const source = await zipFile('source.zip', { 'src/app.js': '12345678901' });
    await expect(loadZipFromFile(source, limits({ maxTextSourceBytes: 10 })))
      .rejects.toMatchObject({ code: 'text-source-bytes' });

    const longPath = await zipFile('path.zip', { 'abcdefghijk.html': 'x' });
    await expect(loadZipFromFile(longPath, limits({ maxPathBytes: 10 })))
      .rejects.toMatchObject({ code: 'path-bytes' });

    const longSegment = await zipFile('segment.zip', { 'abcdef/x.html': 'x' });
    await expect(loadZipFromFile(longSegment, limits({ maxPathSegmentBytes: 5 })))
      .rejects.toMatchObject({ code: 'path-segment-bytes' });
  });
});
