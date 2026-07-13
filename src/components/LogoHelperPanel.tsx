import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import { formatBytes, IMAGE_FILE_ACCEPT, isSupportedImageFile } from '../lib/fileTypes';
import { pickByRole } from '../lib/logoHelper';
import type {
  LogoCandidate,
  LogoHelperConfig,
  LogoHelperHeaderMode,
  LogoRole,
} from '../types';

const ROLES: Array<{ role: LogoRole; label: string; description: string }> = [
  { role: 'headerLogo',    label: 'Header logo',    description: 'The brand mark in your site header / nav.' },
  { role: 'footerLogo',    label: 'Footer logo',    description: 'A secondary logo in the page footer.' },
  { role: 'favicon',       label: 'Favicon',        description: 'The browser tab icon (`<link rel="icon">`).' },
  { role: 'appleTouchIcon', label: 'Apple touch icon', description: 'iOS home-screen icon (`apple-touch-icon`).' },
  { role: 'manifestIcon',  label: 'Manifest icons', description: 'PWA / manifest.json `icons[]` entries.' },
];

interface LogoHelperPanelProps {
  candidates: LogoCandidate[];
  scanning: boolean;
  busy: boolean;
  error: string | null;
  successSummary: LogoHelperSuccessSummary | null;
  onPickFile: (file: File) => void;
  onClearFile: () => void;
  onApply: (config: LogoHelperConfig, file: File) => void;
  onResetSuccess: () => void;
}

export interface LogoHelperSuccessSummary {
  appliedAt: number;
  targets: LogoRole[];
  headerMode: LogoHelperHeaderMode;
  businessName: string;
  patchCount: number;
  filesTouched: string[];
  textInjected: boolean;
}

const DEFAULT_TARGETS = new Set<LogoRole>(['headerLogo']);

const EMPTY_CONFIG: LogoHelperConfig = {
  targets: DEFAULT_TARGETS,
  headerMode: 'image-only',
  businessName: '',
};

