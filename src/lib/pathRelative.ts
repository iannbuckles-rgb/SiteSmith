/**
 * Compute the relative path from a host file (`from`) to a target inside
 * the project (`to`). POSIX-style semantics matching Node's
 * `path.posix.relative`:
 *
 *   pathRelative('index.html',          'assets/mockups/foo.png') -> './assets/mockups/foo.png'
 *   pathRelative('pages/about.html',    'assets/mockups/foo.png') -> '../assets/mockups/foo.png'
 *   pathRelative('styles/main.css',     'assets/mockups/foo.png') -> '../assets/mockups/foo.png'
 *   pathRelative('assets/foo.html',     'assets/mockups/bar.png') -> './mockups/bar.png'
 *
 * The returned path always includes a `./` prefix when no parent traversal
 * is needed so the produced reference is unambiguous.
 */
export function pathRelative(from: string, to: string): string {
  const sourceDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const sourceSegs = sourceDir ? sourceDir.split('/').filter(Boolean) : [];
  const targetSegs = to.split('/').filter(Boolean);

  const fileName = targetSegs.pop() ?? '';

  let common = 0;
  while (
    common < sourceSegs.length &&
    common < targetSegs.length &&
    sourceSegs[common] === targetSegs[common]
  ) {
    common++;
  }

  const ups = sourceSegs.length - common;
  const downs = targetSegs.slice(common);
  const parts = [...Array(ups).fill('..'), ...downs];
  // Always include a `./` prefix when no parent traversal is needed so
  // the produced reference is unambiguous (and matches Node-style
  // `path.posix.relative` only when ups > 0).
  if (parts.length === 0) return `./${fileName}`;
  const prefix = parts[0] === '..' ? '' : './';
  return `${prefix}${parts.join('/')}/${fileName}`;
}
