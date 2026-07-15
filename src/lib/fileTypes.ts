import type { FileCategory } from '../types';

/**
 * Canonical extension groups used by onboarding, file classification,
 * detection, and replacement controls. Keep format knowledge here so
 * an asset cannot be admitted by one surface and silently ignored by another.
 */
export const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'shtml']);
export const STYLE_EXTENSIONS = new Set([
  'css', 'scss', 'sass', 'less', 'styl', 'stylus', 'pcss', 'postcss',
]);
export const SCRIPT_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx',
]);
export const TEMPLATE_EXTENSIONS = new Set([
  'astro', 'vue', 'svelte', 'php', 'phtml', 'twig', 'liquid', 'njk', 'nunjucks',
  'ejs', 'hbs', 'handlebars', 'mustache', 'erb', 'razor', 'cshtml', 'aspx',
  'jsp', 'jspx', 'ftl', 'vm',
]);
export const IMAGE_EXTENSIONS = new Set([
  'png', 'apng', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp', 'gif', 'webp',
  'svg', 'svgz', 'avif', 'ico', 'cur', 'bmp', 'tif', 'tiff', 'heic', 'heif',
  'jxl', 'jp2', 'j2k', 'jpf',
]);
export const FONT_EXTENSIONS = new Set([
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'ttc', 'otc',
]);

const DATA_EXTENSIONS = new Set([
  'json', 'json5', 'jsonc', 'geojson', 'webmanifest', 'webapp', 'map',
  'xml', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'ndjson', 'graphql', 'gql',
]);
const MEDIA_EXTENSIONS = new Set([
  'mp4', 'm4v', 'webm', 'ogv', 'mov', 'avi', 'mp3', 'm4a', 'aac', 'oga',
  'ogg', 'opus', 'wav', 'flac', 'weba',
]);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'txt', 'md', 'mdx', 'markdown', 'rtf']);
const GENERAL_CODE_EXTENSIONS = new Set([
  'py', 'pyw', 'rb', 'java', 'cs', 'fs', 'fsx', 'go', 'rs', 'swift', 'kt',
  'kts', 'scala', 'dart', 'lua', 'pl', 'pm', 'r', 'sql', 'sh', 'bash', 'zsh',
  'fish', 'ps1', 'bat', 'cmd', 'coffee', 'clj', 'ex', 'exs', 'erl', 'hrl',
]);
const RUNTIME_EXTENSIONS = new Set([
  'wasm', 'wat', 'glsl', 'vert', 'frag', 'wgsl', 'webgl', 'worker', 'ktx', 'ktx2',
]);
const VISUAL_ASSET_EXTENSIONS = new Set([
  'gltf', 'glb', 'obj', 'mtl', 'fbx', 'dae', 'stl', 'ply', 'usdz',
  'psd', 'psb', 'ai', 'eps', 'sketch', 'xcf',
]);
const CONFIG_EXTENSIONS = new Set([
  'env', 'ini', 'cfg', 'conf', 'config', 'properties', 'lock', 'npmrc', 'browserslistrc',
  'editorconfig', 'gitignore', 'gitattributes', 'dockerignore',
]);

const PROJECT_EXTENSIONS = new Set([
  ...HTML_EXTENSIONS,
  ...STYLE_EXTENSIONS,
  ...SCRIPT_EXTENSIONS,
  ...TEMPLATE_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...FONT_EXTENSIONS,
  ...DATA_EXTENSIONS,
  ...MEDIA_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
  ...GENERAL_CODE_EXTENSIONS,
  ...RUNTIME_EXTENSIONS,
  ...VISUAL_ASSET_EXTENSIONS,
  ...CONFIG_EXTENSIONS,
]);

const PROJECT_BASENAMES = new Set([
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile',
  'license', 'readme', 'robots.txt', 'humans.txt', 'cname',
]);

/** Shared file-picker contract for every image replacement surface. Including
 * extensions matters because browsers commonly leave `File.type` empty for
 * SVG, ICO, AVIF, or files supplied by drag-and-drop. */
export const IMAGE_FILE_ACCEPT = [
  'image/*',
  'image/png', 'image/apng', 'image/jpeg', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon',
  'image/bmp', 'image/tiff', 'image/heic', 'image/heif', 'image/jxl',
  ...Array.from(IMAGE_EXTENSIONS, (ext) => `.${ext}`),
].join(',');

/** File-picker hints for project onboarding. Drag/drop remains permissive and
 * validation uses `isRecognizedProjectFile`, because picker hints are not a
 * security boundary and browsers vary in which MIME filters they implement. */
