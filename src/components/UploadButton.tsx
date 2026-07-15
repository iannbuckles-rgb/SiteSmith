import { useCallback, useRef, useState, type DragEvent } from 'react';

import { PROJECT_FILE_ACCEPT } from '../lib/fileTypes';
import { normalizeDataTransfer, normalizeFileList } from '../lib/projectInput';
import { UploadIcon } from './FileIcon';

interface UploadButtonProps {
  /** Receives a ready-to-parse `.zip` File — for TAR/folders/loose files this
   *  is packed in-memory before the callback fires. */
  onFile: (file: File) => void;
  disabled?: boolean;
}

export function UploadButton({ onFile, disabled = false }: UploadButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [packing, setPacking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const busy = disabled || packing;

  const run = useCallback(
    async (produce: () => Promise<{ file: File }>) => {
      setLocalError(null);
      setPacking(true);
      try {
        const { file } = await produce();
        onFile(file);
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'Could not read that selection.');
      } finally {
        setPacking(false);
      }
    },
    [onFile],
  );

  const pickFiles = useCallback(() => {
    if (busy) return;
    fileInputRef.current?.click();
  }, [busy]);

  const pickFolder = useCallback(() => {
    if (busy) return;
    folderInputRef.current?.click();
  }, [busy]);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) void run(() => normalizeFileList(files));
      // reset so re-selecting the same file(s) fires onChange again
      e.target.value = '';
    },
    [run],
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (busy) return;
      const dt = e.dataTransfer;
      if (dt && (dt.items?.length || dt.files?.length)) void run(() => normalizeDataTransfer(dt));
    },
    [busy, run],
  );

  const handleDragOver = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (!busy) setDragOver(true);
    },
    [busy],
  );

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={PROJECT_FILE_ACCEPT}
        onChange={handleFileInput}
        className="sr-only"
        data-testid="zip-input"
      />
      <input
        // Directory picker. `webkitdirectory` isn't in React's typed attribute
        // set, so it's applied via a callback ref instead of a JSX prop.
        ref={(el) => el?.setAttribute('webkitdirectory', '')}
        type="file"
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) void run(() => normalizeFileList(files));
          e.target.value = '';
        }}
        className="sr-only"
        data-testid="folder-input"
      />
      <div
        role="button"
        tabIndex={0}
        aria-disabled={busy}
        aria-busy={packing}
        onClick={pickFiles}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pickFiles();
          }
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        className={`group relative flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-4 text-center transition-colors ${
          dragOver
            ? 'border-violet-400 bg-violet-500/10'
            : 'border-zinc-700 bg-zinc-900/60 hover:border-zinc-500 hover:bg-zinc-900'
        } ${busy ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        <div className="rounded-full bg-zinc-800 p-2 text-violet-300 ring-1 ring-zinc-700 group-hover:bg-violet-500/15">
          {packing ? (
            <span
              className="block h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-violet-300"
              aria-hidden="true"
            />
          ) : (
            <UploadIcon />
          )}
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-100">
            {packing ? 'Packaging project…' : 'Upload a website'}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Drop a <span className="font-medium text-zinc-400">ZIP / TAR</span>, a project{' '}
            <span className="font-medium text-zinc-400">folder</span>, or its files
          </p>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            pickFolder();
          }}
          disabled={busy}
          className="mt-0.5 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          data-testid="folder-pick"
        >
          Choose a folder instead
        </button>
      </div>
      {localError && (
        <p role="alert" className="mt-2 text-xs text-rose-300" data-testid="upload-error">
          {localError}
        </p>
      )}
    </div>
  );
}
