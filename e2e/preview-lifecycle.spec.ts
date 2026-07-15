import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';

test('serves a large active site from one immutable generation and exports it', async ({ page }) => {
  await page.goto('/');
  await trackPersistenceStates(page);
  await uploadZip(page, await modernSiteZip('modern-site.zip', 500));

  const persistence = page.getByTestId('persistence-status');
  await expect(persistence).toHaveAttribute('data-state', 'dirty');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
  await expect(persistence).toHaveAttribute('data-state', 'saved');
  const persistenceStates = await readPersistenceStates(page);
  const dirtyIndex = persistenceStates.indexOf('dirty');
  const savingIndex = persistenceStates.indexOf('saving');
  const savedIndex = persistenceStates.lastIndexOf('saved');
  expect(dirtyIndex).toBeGreaterThanOrEqual(0);
  expect(savingIndex).toBeGreaterThan(dirtyIndex);
  expect(savedIndex).toBeGreaterThan(savingIndex);

  const iframe = page.getByTestId('preview-iframe');
  await expect(iframe).toHaveAttribute('src', /\/preview\/project-\d+\/[^/]+\/index\.html$/);
  await expect(page.getByTestId('preview-diagnostics')).toHaveCount(0);

  const preview = page.frameLocator('[data-testid="preview-iframe"]');
  await expect(preview.locator('#status')).toHaveText('module-ok|fetch-ok|worker-ok');
  await expect.poll(() => preview.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor))
    .toBe('rgb(12, 34, 56)');

  await expect.poll(() => previewCacheNames(page)).toHaveLength(1);
  const cacheNames = await previewCacheNames(page);
  expect(cacheNames[0]).toMatch(/^mockswap-preview:project-\d+:/);

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-zip-button').click();
  const download = await downloadPromise;
  await expect(page.getByTestId('export-success')).toBeVisible();
  expect(download.suggestedFilename()).toBe('modern-site-mockupswap.zip');

  const path = await download.path();
  expect(path).not.toBeNull();
  const exported = await JSZip.loadAsync(await readFile(path as string));
  expect(exported.file('dist/index.html')).not.toBeNull();
  expect(exported.file('dist/assets/app.js')).not.toBeNull();
  expect(exported.file('MOCKUPSWAP_CHANGES.md')).not.toBeNull();
});

test('cancels an in-flight large generation when the project changes', async ({ page }) => {
  await page.goto('/');
  await uploadZip(page, await simpleSiteZip('slow-first.zip', 'stale-first', 1_200));

  // Project state is committed before its preview cache finishes populating.
  // Switching here exercises the AbortSignal path rather than merely replacing
  // an already-complete iframe.
  await expect(page.getByTestId('project-summary')).toBeVisible();
  await page.getByRole('button', { name: 'change project' }).click();
  await expect(page.getByTestId('zip-input')).toBeVisible();

  await uploadZip(page, await simpleSiteZip('current.zip', 'current-project', 0));
  const preview = page.frameLocator('[data-testid="preview-iframe"]');
  await expect(preview.locator('#site-name')).toHaveText('current-project');
  await expect(page.getByTestId('preview-diagnostics')).toHaveCount(0);

  await expect.poll(() => previewCacheNames(page)).toHaveLength(1);
  const src = await page.getByTestId('preview-iframe').getAttribute('src');
  const revision = src?.split('/')[3];
  expect(revision).toBeTruthy();
  expect((await previewCacheNames(page))[0]).toContain(`:${revision}`);
});

async function uploadZip(page: Page, payload: { name: string; buffer: Buffer }): Promise<void> {
  await page.getByTestId('zip-input').setInputFiles({
    name: payload.name,
    mimeType: 'application/zip',
    buffer: payload.buffer,
  });
}

async function modernSiteZip(name: string, fillerCount: number): Promise<{ name: string; buffer: Buffer }> {
  const zip = new JSZip();
  zip.file('dist/index.html', [
    '<!doctype html><html><head>',
    '<link rel="stylesheet" href="/assets/site.css">',
    '<script type="module" src="/assets/app.js"></script>',
    '</head><body><h1 id="status">starting</h1></body></html>',
  ].join(''));
  zip.file('dist/assets/site.css', 'body{background:rgb(12,34,56)}');
  zip.file('dist/assets/dep.js', 'export const moduleValue = "module-ok";');
  zip.file('dist/assets/data.json', JSON.stringify({ value: 'fetch-ok' }));
  zip.file('dist/assets/worker.js', 'self.postMessage("worker-ok");');
  zip.file('dist/assets/app.js', [
    'import { moduleValue } from "./dep.js";',
    'const data = await fetch("/assets/data.json").then((response) => response.json());',
    'const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });',
    'worker.onmessage = (event) => {',
    '  document.querySelector("#status").textContent = `${moduleValue}|${data.value}|${event.data}`;',
    '};',
  ].join('\n'));
  addFiller(zip, fillerCount);
  return { name, buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }) };
}

async function simpleSiteZip(
  name: string,
  label: string,
  fillerCount: number,
): Promise<{ name: string; buffer: Buffer }> {
  const zip = new JSZip();
  zip.file('index.html', `<!doctype html><h1 id="site-name">${label}</h1>`);
  addFiller(zip, fillerCount);
  return { name, buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }) };
}

function addFiller(zip: JSZip, count: number): void {
  for (let index = 0; index < count; index += 1) {
    zip.file(`assets/filler/file-${String(index).padStart(4, '0')}.txt`, `fixture-${index}`);
  }
}

async function previewCacheNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await caches.keys())
    .filter((name) => name.startsWith('mockswap-preview:'))
    .sort());
}

async function trackPersistenceStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as { __mockupSwapPersistenceStates?: string[] };
    const states: string[] = [];
    scope.__mockupSwapPersistenceStates = states;
    const observer = new MutationObserver(() => {
      const state = document.querySelector('[data-testid="persistence-status"]')?.getAttribute('data-state');
      if (state && states.at(-1) !== state) states.push(state);
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-state'],
      childList: true,
      subtree: true,
    });
  });
}

async function readPersistenceStates(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scope = window as unknown as { __mockupSwapPersistenceStates?: string[] };
    return scope.__mockupSwapPersistenceStates ?? [];
  });
}
