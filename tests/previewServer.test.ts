import { describe, expect, it } from 'vitest';

import { choosePrimaryHtml } from '../src/lib/previewService';
import { isMessageFromPreviewFrame, previewSandboxPermissions } from '../src/lib/previewControls';
import { augmentHtml, deriveSiteRoot, instrumentEditableMarkup, previewUrl, servedPreviewPath } from '../src/lib/previewServer';

describe('preview message authentication', () => {
  it('accepts only the currently mounted iframe window', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    expect(isMessageFromPreviewFrame({ source: frame.contentWindow }, frame)).toBe(true);
    expect(isMessageFromPreviewFrame({ source: window }, frame)).toBe(false);
    expect(isMessageFromPreviewFrame({ source: frame.contentWindow }, null)).toBe(false);
    frame.remove();
  });

  it('grants same-origin only to the service-worker preview path', () => {
    expect(previewSandboxPermissions('/preview/project-1/index.html')).toContain('allow-same-origin');
    expect(previewSandboxPermissions('blob:https://app.example/abc')).not.toContain('allow-same-origin');
  });
});

describe('previewService.choosePrimaryHtml', () => {
  it('prefers a root index over nested route indexes', () => {
    expect(choosePrimaryHtml([
      'about/index.html',
      'index.html',
      'blog/index.html',
    ])).toBe('index.html');
  });

  it('prefers common built-site entries when no root index exists', () => {
    expect(choosePrimaryHtml([
      'RadAir/src/demo.html',
      'RadAir/dist/about/index.html',
      'RadAir/dist/index.html',
    ])).toBe('RadAir/dist/index.html');
  });

  it('falls back to the shallowest index before arbitrary HTML files', () => {
    expect(choosePrimaryHtml([
      'docs/reference/page.html',
      'docs/reference/index.html',
      'docs/index.html',
    ])).toBe('docs/index.html');
  });
});

describe('previewServer.deriveSiteRoot', () => {
  it('treats the entry HTML directory as the web root', () => {
    // A built site ships under dist/ but references assets at the deploy root,
    // so /assets/x must resolve against RadAir/dist/, not the zip root.
    expect(deriveSiteRoot('RadAir/dist/index.html')).toBe('RadAir/dist/');
    expect(deriveSiteRoot('build/index.html')).toBe('build/');
  });

  it('is empty when the entry already sits at the zip root', () => {
    expect(deriveSiteRoot('index.html')).toBe('');
    expect(deriveSiteRoot('')).toBe('');
  });
});

describe('previewServer.servedPreviewPath', () => {
  it('strips only files inside the selected site root', () => {
    expect(servedPreviewPath('RadAir/dist/index.html', 'RadAir/dist/')).toBe('index.html');
    expect(servedPreviewPath('RadAir/dist/assets/app.js', 'RadAir/dist/')).toBe('assets/app.js');
    expect(servedPreviewPath('RadAir/index.html', 'RadAir/dist/')).toBe('RadAir/index.html');
  });

  it('preserves zip paths when the entry already sits at the root', () => {
    expect(servedPreviewPath('index.html', '')).toBe('index.html');
    expect(servedPreviewPath('about/index.html', '')).toBe('about/index.html');
  });
});

describe('previewServer.previewUrl', () => {
  it('serves under /preview/<projectId>/ and preserves directory structure', () => {
    expect(previewUrl('project-1', 'index.html')).toBe('/preview/project-1/index.html');
    expect(previewUrl('project-1', 'assets/app.js')).toBe('/preview/project-1/assets/app.js');
  });

  it('percent-encodes unsafe characters per segment but keeps slashes', () => {
    expect(previewUrl('project-1', 'assets/my logo.png')).toBe('/preview/project-1/assets/my%20logo.png');
    expect(previewUrl('project-1', 'a b/c#d.css')).toBe('/preview/project-1/a%20b/c%23d.css');
  });
});

describe('previewServer.augmentHtml', () => {
  it('injects the preview runtime immediately after <head>', () => {
    const out = augmentHtml('<html><head><title>x</title></head><body></body></html>', 'index.html');
    expect(out).toMatch(/<head><script data-mockswap-preview>/);
    // Runtime must precede any existing head content so it runs first.
    expect(out.indexOf('data-mockswap-preview')).toBeLessThan(out.indexOf('<title>'));
  });

  it('includes the storage shim and the nav bridge', () => {
    const out = augmentHtml('<head></head>', 'a/b.html');
    expect(out).toContain('localStorage');
    expect(out).toContain('sessionStorage');
    expect(out).toContain('mockswap:navigate');
    expect(out).toContain('"a/b.html"');
  });

  it('includes the direct text editing bridge', () => {
    const out = augmentHtml('<head></head>', 'index.html');
    expect(out).toContain('mockswap:set-edit-mode');
    expect(out).toContain('mockswap:text-edit');
    expect(out).toContain('mockswap:select-element');
    expect(out).toContain('mockswap:nudge-element');
    expect(out).toContain('mockswap:clear-selection');
    expect(out).toContain('sourceStart');
    expect(out).toContain('className');
    expect(out).toContain('contentEditable');
    expect(out).toContain('data-mockswap-editing');
    expect(out).toContain('data-mockswap-selected');
    expect(out).toContain('ArrowUp');
    expect(out).toContain('keyboardMove');
    expect(out).toContain('flushNudge');
    expect(out).toContain('e.shiftKey?10');
    expect(out).not.toContain('document.addEventListener("keyup"');
    expect(out).toContain('data-mockswap-tabindex');
  });

  it('instruments editable elements with source ranges before serving', () => {
    const html = '<main><h1>Hello</h1><script>var x="<h1>skip</h1>";</script><img src="hero.png"></main>';
    const out = instrumentEditableMarkup(html);
    expect(out).toMatch(/<main data-mockswap-source-start="0" data-mockswap-source-end="6">/);
    expect(out).toContain('data-mockswap-source-start="6"');
    expect(out).toContain('data-mockswap-source-end="10"');
    expect(out).toMatch(/<img src="hero\.png" data-mockswap-source-start="\d+" data-mockswap-source-end="\d+">/);
    expect(out).not.toContain('skip</h1>" data-mockswap-source-start');
  });

  it('is idempotent — never double-injects', () => {
    const once = augmentHtml('<head></head>', 'index.html');
    expect(augmentHtml(once, 'index.html')).toBe(once);
  });

  it('escapes angle brackets in the source path so it cannot break out of the script', () => {
    const out = augmentHtml('<head></head>', 'evil</script><img src=x>.html');
    expect(out).not.toContain('</script><img src=x>');
    expect(out).toContain('\\u003c/script\\u003e');
  });

  it('falls back to injecting before <html> or at the top when no <head> exists', () => {
    expect(augmentHtml('<html><body>hi</body></html>', 'p.html'))
      .toMatch(/<html><script data-mockswap-preview>/);
    expect(augmentHtml('just text', 'p.html')).toMatch(/^<script data-mockswap-preview>/);
  });
});
