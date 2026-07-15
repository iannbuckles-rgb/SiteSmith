export interface CssFunctionRange {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

/** Locate balanced image-set() functions, including vendor-prefixed and nested
 * url()/type() calls. Quoted strings, escapes, and block comments cannot close
 * the outer function early. */
export function findImageSetFunctions(css: string): CssFunctionRange[] {
  const ranges: CssFunctionRange[] = [];
  const opener = /(?:-webkit-)?image-set\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(css)) !== null) {
    const open = css.indexOf('(', match.index);
    let depth = 1;
    let quote: '"' | "'" | null = null;
    let escaped = false;
    let inComment = false;
    let cursor = open + 1;

    for (; cursor < css.length; cursor += 1) {
      const char = css[cursor];
      const next = css[cursor + 1];
      if (inComment) {
        if (char === '*' && next === '/') {
          inComment = false;
          cursor += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '/' && next === '*') {
        inComment = true;
        cursor += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) break;
    ranges.push({
      start: match.index,
      end: cursor + 1,
      bodyStart: open + 1,
      bodyEnd: cursor,
    });
    opener.lastIndex = cursor + 1;
  }
  return ranges;
}
