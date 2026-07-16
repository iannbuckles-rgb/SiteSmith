import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROADMAP_PATH = resolve(process.cwd(), 'docs/ROADMAP.md');
const ISSUE_FORM_PATH = resolve(process.cwd(), '.github/ISSUE_TEMPLATE/roadmap.yml');
const LICENSE_PATH = resolve(process.cwd(), 'LICENSE');
const PACKAGE_PATH = resolve(process.cwd(), 'package.json');
const LOCK_PATH = resolve(process.cwd(), 'package-lock.json');

describe('roadmap scheduling contract', () => {
  it('uses unique stable IDs and valid issue links for every open item', async () => {
    const markdown = await readFile(ROADMAP_PATH, 'utf8');
    const rows = markdown
      .split('\n')
      .filter((line) => /^\| [A-Z]+-\d{3} \|/.test(line))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));

    expect(rows.length).toBeGreaterThan(0);
    const ids = rows.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const [id, priority, outcome, status, issue] of rows) {
      expect(id).toMatch(/^[A-Z]+-\d{3}$/);
      expect(priority).toMatch(/^P[0-3]$/);
      expect(outcome).not.toBe('');
      if (status === 'Unscheduled') {
        expect(issue).toContain('/issues/new?template=roadmap.yml');
        expect(decodeURIComponent(issue)).toContain(`[${id}]`);
      } else {
        expect(status).toBe('Scheduled');
        expect(issue).toMatch(/https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/);
      }
    }
  });

  it('requires acceptance criteria, tests, and verification in scheduled issues', async () => {
    const issueForm = await readFile(ISSUE_FORM_PATH, 'utf8');
    for (const id of ['roadmap-id', 'acceptance-criteria', 'acceptance-tests', 'verification']) {
      expect(issueForm).toContain(`id: ${id}`);
    }
    expect(issueForm.match(/required: true/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('keeps the MIT grant and package metadata explicit and synchronized', async () => {
    const [license, packageText, lockText] = await Promise.all([
      readFile(LICENSE_PATH, 'utf8'),
      readFile(PACKAGE_PATH, 'utf8'),
      readFile(LOCK_PATH, 'utf8'),
    ]);
    const packageJson = JSON.parse(packageText) as { license?: string };
    const packageLock = JSON.parse(lockText) as { packages?: Record<string, { license?: string }> };

    expect(license).toMatch(/^MIT License\n/);
    expect(license).toContain('Copyright (c) 2026 MockupSwap contributors');
    expect(packageJson.license).toBe('MIT');
    expect(packageLock.packages?.['']?.license).toBe('MIT');
  });
});
