import { formatBytes, isTextSourcePath } from './fileTypes';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * Hard onboarding limits. Callers may pass a complete override in tests or in
 * a future deployment-specific policy, but every intake path uses this shape.
 */
export interface ArchiveLimits {
  /** Bytes in the uploaded ZIP/TAR/TGZ container before parsing. */
  maxInputBytes: number;
  /** ZIP/TAR/filesystem records, including directories and metadata records. */
  maxEntries: number;
  /** Sum of expanded file bytes (or streamed TGZ output). */
  maxExpandedBytes: number;
  /** Maximum aggregate or individual compression expansion ratio. */
  maxCompressionRatio: number;
  /** Ignore ratio checks below this expanded size to avoid tiny-file noise. */
  compressionRatioFloorBytes: number;
  /** Maximum size of one source file that scanners may decode as text. */
  maxTextSourceBytes: number;
  /** UTF-8 byte limits, chosen to remain portable across common filesystems. */
  maxPathBytes: number;
  maxPathSegmentBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxInputBytes: 512 * MIB,
  maxEntries: 20_000,
  maxExpandedBytes: GIB,
  maxCompressionRatio: 200,
  compressionRatioFloorBytes: MIB,
  maxTextSourceBytes: 16 * MIB,
  maxPathBytes: 1_024,
  maxPathSegmentBytes: 255,
});

export type ArchiveLimitCode =
  | 'input-bytes'
  | 'entries'
  | 'expanded-bytes'
  | 'compression-ratio'
  | 'text-source-bytes'
  | 'path-bytes'
  | 'path-segment-bytes';

export class ArchiveLimitError extends Error {
  readonly name = 'ArchiveLimitError';

  constructor(readonly code: ArchiveLimitCode, message: string) {
    super(message);
  }
}

export function assertArchiveInputSize(
  bytes: number,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
  if (bytes <= limits.maxInputBytes) return;
  throw new ArchiveLimitError(
    'input-bytes',
    `The archive is ${formatBytes(bytes)}; the input limit is ${formatBytes(limits.maxInputBytes)}.`,
  );
}

export function assertArchiveEntryCount(
  count: number,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
  if (count <= limits.maxEntries) return;
  throw new ArchiveLimitError(
    'entries',
    `The project contains more than ${limits.maxEntries.toLocaleString('en-US')} archive entries.`,
  );
}

export function assertExpandedSize(
  bytes: number,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
  if (bytes <= limits.maxExpandedBytes) return;
  throw new ArchiveLimitError(
    'expanded-bytes',
    `The project expands beyond the ${formatBytes(limits.maxExpandedBytes)} limit.`,
  );
}

export function assertCompressionRatio(
  expandedBytes: number,
  compressedBytes: number,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
  if (expandedBytes < limits.compressionRatioFloorBytes) return;
  const ratio = compressedBytes > 0 ? expandedBytes / compressedBytes : Number.POSITIVE_INFINITY;
  if (ratio <= limits.maxCompressionRatio) return;
  const actual = Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : 'unbounded';
  throw new ArchiveLimitError(
    'compression-ratio',
    `The archive expands at ${actual}; the compression-ratio limit is ${limits.maxCompressionRatio}×.`,
  );
}

export function assertTextSourceSize(
  path: string,
  bytes: number,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
  if (!isTextSourcePath(path) || bytes <= limits.maxTextSourceBytes) return;
  throw new ArchiveLimitError(
    'text-source-bytes',
    `Text source "${abbreviatePath(path)}" is ${formatBytes(bytes)}; the per-source limit is ${formatBytes(limits.maxTextSourceBytes)}.`,
  );
}

export function assertArchivePath(
  path: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
  const pathBytes = utf8Bytes(path);
  if (pathBytes > limits.maxPathBytes) {
    throw new ArchiveLimitError(
      'path-bytes',
      `Archive path "${abbreviatePath(path)}" is ${pathBytes.toLocaleString('en-US')} UTF-8 bytes; the limit is ${limits.maxPathBytes.toLocaleString('en-US')}.`,
    );
  }
  for (const segment of path.split('/')) {
    const segmentBytes = utf8Bytes(segment);
    if (segmentBytes <= limits.maxPathSegmentBytes) continue;
    throw new ArchiveLimitError(
      'path-segment-bytes',
      `Path segment "${abbreviatePath(segment)}" is ${segmentBytes.toLocaleString('en-US')} UTF-8 bytes; the limit is ${limits.maxPathSegmentBytes.toLocaleString('en-US')}.`,
    );
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function abbreviatePath(path: string): string {
  if (path.length <= 120) return path;
  return `${path.slice(0, 56)}…${path.slice(-56)}`;
}
