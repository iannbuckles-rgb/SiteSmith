import JSZip from 'jszip';

import type { LoadedProject, ProjectSummary, ZipEntryMeta } from '../types';
import {
  DEFAULT_ARCHIVE_LIMITS,
  assertArchiveEntryCount,
  assertArchiveInputSize,
  assertArchivePath,
  assertCompressionRatio,
  assertExpandedSize,
  assertTextSourceSize,
  type ArchiveLimits,
} from './archiveLimits';
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
export async function loadZipFromFile(
  file: File,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<LoadedProject> {
  assertArchiveInputSize(file.size, limits);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file, { checkCRC32: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message.toLowerCase() : '';
    if (detail.includes('encrypted')) {
      throw new Error('Encrypted ZIP archives are not supported. Export the website as an unencrypted ZIP.');
    }
    throw new Error('Could not read this archive. Use a valid, unencrypted ZIP, TAR, TAR.GZ, or TGZ file.');
  }

  const entries: ZipEntryMeta[] = [];
  let totalSize = 0;
  let htmlFiles = 0;
  let cssFiles = 0;
  let jsFiles = 0;
  let imageFiles = 0;
  let filesCount = 0;
  let archiveEntryCount = 0;
  let archiveExpandedBytes = 0;
  let archiveCompressedBytes = 0;
  const seenPaths = new Map<string, string>();

  zip.forEach((relativePath, zipEntry) => {
    archiveEntryCount += 1;
    assertArchiveEntryCount(archiveEntryCount, limits);
    const normalized = normalizePath(relativePath);
    if (!normalized) return;
    if (
      normalized.startsWith('/')
      || /^[a-z]:\//i.test(normalized)
      || /[\0-\x1f\x7f]/.test(normalized)
    ) {
      throw new Error(`The archive contains an unsafe path: "${relativePath}".`);
    }

    const segments = normalized.split('/');
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      throw new Error(`The archive contains an unsafe relative path: "${relativePath}".`);
    }
    assertArchivePath(normalized, limits);

    const unsafeOriginalName = (zipEntry as unknown as { unsafeOriginalName?: string }).unsafeOriginalName;
    if (unsafeOriginalName) {
      const normalizedOriginalName = normalizePath(unsafeOriginalName);
      assertArchivePath(normalizedOriginalName, limits);
      if (normalizedOriginalName !== normalized) {
        throw new Error(`The archive contains an unsafe parent path: "${unsafeOriginalName}".`);
      }
    }

    const baseName = segments[segments.length - 1];
    const isDir = zipEntry.dir;

    // Best-effort uncompressed size. `_data` is an internal field but is
    // reliably populated when JSZip.loadAsync runs; fall back to 0 instead
    // of reading bytes upfront.
    const data = zipEntry as unknown as {
      _data?: { uncompressedSize?: number; compressedSize?: number };
    };
    const size = data._data?.uncompressedSize ?? 0;
    const compressedSize = data._data?.compressedSize ?? 0;
    if (!isValidArchiveSize(size) || !isValidArchiveSize(compressedSize)) {
      throw new Error(`The archive reports an invalid size for "${normalized}".`);
    }

    if (!isDir) {
      archiveExpandedBytes += size;
      archiveCompressedBytes += compressedSize;
      assertExpandedSize(archiveExpandedBytes, limits);
      assertCompressionRatio(size, compressedSize, limits);
      assertTextSourceSize(normalized, size, limits);
    }

    // Limits and unsafe-path checks deliberately include ignored OS junk so a
    // hostile archive cannot hide resource consumption under __MACOSX.
    if (segments.some(isJunkSegment)) return;

    const foldedPath = normalized.toLocaleLowerCase('en-US');
    const priorPath = seenPaths.get(foldedPath);
    if (priorPath && priorPath !== normalized) {
      throw new Error(
        `The archive contains paths that differ only by letter case: "${priorPath}" and "${normalized}".`,
      );
    }
    seenPaths.set(foldedPath, normalized);

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

  assertCompressionRatio(archiveExpandedBytes, archiveCompressedBytes, limits);

  if (filesCount === 0) {
    throw new Error('The archive contains no usable website files.');
  }

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

function isValidArchiveSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
