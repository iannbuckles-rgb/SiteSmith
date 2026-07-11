/**
 * Lightweight MIME-type lookup keyed by extension.
 * Used to wrap blobs in a `Blob(..., { type })` so e.g. blob URLs used as
 * stylesheets are parsed as CSS, and SVGs are recognised as images.
 */
const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html;charset=utf-8',
  htm:  'text/html;charset=utf-8',
  css:  'text/css;charset=utf-8',
  js:   'text/javascript;charset=utf-8',
  mjs:  'text/javascript;charset=utf-8',
  json: 'application/json;charset=utf-8',
  xml:  'application/xml;charset=utf-8',
  txt:  'text/plain;charset=utf-8',
  svg:  'image/svg+xml',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico:  'image/x-icon',
  bmp:  'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf:  'font/ttf',
  otf:  'font/otf',
  eot:  'application/vnd.ms-fontobject',
  pdf:  'application/pdf',
  mp4:  'video/mp4',
  webm: 'video/webm',
  mp3:  'audio/mpeg',
  wasm: 'application/wasm',
};

export function guessMimeType(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot === -1 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext];
}
