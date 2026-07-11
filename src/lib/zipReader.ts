import JSZip from 'jszip';

import type { LoadedProject, ProjectSummary, ZipEntryMeta } from '../types';
import { getCategory, normalizePath } from './fileTypes';

/** Heuristics to skip junk that operating systems tuck into zips. */
function isJunkSegment(segment: string): boolean {
  if (!segment) return true;
  if (segment.startsWith('__MACOSX')) return true;
  if (segment === '.DS_Store') return true;
  if (segment === 'Thumbs.db') return true;
  return false;
}

/**
 * Loads a `File` (presumably a zip) and returns a normalized metadata view.
 * The full archive stays inside the returned `JSZip` for later export,
 * but only the lightweight `ZipEntryMeta` list is built eagerly.
 */
export async function loadZipFromFile(file: File): Promise<LoadedProject> {
  const zip = await JSZip.loadAsync(file);

  const entries: ZipEntryMeta[] = [];
  let totalSize = 0;
  let htmlFiles = 0;
  let cssFiles = 0;
  let jsFiles = 0;
  let imageFiles = 0;
  let filesCount = 0;

  zip.forEach((relativePath, zipEntry) => {
    const normalized = normalizePath(relativePath);
    // Skip absolute paths that occasionally leak in.
    if (!normalized || normalized.startsWith('/')) return;

    const segments = normalized.split('/');
    if (segments.some(isJunkSegment)) return;

    const baseName = segments[segments.length - 1];
    const isDir = zipEntry.dir;

    // Best-effort uncompressed size. `_data` is an internal field but is
    // reliably populated when JSZip.loadAsync runs; fall back to 0 instead
    // of reading bytes upfront.
    const data = zipEntry as unknown as { _data?: { uncompressedSize?: number } };
    const size = data._data?.uncompressedSize ?? 0;

    const entry: ZipEntryMeta = {
      name: baseName,
      path: normalized,
      isDirectory: isDir,
      size,
      category: getCategory(baseName),
    };
    entries.push(entry);

    if (!isDir) {
      totalSize += size;
      filesCount += 1;
      switch (entry.category) {
        case 'html': htmlFiles += 1; break;
        case 'css':  cssFiles += 1;  break;
        case 'js':   jsFiles += 1;   break;
        case 'image': imageFiles += 1; break;
        default: break;
      }
    }
  });

  entries.sort((a, b) => a.path.localeCompare(b.path));

  const summary: ProjectSummary = {
    totalFiles: filesCount,
    totalSize,
    htmlFiles,
    cssFiles,
    jsFiles,
    imageFiles,
  };

  return { fileName: file.name, zip, entries, summary };
}
