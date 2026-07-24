import JSZip from 'jszip';

import { expect, test } from './fixtures';

// Playwright's WebKit build accepts every `cache.put()` and persists nothing,
// which makes it the one engine here that exercises the compatibility fallback
// end-to-end in a real browser. Chromium and Firefox store the generation and
// take the served path, so there is no fallback to observe there.
//
// This is the browser-level regression test for SCALE-004: before that fix the
// served generation committed on the strength of a resolved write, and this
// project rendered a blank frame whose every request 404'd.
test.skip(
  ({ browserName }) => browserName !== 'webkit',
  'Only WebKit exercises the fallback here; see e2e/fixtures.ts.',
);

async function uploadFallbackProject(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');

  const zip = new JSZip();
  zip.file('index.html', [
    '<!doctype html><html><head><link rel="stylesheet" href="site.css"></head>',
    '<body><h1 id="site-name">fallback-project</h1><img src="logo.png"></body></html>',
  ].join(''));
  zip.file('site.css', 'body{background:rgb(9,8,7)}');
  zip.file('logo.png', Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });

  await page.getByTestId('zip-input').setInputFiles({
    name: 'fallback.zip',
    mimeType: 'application/zip',
    buffer,
  });
}

test('abandons an unstorable generation instead of committing it', async ({ page }) => {
  await uploadFallbackProject(page);

  // The served path is abandoned rather than committed, so the frame is a blob
  // document instead of an immutable /preview/<id>/<revision>/ URL. Before
  // SCALE-004 this committed and every request 404'd into a blank frame.
  await expect(page.getByTestId('preview-iframe')).toHaveAttribute('src', /^blob:/);

  // The reason is surfaced rather than failing silently.
  await expect(page.getByTestId('preview-diagnostics')).toContainText('compatibility mode');

  // The abandoned attempt leaves no staging cache behind.
  expect(await page.evaluate(async () => (await caches.keys())
    .filter((name) => name.startsWith('mockswap-preview:')))).toEqual([]);

  // Export does not depend on which preview path was taken.
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-zip-button').click();
  const download = await downloadPromise;
  await expect(page.getByTestId('export-success')).toBeVisible();
  expect(download.suggestedFilename()).toBe('fallback-mockupswap.zip');
});

// SCALE-005. The compatibility document is a single inline bootstrap script,
// and a blob: document inherits the creating page's CSP — which is
// `script-src 'self'`, with no 'unsafe-inline' and no blob:. WebKit reports
// "Refused to execute a script because its hash, its nonce, or 'unsafe-inline'
// does not appear in the script-src directive", the bootstrap never runs, and
// the frame keeps the empty wrapper document.
//
// This is not WebKit-specific: the fallback cannot execute under the shipped
// policy in any engine. It stays invisible in Chromium and Firefox only because
// they always win the served path and never reach this code.
test.fixme('renders the project in compatibility mode', async ({ page }) => {
  await uploadFallbackProject(page);

  const preview = page.frameLocator('[data-testid="preview-iframe"]');
  await expect(preview.locator('#site-name')).toHaveText('fallback-project');
  await expect.poll(() => preview.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor))
    .toBe('rgb(9, 8, 7)');
});
