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
});
