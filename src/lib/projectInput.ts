/* ----------------------------------------------------------------------------
 * projectInput
 * ----------------------------------------------------------------------------
 * Normalizes every onboarding gesture into a single `.zip` File so the rest of
 * the pipeline (worker parse → detect → preview → export) stays unchanged.
 *
 * Supported inputs:
 *   - a single `.zip` archive               → passed through untouched (fast path)
 *   - a dropped folder                       → traversed via the entries API
 *   - a folder chosen with a directory picker → read via `webkitRelativePath`
 *   - one or more loose web files            → packed by their file names
 *
 * Loose/folder inputs are packed with a dynamically-imported JSZip so the main
 * bundle only pays for the zip encoder when the user actually drops raw files.
 * -------------------------------------------------------------------------*/

/** A file paired with the archive-relative path it should occupy. */
interface PathedFile {
  path: string;
  file: File;
}

/** The outcome of inspecting a drop / picker selection. */
export type NormalizedInput =
  | { kind: 'zip'; file: File }
  | { kind: 'packed'; file: File; fileCount: number };

/** Extensions we recognise as belonging to a static web project. Used only to
 *  give a friendlier error when a selection contains nothing usable — the
 *  detector/preview themselves are tolerant of anything that lands in the zip. */
const WEB_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'json', 'webmanifest', 'map',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'txt', 'xml', 'md',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function isZipName(name: string): boolean {
  return extensionOf(name) === 'zip';
}

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

  if (directFiles.length === 1 && isZipName(directFiles[0].name)) {
    return { kind: 'zip', file: directFiles[0] };
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
  if (files.length === 1 && isZipName(files[0].name)) {
    return { kind: 'zip', file: files[0] };
  }
  const collected: PathedFile[] = files.map((file) => ({
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    file,
  }));
  return packFiles(collected);
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
    .map((f) => ({ ...f, path: f.path.replace(/\\/g, '/').replace(/^\/+/, '') }))
    .filter((f) => f.path && !isJunkPath(f.path));

  const roots = new Set(cleaned.map((f) => f.path.split('/')[0]));
  const firstSegments = cleaned.map((f) => f.path.split('/'));
  const sharedRoot =
    roots.size === 1 && firstSegments.every((segs) => segs.length > 1) ? [...roots][0] : null;

  if (!sharedRoot) return { files: cleaned, rootName: null };
  return {
    files: cleaned.map((f) => ({ ...f, path: f.path.slice(sharedRoot.length + 1) })),
    rootName: sharedRoot,
  };
}

/** Build a deterministic, human-friendly archive name from the input. */
function deriveArchiveName(files: PathedFile[], rootName: string | null): string {
  if (rootName) return `${rootName}.zip`;
  if (files.length === 1) {
    const base = files[0].path.replace(/\.[^./]+$/, '');
    return `${base || 'web-project'}.zip`;
  }
  return 'web-project.zip';
}

/** Pack a pathed-file list into a `.zip` File via a lazily-loaded JSZip. */
async function packFiles(rawFiles: PathedFile[]): Promise<NormalizedInput> {
  const { files, rootName } = tidyPaths(rawFiles);
  if (files.length === 0) {
    throw new Error('No usable files found. Drop a website .zip, a project folder, or its web files.');
  }
  if (!files.some((f) => WEB_EXTENSIONS.has(extensionOf(f.path)))) {
    throw new Error('That selection has no recognizable web files (HTML, CSS, JS, images). Nothing to preview.');
  }

  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const { path, file } of files) zip.file(path, file);

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  const name = deriveArchiveName(files, rootName);
  const file = new File([blob], name, { type: 'application/zip' });
  return { kind: 'packed', file, fileCount: files.length };
}
