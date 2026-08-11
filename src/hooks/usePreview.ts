import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ZipEntryMeta, LoadedProject } from '../types';
import type { PreviewDiagnostic, PreviewIndex } from '../lib/previewService';
import { buildPreview, disposePreview } from '../lib/previewServer';
import {
  isMessageFromPreviewFrame,
  type EditorReorderTarget,
  type EditorSelection,
  type PreviewHistoryState,
  type PreviewMode,
  type PreviewViewport,
} from '../lib/previewControls';
import { resolveAgainst } from '../lib/urlResolver';

// ---------------------------------------------------------------------------
// postMessage type constants (moved from App.tsx)
// ---------------------------------------------------------------------------
const NAV_MESSAGE_TYPE = 'mockswap:navigate';
const TEXT_EDIT_MESSAGE_TYPE = 'mockswap:text-edit';
const SELECT_MESSAGE_TYPE = 'mockswap:select-element';
const REORDER_MESSAGE_TYPE = 'mockswap:reorder-element';
const NUDGE_MESSAGE_TYPE = 'mockswap:nudge-element';
const PREVIEW_STATUS_MESSAGE_TYPE = 'mockswap:preview-status';

// ---------------------------------------------------------------------------
// Callback types — App.tsx wires these to its own handlers
// ---------------------------------------------------------------------------

export interface PreviewTextEditInput {
  sourceFile: string;
  oldText: string;
  newText: string;
  tagName?: string;
  label?: string;
  sourceStart?: number;
  sourceEnd?: number;
  selectorHint?: string;
}

export interface EditorNudgeInput {
  sourceFile?: unknown;
  selection?: unknown;
  deltaX?: unknown;
  deltaY?: unknown;
}

export interface EditorReorderInput {
  sourceFile?: unknown;
  selection?: unknown;
  reference?: unknown;
  placement?: unknown;
}

export interface UsePreviewCallbacks {
  /** Called when the iframe emits a text-edit message. */
  onPreviewTextEdit?: (input: PreviewTextEditInput) => void;
  /** Called when the iframe requests an element nudge. */
  onEditorNudge?: (selection: EditorSelection, deltaX: number, deltaY: number) => void;
  /** Called when the iframe requests an element reorder. */
  onEditorReorder?: (selection: EditorSelection, reference: EditorReorderTarget, placement: 'before' | 'after') => void;
  /** Called when an element is selected in the iframe (for mobile pane switching). */
  onSelectElement?: () => void;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface UsePreviewInput {
  project: LoadedProject | null;
  liveEntries: ZipEntryMeta[];
  /** Called when a patch was applied — triggers a rebuild. */
  previewRevision: number;
  /** App-level callbacks wired from the postMessage handler. */
  callbacks?: UsePreviewCallbacks;
}

export interface UsePreviewResult {
  preview: PreviewIndex | null;
  previewBuilding: boolean;
  previewKey: number;
  currentPagePath: string;
  previewRuntimeDiagnostics: PreviewDiagnostic[];
  previewViewport: PreviewViewport;
  previewZoom: number;
  previewHistory: PreviewHistoryState;
  previewFullscreen: boolean;
  previewMode: PreviewMode;
  editorSelection: EditorSelection | null;
  editorClearSelectionSignal: number;
  editorBusy: boolean;
  editorError: string | null;

  /** Stable ref to the current preview index, for callbacks that must not re-create. */
  previewRef: { current: PreviewIndex | null };
  currentPagePathRef: { current: string };

  // Navigation & toolbar handlers
  navigateToPage: (path: string) => void;
  handleNavigateBack: () => void;
  handleNavigateForward: () => void;
  handleChangeViewport: (vp: PreviewViewport) => void;
  handleChangeZoom: (z: number) => void;
  handleToggleFullscreen: () => void;
  handleExitFullscreen: () => void;
  handleChangePreviewMode: (mode: PreviewMode) => void;
  handleOpenInNewTab: () => void;
  handleRefreshPreview: () => void;

