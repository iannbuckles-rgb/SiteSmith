import type { FileCategory } from '../types';

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'bmp',
]);
const FONT_EXTENSIONS = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot']);

/** Returns the lowercase extension without the dot, or '' if none. */
export function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot === -1 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** Maps a file name to a coarse-grained category used in stats and the UI. */
export function getCategory(name: string): FileCategory {
  const ext = getExtension(name);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs') return 'js';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (FONT_EXTENSIONS.has(ext)) return 'font';
  return 'other';
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
