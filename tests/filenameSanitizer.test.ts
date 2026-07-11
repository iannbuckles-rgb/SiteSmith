import { describe, expect, it, vi } from 'vitest';

import { sanitizeFilename, uniqueAssetPath } from '../src/lib/filenameSanitizer';

describe('filenameSanitizer', () => {
  it('strips unsafe characters, accents, and directory components', () => {
    expect(sanitizeFilename('../Uploads/Creme Logo (Final)!.PNG')).toBe('creme-logo-final.png');
    expect(sanitizeFilename('..\\..\\secret.svg')).toBe('secret.svg');
    expect(sanitizeFilename('../../.env')).toBe('env');
  });

  it('uses a deterministic safe fallback when the base name is empty', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    vi.spyOn(Math, 'random').mockReturnValue(0.123456);

    expect(sanitizeFilename('!!.png')).toBe('image-04fzy.png');

    vi.restoreAllMocks();
  });
});

describe('uniqueAssetPath', () => {
  it('suffixes collisions case-insensitively', () => {
    expect(uniqueAssetPath('logo.png', [
      'assets/mockups/Logo.PNG',
      'assets/mockups/logo-1.png',
    ])).toBe('assets/mockups/logo-2.png');
  });

  it('neutralizes traversal even when called with an unsanitized name', () => {
    expect(uniqueAssetPath('../evil image.png', [])).toBe('assets/mockups/evil-image.png');
  });
});
