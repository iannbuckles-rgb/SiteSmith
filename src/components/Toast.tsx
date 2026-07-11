/* ----------------------------------------------------------------------------
 * Toast
 * ----------------------------------------------------------------------------
 * Lightweight status card rendered inside the global `<ToastViewport>`,
 * which itself is mounted in App.tsx at fixed bottom-right. Each Toast is
 * paired with an optional `expiresAt` so the parent timer can reap transient
 * cards without each card running its own setTimeout timer fleet.
 *
 * Visual model
 * ------------
 * - One 8px colored accent dot on the left (kind-coded):
 *     success  · emerald
 *     info     · zinc
 *     warning  · amber
 * - Title (medium weight). Optional detail underneath in 11px.
 * - 12px dismiss button on the right. Click → 200ms fade-out then drop.
 *
 * Accessibility
 * ------------
 * `role="status"` + `aria-live="polite"` so screen readers hear each
 * toast as it appears but never over-eagerly interrupt mid-read.
 * `motion-reduce:transition-none` opts the fade animation out for users
 * with `prefers-reduced-motion`.
 * -------------------------------------------------------------------------*/

import { useState } from 'react';

export type ToastKind = 'success' | 'info' | 'warning';

export interface ToastData {
  id: string;
  kind: ToastKind;
  title: string;
  detail?: string;
  /** ms since epoch. The global ToastViewer drops the toast when
   *  the wall clock exceeds this; null means the toast is persistent
   *  until the user dismisses it. */
  expiresAt: number | null;
}

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

const FADE_MS = 200;

/** Per-kind emphasis colors. Duplicated as a const object (not a
 *  function) so tailwind's JIT can statically pick up the class names
 *  it sees at module scope. */
const KIND_PANEL_CLASS: Record<ToastKind, string> = {
  success: 'border-emerald-700/50 bg-emerald-950/60 text-emerald-100',
  info: 'border-zinc-700 bg-zinc-900 text-zinc-100',
  warning: 'border-amber-700/50 bg-amber-950/60 text-amber-100',
};

const KIND_ACCENT_CLASS: Record<ToastKind, string> = {
  success: 'bg-emerald-400',
  info: 'bg-zinc-400',
  warning: 'bg-amber-400',
};

export function Toast({ toast, onDismiss }: ToastProps) {
  // Two-step dismiss: trigger fade, then ask the parent to remove
  // us. The Timer-firing parent would race the un-mount if we
  // removed ourselves synchronously, so we always go via onDismiss.
  const [exiting, setExiting] = useState(false);

  const dismiss = () => {
    if (exiting) return;
    if (prefersReducedMotion()) {
      onDismiss(toast.id);
      return;
    }
    setExiting(true);
    window.setTimeout(() => onDismiss(toast.id), FADE_MS);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={`toast-${toast.kind}`}
      className={[
        'flex w-80 max-w-[calc(100vw-2rem)] items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur',
        'transition-opacity duration-200 motion-reduce:transition-none',
        KIND_PANEL_CLASS[toast.kind],
        exiting ? 'opacity-0' : 'opacity-100',
      ].join(' ')}
    >
      <span
        aria-hidden="true"
        className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${KIND_ACCENT_CLASS[toast.kind]}`}
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-tight">
          {toast.title}
        </div>
        {toast.detail && (
          <div className="mt-0.5 text-[11px] leading-snug opacity-80">
            {toast.detail}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="-mr-1 -mt-1 ml-1 rounded p-1 text-current opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
        aria-label="Dismiss notification"
        data-testid={`toast-${toast.kind}-dismiss`}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M3 3 L9 9 M9 3 L3 9"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
