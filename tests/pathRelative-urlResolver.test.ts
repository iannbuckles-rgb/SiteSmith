import { describe, expect, it } from 'vitest';

import { pathRelative } from '../src/lib/pathRelative';
import { classifyUrl, parseSrcset, resolveAgainst } from '../src/lib/urlResolver';

describe('pathRelative', () => {
  it('computes root, sibling, parent, and nested references', () => {
    expect(pathRelative('index.html', 'assets/mockups/logo.png')).toBe('./assets/mockups/logo.png');
    expect(pathRelative('pages/about.html', 'pages/team.png')).toBe('./team.png');
    expect(pathRelative('pages/about.html', 'assets/mockups/logo.png')).toBe('../assets/mockups/logo.png');
    expect(pathRelative('pages/company/about.html', 'pages/assets/logo.png')).toBe('../assets/logo.png');
  });

  it('preserves query and hash suffixes when present on the target string', () => {
    expect(pathRelative('pages/about.html', 'assets/hero.png?v=2#top')).toBe('../assets/hero.png?v=2#top');
  });
});

describe('urlResolver', () => {
  it('resolves relative, root, sibling, and nested project paths', () => {
    expect(resolveAgainst('pages/about.html', '../images/hero.png')).toMatchObject({
      isRemote: false,
      resolvedPath: 'images/hero.png',
    });
    expect(resolveAgainst('pages/about.html', '/images/logo.png')).toMatchObject({
      isRemote: false,
      resolvedPath: 'images/logo.png',
    });
    expect(resolveAgainst('pages/about.html', 'team.png')).toMatchObject({
      isRemote: false,
      resolvedPath: 'pages/team.png',
    });
    expect(resolveAgainst('pages/company/about.html', '../images/team.png')).toMatchObject({
      isRemote: false,
      resolvedPath: 'pages/images/team.png',
    });
  });

  it('preserves query/hash separately from the zip path', () => {
    expect(resolveAgainst('pages/about.html', '../images/hero.png?v=2#top')).toEqual({
      isRemote: false,
      resolvedPath: 'images/hero.png',
      suffix: '?v=2#top',
    });
  });

  it('passes remote and special URLs through as remote', () => {
    for (const ref of [
      'https://example.com/logo.png',
      'http://example.com/logo.png',
      '//cdn.example.com/logo.png',
      'data:image/png;base64,abc',
      'javascript:alert(1)',
      'mailto:test@example.com',
      'tel:5551212',
    ]) {
      expect(classifyUrl(ref)).toBe('remote');
      expect(resolveAgainst('index.html', ref)).toMatchObject({ isRemote: true, resolvedPath: '' });
    }
  });

  it('parses srcset candidates without descriptors', () => {
    expect(parseSrcset('small.png 480w, medium.png 1x, large.png 2x,')).toEqual([
      'small.png',
      'medium.png',
      'large.png',
    ]);
  });
});
