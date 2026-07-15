/* ----------------------------------------------------------------------------
 * projectInput
 * ----------------------------------------------------------------------------
 * Normalizes every onboarding gesture into a single `.zip` File so the rest of
 * the pipeline (worker parse → detect → preview → export) stays unchanged.
 *
 * Supported inputs:
 *   - a single `.zip` archive               → passed through untouched (fast path)
 *   - a single `.tar`, `.tar.gz`, or `.tgz`  → unpacked and repacked as zip
 *   - a dropped folder                       → traversed via the entries API
 *   - a folder chosen with a directory picker → read via `webkitRelativePath`
 *   - one or more loose web files            → packed by their file names
 *
 * Loose/folder inputs are packed with a dynamically-imported JSZip so the main
 * bundle only pays for the zip encoder when the user actually drops raw files.
 * -------------------------------------------------------------------------*/

import { getExtension, isRecognizedProjectFile } from './fileTypes';
import { guessMimeType } from './mime';

/** A file paired with the archive-relative path it should occupy. */
interface PathedFile {
  path: string;
  file: File;
}

/** The outcome of inspecting a drop / picker selection. */
export type NormalizedInput =
  | { kind: 'zip'; file: File }
  | { kind: 'packed'; file: File; fileCount: number };

type ArchiveKind = 'zip' | 'tar' | 'tar-gzip';

const UNSUPPORTED_ARCHIVE_EXTENSIONS = new Set(['7z', 'rar', 'bz2', 'xz']);

function isJunkPath(path: string): boolean {
  return path
    .split('/')
    .some((seg) => !seg || seg === '.DS_Store' || seg === 'Thumbs.db' || seg.startsWith('__MACOSX'));
}

/**
 * Inspect a drop's `DataTransfer`. Returns a single passthrough zip when the
 * user dropped exactly one `.zip`; otherwise recursively walks folders/files
 * via the `webkitGetAsEntry` API (the only reliable way to read a dropped
 * directory) and packs the result.
 */
export async function normalizeDataTransfer(dataTransfer: DataTransfer): Promise<NormalizedInput> {
  const items = Array.from(dataTransfer.items ?? []).filter((it) => it.kind === 'file');
  const directFiles = Array.from(dataTransfer.files ?? []);

  if (directFiles.length === 1) {
    const archive = await normalizeArchive(directFiles[0]);
    if (archive) return archive;
  }

  // Prefer the entries API — it is the only path that exposes folder contents.
  const entries = items
    .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e != null);

  let collected: PathedFile[];
  if (entries.length > 0) {
    collected = (await Promise.all(entries.map((entry) => walkEntry(entry, '')))).flat();
  } else {
    collected = directFiles.map((file) => ({ path: file.name, file }));
  }

  return packFiles(collected);
}

/**
 * Normalize a `<input type="file">` / directory-picker `FileList`. A directory
 * picker populates `webkitRelativePath`; a multi-file picker leaves it empty
 * and we fall back to the file name.
 */
export async function normalizeFileList(fileList: FileList): Promise<NormalizedInput> {
  const files = Array.from(fileList);
  if (files.length === 1) {
    const archive = await normalizeArchive(files[0]);
    if (archive) return archive;
  }
  const collected: PathedFile[] = files.map((file) => ({
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    file,
  }));
  return packFiles(collected);
}

/** Detect supported archives by both name/MIME and signature. Signature
 * detection admits archives downloaded without a useful filename while still
 * keeping ordinary single web files on the loose-file path. */
async function normalizeArchive(file: File): Promise<NormalizedInput | null> {
  const kind = await detectArchiveKind(file);
  if (kind === 'zip') return { kind: 'zip', file };

  if (kind === 'tar' || kind === 'tar-gzip') {
    const tarBytes = kind === 'tar-gzip'
      ? await decompressGzip(file)
      : new Uint8Array(await file.arrayBuffer());
    const files = extractTarFiles(tarBytes);
    return packFiles(files, archiveBaseName(file.name));
  }

  const extension = getExtension(file.name);
  if (UNSUPPORTED_ARCHIVE_EXTENSIONS.has(extension)) {
    throw new Error(
      `.${extension} archives are not supported. Use ZIP, TAR, TAR.GZ, or TGZ for website projects.`,
    );
  }
  return null;
}

