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
    { label: 'Total files', value: summary.totalFiles, tone: 'neutral' },
    { label: 'HTML', value: summary.htmlFiles, tone: 'orange' },
    { label: 'CSS',  value: summary.cssFiles,  tone: 'sky' },
    { label: 'JS',   value: summary.jsFiles,   tone: 'yellow' },
    { label: 'Images', value: summary.imageFiles, tone: 'pink' },
  ];

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3" data-testid="project-summary">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Project
        </h3>
        <span className="truncate text-[11px] text-zinc-500" title={fileName}>
          {fileName}
        </span>
      </header>
      <dl className="grid grid-cols-5 gap-1.5">
        {stats.map((s) => (
          <div key={s.label} className="rounded-md bg-zinc-950/60 px-2 py-2 ring-1 ring-zinc-800">
            <dt className="text-[10px] uppercase tracking-wide text-zinc-500">{s.label}</dt>
            <dd className={`mt-0.5 text-base font-semibold ${toneClasses[s.tone]}`}>{s.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 truncate text-[11px] text-zinc-500">
        Total uncompressed size: <span className="text-zinc-300">{formatBytes(summary.totalSize)}</span>
      </p>
    </div>
  );
}