  // Setters that external code (App.tsx) still needs
  setPreviewKey: (updater: (k: number) => number) => void;
  setCurrentPagePath: React.Dispatch<React.SetStateAction<string>>;
  setPreviewRuntimeDiagnostics: React.Dispatch<React.SetStateAction<PreviewDiagnostic[]>>;
  setEditorSelection: React.Dispatch<React.SetStateAction<EditorSelection | null>>;
  setEditorClearSelectionSignal: React.Dispatch<React.SetStateAction<number>>;
  setEditorBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setEditorError: React.Dispatch<React.SetStateAction<string | null>>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePreview(input: UsePreviewInput): UsePreviewResult {
  const { project, liveEntries, previewRevision, callbacks } = input;

  const [preview, setPreview] = useState<PreviewIndex | null>(null);
  const previewRef = useRef<PreviewIndex | null>(null);
  const [previewBuilding, setPreviewBuilding] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [currentPagePath, setCurrentPagePath] = useState<string>('');
  const currentPagePathRef = useRef<string>('');
  const [previewRuntimeDiagnostics, setPreviewRuntimeDiagnostics] = useState<PreviewDiagnostic[]>([]);
  const [previewViewport, setPreviewViewport] = useState<PreviewViewport>('full');
  const [previewZoom, setPreviewZoom] = useState<number>(1);
  const [previewHistory, setPreviewHistory] = useState<PreviewHistoryState>({ pages: [], index: -1 });
  const previewHistoryRef = useRef<PreviewHistoryState>({ pages: [], index: -1 });
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('preview');
  const [editorSelection, setEditorSelection] = useState<EditorSelection | null>(null);
  const [editorClearSelectionSignal, setEditorClearSelectionSignal] = useState(0);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // Sync refs
  useEffect(() => { previewRef.current = preview; }, [preview]);
  useEffect(() => { currentPagePathRef.current = currentPagePath; }, [currentPagePath]);
  useEffect(() => { previewHistoryRef.current = previewHistory; }, [previewHistory]);

  // Build/rebuild preview when project, entries, or revision change.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const run = async () => {
      if (!project) return;
      setPreviewBuilding(true);
      setPreviewRuntimeDiagnostics([]);
      try {
        const index = await buildPreview(project, liveEntries, { signal: controller.signal });
        if (cancelled) {
          void disposePreview(index);
          return;
        }
        setPreview(index);
        // Preserve the current page path if it still exists in the new index.
        setCurrentPagePath((prev) => {
          const exists = prev && index.urls.has(prev);
          if (exists) return prev;
          return index.primaryPath;
        });
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setPreviewRuntimeDiagnostics((prev) => [
          ...prev,
          { level: 'error', message: `Preview build failed: ${err instanceof Error ? err.message : String(err)}` },
        ]);
      } finally {
        if (!cancelled) setPreviewBuilding(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
      controller.abort();
      const staleIndex = previewRef.current;
      if (staleIndex) {
        setTimeout(() => { void disposePreview(staleIndex); }, 0);
      }
    };
  }, [project, liveEntries, previewRevision]);

  // --- Navigation handlers ---

  const navigateToPage = useCallback((path: string) => {
    if (!path || path === currentPagePathRef.current) return;
    currentPagePathRef.current = path;
    setEditorSelection(null);
    setEditorError(null);
    setPreviewRuntimeDiagnostics([]);
    setCurrentPagePath(path);
    setPreviewHistory((prev) => {
      const curIdx = prev.index;
      const truncated = (curIdx >= 0 && curIdx < prev.pages.length - 1)
        ? prev.pages.slice(0, curIdx + 1)
        : prev.pages;
      return { pages: [...truncated, path], index: truncated.length };
    });
    setPreviewKey((k) => k + 1);
  }, []);

  const handleNavigateBack = useCallback(() => {
    const cur = previewHistoryRef.current;
    if (cur.index <= 0) return;
    const newIndex = cur.index - 1;
    const target = cur.pages[newIndex];
    if (!target) return;
    currentPagePathRef.current = target;
    setPreviewRuntimeDiagnostics([]);
    setCurrentPagePath(target);
    setPreviewHistory({ pages: cur.pages, index: newIndex });
    setPreviewKey((k) => k + 1);
  }, []);

