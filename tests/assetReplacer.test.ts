import { describe, expect, it } from 'vitest';

import {
  applyPlaceholder,
  applyRemove,
  applyReplacement,
  canPlaceholder,
  canRemove,
  canReplace,
} from '../src/lib/assetReplacer';
import { undoPatchById } from '../src/lib/undoStack';
import type { AppliedPatch, ImageDetection, LoadedProject } from '../src/types';
import {
  cssUrlDetection,
  htmlImgDetection,
  makeProject,
  zipBytes,
  zipText,
} from './helpers';

describe('assetReplacer applyReplacement', () => {
  it('rewrites only the matching HTML tag, attribute, and URL', async () => {
    const source = [
      '<main>',
      '<img class="hero" src="images/hero.png" data-src="images/hero.png" alt="Hero">',
      '<a href="images/hero.png">Hero asset</a>',
      '<img src="images/other.png" alt="Other">',
      '</main>',
    ].join('');
    const project = makeProject({
      'index.html': source,
      'images/hero.png': new Uint8Array([0]),
    });

    const patch = await applyReplacement(project, htmlImgDetection(), {
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'Hero Replacement.PNG',
    });

    const html = await zipText(project, 'index.html');
    expect(html).toContain('src="./assets/mockups/hero-replacement.png"');
    expect(html).toContain('data-src="images/hero.png"');
    expect(html).toContain('<a href="images/hero.png">Hero asset</a>');
    expect(html).toContain('<img src="images/other.png" alt="Other">');
    expect(await zipBytes(project, 'assets/mockups/hero-replacement.png')).toEqual(new Uint8Array([1, 2, 3]));
    await expectUndoRestores(project, patch, 'index.html', source);
  });

  it('rewrites multiline HTML tags with quoted angle brackets and skips comments', async () => {
    const source = [
      '<main>',
      '<!-- Builder backup: <img src="images/hero.png" alt="Old hero"> -->',
      '<img',
      '  class="hero"',
      '  title="2 > 1 badge"',
      '  src="images/hero.png"',
      '  alt="Hero"',
      '/>',
      '</main>',
    ].join('\n');
    const project = makeProject({
      'index.html': source,
      'images/hero.png': new Uint8Array([0]),
    });

    const patch = await applyReplacement(project, htmlImgDetection(), {
      bytes: new Uint8Array([7, 8]),
      filename: 'Hero Replacement.png',
    });

    const html = await zipText(project, 'index.html');
    expect(html).toContain('<!-- Builder backup: <img src="images/hero.png" alt="Old hero"> -->');
    expect(html).toContain('title="2 > 1 badge"');
    expect(html).toContain('src="./assets/mockups/hero-replacement.png"');
    await expectUndoRestores(project, patch, 'index.html', source);
  });

  it('rewrites icon link hrefs without touching non-icon links', async () => {
    const source = [
      '<head>',
      '<link rel="stylesheet" href="/favicon.ico">',
      '<link rel="icon" href="/favicon.ico" sizes="32x32" type="image/x-icon">',
      '<link rel="apple-touch-icon" href="/touch.png">',
      '</head>',
    ].join('');
    const project = makeProject({
      'index.html': source,
      'favicon.ico': new Uint8Array([0]),
      'touch.png': new Uint8Array([1]),
    });
    const detection: ImageDetection = {
      rawUrl: '/favicon.ico',
      resolvedPath: 'favicon.ico',
      type: 'favicon',
      status: 'ok',
      sourceKind: 'html',
      sourceFile: 'index.html',
      sourceTag: 'link',
      sourceAttr: 'href',
      extra: { rel: 'icon', sizes: '32x32' },
    };

    expect(canReplace(detection)).toBe(true);
    expect(canRemove(detection)).toBe(false);
    expect(canPlaceholder(detection)).toBe(false);

    const patch = await applyReplacement(project, detection, {
      bytes: new Uint8Array([6, 7]),
      filename: 'New Favicon.ICO',
    });

    const html = await zipText(project, 'index.html');
    expect(html).toContain('<link rel="stylesheet" href="/favicon.ico">');
    expect(html).toContain('<link rel="icon" href="./assets/mockups/new-favicon.ico" sizes="32x32" type="image/x-icon">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/touch.png">');
    expect(patch.sourceTag).toBe('link');
    expect(patch.sourceAttr).toBe('href');
    expect(patch.currentSourceValue).toBe('./assets/mockups/new-favicon.ico');
    expect(await zipBytes(project, 'assets/mockups/new-favicon.ico')).toEqual(new Uint8Array([6, 7]));
    await expectUndoRestores(project, patch, 'index.html', source);
  });

  it('rewrites only matching CSS url tokens and keeps unrelated URLs', async () => {
    const source = '.hero{background:url("../images/hero.png")} .other{background:url("../images/other.png")}';
    const project = makeProject({
      'styles/site.css': source,
      'images/hero.png': new Uint8Array([0]),
    });

    const patch = await applyReplacement(project, cssUrlDetection(), {
      bytes: new Uint8Array([4, 5]),
      filename: 'Hero Replacement.webp',
      reencoded: true,
    });

    const css = await zipText(project, 'styles/site.css');
    expect(css).toContain('url("../assets/mockups/hero-replacement.webp")');
    expect(css).toContain('url("../images/other.png")');
    expect(patch.previousSourceText).toBe(source);
    expect(patch.currentSourceValue).toBe('../assets/mockups/hero-replacement.webp');
    expect(patch.newAssetReencoded).toBe(true);
    await expectUndoRestores(project, patch, 'styles/site.css', source);
  });

  it('re-applies against the previous source value and preserves old replacement assets', async () => {
    const project = makeProject({
      'index.html': '<img src="images/hero.png" alt="Hero">',
      'images/hero.png': new Uint8Array([0]),
    });
    const detection = htmlImgDetection();

    const first = await applyReplacement(project, detection, {
      bytes: new Uint8Array([1]),
      filename: 'Hero.png',
    });
    const second = await applyReplacement(project, detection, {
      bytes: new Uint8Array([2]),
      filename: 'Hero.png',
      previousSourceValue: first.currentSourceValue,
    });

    const html = await zipText(project, 'index.html');
    expect(html).toContain('src="./assets/mockups/hero-1.png"');
    expect(await zipBytes(project, 'assets/mockups/hero.png')).toEqual(new Uint8Array([1]));
    expect(await zipBytes(project, 'assets/mockups/hero-1.png')).toEqual(new Uint8Array([2]));
    expect(second.previousSourceText).toContain('src="./assets/mockups/hero.png"');
  });

  it('does not rewrite CSS url() tokens inside block comments', async () => {
    const source = [
      '/* Builder backup: .hero{background:url("../images/hero.png")} */',
      '.hero{background:url("../images/hero.png")}',
    ].join('\n');
    const project = makeProject({
      'styles/site.css': source,
      'images/hero.png': new Uint8Array([0]),
    });

    const patch = await applyReplacement(project, cssUrlDetection(), {
      bytes: new Uint8Array([9]),
      filename: 'Hero Replacement.webp',
    });

    const css = await zipText(project, 'styles/site.css');
    expect(css).toContain('/* Builder backup: .hero{background:url("../images/hero.png")} */');
    expect(css).toContain('.hero{background:url("../assets/mockups/hero-replacement.webp")}');
    await expectUndoRestores(project, patch, 'styles/site.css', source);
  });
});

