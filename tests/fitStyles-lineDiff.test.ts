import { describe, expect, it } from 'vitest';

import {
  applyFitStyleToCss,
  applyFitStyleToImg,
  canApplyFitStyle,
  canOverlay,
  describeGeneratedCss,
} from '../src/lib/fitStyles';
import { computeDiffStats, lineDiff } from '../src/lib/lineDiff';
import type { ImageFitConfig } from '../src/types';
import { cssUrlDetection, htmlImgDetection } from './helpers';

const config: ImageFitConfig = {
  fit: 'cover',
  position: 'center',
  borderRadius: 'medium',
  overlay: 'medium',
};

describe('fitStyles', () => {
  it('merges img styles idempotently while preserving unrelated styles', () => {
    const detection = htmlImgDetection({ rawUrl: 'hero.png' });
    const source = '<img src="hero.png" style="color:red;object-fit:contain;border:0">';

    const first = applyFitStyleToImg(source, detection, config);
    const second = applyFitStyleToImg(first.sourceText, detection, config);

    expect(canApplyFitStyle(detection)).toBe(true);
    expect(canOverlay(detection)).toBe(false);
    expect(second.sourceText).toContain('color:red');
    expect(second.sourceText).toContain('border:0');
    expect(second.sourceText.match(/object-fit:/g)).toHaveLength(1);
    expect(second.sourceText).toContain('object-fit:cover');
    expect(second.sourceText).toContain('object-position:center');
    expect(second.sourceText).toContain('border-radius:8px');
  });

  it('rewrites CSS background fit styles idempotently with overlay support', () => {
    const detection = cssUrlDetection({
      rawUrl: '../images/hero.png',
      extra: { cssProperty: 'background' },
    });
    const source = '.hero{background:url("../images/hero.png");background-size:contain;color:white;}';

    const first = applyFitStyleToCss(source, detection, config);
    const second = applyFitStyleToCss(first.sourceText, detection, config);

    expect(canApplyFitStyle(detection)).toBe(true);
    expect(canOverlay(detection)).toBe(true);
    expect(second.sourceText.match(/background-size:/g)).toHaveLength(1);
    expect(second.sourceText).toContain('background-size:cover');
    expect(second.sourceText).toContain('background-position:center');
    expect(second.sourceText).toContain('box-shadow:inset 0 0 0 1000px rgba(0,0,0,0.55)');
    expect(describeGeneratedCss(detection, config)).toContain('box-shadow:inset');
  });
});

describe('lineDiff', () => {
  it('reports compressed hunks with line-accurate stats', () => {
    const hunks = lineDiff('a\nb\nc', 'a\nB\nc\nd');

    expect(hunks).toEqual([
      { type: 'context', line: 'a' },
      { type: 'remove', line: 'b' },
      { type: 'add', line: 'B' },
      { type: 'context', line: 'c' },
      { type: 'add', line: 'd' },
    ]);
    expect(computeDiffStats(hunks)).toEqual({
      additions: 2,
      deletions: 1,
      contexts: 2,
    });
  });
});
