import { describe, expect, it } from 'vitest';

import { detectImages } from '../src/lib/imageDetector';
import { makeProject } from './helpers';

describe('imageDetector', () => {
  it('detects HTML, CSS, srcset, manifest, missing, and remote image refs', async () => {
    const project = makeProject({
      'index.html': [
        '<img src="images/logo.png">',
        '<img src="images/missing.png">',
        '<img srcset="images/small.png 1x, https://cdn.example.com/remote.jpg 2x">',
        '<link rel="icon" href="/favicon.ico">',
        '<meta property="og:image" content="https://example.com/social.png">',
      ].join(''),
      'styles/site.css': [
        '.hero{background:url("../images/hero.png")}',
        '@font-face{src:url("../fonts/site.woff2")}',
        '.skip{background:url(data:image/png;base64,abc)}',
      ].join(''),
      'manifest.json': JSON.stringify({ icons: [{ src: 'icons/app.png', sizes: '192x192' }] }),
      'images/logo.png': new Uint8Array([1]),
      'images/small.png': new Uint8Array([2]),
      'images/hero.png': new Uint8Array([3]),
      'favicon.ico': new Uint8Array([4]),
      'icons/app.png': new Uint8Array([5]),
      'fonts/site.woff2': new Uint8Array([6]),
    });

    const detections = await detectImages(project.zip, project.entries);
    const byRaw = new Map(detections.map((detection) => [detection.rawUrl, detection]));

    expect(byRaw.get('images/logo.png')).toMatchObject({ status: 'ok', resolvedPath: 'images/logo.png' });
    expect(byRaw.get('images/missing.png')).toMatchObject({ status: 'missing', resolvedPath: 'images/missing.png' });
    expect(byRaw.get('images/small.png')).toMatchObject({ status: 'ok', sourceAttr: 'srcset' });
    expect(byRaw.get('../images/hero.png')).toMatchObject({ status: 'ok', resolvedPath: 'images/hero.png' });
    expect(byRaw.get('/favicon.ico')).toMatchObject({ status: 'ok', type: 'favicon' });
    expect(byRaw.get('icons/app.png')).toMatchObject({ status: 'ok', sourceKind: 'manifest' });
    expect(byRaw.get('https://cdn.example.com/remote.jpg')).toMatchObject({ status: 'remote', riskReason: 'cdn' });
    expect(byRaw.get('https://example.com/social.png')).toMatchObject({ status: 'remote', riskReason: 'cross-origin-http' });
    expect(detections.some((detection) => detection.rawUrl.includes('woff2'))).toBe(false);
    expect(detections.some((detection) => detection.rawUrl.startsWith('data:'))).toBe(false);
  });

  it('uses DOM parsing for multiline HTML and skips commented or inert images', async () => {
    const project = makeProject({
      'index.html': [
        '<main>',
        '<!-- Builder kept the original asset here: <img src="images/commented.png"> -->',
        '<img',
        '  class="hero"',
        '  title="2 > 1 in the sale badge"',
        '  src="images/hero.png"',
        '  alt="Hero"',
        '>',
        '<template id="product-card">',
        '  <img src="images/template-product.png" alt="Template product">',
        '</template>',
        '<noscript><img src="images/noscript-fallback.png" alt="No script"></noscript>',
        '<picture>',
        '  <source',
        '    media="(min-width: 900px)"',
        '    srcset="images/wide.png 1x, images/wide@2x.png 2x"',
        '  >',
        '  <img src="images/fallback.png" alt="Fallback">',
        '</picture>',
        '</main>',
      ].join('\n'),
      'images/hero.png': new Uint8Array([1]),
      'images/wide.png': new Uint8Array([2]),
      'images/wide@2x.png': new Uint8Array([3]),
      'images/fallback.png': new Uint8Array([4]),
    });

    const detections = await detectImages(project.zip, project.entries);
    const raws = detections.map((detection) => detection.rawUrl);

    expect(raws).toEqual(expect.arrayContaining([
      'images/hero.png',
      'images/wide.png',
      'images/wide@2x.png',
      'images/fallback.png',
    ]));
    expect(raws).not.toEqual(expect.arrayContaining([
      'images/commented.png',
      'images/template-product.png',
      'images/noscript-fallback.png',
    ]));
  });

  it('ignores CSS url() references inside block comments', async () => {
    const project = makeProject({
      'styles/site.css': [
        '/* Webflow backup:',
        '   .hero { background-image: url("../images/commented-hero.png"); }',
        '*/',
        '.hero { background-image: url("../images/hero.png"); }',
      ].join('\n'),
      'images/hero.png': new Uint8Array([1]),
    });

    const detections = await detectImages(project.zip, project.entries);
    const raws = detections.map((detection) => detection.rawUrl);

    expect(raws).toContain('../images/hero.png');
    expect(raws).not.toContain('../images/commented-hero.png');
  });

  it('stops detection with AbortError when the onboarding signal is canceled', async () => {
    const project = makeProject({
      'index.html': '<img src="images/hero.png">',
      'images/hero.png': new Uint8Array([1]),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      detectImages(project.zip, project.entries, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('detects lazy attrs, posters, inline styles, SVG image hrefs, and richer manifest resources', async () => {
    const project = makeProject({
      'index.html': [
        '<img data-src="images/lazy.png" data-srcset="images/lazy-small.png 1x, images/lazy-large.png 2x">',
        '<video poster="images/poster.jpg"></video>',
        '<section style="background-image:url(\'images/inline-bg.webp\')"></section>',
        '<input type="image" src="images/input-icon.svg">',
        '<svg><image href="images/svg-photo.png"></image></svg>',
        '<link rel="preload" as="image" href="images/preload.avif">',
        '<meta name="twitter:image" content="images/social.jpg">',
        '<img src="data:image/png;base64,abc">',
      ].join(''),
      'manifest.webmanifest': JSON.stringify({
        icons: [{ src: 'images/app-icon.png', sizes: '192x192' }],
        screenshots: [{ src: 'images/screenshot.png', sizes: '1280x720' }],
        shortcuts: [{ name: 'Open', icons: [{ src: 'images/shortcut.png', sizes: '96x96' }] }],
      }),
      'images/lazy.png': new Uint8Array([1]),
      'images/lazy-small.png': new Uint8Array([2]),
      'images/lazy-large.png': new Uint8Array([3]),
      'images/poster.jpg': new Uint8Array([4]),
      'images/inline-bg.webp': new Uint8Array([5]),
      'images/input-icon.svg': new Uint8Array([6]),
      'images/svg-photo.png': new Uint8Array([7]),
      'images/preload.avif': new Uint8Array([8]),
      'images/social.jpg': new Uint8Array([9]),
      'images/app-icon.png': new Uint8Array([10]),
      'images/screenshot.png': new Uint8Array([11]),
      'images/shortcut.png': new Uint8Array([12]),
    });

    const detections = await detectImages(project.zip, project.entries);
    const byRaw = new Map(detections.map((detection) => [detection.rawUrl, detection]));

    expect(byRaw.get('images/lazy.png')).toMatchObject({ sourceTag: 'img', sourceAttr: 'data-src', status: 'ok' });
    expect(byRaw.get('images/lazy-large.png')).toMatchObject({ sourceTag: 'img', sourceAttr: 'data-srcset', status: 'ok' });
    expect(byRaw.get('images/poster.jpg')).toMatchObject({ sourceTag: 'video', sourceAttr: 'poster', type: 'hero' });
    expect(byRaw.get('images/inline-bg.webp')).toMatchObject({ sourceTag: 'section', sourceAttr: 'style', extra: { cssProperty: 'background-image' } });
    expect(byRaw.get('images/input-icon.svg')).toMatchObject({ sourceTag: 'input', sourceAttr: 'src', type: 'icon' });
    expect(byRaw.get('images/svg-photo.png')).toMatchObject({ sourceTag: 'image', sourceAttr: 'href' });
    expect(byRaw.get('images/preload.avif')).toMatchObject({ sourceTag: 'link', sourceAttr: 'href', extra: { rel: 'preload' } });
    expect(byRaw.get('images/social.jpg')).toMatchObject({ sourceTag: 'meta', sourceAttr: 'content', type: 'social' });
    expect(byRaw.get('images/app-icon.png')).toMatchObject({ sourceKind: 'manifest', sourceTag: 'icon', extra: { manifestPath: 'icons.0.src' } });
    expect(byRaw.get('images/screenshot.png')).toMatchObject({ sourceKind: 'manifest', sourceTag: 'screenshot', extra: { manifestPath: 'screenshots.0.src' } });
    expect(byRaw.get('images/shortcut.png')).toMatchObject({ sourceKind: 'manifest', sourceTag: 'shortcut-icon', extra: { manifestPath: 'shortcuts.0.icons.0.src' } });
    expect(detections.some((detection) => detection.rawUrl.startsWith('data:'))).toBe(false);
  });
});
