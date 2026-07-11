/**
 * URL/path helpers used by the image detector.
 *
 * The zip itself is not a URL, so we build resolutions against a small
 * synthetic URL with a private host (`zip.local`). That lets us lean on
 * the browser's URL API for safe relative-path resolution, query/fragment
 * handling, and percent-decoding.
 */

const ZIP_HOST = 'zip.local';

/** True if the URL points somewhere outside the project itself. */
export function classifyUrl(rawUrl: string): 'remote' | 'local' {
  if (!rawUrl) return 'local';
  const trimmed = rawUrl.trim();
  if (/^(data|mailto|tel|javascript):/i.test(trimmed)) return 'remote';
  if (/^https?:\/\//i.test(trimmed)) return 'remote';
  if (/^\/\//.test(trimmed)) return 'remote';
  return 'local';
}

export interface ResolutionResult {
  /** True if the reference is not a project-local asset. */
  isRemote: boolean;
  /** Resolved zip-internal path, or '' if not resolvable inside the zip. */
  resolvedPath: string;
  /** Query string and/or fragment suffix preserved from the original ref. */
  suffix: string;
}

/**
 * Resolves a reference URL against the directory of a host file inside the
 * zip. Mirrors browser-style relative resolution:
 *   source `pages/about.html` + ref `../img/foo.png` -> `img/foo.png`
 *   source `index.html` + ref `/img/foo.png`        -> `img/foo.png`
 */
export function resolveAgainst(sourcePath: string, ref: string): ResolutionResult {
  if (classifyUrl(ref) === 'remote' || !ref) {
    return { isRemote: true, resolvedPath: '', suffix: '' };
  }

  const baseDir = '/'
    + (sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '')
    + '/';
  const fakeBase = encodeURI(baseDir);

  let parsed: URL;
  try {
    parsed = new URL(ref, 'http://' + ZIP_HOST + fakeBase);
  } catch {
    return { isRemote: false, resolvedPath: '', suffix: '' };
  }

  if (parsed.hostname !== ZIP_HOST) {
    return { isRemote: true, resolvedPath: '', suffix: '' };
  }

  let pathname = parsed.pathname.replace(/^\/+/, '');
  const suffix = `${parsed.search}${parsed.hash}`;
  if (!pathname) return { isRemote: false, resolvedPath: '', suffix };

  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Leave raw if the bytes aren't valid; the existence check will fail.
  }
  return { isRemote: false, resolvedPath: pathname, suffix };
}

/**
 * Parses a `srcset` value into its candidate URLs.
 * Accepts the spec format:
 *   `"url 1x, url2 2x, url3 480w"`
 * Multi-space and trailing commas are tolerated.
 */
export function parseSrcset(srcset: string): string[] {
  const out: string[] = [];
  for (const part of srcset.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const url = trimmed.split(/\s+/)[0];
    if (url) out.push(url);
  }
  return out;
}
