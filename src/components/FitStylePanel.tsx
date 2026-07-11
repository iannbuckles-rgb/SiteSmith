import { useCallback, useEffect, useState } from 'react';

import { canApplyFitStyle, canOverlay, describeGeneratedCss } from '../lib/fitStyles';
import type {
  AppliedPatch,
  BorderRadius,
  ImageDetection,
  ImageFit,
  ImageFitConfig,
  ImagePosition,
  OverlayDensity,
} from '../types';

interface FitStylePanelProps {
  detection: ImageDetection;
  appliedPatch: AppliedPatch | null;
  busy: boolean;
  error: string | null;
  onApply: (config: ImageFitConfig) => void;
  onReset: () => void;
}

const FIT_OPTIONS: Array<{ value: ImageFit; label: string; description: string }> = [
  { value: 'cover', label: 'Cover', description: 'Fill the box, crop edges if needed' },
  { value: 'contain', label: 'Contain', description: 'Fit fully inside the box' },
  { value: 'fill', label: 'Fill', description: 'Stretch to box (may distort)' },
  { value: 'scale-down', label: 'Scale-down', description: 'Like contain, no upscaling' },
  { value: 'none', label: 'None', description: 'Use natural size' },
];

const POSITION_OPTIONS: Array<{ value: ImagePosition; label: string }> = [
  { value: 'center', label: 'Center' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

const RADIUS_OPTIONS: Array<{ value: BorderRadius; label: string; px: string }> = [
  { value: 'none', label: 'None', px: '0' },
  { value: 'small', label: 'Small', px: '4px' },
  { value: 'medium', label: 'Medium', px: '8px' },
  { value: 'large', label: 'Large', px: '16px' },
  { value: 'full', label: 'Full', px: 'pill' },
];

const OVERLAY_OPTIONS: Array<{ value: OverlayDensity; label: string; description: string }> = [
  { value: 'none', label: 'None', description: '' },
  { value: 'light', label: 'Light', description: '~35% darkness' },
  { value: 'medium', label: 'Medium', description: '~55% darkness' },
];

const DEFAULT_CONFIG: ImageFitConfig = {
  fit: 'cover',
  position: 'center',
  borderRadius: 'none',
  overlay: 'none',
};

/**
 * Chip-grid panel for the lightweight image-fit controls. Hidden when the
 * selected detection can't accept the surgery; otherwise presents fit /
 * position / radius / overlay as small chip rows and emits a single
 * `ImageFitConfig` to the parent on Apply.
 */
export function FitStylePanel({
  detection, appliedPatch, busy, error, onApply, onReset,
}: FitStylePanelProps) {
  const canApply = canApplyFitStyle(detection);
  const overlayAvailable = canOverlay(detection);
  const [config, setConfig] = useState<ImageFitConfig>(DEFAULT_CONFIG);

  // Reset the draft whenever the user selects a different detection so
  // they don't accidentally apply last selection's config to the new one.
  // Also resets when an applied patch is removed (post-Edit-again) — without
  // this dependency the chips would silently retain the previously-applied
  // config and the next Apply would do nothing visually different for the
  // user, masking that the panel is back in draft mode.
  const appliedPatchId = appliedPatch?.id ?? null;
  useEffect(() => {
    setConfig(DEFAULT_CONFIG);
  }, [detection.sourceFile, detection.sourceTag, detection.sourceAttr, detection.rawUrl, appliedPatchId]);

  const setFit = useCallback((fit: ImageFit) => setConfig((p) => ({ ...p, fit })), []);
  const setPosition = useCallback((position: ImagePosition) => setConfig((p) => ({ ...p, position })), []);
  const setRadius = useCallback((borderRadius: BorderRadius) => setConfig((p) => ({ ...p, borderRadius })), []);
  const setOverlay = useCallback((overlay: OverlayDensity) => setConfig((p) => ({ ...p, overlay })), []);

  const handleApply = useCallback(() => {
    if (!canApply) return;
    onApply(config);
  }, [canApply, config, onApply]);

  if (!canApply) return null;

  // Existing patch? Show a summary card + Edit-again affordance; the chip
  // grid is a draft editor so it stays out of the way while the success
  // summary is informative.
  const existing = appliedPatch?.action === 'fit-style' ? appliedPatch : null;

  return (
    <div className="flex flex-col gap-3" data-testid="fit-style-panel">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Fit & style
        </h3>
        <span className="text-[11px] text-zinc-500">
          {detection.sourceKind === 'css' ? 'CSS background' : 'HTML <img>'}
        </span>
      </header>

      {existing ? (
        <AppliedFitSummary patch={existing} onReset={onReset} />
      ) : (
        <>
          <ChipRow label="Object-fit">
            {FIT_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                active={config.fit === opt.value}
                label={opt.label}
                title={opt.description}
                onClick={() => setFit(opt.value)}
                testId={`fit-fit-${opt.value}`}
              />
            ))}
          </ChipRow>

          <ChipRow label="Object-position">
            {POSITION_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                active={config.position === opt.value}
                label={opt.label}
                onClick={() => setPosition(opt.value)}
                testId={`fit-pos-${opt.value}`}
              />
            ))}
          </ChipRow>

          <ChipRow label="Border-radius">
            {RADIUS_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                active={config.borderRadius === opt.value}
                label={`${opt.label} (${opt.px})`}
                onClick={() => setRadius(opt.value)}
                testId={`fit-radius-${opt.value}`}
              />
            ))}
          </ChipRow>

          <ChipRow label="Hero overlay" disabled={!overlayAvailable}>
            {OVERLAY_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                active={config.overlay === opt.value}
                label={opt.label}
                title={opt.description || (overlayAvailable ? 'No overlay' : 'Only available for CSS background refs')}
                onClick={() => overlayAvailable && setOverlay(opt.value)}
                disabled={!overlayAvailable}
                testId={`fit-overlay-${opt.value}`}
              />
            ))}
          </ChipRow>

          {error && (
            <div
              role="alert"
              className="rounded-md border border-rose-700/60 bg-rose-900/30 px-3 py-2 text-xs text-rose-200"
              data-testid="fit-style-error"
            >
              {error}
            </div>
          )}

          <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
            <p className="text-[10px] uppercase tracking-wide text-zinc-500">Generated</p>
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-300">
              {describeGeneratedCss(detection, config)}
            </pre>
          </div>

          <button
            type="button"
            onClick={handleApply}
            disabled={busy}
            className="w-full rounded-md bg-violet-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="fit-style-apply"
          >
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                Applying fit style…
              </span>
            ) : (
              'Apply fit & style'
            )}
          </button>
        </>
      )}
    </div>
  );
}

