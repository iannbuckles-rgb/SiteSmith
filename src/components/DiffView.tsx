import { useMemo, useState } from 'react';

import { computeDiffStats, lineDiff, type DiffHunk } from '../lib/lineDiff';

/* ----------------------------------------------------------------------------
 * DiffView
 * --------------------------------------------------------------------------
 * Renders a line-level diff between two file snapshots so the user can see
 * what a single AppliedPatch did to its host file. Lives inline under each
 * History row as a "Show diff" disclosure.
 *
 * SIZE BOUNDS
 *   For typical HTML / CSS files (≤ a few thousand lines) the diff renders
 *   instantly. For pathological files (e.g. a 200,000-line JSON manifest)
 *   we offer a `maxLines` cap: hunks beyond the cap collapse into a single
 *   "... N more lines changed" tail so the UI stays responsive. The
 *   default cap is conservative (400 lines) and applied ONCE to both sides.
 *
 * PROPS
 *   - before / after : the two file snapshots (previousSourceText vs
 *                       currentSourceText). Required.
 *   - defaultOpen    : whether the disclosure opens on first render.
 *   - maxLines       : render-side cap. Default 400.
 *   - fileLabel      : optional label for the disclosed header.
 * -------------------------------------------------------------------------*/

interface DiffViewProps {
  before: string;
  after: string;
  defaultOpen?: boolean;
  maxLines?: number;
  fileLabel?: string;
}

export function DiffView({ before, after, defaultOpen = false, maxLines = 400, fileLabel }: DiffViewProps) {
  const [open, setOpen] = useState(defaultOpen);

  // Diff is computed lazily so a closed diff stays cheap.
  const hunks = useMemo(() => open ? lineDiff(before, after) : [], [open, before, after]);
  const stats = useMemo(() => open ? computeDiffStats(hunks) : null, [hunks, open]);

  // Lightweight line-cap: when the diff is huge we collapse away rows
  // from the middle (still showing the headline adds/removes). A
  // simple "first N add hunks + last N remove hunks" works for the
  // common "single tag replacement" shape that the History panel
  // produces.
  const cap = maxLines;

  const visible = useMemo(() => {
    if (!stats) return [] as DiffHunk[];
    return hunks.length > cap ? truncateHunks(hunks, cap) : hunks;
  }, [hunks, cap, stats]);

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-violet-200"
        data-testid="diff-toggle"
      >
        <Chevron open={open} />
        <span>
          {open ? 'Hide diff' : 'Show diff'}
          {fileLabel ? <span className="ml-1 text-zinc-500">({fileLabel})</span> : null}
        </span>
        {stats && (stats.additions > 0 || stats.deletions > 0)
          ? (
            <span className="ml-1 text-[10px] text-zinc-500">
              +{stats.additions} / −{stats.deletions}
            </span>
          )
          : null}
      </button>
      {open && (
        <pre
          className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-snug text-zinc-200"
          data-testid="diff-render"
        >
          {visible.length === 0 ? (
            <span className="text-zinc-500">No textual changes — the patch mutated binary bytes or rewrote identical text.</span>
          ) : visible.map((h, i) => (
            <DiffLine key={i} hunk={h} />
          ))}
        </pre>
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function DiffLine({ hunk }: { hunk: DiffHunk }) {
  if (hunk.type === 'context') {
    // Single-line context is preferred when there's only one line; otherwise
    // multi-line is the common case for unchanged background.
    return (
      <span className="block text-zinc-500">{hunk.line}</span>
    );
  }
  if (hunk.type === 'add') {
    return (
      <span className="block bg-emerald-950/40 text-emerald-200">
        <span aria-hidden="true">+ </span>{hunk.line}
      </span>
    );
  }
  return (
    <span className="block bg-rose-950/40 text-rose-200">
      <span aria-hidden="true">− </span>{hunk.line}
    </span>
  );
}

/** When the diff is huge, keep the first half and last half of hunks so
 *  the user sees both the prologue changes and the epilogue changes. */
function truncateHunks(hunks: DiffHunk[], cap: number): DiffHunk[] {
  if (hunks.length <= cap) return hunks;
  const head = Math.floor(cap / 2);
  const tail = cap - head;
  return [
    ...hunks.slice(0, head),
    { type: 'context', line: `… ${hunks.length - cap} more lines collapsed …` },
    ...hunks.slice(hunks.length - tail),
  ];
}