  const handleNavigateForward = useCallback(() => {
    const cur = previewHistoryRef.current;
    if (cur.index >= cur.pages.length - 1) return;
    const newIndex = cur.index + 1;
    const target = cur.pages[newIndex];
    if (!target) return;
    currentPagePathRef.current = target;
    setPreviewRuntimeDiagnostics([]);
    setCurrentPagePath(target);
    setPreviewHistory({ pages: cur.pages, index: newIndex });
    setPreviewKey((k) => k + 1);
  }, []);

  // Alt+←/→ keyboard shortcuts
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (!previewRef.current || previewRef.current.htmlPaths.length === 0) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') handleNavigateBack();
      else handleNavigateForward();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleNavigateBack, handleNavigateForward]);

  const handleChangeViewport = useCallback((vp: PreviewViewport) => setPreviewViewport(vp), []);
  const handleChangeZoom = useCallback((z: number) => {
    if (!Number.isFinite(z)) return;
    setPreviewZoom(Math.min(2, Math.max(0.25, z)));
  }, []);
  const handleToggleFullscreen = useCallback(() => setPreviewFullscreen((v) => !v), []);
  const handleExitFullscreen = useCallback(() => setPreviewFullscreen(false), []);
  const handleChangePreviewMode = useCallback((mode: PreviewMode) => {
    setPreviewMode(mode);
    setEditorError(null);
    if (mode === 'preview') setEditorSelection(null);
  }, []);
  const handleOpenInNewTab = useCallback(() => {
    const index = previewRef.current;
    if (!index) return;
    const cur = currentPagePathRef.current;
    const target = (cur && index.urls.get(cur)) || index.primaryUrl;
    if (!target) return;
    window.open(target, '_blank', 'noopener,noreferrer');
  }, []);
  const handleRefreshPreview = useCallback(() => {
    setPreviewRuntimeDiagnostics([]);
    setPreviewKey((k) => k + 1);
  }, []);

  // ---------------------------------------------------------------------------
  // postMessage listener — handles messages from the preview iframe
  // (moved from App.tsx so raw state setters don't need to be exposed)
  // ---------------------------------------------------------------------------

  const onPreviewTextEdit = callbacks?.onPreviewTextEdit;
  const onEditorNudge = callbacks?.onEditorNudge;
  const onEditorReorder = callbacks?.onEditorReorder;
  const onSelectElement = callbacks?.onSelectElement;

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const previewFrame = document.querySelector<HTMLIFrameElement>('[data-testid="preview-iframe"]');
      if (!isMessageFromPreviewFrame(event, previewFrame)) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const type = (data as { type?: string }).type;

      // --- Runtime error diagnostics ---
      if (type === PREVIEW_STATUS_MESSAGE_TYPE) {
        const payload = data as { level?: unknown; message?: unknown; detail?: unknown; sourceFile?: unknown };
        if (payload.level !== 'error' || typeof payload.message !== 'string') return;
        const source = typeof payload.sourceFile === 'string' ? payload.sourceFile : currentPagePathRef.current;
        const detail = typeof payload.detail === 'string' ? payload.detail : '';
        const diagnostic: PreviewDiagnostic = {
          level: 'error',
          message: formatPreviewRuntimeError(payload.message, detail, source),
        };
        setPreviewRuntimeDiagnostics((current) => {
          if (current.some((item) => item.message === diagnostic.message)) return current;
          return [...current, diagnostic].slice(-8);
        });
        return;
      }

      // --- Element selection ---
      if (type === SELECT_MESSAGE_TYPE) {
        const payload = data as Partial<EditorSelection>;
        if (
          payload &&
          (payload.kind === 'text' || payload.kind === 'image' || payload.kind === 'element') &&
          typeof payload.sourceFile === 'string' &&
          typeof payload.tagName === 'string' &&
          typeof payload.label === 'string'
        ) {
          setEditorSelection({
            sourceFile: payload.sourceFile,
            kind: payload.kind,
            tagName: payload.tagName,
            label: payload.label,
            text: typeof payload.text === 'string' ? payload.text : undefined,
            src: typeof payload.src === 'string' ? payload.src : undefined,
            alt: typeof payload.alt === 'string' ? payload.alt : undefined,
            href: typeof payload.href === 'string' ? payload.href : undefined,
            elementId: typeof payload.elementId === 'string' ? payload.elementId : undefined,
            className: typeof payload.className === 'string' ? payload.className : undefined,
            style: typeof payload.style === 'string' ? payload.style : undefined,
            role: typeof payload.role === 'string' ? payload.role : undefined,
            ariaLabel: typeof payload.ariaLabel === 'string' ? payload.ariaLabel : undefined,
            name: typeof payload.name === 'string' ? payload.name : undefined,
            inputType: typeof payload.inputType === 'string' ? payload.inputType : undefined,
            value: typeof payload.value === 'string' ? payload.value : undefined,
            placeholder: typeof payload.placeholder === 'string' ? payload.placeholder : undefined,
            sourceStart: typeof payload.sourceStart === 'number' ? payload.sourceStart : undefined,
            sourceEnd: typeof payload.sourceEnd === 'number' ? payload.sourceEnd : undefined,
            hasElementChildren: typeof payload.hasElementChildren === 'boolean' ? payload.hasElementChildren : undefined,
            selectorHint: typeof payload.selectorHint === 'string' ? payload.selectorHint : undefined,
            moveBeforeTarget: readEditorReorderTarget(payload.moveBeforeTarget),
            moveAfterTarget: readEditorReorderTarget(payload.moveAfterTarget),
          });
          setEditorError(null);
          onSelectElement?.();
        }
        return;
      }

      // --- Text edit ---
      if (type === TEXT_EDIT_MESSAGE_TYPE) {
        const payload = data as {
          sourceFile?: unknown;
          oldText?: unknown;
          newText?: unknown;
          tagName?: unknown;
          label?: unknown;
          sourceStart?: unknown;
          sourceEnd?: unknown;
          selectorHint?: unknown;
        };
        if (
          typeof payload.sourceFile === 'string' &&
          typeof payload.oldText === 'string' &&
          typeof payload.newText === 'string'
        ) {
          void onPreviewTextEdit?.({
            sourceFile: payload.sourceFile,
            oldText: payload.oldText,
            newText: payload.newText,
            tagName: typeof payload.tagName === 'string' ? payload.tagName : undefined,
            label: typeof payload.label === 'string' ? payload.label : undefined,
            sourceStart: typeof payload.sourceStart === 'number' ? payload.sourceStart : undefined,
            sourceEnd: typeof payload.sourceEnd === 'number' ? payload.sourceEnd : undefined,
            selectorHint: typeof payload.selectorHint === 'string' ? payload.selectorHint : undefined,
          });
        }
        return;
      }

      // --- Nudge ---
      if (type === NUDGE_MESSAGE_TYPE) {
        const payload = data as {
          sourceFile?: unknown;
          selection?: unknown;
          deltaX?: unknown;
          deltaY?: unknown;
        };
        const selection = readEditorSelection(payload.selection, payload.sourceFile);
        if (
          selection &&
          typeof payload.deltaX === 'number' &&
          typeof payload.deltaY === 'number' &&
          Number.isFinite(payload.deltaX) &&
          Number.isFinite(payload.deltaY)
        ) {
          onEditorNudge?.(selection, payload.deltaX, payload.deltaY);
        }
        return;
      }

      // --- Reorder ---
      if (type === REORDER_MESSAGE_TYPE) {
        const payload = data as {
          sourceFile?: unknown;
          selection?: unknown;
          reference?: unknown;
          placement?: unknown;
        };
        const selection = readEditorSelection(payload.selection, payload.sourceFile);
        const reference = readEditorReorderTarget(payload.reference);
        if (
          selection &&
          reference &&
          (payload.placement === 'before' || payload.placement === 'after')
        ) {
          void onEditorReorder?.(selection, reference, payload.placement);
        }
        return;
      }

      // --- Navigation ---
      if (type !== NAV_MESSAGE_TYPE) return;
      const href = (data as { href?: unknown }).href;
      const sourceFile = (data as { sourceFile?: unknown }).sourceFile;
      if (typeof href !== 'string' || typeof sourceFile !== 'string') return;
      const r = resolveAgainst(sourceFile, href);
      if (r.isRemote || !r.resolvedPath) return;
      const index = previewRef.current;
      if (!index) return;
      const target = index.urls.get(r.resolvedPath);
      if (!target) return;
      navigateToPage(r.resolvedPath);
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigateToPage, onPreviewTextEdit, onEditorNudge, onEditorReorder, onSelectElement]);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    preview, previewBuilding, previewKey, currentPagePath, previewRuntimeDiagnostics,
    previewViewport, previewZoom, previewHistory, previewFullscreen, previewMode,
    editorSelection, editorClearSelectionSignal, editorBusy, editorError,
    previewRef, currentPagePathRef,
    navigateToPage, handleNavigateBack, handleNavigateForward,
    handleChangeViewport, handleChangeZoom, handleToggleFullscreen, handleExitFullscreen,
    handleChangePreviewMode, handleOpenInNewTab, handleRefreshPreview,
    setPreviewKey, setCurrentPagePath, setPreviewRuntimeDiagnostics,
    setEditorSelection, setEditorClearSelectionSignal, setEditorBusy, setEditorError,
  };
}

