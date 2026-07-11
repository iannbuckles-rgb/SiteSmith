/* ----------------------------------------------------------------------------
 * lineDiff
 * --------------------------------------------------------------------------
 * A tiny line-based diff that returns a sequence of hunks describing how a
 * pair of source texts differ at the line level. Used by the History panel
 * to render before/after for every applied patch.
 *
 * Algorithm: classic O(N·M) LCS table. Inputs are sizes kept small — the
 * History panel feeds it single source-file snapshots, NOT the whole zip,
 * so even 100k-line HTML is fine. If we ever need to diff megabyte-sized
 * files we can swap in Myers, but for v1 the easy algorithm wins on
 * readability. Worst-case memory is N×M of the input line counts.
 *
 * Output shape:
 *   - Each hunk is `{ type: 'context' | 'add' | 'remove', line: string }`.
 *   - 'context' lines are unchanged and shared between both sides.
 *   - 'add' lines exist in the AFTER text only.
 *   - 'remove' lines exist in the BEFORE text only.
 *
 * The hunk order matches the AFTER text's frame of reference: we walk it
 * forward, emitting context lines from either side and run-length
 * compressing adjacent same-kind lines into one block so the renderer
 * doesn't have to special-case them.
 * -------------------------------------------------------------------------*/

export type DiffHunk =
  | { type: 'context'; line: string }
  | { type: 'add'; line: string }
  | { type: 'remove'; line: string };

/**
 * Compute a line diff between two source texts. Returns an array of
 * hunks suitable for rendering. Lines are split on `\n` (a single trailing
 * `\n` is treated as part of the previous line so a final empty line does
 * NOT generate a spurious hunk).
 *
 * Time: O(N·M); space: O(N·M). Fine for files under ~50,000 lines; if we
 * need bigger, swap in Myers without changing the call shape.
 */
export function lineDiff(before: string, after: string): DiffHunk[] {
  const aLines = splitLines(before);
  const bLines = splitLines(after);

  // Build the LCS table. lcs[i][j] = length of LCS between aLines[:i] and
  // bLines[:j]. Indices start at 0; the table has shape (len(a)+1) × (len(b)+1)
  // so we can walk it backward to reconstruct the diff.
  const aLen = aLines.length;
  const bLen = bLines.length;
  const lcs: number[][] = new Array(aLen + 1);
  for (let i = 0; i <= aLen; i++) {
    lcs[i] = new Array(bLen + 1).fill(0);
  }
  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      lcs[i][j] = aLines[i - 1] === bLines[j - 1]
        ? lcs[i - 1][j - 1] + 1
        : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }

  // Walk backward from (aLen, bLen) to collect hunks in REVERSE order, then
  // reverse at the end. Walking forward is also possible but recursion
  // would balloon the stack on large files; the iterative backward walk is
  // simpler and stays below a few hundred KB of allocations for our
  // typical HTML / CSS files.
  const out: DiffHunk[] = [];
  let i = aLen;
  let j = bLen;
  while (i > 0 && j > 0) {
    if (aLines[i - 1] === bLines[j - 1]) {
      out.push({ type: 'context', line: aLines[i - 1] });
      i -= 1;
      j -= 1;
    } else if (lcs[i - 1][j] > lcs[i][j - 1]) {
      out.push({ type: 'remove', line: aLines[i - 1] });
      i -= 1;
    } else {
      out.push({ type: 'add', line: bLines[j - 1] });
      j -= 1;
    }
  }
  while (i > 0) {
    out.push({ type: 'remove', line: aLines[i - 1] });
    i -= 1;
  }
  while (j > 0) {
    out.push({ type: 'add', line: bLines[j - 1] });
    j -= 1;
  }
  out.reverse();
  return compressRunLength(out);
}

/**
 * Coalesce adjacent hunks of the same type into a single hunk so the
 * renderer can show one block per change rather than N "add"/N "remove"
 * repeats. We deliberately keep them as multi-line hunks — the renderer
 * is responsible for visually formatting them as a block.
 */
export function compressRunLength(hunks: DiffHunk[]): DiffHunk[] {
  if (hunks.length === 0) return hunks;
  const out: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const h of hunks) {
    if (current && current.type === h.type) {
      // Construct explicitly rather than spreading `current` (a discriminated
      // union) so TS treats it as a fresh object literal of the matching
      // variant, not a "we don't know which literal type this is" union.
      current = { type: h.type, line: current.line + '\n' + h.line };
    } else {
      if (current) out.push(current);
      current = { type: h.type, line: h.line };
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Split the source text into lines but keep newline-terminated lines whole
 * so the diff is faithful to the original file's framing. We split on `\n`
 * and DO NOT include the delimiter; the renderer adds its own when
 * rendering a multi-line context.
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  // Trailing newline does not introduce a phantom empty line.
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;
  return stripped.split('\n');
}

/**
 * A coarse statistic over a diff result: how many lines are adds,
 * removes, and contexts. Lets the renderer show "3 lines removed" without
 * re-walking the hunks.
 */
export interface DiffStats {
  additions: number;
  deletions: number;
  contexts: number;
}

export function computeDiffStats(hunks: DiffHunk[]): DiffStats {
  let additions = 0;
  let deletions = 0;
  let contexts = 0;
  for (const h of hunks) {
    const lineCount = h.line === '' ? 0 : h.line.split('\n').length;
    if (h.type === 'add') additions += lineCount;
    else if (h.type === 'remove') deletions += lineCount;
    else contexts += lineCount;
  }
  return { additions, deletions, contexts };
}
