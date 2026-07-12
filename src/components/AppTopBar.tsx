import type { PersistedTheme } from '../lib/idb';
import type { Phase } from '../lib/progress';
import type { LoadedProject } from '../types';
import { TopBarProgress } from './TopBarProgress';

interface AppTopBarProps {
  project: LoadedProject | null;
  progress: Phase;
  saveAtRisk: boolean;
  projectSaveBusy: boolean;
  projectMutationBusy: boolean;
  theme: PersistedTheme;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onToggleTheme: () => void;
  onCancelOnboarding: () => void;
}

export function AppTopBar({
  project,
  progress,
  saveAtRisk,
  projectSaveBusy,
  projectMutationBusy,
  theme,
  onSaveProject,
  onSaveProjectAs,
  onToggleTheme,
  onCancelOnboarding,
}: AppTopBarProps) {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const canSaveProject = project !== null && !projectSaveBusy && !projectMutationBusy;
  const saveTitle = projectMutationBusy ? 'Finish the current edit before saving' : 'Save project to Projects';

  return (
    <header className="flex min-w-0 items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 backdrop-blur sm:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <img src="/ms-logo.png" alt="" aria-hidden="true" className="h-7 w-7 shrink-0 rounded-md object-contain" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold leading-tight text-zinc-100">MockupSwap</h1>
          <p className="hidden truncate text-[11px] leading-tight text-zinc-500 sm:block">Website source editor</p>
        </div>
      </div>

      <div className="ml-auto flex max-w-[62vw] min-w-0 items-center justify-end gap-2 text-[11px] text-zinc-500">
        {project ? (
          <span className="min-w-0 max-w-full truncate rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300">{project.fileName}</span>
        ) : (
          <span className="hidden shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 sm:inline">No project</span>
        )}
        {project && saveAtRisk && (
          <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-950/60 px-2 py-0.5 font-medium text-amber-200">Save at risk</span>
        )}
        <TopBarProgress phase={progress} onCancel={progress.kind === 'detecting' ? onCancelOnboarding : undefined} />
        {project && (
          <>
            <button
              type="button"
              onClick={onSaveProject}
              disabled={!canSaveProject}
              aria-busy={projectSaveBusy}
              title={saveTitle}
              className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
              data-testid="save-project-button"
            >
              {projectSaveBusy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={onSaveProjectAs}
              disabled={!canSaveProject}
              title={projectMutationBusy ? 'Finish the current edit before saving' : 'Save as a new project'}
              className="hidden shrink-0 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[11px] font-medium text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 sm:inline-flex"
              data-testid="save-project-as-button"
            >
              Save as
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onToggleTheme}
          aria-pressed={theme === 'light'}
          title={`Switch to ${nextTheme} theme`}
          aria-label={`Switch to ${nextTheme} theme`}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          data-testid="theme-toggle"
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z" />
    </svg>
  );
}
