import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';

import { formatBytes, IMAGE_FILE_ACCEPT, isSupportedImageFile } from '../lib/fileTypes';
import {
  ALL_SCOPE,
  editableEntries,
  isEditableExtension,
  planManualReplace,
  type ManualReplacePlan,
} from '../lib/manualReplace';
import type { AppliedPatch, LoadedProject } from '../types';

interface ManualReplacePanelProps {
  project: LoadedProject | null;
  busy: boolean;
  error: string | null;
  /** Ordered newest-first; the parent owns the list so undo + re-render
   *  stay synchronised across the Manual panel and the global patchesByKey. */
  recent: AppliedPatch[];
  onApply: (input: {
    scope: string;
    searchText: string;
    replacementText: string;
    replaceAll: boolean;
    imageFile: File | null;
    customAssetFilename: string;
  }) => void;
  onUndo: (patchId: string) => void;
}

/**
 * Plain-text find-and-replace workflow. The user picks a file (or "All
 * editable files") from a dropdown, types a search snippet, optionally
 * uploads a replacement image, and applies. Each apply snapshots the
 * pre-patch source text of every touched file into the AppliedPatch so
 * a one-click Undo restores the zip exactly.
 */
export function ManualReplacePanel({
  project, busy, error, recent,
  onApply, onUndo,
}: ManualReplacePanelProps) {
  const defaults = useMemo(
    () => (project ? editableEntries(project.entries) : []),
    [project],
  );

  const [scope, setScope] = useState<string>(ALL_SCOPE);
  const [searchText, setSearchText] = useState('');
  const [replacementText, setReplacementText] = useState('');
  const [replaceAll, setReplaceAll] = useState(true);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [customAssetFilename, setCustomAssetFilename] = useState('');
  const [hover, setHover] = useState(false);
  const [plan, setPlan] = useState<ManualReplacePlan | null>(null);
  const [planning, setPlanning] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const planRequestIdRef = useRef(0);

  // Live-preview the image the user is about to drop in. Object URLs are
  // revoked when the file changes or the panel unmounts.
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!imageFile) { setImagePreviewUrl(null); return; }
    const url = URL.createObjectURL(imageFile);
    setImagePreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  // Reset when the project changes \u2014 the dropdown's file list invalidates.
  useEffect(() => {
    planRequestIdRef.current += 1;
    setScope(ALL_SCOPE);
    setSearchText('');
    setReplacementText('');
    setImageFile(null);
    setCustomAssetFilename('');
    setPlan(null);
    setPlanning(false);
  }, [project]);

  const refreshPlan = useCallback(async (
    nextScope: string,
    nextSearchText: string,
    nextReplaceAll: boolean,
  ) => {
    const requestId = ++planRequestIdRef.current;
    if (!project || !nextSearchText.trim()) {
      setPlan(null);
      setPlanning(false);
      return;
    }
    setPlanning(true);
    try {
      const nextPlan = await planManualReplace(project, nextScope, nextSearchText, nextReplaceAll);
      if (planRequestIdRef.current === requestId) setPlan(nextPlan);
    } catch {
      if (planRequestIdRef.current === requestId) setPlan(null);
    } finally {
      if (planRequestIdRef.current === requestId) setPlanning(false);
    }
  }, [project]);

  const handleSearch = useCallback((next: string) => {
    setSearchText(next);
    void refreshPlan(scope, next, replaceAll);
  }, [scope, replaceAll, refreshPlan]);

  const handleScopeChange = useCallback((next: string) => {
    setScope(next);
    void refreshPlan(next, searchText, replaceAll);
  }, [searchText, replaceAll, refreshPlan]);

  const handleReplaceAllToggle = useCallback((next: boolean) => {
    setReplaceAll(next);
    void refreshPlan(scope, searchText, next);
  }, [searchText, scope, refreshPlan]);

  const handleImage = useCallback((file: File | null | undefined) => {
    if (!file) return;
    if (!isSupportedImageFile(file)) return;
    setImageFile(file);
    if (!customAssetFilename.trim()) {
      const lastSlash = Math.max(file.name.lastIndexOf('/'), file.name.lastIndexOf('\\'));
      const baseName = lastSlash >= 0 ? file.name.slice(lastSlash + 1) : file.name;
      setCustomAssetFilename(baseName);
    }
  }, [customAssetFilename]);

  const handleClearImage = useCallback(() => {
    setImageFile(null);
    setCustomAssetFilename('');
  }, []);

  const handleApply = useCallback(() => {
    if (!project || !searchText.trim()) return;
    planRequestIdRef.current += 1;
    onApply({
      scope,
      searchText,
      replacementText,
      replaceAll,
      imageFile,
      customAssetFilename: customAssetFilename.trim(),
    });
    setSearchText('');
    setReplacementText('');
    setImageFile(null);
    setCustomAssetFilename('');
    setPlan(null);
    setPlanning(false);
  }, [
    project, scope, searchText, replacementText, replaceAll,
    imageFile, customAssetFilename, onApply,
  ]);

  if (!project) {
    return (
      <p className="px-3 py-4 text-center text-xs text-zinc-500">
        Upload a zip to use Manual Replace.
      </p>
    );
  }

  const canApply = !!project && !!searchText.trim() && !!plan && plan.canApply && !busy;

  return (
    <div className="flex h-full flex-col gap-3" data-testid="manual-replace-panel">
      <ScopeDropdown
        scope={scope}
        onScopeChange={handleScopeChange}
        editableFiles={defaults}
        project={project}
      />

      <TextField
        label="Find"
        value={searchText}
        onChange={handleSearch}
        placeholder="Paste a path or text snippet to match"
        multiLine
        testId="manual-search-text"
      />

      <ReplaceAllToggle
        replaceAll={replaceAll}
        onToggle={handleReplaceAllToggle}
      />

      <PlanPreview plan={plan} planning={planning} scope={scope} />

      <TextField
        label="Replace with"
        value={replacementText}
        onChange={setReplacementText}
        placeholder="What the snippet becomes. Pre-filled with the relative path to the new image if you uploaded one."
        multiLine
        rows={3}
        testId="manual-replace-text"
      />

      <ImagePicker
        inputRef={inputRef}
        hover={hover}
        setHover={setHover}
        imageFile={imageFile}
        imagePreviewUrl={imagePreviewUrl}
        customAssetFilename={customAssetFilename}
        onCustomAssetFilenameChange={setCustomAssetFilename}
        onPickFile={handleImage}
        onClearFile={handleClearImage}
      />

      {error && (
        <div
          role="alert"
          className="rounded-md border border-rose-700/60 bg-rose-900/30 px-3 py-2 text-xs text-rose-200"
          data-testid="manual-replace-error"
        >
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={handleApply}
        disabled={!canApply || busy}
        className="mt-auto w-full rounded-md bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="manual-replace-apply"
      >
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            Applying manual replace\u2026
          </span>
        ) : plan?.canApply ? (
          `Apply manual replace (${plan.totalMatches} match${plan.totalMatches === 1 ? '' : 'es'})`
        ) : (
          'Apply manual replace'
        )}
      </button>

      <RecentChangesList recent={recent} onUndo={onUndo} />
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Recent changes (undo list)
 * -------------------------------------------------------------------------*/

interface RecentChangesListProps {
  recent: AppliedPatch[];
  onUndo: (patchId: string) => void;
}

function RecentChangesList({ recent, onUndo }: RecentChangesListProps) {
  const manualOnly = useMemo(
    () => recent.filter((p): p is Extract<AppliedPatch, { action: 'manual-replace' }> =>
      p.action === 'manual-replace',
    ),
    [recent],
  );

  if (manualOnly.length === 0) return null;

  return (
    <section className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2" data-testid="manual-replace-recent">
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        Recent manual changes
      </h4>
      <ul className="space-y-1.5">
        {manualOnly.map((p) => (
          <RecentChangeRow key={p.id} patch={p} onUndo={onUndo} />
        ))}
      </ul>
    </section>
  );
}

interface RecentChangeRowProps {
  patch: Extract<AppliedPatch, { action: 'manual-replace' }>;
  onUndo: (patchId: string) => void;
}

function RecentChangeRow({ patch, onUndo }: RecentChangeRowProps) {
  const scopeLabel = patch.targetScope === ALL_SCOPE
    ? `${patch.filesTouched} file${patch.filesTouched === 1 ? '' : 's'}`
    : patch.targetScope.split('/').pop() ?? patch.targetScope;
  return (
    <li className="rounded-md border border-emerald-700/40 bg-emerald-950/20 p-2" data-testid={`manual-replace-row-${patch.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium text-emerald-200" title={patch.targetScope}>
            {scopeLabel} \u00b7 {patch.matchCount} match{patch.matchCount === 1 ? '' : 'es'}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500" title={patch.searchText}>
            \u201c{clip(patch.searchText, 60)}\u201d \u2192 \u201c{clip(patch.replacementText, 60)}\u201d
          </p>
          {patch.newAssetPath && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-violet-300" title={patch.newAssetPath}>
              {patch.newAssetPath}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onUndo(patch.id)}
          className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 transition-colors hover:border-rose-500/50 hover:text-rose-200"
          data-testid={`manual-replace-undo-${patch.id}`}
          title="Restore the previous source text and remove any uploaded asset."
        >
          Undo
        </button>
      </div>
    </li>
  );
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/* ----------------------------------------------------------------------------
 * Scope dropdown
 * -------------------------------------------------------------------------*/

interface ScopeDropdownProps {
  scope: string;
  onScopeChange: (next: string) => void;
  editableFiles: Array<{ path: string; name: string }>;
  project: LoadedProject;
}

function ScopeDropdown({ scope, onScopeChange, editableFiles, project }: ScopeDropdownProps) {
  const totalEditable = editableFiles.length;
  const totalInZip = useMemo(
    () => project.entries.filter((e) => !e.isDirectory && isEditableExtension(e.name)).length,
    [project],
  );
  const uneditableCount = totalInZip - totalEditable;

  return (
    <div className="space-y-1">
      <label
        htmlFor="manual-scope-dropdown"
        className="block text-[11px] font-semibold uppercase tracking-wide text-zinc-400"
      >
        File to edit
      </label>
      <select
        id="manual-scope-dropdown"
        value={scope}
        onChange={(e) => onScopeChange(e.target.value)}
        className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 focus:border-violet-400 focus:outline-none"
        data-testid="manual-scope-dropdown"
      >
        <option value={ALL_SCOPE}>
          All editable files ({totalEditable})
        </option>
        {editableFiles.map((e) => (
          <option key={e.path} value={e.path}>
            {e.path}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-zinc-500">
        Only text-editable files are listed. Binary assets (PNGs, fonts, etc.) aren&apos;t supported here
        {uneditableCount > 0 ? ` \u2014 ${uneditableCount} skipped.` : '.'}
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Plain text fields (Find / Replace with)
 * -------------------------------------------------------------------------*/

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  multiLine?: boolean;
  rows?: number;
  testId?: string;
}

function TextField({ label, value, onChange, placeholder, multiLine, rows, testId }: TextFieldProps) {
  return (
    <div className="space-y-1">
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        {label}
      </label>
      {multiLine ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={rows ?? 3}
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-100 placeholder-zinc-600 focus:border-violet-400 focus:outline-none"
          data-testid={testId}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-100 placeholder-zinc-600 focus:border-violet-400 focus:outline-none"
          data-testid={testId}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Replace-once vs Replace-all toggle
 * -------------------------------------------------------------------------*/

interface ReplaceAllToggleProps {
  replaceAll: boolean;
  onToggle: (next: boolean) => void;
}

function ReplaceAllToggle({ replaceAll, onToggle }: ReplaceAllToggleProps) {
  return (
    <div className="flex items-center gap-1" role="tablist" aria-label="Replace scope">
      <Chip
        active={!replaceAll}
        onClick={() => onToggle(false)}
        testId="manual-replace-once"
        label="Replace once"
      />
      <Chip
        active={replaceAll}
        onClick={() => onToggle(true)}
        testId="manual-replace-all"
        label="Replace all"
      />
    </div>
  );
}

interface ChipProps {
  active: boolean;
  onClick: () => void;
  label: string;
  testId?: string;
}

function Chip({ active, onClick, label, testId }: ChipProps) {
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
      {label}
    </button>
  );
}

/* ----------------------------------------------------------------------------
 * Plan / match preview
 * -------------------------------------------------------------------------*/

interface PlanPreviewProps {
  plan: ManualReplacePlan | null;
  planning: boolean;
  scope: string;
}

function PlanPreview({ plan, planning, scope }: PlanPreviewProps) {
  if (planning) {
    return (
      <p className="text-[11px] text-zinc-500">
        <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400 align-middle" />
        Scanning target files for matches\u2026
      </p>
    );
  }
  if (!plan) return null;
  if (!plan.canApply) {
    return (
      <p className="text-[11px] text-zinc-500" data-testid="manual-replace-no-match">
        No matches in the selected file
        {scope === ALL_SCOPE ? 's.' : '.'}
      </p>
    );
  }
  const showFileList = scope !== ALL_SCOPE
    && plan.files.length > 0
    && (plan.firstFile?.path === plan.files[0]?.path);
  return (
    <div className="space-y-1" data-testid="manual-replace-plan">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-300">
        {plan.totalMatches} match{plan.totalMatches === 1 ? '' : 'es'} found
      </p>
      {plan.firstFile?.contextSnippet && plan.firstFile.contextSnippet.match && (
        <pre
          className="whitespace-pre-wrap break-all rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-zinc-400"
          data-testid="manual-replace-context"
        >
          {plan.firstFile.contextSnippet.before}
          <mark className="rounded bg-violet-500/30 px-0.5 text-violet-100">
            {plan.firstFile.contextSnippet.match}
          </mark>
          {plan.firstFile.contextSnippet.after}
        </pre>
      )}
      {showFileList && (
        <ul className="space-y-0.5">
          {plan.files.map((f) => (
            <li key={f.path} className="font-mono text-[11px] text-zinc-400">
              {f.path} \u00b7 {f.matches} match{f.matches === 1 ? '' : 'es'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Image picker + asset filename
 * -------------------------------------------------------------------------*/

interface ImagePickerProps {
  inputRef: React.RefObject<HTMLInputElement>;
  hover: boolean;
  setHover: (v: boolean) => void;
  imageFile: File | null;
  imagePreviewUrl: string | null;
  customAssetFilename: string;
  onCustomAssetFilenameChange: (v: string) => void;
  onPickFile: (f: File | null | undefined) => void;
  onClearFile: () => void;
}

function ImagePicker({
  inputRef, hover, setHover, imageFile, imagePreviewUrl,
  customAssetFilename, onCustomAssetFilenameChange,
  onPickFile, onClearFile,
}: ImagePickerProps) {
  return (
    <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-2">
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        Replacement image (optional)
      </label>
      {imageFile ? (
        <>
          <div className="flex h-20 w-full overflow-hidden rounded-md bg-zinc-100 ring-1 ring-zinc-800">
            {imagePreviewUrl ? (
              <img src={imagePreviewUrl} alt="Replacement preview" className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[11px] text-zinc-500">Preview unavailable</div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate font-mono text-zinc-300" title={imageFile.name}>{imageFile.name}</span>
            <button
              type="button"
              onClick={onClearFile}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-200 hover:border-rose-500/50 hover:text-rose-200"
              data-testid="manual-image-clear"
            >
              Change
            </button>
          </div>
          <p className="text-[11px] text-zinc-500">{formatBytes(imageFile.size)} \u00b7 {imageFile.type || 'image'}</p>
        </>
      ) : (
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
          className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed px-3 py-4 text-center transition-colors ${
            hover ? 'border-violet-400 bg-violet-500/10' : 'border-zinc-700 bg-zinc-950 hover:border-zinc-500 hover:bg-zinc-900'
          }`}
          data-testid="manual-image-dropzone"
        >
          <p className="text-xs font-medium text-zinc-200">Drop replacement image</p>
          <p className="text-[11px] text-zinc-500">or click to choose \u2014 PNG, JPG, WebP, SVG\u2026</p>
          <input
            ref={inputRef}
            type="file"
            accept={IMAGE_FILE_ACCEPT}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              onPickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
            className="sr-only"
            data-testid="manual-image-input"
          />
        </div>
      )}
      <div className="space-y-1">
        <label
          htmlFor="manual-asset-filename"
          className="block text-[11px] font-semibold uppercase tracking-wide text-zinc-400"
        >
          New asset filename
        </label>
        <input
          id="manual-asset-filename"
          type="text"
          value={customAssetFilename}
          onChange={(e) => onCustomAssetFilenameChange(e.target.value)}
          placeholder="hero.png"
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-100 placeholder-zinc-600 focus:border-violet-400 focus:outline-none"
          data-testid="manual-asset-filename"
        />
        <p className="text-[11px] text-zinc-500">
          Saved under <span className="font-mono">assets/mockups/&lt;name&gt;</span>. Filename is sanitised; collisions get a <span className="font-mono">-N</span> suffix.
        </p>
      </div>
    </div>
  );
}
