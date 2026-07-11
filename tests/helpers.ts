import JSZip from 'jszip';

import { getCategory } from '../src/lib/fileTypes';
import type {
  AppliedPatch,
  FileCategory,
  ImageDetection,
  ImageStatus,
  ImageType,
  LoadedProject,
  ZipEntryMeta,
} from '../src/types';

const encoder = new TextEncoder();

export function makeProject(files: Record<string, string | Uint8Array>): LoadedProject {
  const zip = new JSZip();
  const entries: ZipEntryMeta[] = [];

  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
    entries.push({
      name: path.split('/').pop() ?? path,
      path,
      isDirectory: false,
      size: typeof content === 'string' ? encoder.encode(content).byteLength : content.byteLength,
      category: categoryFor(path),
    });
  }

  return {
    fileName: 'fixture.zip',
    zip,
    entries,
    summary: {
      totalFiles: entries.length,
      totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
      htmlFiles: entries.filter((entry) => entry.category === 'html').length,
      cssFiles: entries.filter((entry) => entry.category === 'css').length,
      jsFiles: entries.filter((entry) => entry.category === 'js').length,
      imageFiles: entries.filter((entry) => entry.category === 'image').length,
    },
  };
}

export function htmlImgDetection(overrides: Partial<ImageDetection> = {}): ImageDetection {
  return {
    rawUrl: 'images/hero.png',
    resolvedPath: 'images/hero.png',
    type: 'hero',
    status: 'ok',
    sourceKind: 'html',
    sourceFile: 'index.html',
    sourceTag: 'img',
    sourceAttr: 'src',
    ...overrides,
  };
}

export function cssUrlDetection(overrides: Partial<ImageDetection> = {}): ImageDetection {
  return {
    rawUrl: '../images/hero.png',
    resolvedPath: 'images/hero.png',
    type: 'background',
    status: 'ok',
    sourceKind: 'css',
    sourceFile: 'styles/site.css',
    sourceTag: 'url',
    sourceAttr: 'url',
    extra: { cssProperty: 'background' },
    ...overrides,
  };
}

export function missingDetection(index: number, overrides: Partial<ImageDetection> = {}): ImageDetection {
  const rawUrl = `images/missing-${index}.png`;
  return {
    rawUrl,
    resolvedPath: rawUrl,
    type: 'hero',
    status: 'missing',
    sourceKind: 'html',
    sourceFile: `page-${index}.html`,
    sourceTag: 'img',
    sourceAttr: 'src',
    ...overrides,
  };
}

export function remoteDetection(index: number, overrides: Partial<ImageDetection> = {}): ImageDetection {
  return {
    rawUrl: `https://cdn.example.com/remote-${index}.png`,
    resolvedPath: '',
    type: 'hero',
    status: 'remote',
    sourceKind: 'html',
    sourceFile: `remote-${index}.html`,
    sourceTag: 'img',
    sourceAttr: 'src',
    riskReason: 'cdn',
    ...overrides,
  };
}

export function removePatchFor(detection: ImageDetection, appliedAt = Date.now()): AppliedPatch {
  return {
    id: `${detection.sourceFile}::${detection.sourceTag}::${detection.sourceAttr}::${detection.rawUrl}`,
    sourceFile: detection.sourceFile,
    sourceKind: detection.sourceKind,
    sourceTag: detection.sourceTag,
    sourceAttr: detection.sourceAttr,
    rawUrl: detection.rawUrl,
    action: 'remove',
    currentSourceValue: '',
    appliedAt,
    previousSourceText: `<img src="${detection.rawUrl}">`,
    currentSourceText: ' ',
  };
}

export function placeholderPatchFor(detection: ImageDetection, appliedAt = Date.now()): AppliedPatch {
  return {
    id: `${detection.sourceFile}::${detection.sourceTag}::${detection.sourceAttr}::${detection.rawUrl}`,
    sourceFile: detection.sourceFile,
    sourceKind: detection.sourceKind,
    sourceTag: detection.sourceTag,
    sourceAttr: detection.sourceAttr,
    rawUrl: detection.rawUrl,
    action: 'placeholder',
    currentSourceValue: 'mockswap-placeholder:Hero Image',
    placeholder: { label: 'Hero Image' },
    appliedAt,
    previousSourceText: `<img src="${detection.rawUrl}">`,
    currentSourceText: '<div data-mockswap-placeholder="true">Hero Image</div>',
  };
}

export async function zipText(project: LoadedProject, path: string): Promise<string> {
  const file = project.zip.file(path);
  if (!file) throw new Error(`Expected ${path} to exist in zip`);
  return file.async('text');
}

export async function zipBytes(project: LoadedProject, path: string): Promise<Uint8Array> {
  const file = project.zip.file(path);
  if (!file) throw new Error(`Expected ${path} to exist in zip`);
  return file.async('uint8array');
}

export function section(report: string, heading: string): string {
  const start = report.indexOf(`## ${heading}`);
  if (start === -1) throw new Error(`Missing section: ${heading}`);
  const next = report.indexOf('\n## ', start + 1);
  return next === -1 ? report.slice(start) : report.slice(start, next);
}

export function imageDetection(
  rawUrl: string,
  status: ImageStatus,
  type: ImageType = 'hero',
): ImageDetection {
  return {
    rawUrl,
    resolvedPath: status === 'remote' ? '' : rawUrl,
    type,
    status,
    sourceKind: 'html',
    sourceFile: 'index.html',
    sourceTag: 'img',
    sourceAttr: 'src',
  };
}

function categoryFor(path: string): FileCategory {
  return getCategory(path);
}
