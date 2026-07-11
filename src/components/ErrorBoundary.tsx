import { Component, type ErrorInfo, type ReactNode } from 'react';

import { clearSession } from '../lib/idb';

interface ErrorBoundaryProps {
  children: ReactNode;
  title?: string;
  description?: string;
  className?: string;
  reloadPage?: () => void;
}

interface ErrorBoundaryState {
  error: unknown;
  clearing: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    clearing: false,
  };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    // Render errors leave the app in an unknown state. Log the component
    // stack for local debugging while the UI gives the user recovery paths.
    // eslint-disable-next-line no-console
    console.error('[mockswap] render boundary caught an error', error, errorInfo.componentStack);
  }

  private reloadPage = (): void => {
    if (this.props.reloadPage) {
      this.props.reloadPage();
      return;
    }
    window.location.reload();
  };

  private startFresh = async (): Promise<void> => {
    this.setState({ clearing: true });
    try {
      await clearSession();
    } finally {
      this.reloadPage();
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    const title = this.props.title ?? 'MockupSwap hit a problem';
    const description = this.props.description
      ?? 'The editor stopped rendering, but your browser tab is still alive. Reload to try again, or start fresh if a saved session keeps failing on boot.';
    const errorText = formatError(this.state.error);

    return (
      <div className={this.props.className ?? 'flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-100'}>
        <section
          role="alert"
          aria-labelledby="error-boundary-title"
          className="mx-auto w-full max-w-2xl rounded-lg border border-rose-500/30 bg-zinc-900/95 p-5 shadow-2xl shadow-rose-950/20"
        >
          <div className="flex items-start gap-3">
            <div
              aria-hidden="true"
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-rose-500/40 bg-rose-500/15 text-sm font-semibold text-rose-200"
            >
              !
            </div>
            <div className="min-w-0 flex-1">
              <h1 id="error-boundary-title" className="text-base font-semibold text-zinc-100">
                {title}
              </h1>
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                {description}
              </p>
            </div>
          </div>

          <details className="mt-4 rounded-md border border-zinc-800 bg-zinc-950/70">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:text-zinc-100">
              Error details
            </summary>
            <pre className="max-h-56 overflow-auto border-t border-zinc-800 p-3 text-xs leading-5 text-rose-100 whitespace-pre-wrap">
              {errorText}
            </pre>
          </details>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={this.reloadPage}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={() => void this.startFresh()}
              disabled={this.state.clearing}
              className="rounded-md bg-rose-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-rose-500 disabled:cursor-wait disabled:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
            >
              {this.state.clearing ? 'Clearing...' : 'Start fresh'}
            </button>
          </div>
        </section>
      </div>
    );
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message || error.name;
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}