async function detectArchiveKind(file: File): Promise<ArchiveKind | null> {
  const lowerName = file.name.toLowerCase();
  const mime = file.type.trim().toLowerCase().split(';', 1)[0];
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());

  const zipSignature = head.length >= 4
    && head[0] === 0x50
    && head[1] === 0x4b
    && ((head[2] === 0x03 && head[3] === 0x04)
      || (head[2] === 0x05 && head[3] === 0x06)
      || (head[2] === 0x07 && head[3] === 0x08));
  if (
    zipSignature
    || lowerName.endsWith('.zip')
    || mime === 'application/zip'
    || mime === 'application/x-zip-compressed'
  ) return 'zip';

  const gzipSignature = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
  if (
    gzipSignature
    || lowerName.endsWith('.tar.gz')
    || lowerName.endsWith('.tgz')
    || mime === 'application/gzip'
    || mime === 'application/x-gzip'
  ) return 'tar-gzip';

  const tarSignature = head.length >= 265 && decodeTarText(head.subarray(257, 263)).startsWith('ustar');
  if (tarSignature || lowerName.endsWith('.tar') || mime === 'application/x-tar') return 'tar';
  return null;
}

async function decompressGzip(file: File): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot unpack TAR.GZ files. Repackage the project as ZIP or TAR.');
  }
  try {
    const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error('The gzip archive is damaged or could not be decompressed.');
  }
}

/** Minimal POSIX/GNU/PAX TAR reader. It deliberately imports regular files
 * only: symlinks, devices, and other filesystem-specific entries have no safe
 * or useful representation in a browser-authored website zip. */
function extractTarFiles(bytes: Uint8Array): PathedFile[] {
  const files: PathedFile[] = [];
  let offset = 0;
  let nextLongPath: string | null = null;
  let nextPaxPath: string | null = null;
  let sawHeader = false;

  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    sawHeader = true;
    validateTarChecksum(header);

    const name = decodeTarText(header.subarray(0, 100));
    const prefix = decodeTarText(header.subarray(345, 500));
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const size = parseTarNumber(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || dataEnd > bytes.byteLength) {
      throw new Error('The TAR archive contains a truncated or invalid file entry.');
    }
    const payload = bytes.subarray(dataStart, dataEnd);

    if (type === 'L') {
      nextLongPath = decodeTarText(payload);
    } else if (type === 'x') {
      nextPaxPath = parsePaxPath(payload);
    } else if (type === '\0' || type === '0' || type === '7') {
      const path = nextPaxPath || nextLongPath || headerPath;
      if (path) {
        const normalizedPath = normalizeInputPath(path);
        const namePart = normalizedPath.split('/').pop() || 'file';
        const copy = payload.slice();
        files.push({
          path: normalizedPath,
          file: new File([copy], namePart, { type: guessMimeType(namePart) ?? '' }),
        });
      }
      nextLongPath = null;
      nextPaxPath = null;
    } else if (type !== '5') {
      // Metadata and unsupported filesystem entries apply to at most the next
      // regular file. Do not let a stale extended path leak across entries.
      nextLongPath = null;
      nextPaxPath = null;
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  if (!sawHeader) throw new Error('The TAR archive is empty or invalid.');
  if (files.length === 0) throw new Error('The TAR archive contains no regular files.');
  return files;
}

function validateTarChecksum(header: Uint8Array): void {
  const stored = parseTarNumber(header.subarray(148, 156));
  if (stored === 0) return;
  let sum = 0;
  for (let i = 0; i < header.length; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  if (sum !== stored) throw new Error('The TAR archive failed its integrity check.');
}

function parseTarNumber(field: Uint8Array): number {
  // POSIX octal is overwhelmingly common. GNU base-256 is supported for large
  // entries as long as the result remains a safe JavaScript integer.
  if ((field[0] & 0x80) !== 0) {
    let value = BigInt(field[0] & 0x7f);
    for (let i = 1; i < field.length; i += 1) value = (value << 8n) | BigInt(field[i]);
    const result = Number(value);
    return Number.isSafeInteger(result) ? result : Number.NaN;
  }
  const text = decodeTarText(field).trim();
  if (!text) return 0;
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : Number.NaN;
}

function decodeTarText(bytes: Uint8Array): string {
  const zero = bytes.indexOf(0);
  const slice = zero === -1 ? bytes : bytes.subarray(0, zero);
  return new TextDecoder().decode(slice).trim();
}

function parsePaxPath(payload: Uint8Array): string | null {
  const text = new TextDecoder().decode(payload);
  let cursor = 0;
  while (cursor < text.length) {
    const space = text.indexOf(' ', cursor);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(cursor, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, cursor + length).replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals !== -1 && record.slice(0, equals) === 'path') return record.slice(equals + 1);
    cursor += length;
  }
  return null;
}

function archiveBaseName(name: string): string {
  return name.replace(/\.(?:tar\.gz|tgz|tar)$/i, '') || 'web-project';
}

/* ---------------------------------------------------------------------------
 * Internals
 * -------------------------------------------------------------------------*/

/** Recursively read a dropped FileSystemEntry into a flat pathed-file list. */
async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<PathedFile[]> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    return [{ path, file }];
  }
  if (entry.isDirectory) {
    const children = await readAllDirectoryEntries((entry as FileSystemDirectoryEntry).createReader());
    const nested = await Promise.all(children.map((child) => walkEntry(child, path)));
    return nested.flat();
  }
  return [];
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** `readEntries` yields at most ~100 entries per call, so drain it in a loop. */
async function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

