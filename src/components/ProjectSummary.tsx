import type { ProjectSummary } from '../types';
import { formatBytes } from '../lib/fileTypes';

interface ProjectSummaryProps {
  summary: ProjectSummary;
  fileName: string;
}

interface Stat {
  label: string;
  value: number | string;
  tone: 'neutral' | 'orange' | 'sky' | 'yellow' | 'pink';
}

const toneClasses: Record<Stat['tone'], string> = {
  neutral: 'text-zinc-100',
  orange:  'text-orange-300',
  sky:     'text-sky-300',
  yellow:  'text-yellow-300',
  pink:    'text-pink-300',
};

export function ProjectSummaryCard({ summary, fileName }: ProjectSummaryProps) {
  const stats: Stat[] = [
    { label: 'Files', value: summary.totalFiles, tone: 'neutral' },
    { label: 'HTML', value: summary.htmlFiles, tone: 'orange' },
    { label: 'CSS',  value: summary.cssFiles,  tone: 'sky' },
    { label: 'JS',   value: summary.jsFiles,   tone: 'yellow' },
    { label: 'Images', value: summary.imageFiles, tone: 'pink' },
  ];

  return (
    <div className="shrink-0 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2.5" data-testid="project-summary">
      <header className="mb-2 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Project
          </h3>
          <span className="shrink-0 text-[11px] text-zinc-500">
            {formatBytes(summary.totalSize)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs font-medium text-zinc-200" title={fileName}>
          {fileName}
        </p>
      </header>
      <dl className="grid grid-cols-5 gap-1">
        {stats.map((s) => (
          <div key={s.label} className="min-w-0 rounded-md bg-zinc-950/60 px-1.5 py-1 ring-1 ring-zinc-800">
            <dt className="truncate text-[9px] uppercase tracking-wide text-zinc-500">{s.label}</dt>
            <dd className={`mt-0.5 truncate text-sm font-semibold ${toneClasses[s.tone]}`}>{s.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