// ---------------------------------------------------------------------------
// Utility helpers (moved from App.tsx)
// ---------------------------------------------------------------------------

function formatPreviewRuntimeError(message: string, detail: string, sourceFile: string): string {
  const cleanMessage = message.trim().slice(0, 300) || 'Unknown preview runtime error';
  const cleanDetail = detail.trim().replace(/\s+/g, ' ').slice(0, 500);
  const source = sourceFile.trim() || 'preview';
  return `${source}: ${cleanMessage}${cleanDetail && cleanDetail !== cleanMessage ? ` \u2014 ${cleanDetail}` : ''}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readEditorSelection(value: unknown, sourceFileHint: unknown): EditorSelection | null {
  if (!isObjectRecord(value)) return null;
  const kind = value.kind;
  const sourceFile = typeof value.sourceFile === 'string'
    ? value.sourceFile
    : typeof sourceFileHint === 'string'
      ? sourceFileHint
      : null;
  if (
    sourceFile === null ||
    (kind !== 'text' && kind !== 'image' && kind !== 'element') ||
    typeof value.tagName !== 'string' ||
    typeof value.label !== 'string'
  ) {
    return null;
  }
  return {
    sourceFile,
    kind,
    tagName: value.tagName,
    label: value.label,
    text: typeof value.text === 'string' ? value.text : undefined,
    src: typeof value.src === 'string' ? value.src : undefined,
    alt: typeof value.alt === 'string' ? value.alt : undefined,
    href: typeof value.href === 'string' ? value.href : undefined,
    target: typeof value.target === 'string' ? value.target : undefined,
    rel: typeof value.rel === 'string' ? value.rel : undefined,
    title: typeof value.title === 'string' ? value.title : undefined,
    elementId: typeof value.elementId === 'string' ? value.elementId : undefined,
    className: typeof value.className === 'string' ? value.className : undefined,
    style: typeof value.style === 'string' ? value.style : undefined,
    role: typeof value.role === 'string' ? value.role : undefined,
    ariaLabel: typeof value.ariaLabel === 'string' ? value.ariaLabel : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    inputType: typeof value.inputType === 'string' ? value.inputType : undefined,
    value: typeof value.value === 'string' ? value.value : undefined,
    placeholder: typeof value.placeholder === 'string' ? value.placeholder : undefined,
    sourceStart: typeof value.sourceStart === 'number' ? value.sourceStart : undefined,
    sourceEnd: typeof value.sourceEnd === 'number' ? value.sourceEnd : undefined,
    hasElementChildren: typeof value.hasElementChildren === 'boolean' ? value.hasElementChildren : undefined,
    selectorHint: typeof value.selectorHint === 'string' ? value.selectorHint : undefined,
  };
}

function readEditorReorderTarget(value: unknown): EditorReorderTarget | undefined {
  if (!isObjectRecord(value)) return undefined;
  if (typeof value.tagName !== 'string' || typeof value.label !== 'string') return undefined;
  return {
    tagName: value.tagName,
    label: value.label,
    sourceStart: typeof value.sourceStart === 'number' ? value.sourceStart : undefined,
    sourceEnd: typeof value.sourceEnd === 'number' ? value.sourceEnd : undefined,
    selectorHint: typeof value.selectorHint === 'string' ? value.selectorHint : undefined,
  };
}