interface ChipRowProps {
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}

function ChipRow({ label, disabled, children }: ChipRowProps) {
  return (
    <div className={disabled ? 'opacity-50' : ''}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </p>
      <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

interface ChipProps {
  active: boolean;
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}

function Chip({ active, label, title, disabled, onClick, testId }: ChipProps) {
  let cls = 'rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors';
  if (disabled) {
    cls += ' cursor-not-allowed border-zinc-800 bg-zinc-950/60 text-zinc-600';
  } else if (active) {
    cls += ' border-violet-500/60 bg-violet-500/15 text-violet-100';
  } else {
    cls += ' border-zinc-800 bg-zinc-900/50 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100';
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cls}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

interface AppliedFitSummaryProps {
  // Narrowed to the 'fit-style' arm so `generatedCss` / `config` are
  // typed precisely inside the summary card without runtime guards.
  // Without this Extract, TS rejects `patch.generatedCss` because the
  // `AppliedPatch` union also contains 'replace' / 'remove' /
  // 'placeholder' arms that don't carry that property.
  patch: Extract<AppliedPatch, { action: 'fit-style' }>;
  onReset: () => void;
}

function AppliedFitSummary({ patch, onReset }: AppliedFitSummaryProps) {
  return (
    <div className="space-y-2" data-testid="fit-style-applied">
      <div className="rounded-md border border-emerald-700/40 bg-emerald-950/30 p-3">
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" className="h-4 w-4 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <p className="text-xs font-medium text-emerald-200">Fit & style applied</p>
        </div>
        <p className="mt-2 text-[10px] uppercase tracking-wide text-zinc-500">Generated</p>
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-zinc-300">
          {patch.generatedCss}
        </pre>
      </div>
      <button
        type="button"
        onClick={onReset}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:border-violet-400 hover:bg-violet-500/10 hover:text-violet-100"
        data-testid="fit-style-edit-again"
      >
        Edit again
      </button>
    </div>
  );
}
