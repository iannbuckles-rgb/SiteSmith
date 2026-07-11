/**
 * Convert a raw user-provided file name into something safe to embed in a
 * web project path:
 *   - Strip any directory piece (`/` and `\\`).
 *   - Lowercase the base name.
 *   - Strip accents (NFKD + combining-marks removal) so accented Latin
 *     and most diacritics resolve to plain ASCII.
 *   - Replace any non-alphanumeric run with a single hyphen.
 *   - Trim leading and trailing hyphens.
 *   - Preserve the lowercased extension verbatim if present and plausible.
 *
 * If the cleaning step leaves an empty base, fall back to a deterministic
 * `image-<timestamp><random>` token instead of the literal `'image'`, so
 * distinct uploads (e.g. two kanji-named PNGs dropped in a row) don't
 * collide on `-1`, `-2` suffixes.
 */
export function sanitizeFilename(name: string): string {
  const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const basename = lastSlash >= 0 ? name.slice(lastSlash + 1) : name;

  const lastDot = basename.lastIndexOf('.');
  const hasExt = lastDot > 0; // exclude leading-dot files like `.gitignore`
  let base = hasExt ? basename.slice(0, lastDot) : basename;
  const ext = hasExt ? basename.slice(lastDot + 1).toLowerCase() : '';

  base = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!base) {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 6);
    base = `image-${ts}${rnd}`;
  }

  return ext ? `${base}.${ext}` : base;
}

const MOCKUPS_PREFIX = 'assets/mockups/';

/**
 * Return a path under `assets/mockups/` for `baseName` that does not yet
 * exist in `existing`. Collision-free naming with a `-N` suffix until free.
 */
export function uniqueAssetPath(baseName: string, existing: Iterable<string>): string {
  const safeBaseName = sanitizeFilename(baseName);
  const lower = new Set<string>();
  for (const e of existing) lower.add(e.toLowerCase());

  const baseCandidate = MOCKUPS_PREFIX + safeBaseName;
  if (!lower.has(baseCandidate.toLowerCase())) return baseCandidate;

  const lastDot = safeBaseName.lastIndexOf('.');
  const stem = lastDot > 0 ? safeBaseName.slice(0, lastDot) : safeBaseName;
  const ext = lastDot > 0 ? safeBaseName.slice(lastDot) : '';

  for (let i = 1; i < 10000; i++) {
    const candidate = `${MOCKUPS_PREFIX}${stem}-${i}${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  // Unreachable in practice; return as a fallback and let the zip write
  // surface the conflict if it really happens.
  return baseCandidate;
}
