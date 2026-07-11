/* ----------------------------------------------------------------------------
 * TopBarProgress
 * ----------------------------------------------------------------------------
 * Small status pill rendered inside the TopBar, to the right of the
 * filename pill. Renders nothing in `idle`. Otherwise shows a 14px SVG
 * progress ring + a mono label that updates twice per second.
 *
 * The ring uses two modes:
 *   - indeterminate: the whole SVG rotates via `animate-spin` and the
 *     visible arc is a fixed 30% slice of the circumference, producing
 *     the classic Pacman / Material spinner look.
 *   - determinate:  the SVG is static and `stroke-dashoffset` is
 *     proportional to the phase's done/total. Updates are eased with
 *     a 200ms transform transition.
 *
 * Accessibility
 * -------------
 * `role="status"`, `aria-live="polite"`, `aria-atomic="true"` so screen
 * readers hear the full phase label on change. The SVG itself is
 * `aria-hidden` because the text below it carries the same meaning.
 * -------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';

import {
  describePhase,
  isPhaseActive,
  progressFraction,
  type Phase,
} from '../lib/progress';

interface TopBarProgressProps {
  phase: Phase;
  onCancel?: () => void;
}

/** Tick interval for elapsed-time text refresh. Two Hz is plenty and
 *  keeps the re-render cost trivial even on long operations. */
const TICK_MS = 500;

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_INDET_VISIBLE_FRACTION = 0.32;

export function TopBarProgress({ phase, onCancel }: TopBarProgressProps) {
  // Drive the elapsed-time label with a low-frequency tick so it does
  // not re-render every animation frame. Two half-second ticks is fine.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isPhaseActive(phase)) return;
    const handle = window.setInterval(() => forceTick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(handle);
    // `phase.kind` is intentionally the only dependency: when the phase
    // transitions we always tear down + rebuild, and once stable the
    // setInterval keeps the label fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  if (!isPhaseActive(phase)) return null;

  const label = describePhase(phase);
  // Narrow via control flow so TS proves the field accesses; no `as`
  // casts and the discriminator carries us through.
  let fraction: number | null = null;
  if (phase.kind === 'bulk-replacing') {
    fraction = progressFraction(phase.done, phase.total);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex items-center gap-2 rounded-full border border-violet-700/50 bg-violet-950/40 px-2.5 py-0.5 text-[11px] text-violet-100"
      data-testid="top-bar-progress"
    >
      <ProgressRing
        indeterminate={fraction === null}
        fraction={fraction ?? 0}
      />
      <span
        className="font-mono tracking-tight tabular-nums"
        data-testid="top-bar-progress-label"
      >
        {label}
      </span>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="ml-1 rounded-full border border-violet-500/50 bg-violet-900/70 px-1.5 py-0 text-[10px] font-medium text-violet-50 transition-colors hover:border-violet-300 hover:bg-violet-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          data-testid="top-bar-progress-cancel"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

/** 14px SVG ring. Two visual modes — see file header. */
function ProgressRing({
  indeterminate,
  fraction,
}: {
  indeterminate: boolean;
  fraction: number;
}) {
  const clamped = Math.min(1, Math.max(0, fraction));
  const dashArray = indeterminate
    ? `${RING_CIRCUMFERENCE * RING_INDET_VISIBLE_FRACTION} ${RING_CIRCUMFERENCE}`
    : `${RING_CIRCUMFERENCE}`;
  const dashOffset = indeterminate
    ? 0
    : RING_CIRCUMFERENCE * (1 - clamped);

  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      // `motion-safe:` opts out of the spin animation for users with
      // `prefers-reduced-motion`. The 1s period matches Material /
      // web-standard spinner timing; 0.9s reads as slightly restless.
      className={indeterminate ? 'motion-safe:animate-[spin_1s_linear_infinite]' : undefined}
      aria-hidden="true"
      data-testid={
        indeterminate
          ? 'top-bar-progress-ring-indet'
          : 'top-bar-progress-ring-det'
      }
    >
      {/* Track */}
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-violet-900/60"
      />
      {/* Visible arc */}
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-violet-300"
        strokeLinecap="round"
        strokeDasharray={dashArray}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 7 7)"
        style={
          !indeterminate
            ? { transition: 'stroke-dashoffset 200ms ease-out' }
            : undefined
        }
      />
    </svg>
  );
}