export const PROJECT_FILE_ACCEPT = [
  '.zip', '.tar', '.tar.gz', '.tgz',
  'application/zip', 'application/x-zip-compressed',
  'application/x-tar', 'application/gzip', 'application/x-gzip',
  'image/*', 'audio/*', 'video/*',
  ...Array.from(PROJECT_EXTENSIONS, (ext) => `.${ext}`),
].join(',');

/** Returns the lowercase extension without the dot, or '' if none. */
export function getExtension(name: string): string {
  const clean = name.split(/[?#]/, 1)[0];
  const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  const dot = clean.lastIndexOf('.');
  if (dot <= slash || dot === clean.length - 1) return '';
  return clean.slice(dot + 1).toLowerCase();
}

/** Maps a file name to a coarse-grained category used in stats and the UI. */
export function getCategory(name: string): FileCategory {
  const ext = getExtension(name);
  if (HTML_EXTENSIONS.has(ext)) return 'html';
  if (STYLE_EXTENSIONS.has(ext)) return 'css';
  if (SCRIPT_EXTENSIONS.has(ext)) return 'js';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (FONT_EXTENSIONS.has(ext)) return 'font';
  return 'other';
}

/** True for files that can form part of a website project, including source
 * formats that a browser cannot execute without the project's own build step.
 * Unknown companion files are still retained whenever the selection contains
 * at least one recognized project file. */
export function isRecognizedProjectFile(file: Pick<File, 'name' | 'type'>): boolean {
  const ext = getExtension(file.name);
  if (PROJECT_EXTENSIONS.has(ext)) return true;

  const base = file.name.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (PROJECT_BASENAMES.has(base)) return true;

  const mime = file.type.trim().toLowerCase().split(';', 1)[0];
  return (
    (Boolean(ext) && mime.startsWith('text/'))
    || mime.startsWith('image/')
    || mime.startsWith('audio/')
    || mime.startsWith('video/')
    || mime.startsWith('font/')
    || mime === 'application/json'
    || mime === 'application/manifest+json'
    || mime === 'application/wasm'
    || mime === 'application/xml'
    || mime === 'application/pdf'
  );
}

/** Tests a URL/path by extension without trusting a browser-supplied MIME. */
export function looksLikeImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(path));
}

/** Source formats scanned for literal visual references even when they are not
 * directly renderable by the browser preview without a framework build. */
export function isScriptSourcePath(path: string): boolean {
  return SCRIPT_EXTENSIONS.has(getExtension(path));
}

export function isTemplateSourcePath(path: string): boolean {
  return TEMPLATE_EXTENSIONS.has(getExtension(path));
}

/** Whether an admitted project file should receive a readable text fallback
 * MIME when its format has no registered media type. */
export function isTextSourcePath(path: string): boolean {
  const ext = getExtension(path);
  const base = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return (
    HTML_EXTENSIONS.has(ext)
    || STYLE_EXTENSIONS.has(ext)
    || SCRIPT_EXTENSIONS.has(ext)
    || TEMPLATE_EXTENSIONS.has(ext)
    || DATA_EXTENSIONS.has(ext)
    || GENERAL_CODE_EXTENSIONS.has(ext)
    || CONFIG_EXTENSIONS.has(ext)
    || ext === 'svg'
    || (DOCUMENT_EXTENSIONS.has(ext) && ext !== 'pdf' && ext !== 'rtf')
    || (RUNTIME_EXTENSIONS.has(ext) && ext !== 'wasm' && ext !== 'ktx' && ext !== 'ktx2')
    || PROJECT_BASENAMES.has(base)
  );
}

/** Filters CSS/markup URL candidates that are definitively another asset kind.
 * Extensionless URLs remain eligible because many build pipelines emit routes
 * or hashed resources without an informative suffix. */
export function looksLikeKnownNonImagePath(path: string): boolean {
  const ext = getExtension(path);
  return (
    FONT_EXTENSIONS.has(ext)
    || MEDIA_EXTENSIONS.has(ext)
    || DOCUMENT_EXTENSIONS.has(ext)
    || DATA_EXTENSIONS.has(ext)
    || RUNTIME_EXTENSIONS.has(ext)
    || VISUAL_ASSET_EXTENSIONS.has(ext)
  );
}

/** Accept browser-identified images and known image extensions. The extension
 * fallback keeps valid local files usable when the OS does not provide a MIME
 * type; source bytes are still stored unchanged by the replacement pipeline. */
export function isSupportedImageFile(file: Pick<File, 'name' | 'type'>): boolean {
  const mime = file.type.trim().toLowerCase();
  return mime.startsWith('image/') || IMAGE_EXTENSIONS.has(getExtension(file.name));
}

/** Human-readable byte size (1024-based). Returns '0 B' for zero. */
export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Normalize a zip-internal path to forward slashes (for cross-platform zips). */
export function normalizePath(rawPath: string): string {
  return rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
}
