export interface SourceRange {
  start: number;
  end: number;
}

export function findHtmlCommentRanges(text: string): SourceRange[] {
  return findDelimitedRanges(text, '<!--', '-->');
}

export function findCssCommentRanges(text: string): SourceRange[] {
  return findDelimitedRanges(text, '/*', '*/');
}

export function isOffsetInRanges(offset: number, ranges: SourceRange[]): boolean {
  for (const range of ranges) {
    if (offset < range.start) return false;
    if (offset >= range.start && offset < range.end) return true;
  }
  return false;
}

export function replaceRangesWithWhitespace(text: string, ranges: SourceRange[]): string {
  if (ranges.length === 0) return text;

  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start);
    out += text.slice(range.start, range.end).replace(/[^\r\n]/g, ' ');
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

function findDelimitedRanges(text: string, open: string, close: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  let start = text.indexOf(open);

  while (start !== -1) {
    const closeStart = text.indexOf(close, start + open.length);
    const end = closeStart === -1 ? text.length : closeStart + close.length;
    ranges.push({ start, end });
    if (end >= text.length) break;
    start = text.indexOf(open, end);
  }

  return ranges;
}
