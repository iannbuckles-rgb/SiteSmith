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
        '.responsive{background-image:image-set(url("../images/hero.png") 1x, "../images/hero.jxl" 2x)}',
        '@font-face{src:url("../fonts/site.woff2")}',
        '.skip{background:url(data:image/png;base64,abc)}',
      ].join(''),
      'manifest.json': JSON.stringify({ icons: [{ src: 'icons/app.png', sizes: '192x192' }] }),
      'images/logo.png': new Uint8Array([1]),
      'images/small.png': new Uint8Array([2]),
      'images/hero.png': new Uint8Array([3]),
      'images/hero.jxl': new Uint8Array([7]),
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
    expect(byRaw.get('../images/hero.jxl')).toMatchObject({ status: 'ok', sourceTag: 'image-set', sourceAttr: 'string' });
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
        '<img data-original-src="images/original.heic">',
        '<video poster="images/poster.jpg"></video>',
        '<section style="background-image:url(\'images/inline-bg.webp\')"></section>',
        '<input type="image" src="images/input-icon.svg">',
        '<object data="images/object.tiff"></object>',
        '<embed src="images/embed.jxl">',
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
      'images/original.heic': new Uint8Array([13]),
      'images/object.tiff': new Uint8Array([14]),
      'images/embed.jxl': new Uint8Array([15]),
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
    expect(byRaw.get('images/original.heic')).toMatchObject({ sourceTag: 'img', sourceAttr: 'data-original-src' });
    expect(byRaw.get('images/object.tiff')).toMatchObject({ sourceTag: 'object', sourceAttr: 'data' });
    expect(byRaw.get('images/embed.jxl')).toMatchObject({ sourceTag: 'embed', sourceAttr: 'src' });
    expect(byRaw.get('images/svg-photo.png')).toMatchObject({ sourceTag: 'image', sourceAttr: 'href' });
    expect(byRaw.get('images/preload.avif')).toMatchObject({ sourceTag: 'link', sourceAttr: 'href', extra: { rel: 'preload' } });
    expect(byRaw.get('images/social.jpg')).toMatchObject({ sourceTag: 'meta', sourceAttr: 'content', type: 'social' });
    expect(byRaw.get('images/app-icon.png')).toMatchObject({ sourceKind: 'manifest', sourceTag: 'icon', extra: { manifestPath: 'icons.0.src' } });
    expect(byRaw.get('images/screenshot.png')).toMatchObject({ sourceKind: 'manifest', sourceTag: 'screenshot', extra: { manifestPath: 'screenshots.0.src' } });
    expect(byRaw.get('images/shortcut.png')).toMatchObject({ sourceKind: 'manifest', sourceTag: 'shortcut-icon', extra: { manifestPath: 'shortcuts.0.icons.0.src' } });
    expect(detections.some((detection) => detection.rawUrl.startsWith('data:'))).toBe(false);
  });

  it('detects conservative literal image references in JS, TS, JSX, and CSS-in-JS', async () => {
    const project = makeProject({
      'src/App.tsx': [
        "import hero from '../images/hero.apng';",
        "const icon = require('./icon.jxl');",
        "const portrait = new URL('../images/portrait.tiff', import.meta.url);",
        "fetch('../images/loaded.avif');",
        "const style = `.card { background-image: url('../images/card.heic') }`;",
        "export const App = () => <img src='../images/product.webp' />;",
        "// const ignored = new URL('../images/commented.png', import.meta.url);",
        "import data from '../content/data.json';",
      ].join('\n'),
      'images/hero.apng': new Uint8Array([1]),
      'src/icon.jxl': new Uint8Array([2]),
      'images/portrait.tiff': new Uint8Array([3]),
      'images/loaded.avif': new Uint8Array([4]),
      'images/card.heic': new Uint8Array([5]),
      'images/product.webp': new Uint8Array([6]),
      'content/data.json': '{}',
    });

    const detections = await detectImages(project.zip, project.entries);
    const byRaw = new Map(detections.map((detection) => [detection.rawUrl, detection]));

    expect(byRaw.get('../images/hero.apng')).toMatchObject({ sourceKind: 'code', sourceTag: 'import', status: 'ok' });
    expect(byRaw.get('./icon.jxl')).toMatchObject({ sourceKind: 'code', sourceTag: 'require', status: 'ok' });
    expect(byRaw.get('../images/portrait.tiff')).toMatchObject({ sourceKind: 'code', sourceTag: 'new-url', status: 'ok' });
    expect(byRaw.get('../images/loaded.avif')).toMatchObject({ sourceKind: 'code', sourceTag: 'fetch', status: 'ok' });
    expect(byRaw.get('../images/card.heic')).toMatchObject({ sourceKind: 'code', sourceTag: 'url', status: 'ok' });
    expect(byRaw.get('../images/product.webp')).toMatchObject({ sourceKind: 'code', sourceTag: 'img', status: 'ok' });
    expect(byRaw.has('../images/commented.png')).toBe(false);
    expect(byRaw.has('../content/data.json')).toBe(false);
  });

  it('scans static visual markup inside framework template containers', async () => {
    const project = makeProject({
      'components/Card.vue': [
        '<template>',
        '  <article style="background-image:url(\'../images/card-bg.webp\')">',
        '    <img src="../images/card.apng" srcset="../images/card@2x.jxl 2x">',
        '    <img :src="dynamicUrl"><img src={svelteImage}>',
        '  </article>',
        '</template>',
        '<script setup lang="ts">const dynamic = imageUrl</script>',
      ].join('\n'),
      'images/card-bg.webp': new Uint8Array([1]),
      'images/card.apng': new Uint8Array([2]),
      'images/card@2x.jxl': new Uint8Array([3]),
    });

    const detections = await detectImages(project.zip, project.entries);
    const byRaw = new Map(detections.map((detection) => [detection.rawUrl, detection]));
    expect(byRaw.get('../images/card-bg.webp')).toMatchObject({ sourceKind: 'html', sourceAttr: 'style', status: 'ok' });
    expect(byRaw.get('../images/card.apng')).toMatchObject({ sourceKind: 'html', sourceTag: 'img', status: 'ok' });
    expect(byRaw.get('../images/card@2x.jxl')).toMatchObject({ sourceKind: 'html', sourceAttr: 'srcset', status: 'ok' });
    expect(byRaw.has('{svelteImage}')).toBe(false);
    expect(byRaw.has('dynamicUrl')).toBe(false);
  });
});