describe('assetReplacer destructive flows', () => {
  it('removes an HTML img tag and undo restores exact source text', async () => {
    const source = '<p>A</p><img class="hero" src="missing.png" alt="Missing"><span>B</span>';
    const project = makeProject({ 'index.html': source });

    const patch = await applyRemove(project, htmlImgDetection({
      rawUrl: 'missing.png',
      resolvedPath: 'missing.png',
      status: 'missing',
    }));

    const html = await zipText(project, 'index.html');
    expect(html).not.toContain('<img');
    expect(html).toContain('<p>A</p> <span>B</span>');
    await expectUndoRestores(project, patch, 'index.html', source);
  });

  it('strips url() from background shorthand while keeping color and position', async () => {
    const source = '.hero { background: #123 url("../missing.png") center / cover no-repeat; color: white; }';
    const project = makeProject({ 'styles/site.css': source });

    const patch = await applyRemove(project, cssUrlDetection({
      rawUrl: '../missing.png',
      resolvedPath: 'missing.png',
      status: 'missing',
    }));

    const css = await zipText(project, 'styles/site.css');
    expect(css).toContain('background: #123 center / cover no-repeat');
    expect(css).toContain('color: white');
    expect(css).not.toContain('url("../missing.png")');
    await expectUndoRestores(project, patch, 'styles/site.css', source);
  });

  it('drops background-image declarations when removing a CSS url', async () => {
    const source = '.hero { color: white; background-image: url("../missing.png"); background-size: cover; }';
    const project = makeProject({ 'styles/site.css': source });

    const patch = await applyRemove(project, cssUrlDetection({
      rawUrl: '../missing.png',
      resolvedPath: 'missing.png',
      status: 'missing',
      extra: { cssProperty: 'background-image' },
    }));

    const css = await zipText(project, 'styles/site.css');
    expect(css).toContain('color: white');
    expect(css).toContain('background-size: cover');
    expect(css).not.toContain('background-image');
    await expectUndoRestores(project, patch, 'styles/site.css', source);
  });

  it('leaves commented CSS urls untouched when removing a real declaration', async () => {
    const source = [
      '/* Backup rule: .hero { background: url("../missing.png"); } */',
      '.hero { background: #123 url("../missing.png") center / cover no-repeat; color: white; }',
    ].join('\n');
    const project = makeProject({ 'styles/site.css': source });

    const patch = await applyRemove(project, cssUrlDetection({
      rawUrl: '../missing.png',
      resolvedPath: 'missing.png',
      status: 'missing',
    }));

    const css = await zipText(project, 'styles/site.css');
    expect(css).toContain('/* Backup rule: .hero { background: url("../missing.png"); } */');
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('url("../missing.png")');
    await expectUndoRestores(project, patch, 'styles/site.css', source);
  });

  it('converts img tags to placeholders while preserving layout and accessible alt text', async () => {
    const source = '<img id="hero" class="hero fluid" src="missing.png" width="640" height="360" alt="Product shot">';
    const project = makeProject({ 'index.html': source });

    const patch = await applyPlaceholder(project, htmlImgDetection({
      rawUrl: 'missing.png',
      resolvedPath: 'missing.png',
      status: 'missing',
      type: 'hero',
    }));

    const html = await zipText(project, 'index.html');
    expect(html).toContain('<div');
    expect(html).toContain('class="hero fluid mockswap-placeholder"');
    expect(html).toContain('id="hero"');
    expect(html).toContain('width="640"');
    expect(html).toContain('height="360"');
    expect(html).toContain('aria-label="Product shot"');
    expect(html).toContain('Hero Image');
    await expectUndoRestores(project, patch, 'index.html', source);
  });
});

async function expectUndoRestores(
  project: LoadedProject,
  patch: AppliedPatch,
  sourceFile: string,
  original: string,
): Promise<void> {
  if (!('previousSourceText' in patch)) throw new Error('Expected single-file patch');
  expect(patch.previousSourceText).toBe(original);
  undoPatchById(project, patch);
  expect(await zipText(project, sourceFile)).toBe(original);
  if (patch.action === 'replace') {
    expect(project.zip.file(patch.newAssetPath)).toBeNull();
  }
}
