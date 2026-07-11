import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

interface DialogShellProps {
  titleId: string;
  testId: string;
  onClose: () => void;
  children: ReactNode;
}

export function DialogShell({
  titleId,
  testId,
  onClose,
  children,
}: DialogShellProps) {
  const { dialogRef, onKeyDown } = useDialogFocusTrap(onClose);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/70 p-4"
      data-testid={testId}
    >
      <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
        {children}
      </div>
    </div>
  );
}

function useDialogFocusTrap(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    if (dialog) {
      const focusable = getFocusableElements(dialog);
      const target = focusable[0] ?? dialog;
      target.focus({ preventScroll: true });
    }

    return () => {
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      event.stopPropagation();
      dialog.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey) {
      if (active === first || !(active instanceof Node) || !dialog.contains(active)) {
        event.preventDefault();
        event.stopPropagation();
        last.focus({ preventScroll: true });
      }
      return;
    }

    if (active === last || !(active instanceof Node) || !dialog.contains(active)) {
      event.preventDefault();
      event.stopPropagation();
      first.focus({ preventScroll: true });
    }
  }, [onClose]);

  return { dialogRef, onKeyDown };
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
}
