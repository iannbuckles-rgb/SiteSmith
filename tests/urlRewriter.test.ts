import { describe, expect, it } from 'vitest';

import { rewriteCssBody, rewriteHtml } from '../src/lib/urlRewriter';

describe('urlRewriter', () => {
  it('rewrites relative CSS urls to blob urls and preserves query/hash suffixes', () => {
    const lookup = (path: string) => path === 'assets/hero.png' ? 'blob:hero' : undefined;
    const css = [
      '.hero{background:url("../assets/hero.png?v=2#top")}',
      '.remote{background:url("https://example.com/hero.png")}',
      '.data{background:url(data:image/png;base64,abc)}',
    ].join('');

    const rewritten = rewriteCssBody(css, 'styles/site.css', lookup);

    expect(rewritten).toContain('url("blob:hero?v=2#top")');
    expect(rewritten).toContain('url("https://example.com/hero.png")');
    expect(rewritten).toContain('url(data:image/png;base64,abc)');
  });

  it('rewrites HTML attrs and preserves srcset descriptors', () => {
    const lookup = (path: string) => new Map([
      ['images/small.png', 'blob:small'],
      ['images/large.png', 'blob:large'],
      ['images/poster.png', 'blob:poster'],
    ]).get(path);
    const html = [
      '<head></head>',
      '<img src="images/poster.png" srcset="images/small.png 480w, images/large.png 2x, https://example.com/remote.png 3x">',
    ].join('');

    const rewritten = rewriteHtml(html, 'index.html', lookup);

    expect(rewritten).toContain('src="blob:poster"');
    expect(rewritten).toContain('srcset="blob:small 480w, blob:large 2x, https://example.com/remote.png 3x"');
  });

  it('rewrites multiline HTML attrs without touching commented-out images', () => {
    const lookup = (path: string) => new Map([
      ['images/commented.png', 'blob:commented'],
      ['images/hero.png', 'blob:hero'],
    ]).get(path);
    const html = [
      '<html><head></head><body>',
      '<!-- Export backup: <img src="images/commented.png" alt="Old hero"> -->',
      '<img',
      '  class="hero"',
      '  title="2 > 1 badge"',
      '  src="images/hero.png"',
      '  alt="Hero"',
      '>',
      '</body></html>',
    ].join('\n');

    const rewritten = rewriteHtml(html, 'index.html', lookup);

    expect(rewritten).toContain('src="blob:hero"');
    expect(rewritten).toContain('title="2 > 1 badge"');
    expect(rewritten).toContain('<!-- Export backup: <img src="images/commented.png" alt="Old hero"> -->');
    expect(rewritten).not.toContain('blob:commented');
  });

  it('does not rewrite CSS url() tokens inside block comments', () => {
    const lookup = (path: string) => new Map([
      ['assets/commented.png', 'blob:commented'],
      ['assets/hero.png', 'blob:hero'],
    ]).get(path);
    const css = [
      '/* Squarespace backup: .hero { background: url("../assets/commented.png"); } */',
      '.hero { background: url("../assets/hero.png"); }',
    ].join('\n');

    const rewritten = rewriteCssBody(css, 'styles/site.css', lookup);

    expect(rewritten).toContain('/* Squarespace backup: .hero { background: url("../assets/commented.png"); } */');
    expect(rewritten).toContain('background: url("blob:hero")');
    expect(rewritten).not.toContain('blob:commented');
  });

  it('injects the navigation script idempotently', () => {
    const html = '<html><head></head><body><a href="page.html">Page</a></body></html>';
    const once = rewriteHtml(html, 'index.html', () => undefined);
    const twice = rewriteHtml(once, 'index.html', () => undefined);

    expect(twice.match(/data-mockswap-nav/g)).toHaveLength(1);
  });

  it('escapes source paths so injected script literals cannot break out', () => {
    const sourcePath = 'pages/</script><script>alert(1)</script>.html';
    const rewritten = rewriteHtml('<html><head></head><body></body></html>', sourcePath, () => undefined);

    expect(rewritten).not.toContain('</script><script>alert(1)</script>');
    expect(rewritten).toContain('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e');
  });
});
