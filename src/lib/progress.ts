/* ----------------------------------------------------------------------------
 * progress.ts
 * ----------------------------------------------------------------------------
 * Phase discriminated union for every long-running operation the TopBar
 * surfaces. Five variants:
 *
 *   - idle               — no operation in flight. Filename pill only.
 *   - detecting          — image / logo scan running. Indeterminate.
 *   - bulk-replacing     — N detections to apply, M done so far. Determinate.
 *   - exporting          — zip compression running. Indeterminate w/ bytes.
 *   - re-encoding        — handled as a TOAST (single sub-second event);
 *                          intentionally NOT in this union because the
 *                          toast and the top-bar are separate affordances.
 *
 * Stability guarantees
 * --------------------
 * Every async path in App.tsx that sets a non-idle phase MUST also set
 * `idle` in a `finally` block (so a thrown error or a project remount
 * cannot strand the widget on a stale message). The useEffect cleanup
 * in App.tsx additionally resets to idle on unmount.
 *
 * Scalability
 * -----------
 * New operation kinds should be added here at the bottom of the union so
 * the exhaustive `describePhase` switch warns at compile-time. Keep the
 * `kind` strings literal so downstream tests can pattern-match without
 * churn.
 * -------------------------------------------------------------------------*/

export type Phase =
  | { kind: 'idle' }
  | { kind: 'detecting'; startedAt: number }
  | {
      kind: 'bulk-replacing';
      done: number;
      total: number;
      fileName: string;
    }
  | {
      kind: 'exporting';
      /** Percent 0..100 reported by JSZip's `onUpdate` callback. The
       *  zip final size isn't known until `generateAsync` resolves, so
       *  we surface a percentage rather than fabricating a byte count. */
      progress: number;
      startedAt: number;
    };

export type NonIdlePhase = Exclude<Phase, { kind: 'idle' }>;

export const IDLE_PHASE: Phase = { kind: 'idle' };

export function isPhaseActive(p: Phase): p is NonIdlePhase {
  return p.kind !== 'idle';
}

/** Clamp a (done, total) progress pair to a sane interval. */
export function clampProgress(
  done: number,
  total: number,
): { done: number; total: number } {
  const t = Math.max(0, Math.floor(total));
  const d = Math.max(
    0,
    Math.min(
      Math.floor(done),
      t === 0 ? Number.MAX_SAFE_INTEGER : t,
    ),
  );
  return { done: d, total: t };
}

export function progressFraction(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, done / total));
}

/** Human-readable duration. "just started", "12s", "1m 23s". */
export function formatPhaseDuration(
  startedAt: number,
  nowMs: number = Date.now(),
): string {
  const ms = Math.max(0, nowMs - startedAt);
  if (ms < 1500) return 'just started';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (rem === 0) return `${m}m`;
  return `${m}m ${rem}s`;
}

/** Stable label string per phase. Updated from inside TopBarProgress. */
export function describePhase(p: Phase, nowMs: number = Date.now()): string {
  switch (p.kind) {
    case 'idle':
      return '';
    case 'detecting':
      return `analyzing project · ${formatPhaseDuration(p.startedAt, nowMs)}`;
    case 'bulk-replacing': {
      const { done, total } = clampProgress(p.done, p.total);
      return `replacing ${done}/${total} → ${p.fileName}`;
    }
    case 'exporting': {
      const pct = Math.max(0, Math.min(100, Math.round(p.progress)));
      return `writing zip · ${pct}% · ${formatPhaseDuration(p.startedAt, nowMs)}`;
    }
  }
}
