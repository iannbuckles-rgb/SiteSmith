import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import { isBroken } from '../lib/assetReplacer';
import type { ImageDetection, ImageStatus, ImageType } from '../types';
import { formatBytes } from '../lib/fileTypes';

/** Filter applied to the detected images list. The default 'all' shows
 *  every reference; 'broken' is the focused panel for the user's task. */
type Filter = 'all' | 'ok' | 'broken';

interface FolderBucket {
  dir: string;
  count: number;
}

interface DetectedImagesListProps {
  /** Already-filtered list: detections minus those that have a patch. */
  detections: ImageDetection[];
  thumbnails: Map<string, string>;
  scanning: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Folder buckets computed by App.tsx (drives bulk-replace scoping). */
  folderBuckets: FolderBucket[];
  bulkFolder: string;
  bulkPendingFile: File | null;
  bulkBusy: boolean;
  scopedDetectionCount: number;
  onSetBulkFolder: (dir: string) => void;
  onPickBulkFile: (file: File) => void;
  onClearBulkFile: () => void;
  onAskBulkConfirm: () => void;
}

/**
 * Vertical, scrollable list of detected image references. Each row carries:
 *   - thumbnail (when the file exists locally),
 *   - the type with a color-coded badge,
 *   - the path/URL,
 *   - which file the reference came from,
 *   - status badge (ok / missing / remote).
 *
 * The list groups items by status visually via row color and renders a
 * short empty state when the scan finishes with zero results. A small
 * filter-chip row at the top toggles the view between All / OK / Broken
 * (`missing` or remote with a riskReason).
 */
