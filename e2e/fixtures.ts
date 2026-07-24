import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test as base, devices, expect, type BrowserContext } from '@playwright/test';

/**
 * WebKit keeps IndexedDB Blob payloads in files stored beside the browser
 * profile. Playwright's default context is ephemeral and has no profile
 * directory, so every `put()` carrying a Blob fails with
 *
 *   UnknownError: Error preparing Blob/File data to be stored in object store
 *
 * which takes MockupSwap's autosave straight to `at-risk`. Real Safari always
 * has a profile on disk and is unaffected, so this is a harness limitation
 * rather than an application or engine defect — verified by running the same
 * `put()` against a persistent WebKit context, where it succeeds.
 *
 * The WebKit project therefore supplies its own on-disk profile. Chromium and
 * Firefox store IDB blobs without one and keep Playwright's default context,
 * along with its built-in tracing.
 */
export const test = base.extend<{ context: BrowserContext }>({
  context: async ({ browserName, context, playwright, baseURL }, use, testInfo) => {
    if (browserName !== 'webkit') {
      await use(context);
      return;
    }

    const profileDir = await mkdtemp(join(tmpdir(), 'mockupswap-webkit-'));
    const persistent = await playwright.webkit.launchPersistentContext(profileDir, {
      baseURL,
      headless: testInfo.project.use.headless ?? true,
      viewport: devices['Desktop Safari'].viewport,
      userAgent: devices['Desktop Safari'].userAgent,
    });

    try {
      await use(persistent);
    } finally {
      await persistent.close();
      await rm(profileDir, { recursive: true, force: true });
    }
  },
});

export { expect };