export function LogoHelperPanel({
  candidates, scanning, busy, error, successSummary,
  onPickFile, onClearFile, onApply, onResetSuccess,
}: LogoHelperPanelProps) {
  const byRole = useMemo(() => pickByRole(candidates), [candidates]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [config, setConfig] = useState<LogoHelperConfig>(EMPTY_CONFIG);

  // Manage the object URL lifecycle for the live preview of the uploaded
  // logo. The same URL is revoked when the user clears the pending file
  // OR switches the pendingFile to something else OR the panel unmounts.
  useEffect(() => {
    if (!pendingFile) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(pendingFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  // Reset the success card after a delay? No — keep it pinned until the
  // user uploads a new file, the project reloads, or they explicitly click
  // "Start over". UI affordance surfaces it via a small Start-over button.

  const handleFile = useCallback((file: File | null | undefined) => {
    if (!file) return;
    if (!isSupportedImageFile(file)) return;
    setPendingFile(file);
    onPickFile(file);
  }, [onPickFile]);

  const handleClear = useCallback(() => {
    setPendingFile(null);
    onClearFile();
  }, [onClearFile]);

  const handleTargetToggle = useCallback((role: LogoRole) => {
    setConfig((prev) => {
      const next = new Set(prev.targets);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return { ...prev, targets: next };
    });
  }, []);

  const handleModeChange = useCallback((mode: LogoHelperHeaderMode) => {
    setConfig((prev) => ({ ...prev, headerMode: mode }));
  }, []);

  const handleBusinessName = useCallback((name: string) => {
    setConfig((prev) => ({ ...prev, businessName: name }));
  }, []);

  const handleApply = useCallback(() => {
    if (!pendingFile) return;
    onApply(config, pendingFile);
  }, [pendingFile, onApply, config]);

  const handleStartOver = useCallback(() => {
    setPendingFile(null);
    setConfig(EMPTY_CONFIG);
    onResetSuccess();
  }, [onResetSuccess]);

  if (scanning) {
    return (
      <p className="px-3 py-4 text-center text-xs text-zinc-500" aria-live="polite">
        <span className="mb-1 inline-block h-3 w-3 animate-pulse rounded-full bg-violet-400 align-middle mr-2" />
        Scanning project for logo references…
      </p>
    );
  }

  // Empty state when the scan completed but no logo candidates were found
  // anywhere in the project. The Logo Helper can't help this project, so
  // we show a polite empty message instead of a useless upload zone.
  if (candidates.length === 0) {
    return (
      <div className="m-auto max-w-xs px-4 py-6 text-center" data-testid="logo-helper-empty">
        <p className="text-sm font-medium text-zinc-200">No logos detected</p>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
          We didn&apos;t find any header, footer, favicon, apple-touch or manifest
          icon references in this zip. If you expected some, check the HTML for
          classes like <code>navbar-brand</code> or filenames like <code>logo.png</code>.
        </p>
        <p className="mt-2 text-[11px] text-zinc-500">
          You can still replace individual images from the <strong>Images</strong> tab.
        </p>
      </div>
    );
  }

  if (successSummary) {
    return (
      <SuccessCard summary={successSummary} onStartOver={handleStartOver} />
    );
  }

  return (
    <div className="flex h-full flex-col gap-3" data-testid="logo-helper-panel">
      <UploadArea
        inputRef={inputRef}
        hover={hover}
        setHover={setHover}
        pendingFile={pendingFile}
        previewUrl={previewUrl}
        onPickFile={handleFile}
        onClearFile={handleClear}
      />

      {pendingFile && (
        <>
          <RoleSelector
            byRole={byRole}
            selected={config.targets}
            onToggle={handleTargetToggle}
          />

          {config.targets.has('headerLogo') && byRole.headerLogo && (
            <HeaderModeControl
              mode={config.headerMode}
              businessName={config.businessName}
              onChangeMode={handleModeChange}
              onChangeBusinessName={handleBusinessName}
            />
          )}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-rose-700/60 bg-rose-900/30 px-3 py-2 text-xs text-rose-200"
              data-testid="logo-helper-error"
            >
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleApply}
            disabled={busy || config.targets.size === 0}
            className="mt-auto w-full rounded-md bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="logo-helper-apply"
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                Applying logo…
              </span>
            ) : (
              `Apply logo to ${config.targets.size} target${config.targets.size === 1 ? '' : 's'}`
            )}
          </button>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Upload area
 * -------------------------------------------------------------------------*/

interface UploadAreaProps {
  inputRef: React.RefObject<HTMLInputElement>;
  hover: boolean;
  setHover: (v: boolean) => void;
  pendingFile: File | null;
  previewUrl: string | null;
  /** Accept null/undefined so the drop + change handlers don't have to
   *  inline a guard — the consumer (handleFile) already filters. */
  onPickFile: (f: File | null | undefined) => void;
  onClearFile: () => void;
}

function UploadArea({
  inputRef, hover, setHover, pendingFile, previewUrl,
  onPickFile, onClearFile,
}: UploadAreaProps) {
  if (pendingFile) {
    return (
      <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-2" data-testid="logo-helper-pending">
        <div className="flex h-24 w-full overflow-hidden rounded-md bg-zinc-100 ring-1 ring-zinc-800">
          {previewUrl ? (
            <img src={previewUrl} alt="Logo preview" className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[11px] text-zinc-500">
              Preview unavailable
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-mono text-[11px] text-zinc-300" title={pendingFile.name}>{pendingFile.name}</p>
          <button
            type="button"
            onClick={onClearFile}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 transition-colors hover:border-rose-500/50 hover:text-rose-200"
            data-testid="logo-helper-clear"
          >
            Change
          </button>
        </div>
        <p className="text-[11px] text-zinc-500">
          {formatBytes(pendingFile.size)} · {pendingFile.type || 'image'}
        </p>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setHover(false);
        onPickFile(e.dataTransfer.files?.[0]);
      }}
      className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed px-3 py-5 text-center transition-colors ${
        hover ? 'border-violet-400 bg-violet-500/10' : 'border-zinc-700 bg-zinc-950 hover:border-zinc-500 hover:bg-zinc-900'
      }`}
      data-testid="logo-helper-dropzone"
    >
      <p className="text-xs font-medium text-zinc-200">Drop your logo here</p>
      <p className="text-[11px] text-zinc-500">
        or click to choose — PNG with transparency works best
      </p>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_FILE_ACCEPT}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          onPickFile(e.target.files?.[0]);
          e.target.value = '';
        }}
        className="sr-only"
        data-testid="logo-helper-file-input"
      />
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Role chips
 * -------------------------------------------------------------------------*/

interface RoleSelectorProps {
  byRole: Partial<Record<LogoRole, LogoCandidate>>;
  selected: Set<LogoRole>;
  onToggle: (role: LogoRole) => void;
}

function RoleSelector({ byRole, selected, onToggle }: RoleSelectorProps) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        Apply to
      </h4>
      <ul className="space-y-1" role="group" aria-label="Logo targets">
        {ROLES.map(({ role, label, description }) => {
          const found = !!byRole[role];
          const isSelected = selected.has(role);
          return (
            <li key={role}>
              <label
                className={`flex items-start gap-2 rounded-md border px-2 py-1.5 transition-colors ${
                  isSelected
                    ? 'border-violet-500/60 bg-violet-500/15'
                    : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700'
                } ${!found ? 'opacity-60' : 'cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={!found}
                  onChange={() => onToggle(role)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-zinc-600 bg-zinc-800 text-violet-500 focus:ring-violet-400 disabled:cursor-not-allowed"
                  data-testid={`logo-target-${role}`}
                />
                <span className="ml-1">
                  <span className="block text-xs font-medium text-zinc-100">
                    {label}
                    {!found && <span className="ml-1 text-[10px] font-normal text-zinc-500">not found</span>}
                  </span>
                  <span className="block text-[11px] text-zinc-500">{description}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Header mode (image-only vs icon-text)
 * -------------------------------------------------------------------------*/

interface HeaderModeControlProps {
  mode: LogoHelperHeaderMode;
  businessName: string;
  onChangeMode: (mode: LogoHelperHeaderMode) => void;
  onChangeBusinessName: (name: string) => void;
}

function HeaderModeControl({
  mode, businessName, onChangeMode, onChangeBusinessName,
}: HeaderModeControlProps) {
  return (
    <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        Header mode
      </h4>
      <div className="flex items-center gap-1" role="tablist" aria-label="Header logo mode">
        <ModeChip
          active={mode === 'image-only'}
          onClick={() => onChangeMode('image-only')}
          testId="logo-mode-image"
        >
          Image only
        </ModeChip>
        <ModeChip
          active={mode === 'icon-text'}
          onClick={() => onChangeMode('icon-text')}
          testId="logo-mode-icontext"
        >
          Icon + live text
        </ModeChip>
      </div>
      <p className="text-[11px] text-zinc-500">
        {mode === 'image-only'
          ? 'Replaces the logo image. Existing text beside the logo is preserved.'
          : 'Replaces the logo image AND keeps your business name as live HTML text beside it. The name is NOT baked into the image.'}
      </p>

      {mode === 'icon-text' && (
        <div className="space-y-1">
          <label className="block text-[11px] font-medium text-zinc-300" htmlFor="logo-helper-business-name">
            Business name
          </label>
          <input
            id="logo-helper-business-name"
            type="text"
            value={businessName}
            onChange={(e) => onChangeBusinessName(e.target.value)}
            placeholder="e.g. All About Mowers"
            maxLength={64}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:border-violet-400 focus:outline-none"
            data-testid="logo-helper-business-name"
          />
          <p className="text-[11px] text-zinc-500">
            If your header already has text beside the logo, we'll preserve it.
            Otherwise we add this as a real &lt;span&gt; next to the icon.
          </p>
        </div>
      )}
    </div>
  );
}

interface ModeChipProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}

function ModeChip({ active, onClick, children, testId }: ModeChipProps) {
  const cls = active
    ? 'border-violet-500/60 bg-violet-500/15 text-violet-100'
    : 'border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${cls}`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------------------
 * Success card
 * -------------------------------------------------------------------------*/

interface SuccessCardProps {
  summary: LogoHelperSuccessSummary;
  onStartOver: () => void;
}

function SuccessCard({ summary, onStartOver }: SuccessCardProps) {
  return (
    <div className="flex h-full flex-col gap-3" data-testid="logo-helper-success">
      <div className="rounded-md border border-emerald-700/40 bg-emerald-950/30 p-3">
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" className="h-4 w-4 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <p className="text-xs font-medium text-emerald-200">Logo Helper complete</p>
        </div>
        <dl className="mt-2 space-y-1 text-[11px]">
          <Row label="Patches" value={String(summary.patchCount)} />
          {summary.targets.length > 0 && (
            <Row label="Targets" value={summary.targets.join(', ')} />
          )}
          {summary.targets.includes('headerLogo') && (
            <Row label="Header mode" value={summary.headerMode === 'icon-text' ? 'icon + live text' : 'image only'} />
          )}
          {summary.textInjected && (
            <Row
              label="Text"
              value={summary.businessName ? summary.businessName : '(preserved existing)'}
            />
          )}
          {summary.filesTouched.length > 0 && (
            <Row label="Files" value={`${summary.filesTouched.length} updated`} mono truncate />
          )}
          <Row label="Applied" value={new Date(summary.appliedAt).toLocaleTimeString()} />
        </dl>
      </div>
      <button
        type="button"
        onClick={onStartOver}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-violet-400 hover:bg-violet-500/10 hover:text-violet-100"
        data-testid="logo-helper-startover"
      >
        Apply a different logo
      </button>
      <p className="text-[11px] text-zinc-500">
        The changes are now visible in the preview. When you're ready, export
        the updated zip from the right panel.
      </p>
    </div>
  );
}

function Row({
  label, value, mono = false, truncate = false,
}: { label: string; value: string; mono?: boolean; truncate?: boolean }) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-baseline gap-x-2">
      <dt className="uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd
        className={`text-zinc-200 ${mono ? 'font-mono text-[11px]' : ''} ${truncate ? 'truncate' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