export function DetectedImagesList({
  detections, thumbnails, scanning, selectedKey, onSelect,
  folderBuckets, bulkFolder, bulkPendingFile, bulkBusy, scopedDetectionCount,
  onSetBulkFolder, onPickBulkFile, onClearBulkFile, onAskBulkConfirm,
}: DetectedImagesListProps) {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    return detections.reduce(
      (acc, d) => {
        acc.total += 1;
        if (d.status === 'ok') acc.ok += 1;
        if (isBroken(d)) acc.broken += 1;
        return acc;
      },
      { total: 0, ok: 0, broken: 0 },
    );
  }, [detections]);

  if (scanning) {
    return (
      <p className="px-3 py-4 text-center text-xs text-zinc-500">
        <span className="mb-1 inline-block h-3 w-3 animate-pulse rounded-full bg-violet-400 align-middle mr-2" />
        Scanning project for image references…
      </p>
    );
  }

  const visible = detections.filter((d) => {
    if (filter === 'ok') return d.status === 'ok';
    if (filter === 'broken') return isBroken(d);
    return true;
  });

  return (
    <div className="flex h-full flex-col gap-2">
      {folderBuckets.length > 1 && (
        <FolderScopeRow
          buckets={folderBuckets}
          active={bulkFolder}
          onChange={onSetBulkFolder}
        />
      )}
      <BulkReplaceZone
        buckets={folderBuckets}
        active={bulkFolder}
        pendingFile={bulkPendingFile}
        busy={bulkBusy}
        scopedDetectionCount={scopedDetectionCount}
        onPickBulkFile={onPickBulkFile}
        onClearBulkFile={onClearBulkFile}
        onAskBulkConfirm={onAskBulkConfirm}
      />
      <div
        className="flex flex-wrap items-center gap-1 px-1"
        role="tablist"
        aria-label="Filter detected images"
      >
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} testId="detected-filter-all">
          All <span className="ml-1 text-zinc-500">{counts.total}</span>
        </FilterChip>
        <FilterChip active={filter === 'ok'} onClick={() => setFilter('ok')} tone="emerald" testId="detected-filter-ok">
          OK <span className="ml-1 text-zinc-500">{counts.ok}</span>
        </FilterChip>
        <FilterChip active={filter === 'broken'} onClick={() => setFilter('broken')} tone="rose" testId="detected-filter-broken">
          Broken <span className="ml-1 text-zinc-500">{counts.broken}</span>
        </FilterChip>
      </div>
      {visible.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-zinc-500">
          {filter === 'broken'
            ? 'No broken or risky references in this project.'
            : 'No image references detected.'}
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto pr-1" data-testid="detected-images">
          {visible.map((d) => (
            <DetectionCard
              key={`${detectionKey(d)}|${d.resolvedPath}|${d.status}`}
              detection={d}
              thumbnail={d.resolvedPath ? thumbnails.get(d.resolvedPath) : undefined}
              selected={selectedKey === detectionKey(d)}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface FilterChipProps {
  active: boolean;
  onClick: () => void;
  tone?: 'emerald' | 'rose';
  children: React.ReactNode;
  testId?: string;
}

function FilterChip({ active, onClick, tone, children, testId }: FilterChipProps) {
  const toneCls = active
    ? tone === 'rose'
      ? 'border-rose-500/60 bg-rose-500/15 text-rose-100'
      : tone === 'emerald'
        ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-100'
        : 'border-violet-500/60 bg-violet-500/15 text-violet-100'
    : 'border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${toneCls}`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

interface CardProps {
  detection: ImageDetection;
  thumbnail: string | undefined;
  selected: boolean;
  onSelect: (key: string) => void;
}

/**
 * Base classes shared by every card button (motion reduced, layout,
 * padding). The focus ring colour is computed per status and tacked on
 * at the call site so Missing cards get a rose ring while OK / Remote
 * get violet. Items-centre + min-h-[72px] keeps the smaller missing-
 * alert icon vertically centred AND gives every row a uniform 72-px
 * floor so the unfiltered list doesn't visibly "breathe" between
 * OK / Remote rows and missing rows.
 */
const CARD_BTN_BASE =
  'group flex w-full min-h-[72px] items-center gap-2.5 rounded-lg border p-1.5 text-left ' +
  'transition-colors motion-reduce:transition-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950';
const FOCUS_VIOLET = 'focus-visible:ring-violet-400';
const FOCUS_ROSE = 'focus-visible:ring-rose-400';

function cardCls(status: ImageStatus, selected: boolean): string {
  const focusCls = status === 'missing' ? FOCUS_ROSE : FOCUS_VIOLET;
  if (selected) {
    return `${CARD_BTN_BASE} ${focusCls} border-violet-500/60 bg-violet-500/10 ring-1 ring-violet-400/40`;
  }
  switch (status) {
    case 'missing':
      // Missing cards get a SEVERE skin — no thumb box, hard rose tint,
      // a 2 px solid rose left border. Audit's "first impression" fix:
      // when the broken filter is active the list visibly changes
      // posture, not just colour.
      return `${CARD_BTN_BASE} ${focusCls} border-zinc-800 border-l-2 border-l-rose-500 bg-rose-950/30 hover:bg-rose-900/40`;
    case 'remote':
      return `${CARD_BTN_BASE} ${focusCls} border-violet-700/40 bg-violet-950/30 hover:bg-violet-900/40 hover:border-violet-500/60`;
    case 'ok':
    default:
      return `${CARD_BTN_BASE} ${focusCls} border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800 hover:border-zinc-700`;
  }
}

function DetectionCard({ detection, thumbnail, selected, onSelect }: CardProps) {
  const { rawUrl, type, status, sourceFile, sourceTag, sourceAttr, extra } = detection;
  const isMissing = status === 'missing';
  const isRemote = status === 'remote';
  const dataTestId = `detection-card-${status}`;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(detectionKey(detection))}
        // "current" rather than "pressed" — the selection is mutually
        // exclusive and updates the right-panel editor, so AT users
        // benefit from "current item" framing.
        aria-current={selected ? 'true' : undefined}
        data-testid={dataTestId}
        className={cardCls(status, selected)}
      >
        {isMissing ? (
          // Alert-led thumbnail box. Lighter than the OK variant so the
          // eye keeps finding cards in the unfiltered (mixed-status)
          // view. The BrokenBadge SVG carries the affordance; no type
          // overlay because the source image is unknown / unrecoverable.
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-rose-900/40 ring-1 ring-rose-500/40"
            aria-hidden="true"
          >
            <BrokenBadge />
          </div>
        ) : (
          <Thumbnail thumb={thumbnail} status={status} type={type} />
        )}
        <div className="min-w-0 flex-1 py-0.5">
          {isMissing ? (
            <span
              className="truncate text-[10px] font-semibold uppercase tracking-wide text-rose-200"
              data-testid="detection-card-status-label"
            >
              Missing · {sourceTag}
              {sourceAttr && sourceAttr !== sourceTag ? ` · ${sourceAttr}` : ''}
            </span>
          ) : (
            <div className="flex items-center gap-1.5">
              {isRemote && (
                <span
                  className="text-[10px] font-semibold uppercase tracking-wide text-violet-300"
                  data-testid="detection-card-status-label"
                >
                  Remote
                </span>
              )}
              <span className="truncate text-[10px] uppercase tracking-wide text-zinc-500">
                {sourceTag}
                {sourceAttr && sourceAttr !== sourceTag ? ` · ${sourceAttr}` : ''}
              </span>
            </div>
          )}
          <p
            className="mt-0.5 truncate font-mono text-[11px] text-zinc-100"
            title={rawUrl}
            data-testid="detection-card-raw-url"
          >
            {displayablePath(rawUrl)}
          </p>
          <p
            className={`mt-0.5 truncate text-[11px] ${selected ? 'text-violet-300' : 'text-zinc-500'}`}
            title={`Found in ${sourceFile}`}
          >
            <span className={selected ? 'text-violet-400/80' : 'text-zinc-600'}>in</span>{' '}
            {sourceFile}
            {!isMissing && extra?.property && (
              <span className="ml-1 text-violet-300/80">[{extra.property}]</span>
            )}
            {!isMissing && extra?.rel && (
              <span className="ml-1 text-violet-300/80">[rel={extra.rel}]</span>
            )}
            {!isMissing && extra?.sizes && (
              <span className="ml-1 text-violet-300/80">{extra.sizes}</span>
            )}
            {!isMissing && extra?.cssProperty && (
              <span className="ml-1 text-violet-300/80">{extra.cssProperty}</span>
            )}
          </p>
        </div>
      </button>
    </li>
  );
}

function detectionKey(detection: ImageDetection): string {
  return `${detection.sourceFile}::${detection.sourceTag}::${detection.sourceAttr}::${detection.rawUrl}`;
}

/**
 * 64×64 thumbnail that pairs an image (when available) with a bottom
 * TYPE OVERLAY. The overlay's blurred-on-zinc-950 background guarantees
 * type readability even when the underlying image is bright, transparent,
 * or visually noisy. Hover brightens the image (no scale / shadow — those
 * would inflate the row height and break density).
 */
function Thumbnail({
  thumb,
  status,
  type,
}: {
  thumb: string | undefined;
  status: ImageStatus;
  type: ImageType;
}) {
  const isRemote = status === 'remote';
  const ringCls = isRemote ? 'ring-violet-500/40' : 'ring-zinc-800';
  const panelCls = isRemote ? 'bg-violet-950/40' : 'bg-zinc-800';

  const inner: React.ReactNode =
    thumb && !isRemote ? (
      // OK with thumb. Brightness dims slightly so the row reads as
      // "image data" rather than "image as page"; hover lifts the
      // brightness back to neutral so the user can preview detail.
      // The panel colour (zinc-800) shows through transparent PNGs /
      // image gaps — replacing the prior off-white panel that turned
      // a failed-load into a stark bright square against the dark
      // surrounding UI.
      <img
        src={thumb}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-full w-full object-contain brightness-90 transition-[filter] duration-200 group-hover:brightness-100 motion-reduce:transition-none"
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
      />
    ) : isRemote && thumb ? (
      <img
        src={thumb}
        alt=""
        loading="lazy"
        decoding="async"
        className="h-full w-full object-contain brightness-95 transition-[filter] duration-200 group-hover:brightness-100 motion-reduce:transition-none"
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
      />
    ) : isRemote ? (
      <RemoteBadge />
    ) : (
      // OK without thumb. Bare skeleton — no FileIcon. The audit's
      // thumbnail-prominence move doesn't survive a generic file glyph
      // sat in the corner; better to let the row read "this card is
      // still loading" than to fall back to a wrong-tagged icon.
      <span aria-hidden="true" />
    );

  return (
    <div
      className={`relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md ${panelCls} ring-1 ${ringCls}`}
    >
      {inner}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-zinc-950/85 px-1 py-0.5 text-center text-[9px] font-bold uppercase tracking-wider text-zinc-200 backdrop-blur-sm">
        {type}
      </div>
    </div>
  );
}

function RemoteBadge() {
  // The badge sits inside a flex-centring parent (h-16 w-16) so we don't
  // need margin hacks. The size is reduced to h-7 w-7 to leave room for
  // the bottom type-strip overlay (px-1 py-0.5 ~12 px tall) instead of
  // being clipped by it.
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-7 w-7 text-violet-300"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}

function BrokenBadge() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5 text-rose-300"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function displayablePath(rawUrl: string): string {
  if (/^https?:\/\//i.test(rawUrl)) {
    try {
      const u = new URL(rawUrl);
      return u.hostname + u.pathname;
    } catch {
      return rawUrl;
    }
  }
  if (rawUrl.startsWith('//')) return rawUrl.slice(2);
  return rawUrl;
}

/* ---------------------------------------------------------------------------
 * Folder scoping + bulk replace zone
 * ------------------------------------------------------------------------*/

const ALL_FOLDER = '__all__';
const ACCEPTED_IMAGE_MIMES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/avif', 'image/bmp', 'image/x-icon',
];

interface FolderScopeRowProps {
  buckets: FolderBucket[];
  active: string;
  onChange: (dir: string) => void;
}

function FolderScopeRow({ buckets, active, onChange }: FolderScopeRowProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 px-1"
      role="tablist"
      aria-label="Folder scope for bulk replace"
    >
      <ScopeChip
        active={active === ALL_FOLDER}
        onClick={() => onChange(ALL_FOLDER)}
        testId="folder-scope-all"
      >
        All folders <span className="ml-1 text-zinc-500">{buckets.reduce((acc, b) => acc + b.count, 0)}</span>
      </ScopeChip>
      {buckets.map((b) => (
        <ScopeChip
          key={b.dir}
          active={active === b.dir}
          onClick={() => onChange(b.dir)}
          testId={`folder-scope-${b.dir}`}
          title={b.dir}
        >
          <span className="font-mono">{b.dir.replace(/\/$/, '') || '/'}</span> <span className="ml-1 text-zinc-500">{b.count}</span>
        </ScopeChip>
      ))}
    </div>
  );
}

function ScopeChip({ active, onClick, children, testId, title }: { active: boolean; onClick: () => void; children: React.ReactNode; testId?: string; title?: string }) {
  const cls = active
    ? 'border-violet-500/60 bg-violet-500/15 text-violet-100'
    : 'border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={title}
      className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${cls}`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

interface BulkReplaceZoneProps {
  buckets: FolderBucket[];
  active: string;
  pendingFile: File | null;
  busy: boolean;
  scopedDetectionCount: number;
  onPickBulkFile: (file: File) => void;
  onClearBulkFile: () => void;
  onAskBulkConfirm: () => void;
}

/**
 * Drop-zone + apply CTA for "pick one image, apply it to every detection
 * in the scoped folder". Lives directly above the filter chip row so the
 * user sees both filters and bulk-affordance in the same viewport. Shows
 * only when there's at least one folder bucket to apply against (so a
 * one-file project doesn't get a zone it can't use).
 */
function BulkReplaceZone({
  active, pendingFile, busy, scopedDetectionCount,
  onPickBulkFile, onClearBulkFile, onAskBulkConfirm,
}: BulkReplaceZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);

  const acceptFile = (file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    onPickBulkFile(file);
  };

  useEffect(() => { return () => { /* nothing to clean up here */ }; }, []);

  const canApply = !!pendingFile && scopedDetectionCount > 0 && !busy;

  return (
    <div className="space-y-1.5 rounded-md border border-zinc-800 bg-zinc-900/40 p-2" data-testid="bulk-replace-zone">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGE_MIMES.join(',')}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          acceptFile(e.target.files?.[0]);
          e.target.value = '';
        }}
        className="sr-only"
        data-testid="bulk-replace-input"
      />
      <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-400">
        <span className="font-semibold uppercase tracking-wide text-zinc-500">Bulk replace</span>
        <span className="font-mono text-zinc-500" title={active}>{active === ALL_FOLDER ? 'all folders' : active}</span>
      </div>
      {!pendingFile ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); }
          }}
          onDragOver={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setHover(true); }}
          onDragLeave={() => setHover(false)}
          onDrop={(e: DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            setHover(false);
            acceptFile(e.dataTransfer.files?.[0]);
          }}
          className={`flex cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed px-2 py-3 text-center text-[11px] transition-colors ${
            hover ? 'border-violet-400 bg-violet-500/10' : 'border-zinc-700 bg-zinc-950 hover:border-zinc-500 hover:bg-zinc-900'
          }`}
          data-testid="bulk-replace-dropzone"
        >
          <p className="text-zinc-200 font-medium">Drop a replacement image</p>
          <p className="text-zinc-500">apply it to {scopedDetectionCount} {scopedDetectionCount === 1 ? 'image' : 'images'} in scope</p>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[11px] text-zinc-300" title={pendingFile.name}>{pendingFile.name}</p>
            <p className="text-[11px] text-zinc-500">{formatBytes(pendingFile.size)} · {pendingFile.type || 'image'}</p>
          </div>
          <button
            type="button"
            onClick={onClearBulkFile}
            className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-200 transition-colors hover:border-rose-500/50 hover:text-rose-200"
            data-testid="bulk-replace-clear"
          >
            Change
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={onAskBulkConfirm}
        disabled={!canApply}
        aria-busy={busy}
        className="w-full rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="bulk-replace-apply"
        title={canApply
          ? `Apply ${pendingFile?.name ?? ''} to ${scopedDetectionCount} ${scopedDetectionCount === 1 ? 'image' : 'images'}`
          : 'Drop a replacement image, then choose a folder scope'}
      >
        {busy
          ? <span className="inline-flex items-center gap-2"><span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />Applying to {scopedDetectionCount}…</span>
          : `Apply to ${scopedDetectionCount} ${scopedDetectionCount === 1 ? 'image' : 'images'}`}
      </button>
    </div>
  );
}
