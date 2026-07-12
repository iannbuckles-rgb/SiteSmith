import type { ReactNode } from 'react';

export type WorkspacePane = 'left' | 'preview' | 'right';

interface WorkspaceShellProps {
  activePane: WorkspacePane;
  inspectorOpen: boolean;
  onChangePane: (pane: WorkspacePane) => void;
  onOpenInspector: () => void;
  onCloseInspector: () => void;
  projectPane: ReactNode;
  previewPane: ReactNode;
  inspectorPane: ReactNode;
}

const WORKSPACE_PANES: Array<{ id: WorkspacePane; label: string }> = [
  { id: 'left', label: 'Project' },
  { id: 'preview', label: 'Canvas' },
  { id: 'right', label: 'Inspector' },
];

/**
 * Owns responsive workspace composition only. Feature state stays in App,
 * while pane sizing, mobile navigation, and the tablet inspector drawer stay
 * centralized here instead of being repeated around feature components.
 */
export function WorkspaceShell({
  activePane,
  inspectorOpen,
  onChangePane,
  onOpenInspector,
  onCloseInspector,
  projectPane,
  previewPane,
  inspectorPane,
}: WorkspaceShellProps) {
  return (
    <>
      <MobileWorkspaceTabs activePane={activePane} onChange={onChangePane} />

      <div className="hidden min-w-0 items-center justify-end border-b border-zinc-800 bg-zinc-950 px-3 py-2 md:flex xl:hidden">
        <button
          type="button"
          onClick={onOpenInspector}
          aria-expanded={inspectorOpen}
          aria-controls="workspace-inspector"
          className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          data-testid="right-drawer-toggle"
        >
          <InspectorIcon />
          Inspector
        </button>
      </div>

      {inspectorOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 hidden bg-zinc-950/70 md:block xl:hidden"
          onClick={onCloseInspector}
          aria-label="Close inspector"
          data-testid="right-drawer-backdrop"
        />
      )}

      <main
        className="grid min-h-0 min-w-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(280px,320px)_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)_360px] 2xl:grid-cols-[360px_minmax(0,1fr)_380px]"
        data-testid="responsive-shell"
      >
        <section
          className={`${activePane === 'left' ? 'block' : 'hidden'} h-full min-h-0 min-w-0 md:block`}
          aria-label="Project browser"
          data-testid="left-pane-shell"
        >
          {projectPane}
        </section>

        <section
          className={`${activePane === 'preview' ? 'block' : 'hidden'} h-full min-h-0 min-w-0 border-x border-zinc-900 md:block`}
          aria-label="Preview canvas"
          data-testid="preview-pane-shell"
        >
          {previewPane}
        </section>

        <aside
          id="workspace-inspector"
          className={`${activePane === 'right' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col bg-zinc-950 md:fixed md:inset-y-0 md:right-0 md:z-50 md:w-[min(380px,calc(100vw-2rem))] md:max-w-full md:shadow-2xl ${inspectorOpen ? 'md:flex' : 'md:hidden'} xl:static xl:z-auto xl:flex xl:w-auto xl:max-w-none xl:shadow-none`}
          aria-label="Inspector"
          data-testid="right-pane-shell"
        >
          <div className="hidden shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-2 md:flex xl:hidden">
            <h2 className="text-sm font-semibold text-zinc-100">Inspector</h2>
            <button
              type="button"
              onClick={onCloseInspector}
              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
              aria-label="Close inspector"
              title="Close inspector"
              data-testid="right-drawer-close"
            >
              <CloseIcon />
            </button>
          </div>
          <div className="min-h-0 flex-1">{inspectorPane}</div>
        </aside>
      </main>
    </>
  );
}

function MobileWorkspaceTabs({
  activePane,
  onChange,
}: {
  activePane: WorkspacePane;
  onChange: (pane: WorkspacePane) => void;
}) {
  return (
    <nav className="border-b border-zinc-800 bg-zinc-950 px-2 py-2 md:hidden" aria-label="Workspace panes" data-testid="mobile-pane-tabs">
      <div className="grid min-w-0 grid-cols-3 gap-1 rounded-lg border border-zinc-800 bg-zinc-900/70 p-1" role="tablist">
        {WORKSPACE_PANES.map((pane) => {
          const active = pane.id === activePane;
          return (
            <button
              key={pane.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(pane.id)}
              className={`min-w-0 rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
                active ? 'bg-violet-600 text-white shadow-sm' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
              }`}
              data-testid={`mobile-pane-${pane.id}`}
            >
              <span className="block truncate">{pane.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function InspectorIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M4 5h16M4 12h10M4 19h16" />
      <circle cx="17" cy="12" r="2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
