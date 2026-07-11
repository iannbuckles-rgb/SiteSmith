import { describe, expect, it } from 'vitest';

import { buildReport } from '../src/lib/exportService';
import {
  missingDetection,
  placeholderPatchFor,
  remoteDetection,
  removePatchFor,
  section,
} from './helpers';

describe('exportService.buildReport', () => {
  it('does not report a removed-then-missing image as remaining missing', () => {
    const detection = missingDetection(0, {
      rawUrl: 'images/removed.png',
      resolvedPath: 'images/removed.png',
      sourceFile: 'index.html',
    });
    const report = buildReport([removePatchFor(detection)], [detection]);

    expect(section(report, 'Remaining missing assets')).not.toContain('images/removed.png');
    expect(section(report, 'Image references removed')).toContain('images/removed.png');
  });

  it('does not report a placeholder-converted image as remaining missing', () => {
    const detection = missingDetection(1, {
      rawUrl: 'images/placeholder.png',
      resolvedPath: 'images/placeholder.png',
      sourceFile: 'index.html',
    });
    const report = buildReport([placeholderPatchFor(detection)], [detection]);

    expect(section(report, 'Remaining missing assets')).not.toContain('images/placeholder.png');
    expect(section(report, 'Image references replaced with placeholders')).toContain('images/placeholder.png');
  });

  it('respects broken, remote, and removed list caps', () => {
    const missing = Array.from({ length: 55 }, (_, index) => missingDetection(index));
    const remote = Array.from({ length: 35 }, (_, index) => remoteDetection(index));
    const removed = Array.from({ length: 52 }, (_, index) => removePatchFor(missingDetection(index), index));
    const report = buildReport(removed, [...missing, ...remote]);

    expect(section(report, 'Broken images detected')).toContain('and 5 more');
    expect(section(report, 'Remaining remote dependencies')).toContain('and 5 more');
    expect(section(report, 'Image references removed')).toContain('and 2 more');
  });
});