/** Drop OS junk and strip a single shared top-level folder ("my-site/…"). */
function tidyPaths(files: PathedFile[]): { files: PathedFile[]; rootName: string | null } {
  const cleaned = files
    .map((f) => ({ ...f, path: normalizeInputPath(f.path) }))
    .filter((f) => f.path && !isJunkPath(f.path));

  const roots = new Set(cleaned.map((f) => f.path.split('/')[0]));
  const firstSegments = cleaned.map((f) => f.path.split('/'));
  const sharedRoot =
    roots.size === 1 && firstSegments.every((segs) => segs.length > 1) ? [...roots][0] : null;

  const tidied = !sharedRoot ? cleaned : cleaned.map((f) => ({
    ...f,
    path: f.path.slice(sharedRoot.length + 1),
  }));

  const seen = new Map<string, string>();
  for (const { path } of tidied) {
    const folded = path.toLocaleLowerCase('en-US');
    const previous = seen.get(folded);
    if (previous) {
      throw new Error(
        previous === path
          ? `The selection contains duplicate files at "${path}".`
          : `The selection contains paths that differ only by letter case: "${previous}" and "${path}".`,
      );
    }
    seen.set(folded, path);
  }

  return {
    files: tidied,
    rootName: sharedRoot,
  };
}

/** Normalize a browser/TAR-provided relative path without allowing traversal
 * or control characters to become zip entry names. */
function normalizeInputPath(rawPath: string): string {
  const path = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/[\0-\x1f\x7f]/.test(path)) {
    throw new Error('The selection contains a filename with unsupported control characters.');
  }
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      throw new Error(`The selection contains an unsafe parent path: "${rawPath}".`);
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** Build a deterministic, human-friendly archive name from the input. */
function deriveArchiveName(
  files: PathedFile[],
  rootName: string | null,
  preferredName?: string,
): string {
  if (rootName) return `${rootName}.zip`;
  if (preferredName) return `${preferredName}.zip`;
  if (files.length === 1) {
    const base = files[0].path.replace(/\.[^./]+$/, '');
    return `${base || 'web-project'}.zip`;
  }
  return 'web-project.zip';
}

/** Pack a pathed-file list into a `.zip` File via a lazily-loaded JSZip. */
async function packFiles(rawFiles: PathedFile[], preferredName?: string): Promise<NormalizedInput> {
  const { files, rootName } = tidyPaths(rawFiles);
  if (files.length === 0) {
    throw new Error('No usable files found. Drop a website archive, project folder, or its source/assets.');
  }
  if (!files.some((f) => isRecognizedProjectFile({ name: f.path, type: f.file.type }))) {
    throw new Error(
      'That selection has no recognizable web files, source, or assets. Nothing can be inspected.',
    );
  }

  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const { path, file } of files) zip.file(path, file);

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const name = deriveArchiveName(files, rootName, preferredName);
  const file = new File([blob], name, { type: 'application/zip' });
  return { kind: 'packed', file, fileCount: files.length };
}
