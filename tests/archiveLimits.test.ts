import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ARCHIVE_LIMITS,
  assertArchiveEntryCount,
  assertArchiveInputSize,
  assertArchivePath,
  assertCompressionRatio,
  assertExpandedSize,
  assertTextSourceSize,
  type ArchiveLimits,
} from '../src/lib/archiveLimits';

function limits(overrides: Partial<ArchiveLimits>): ArchiveLimits {
  return { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
}

describe('archive resource policy', () => {
  it('keeps the production limits explicit and stable', () => {
    expect(DEFAULT_ARCHIVE_LIMITS).toEqual({
      maxInputBytes: 512 * 1024 * 1024,
      maxEntries: 20_000,
      maxExpandedBytes: 1024 * 1024 * 1024,
      maxCompressionRatio: 200,
      compressionRatioFloorBytes: 1024 * 1024,
      maxTextSourceBytes: 16 * 1024 * 1024,
      maxPathBytes: 1_024,
      maxPathSegmentBytes: 255,
    });
  });

  it('allows values exactly at each inclusive boundary', () => {
    const policy = limits({
      maxInputBytes: 10,
      maxEntries: 2,
      maxExpandedBytes: 20,
      compressionRatioFloorBytes: 1,
      maxCompressionRatio: 2,
      maxTextSourceBytes: 5,
      maxPathBytes: 10,
      maxPathSegmentBytes: 10,
    });

    expect(() => assertArchiveInputSize(10, policy)).not.toThrow();
    expect(() => assertArchiveEntryCount(2, policy)).not.toThrow();
    expect(() => assertExpandedSize(20, policy)).not.toThrow();
    expect(() => assertCompressionRatio(20, 10, policy)).not.toThrow();
    expect(() => assertTextSourceSize('a.js', 5, policy)).not.toThrow();
    expect(() => assertArchivePath('1234567890', policy)).not.toThrow();
  });

  it('measures paths in UTF-8 bytes and ignores binary files for the text cap', () => {
    const policy = limits({ maxPathBytes: 4, maxPathSegmentBytes: 4, maxTextSourceBytes: 1 });
    expect(() => assertArchivePath('éé', policy)).not.toThrow();
    expect(() => assertArchivePath('ééa', policy)).toThrowError(/UTF-8 bytes/i);
    expect(() => assertTextSourceSize('video.mp4', 10_000, policy)).not.toThrow();
  });
});
