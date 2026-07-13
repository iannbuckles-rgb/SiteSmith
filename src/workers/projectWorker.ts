import JSZip from 'jszip';

import { buildReport, deriveExportFilename } from '../lib/exportService';
import { detectLogos } from '../lib/logoHelper';
import { loadZipFromFile } from '../lib/zipReader';
import type { AppliedPatch, ImageDetection } from '../types';
import type {
  ArchiveMutations,
  ProjectWorkerRequest,
  ProjectWorkerResponse,
  SerializedZipWrite,
  WorkerExportResult,
} from './projectWorkerProtocol';

interface WorkerProject {
  fileName: string;
  zip: JSZip;
}

const projects = new Map<string, WorkerProject>();
const canceledRequests = new Set<number>();
const activeRequests = new Set<number>();
let nextProjectId = 1;

self.addEventListener('message', (event: MessageEvent<ProjectWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    // Ignore late cancellation messages for requests that already completed;
    // otherwise their ids accumulate for the lifetime of the worker.
    if (activeRequests.has(request.id)) canceledRequests.add(request.id);
    return;
  }
  activeRequests.add(request.id);
  void handleRequest(request).catch((error: unknown) => {
    if (consumeCanceled(request.id)) return;
    postError(request.id, error);
  }).finally(() => {
    activeRequests.delete(request.id);
    canceledRequests.delete(request.id);
  });
});

async function handleRequest(request: ProjectWorkerRequest): Promise<void> {
  switch (request.type) {
    case 'parse-project': {
      const project = await loadZipFromFile(request.file);
      if (consumeCanceled(request.id)) return;
      const zip = project.zip as JSZip;
      const logoCandidates = await detectLogos(project.zip, project.entries);
      if (consumeCanceled(request.id)) return;
      const projectId = `project-${nextProjectId++}`;
      projects.set(projectId, { fileName: project.fileName, zip });
      if (consumeCanceled(request.id)) {
        projects.delete(projectId);
        return;
      }
      postResponse(request.id, {
        projectId,
        fileName: project.fileName,
        entries: project.entries,
        summary: project.summary,
        logoCandidates,
      });
      return;
    }

    case 'read-file': {
      const project = getProject(request.projectId);
      const file = project.zip.file(request.path);
      if (!file) throw new Error(`File "${request.path}" was not found in the archive.`);
      if (request.format === 'uint8array') {
        const bytes = await file.async('uint8array');
        if (consumeCanceled(request.id)) return;
        postResponse(request.id, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        return;
      }
      const result = await file.async(request.format);
      if (consumeCanceled(request.id)) return;
      postResponse(request.id, result);
      return;
    }

    case 'build-export': {
      const project = getProject(request.projectId);
      const result = await buildExportFromWorkerProject({
        zip: project.zip,
        fileName: request.fileName || project.fileName,
        patches: request.patches,
        detections: request.detections,
        mutations: request.mutations,
        onProgress: (progress) => postProgress(request.id, progress),
      });
      if (consumeCanceled(request.id)) return;
      postResponse(request.id, result);
      return;
    }

    case 'generate-zip': {
      const project = getProject(request.projectId);
      const blob = await generateZipSnapshot(project.zip, request.mutations, {
        compression: request.compression,
        compressionLevel: request.compressionLevel,
      });
      if (consumeCanceled(request.id)) return;
      postResponse(request.id, blob);
      return;
    }

    case 'dispose-project':
      projects.delete(request.projectId);
      postResponse(request.id, undefined);
      return;
  }
}

function consumeCanceled(id: number): boolean {
  if (!canceledRequests.has(id)) return false;
  canceledRequests.delete(id);
  return true;
}

async function buildExportFromWorkerProject(input: {
  zip: JSZip;
  fileName: string;
  patches: AppliedPatch[];
  detections: ImageDetection[];
  mutations: ArchiveMutations;
  onProgress: (percent: number) => void;
}): Promise<WorkerExportResult> {
  const outZip = new JSZip();
  const fileCount = queueProjectFiles(outZip, input.zip, input.mutations, { filterJunk: true });
  const reportText = buildReport(input.patches, input.detections);
  outZip.file('MOCKUPSWAP_CHANGES.md', reportText);

  const blob = await outZip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    (metadata) => input.onProgress(metadata.percent),
  );

  return {
    blob,
    filename: deriveExportFilename(input.fileName),
    reportText,
    fileCount: fileCount + 1,
  };
}

async function generateZipSnapshot(
  zip: JSZip,
  mutations: ArchiveMutations,
  options: { compression?: string; compressionLevel?: number },
): Promise<Blob> {
  const outZip = new JSZip();
  queueProjectFiles(outZip, zip, mutations, { filterJunk: false });
  const compression = options.compression === 'DEFLATE' || options.compression === 'STORE'
    ? options.compression
    : 'STORE';
  return outZip.generateAsync({
    type: 'blob',
    compression,
    compressionOptions: options.compressionLevel ? { level: options.compressionLevel } : undefined,
  });
}

function queueProjectFiles(
  outZip: JSZip,
  sourceZip: JSZip,
  mutations: ArchiveMutations,
  options: { filterJunk: boolean },
): number {
  const writes = new Map(mutations.writes.map((write) => [normalizeZipPath(write.path), write] as const));
  const removed = new Set(mutations.removed.map(normalizeZipPath));
  const written = new Set<string>();
  let fileCount = 0;

  sourceZip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) return;
    const normalized = normalizeZipPath(relativePath);
    if (!normalized || removed.has(normalized)) return;
    if (options.filterJunk && isJunkPath(normalized)) return;

    const override = writes.get(normalized);
    if (override) {
      queueWrite(outZip, override);
      written.add(normalized);
    } else {
      outZip.file(normalized, zipEntry.async('uint8array'));
    }
    fileCount += 1;
  });

  for (const write of mutations.writes) {
    const normalized = normalizeZipPath(write.path);
    if (!normalized || removed.has(normalized) || written.has(normalized)) continue;
    if (options.filterJunk && isJunkPath(normalized)) continue;
    queueWrite(outZip, { ...write, path: normalized });
    fileCount += 1;
  }

  return fileCount;
}

function queueWrite(outZip: JSZip, write: SerializedZipWrite): void {
  if (write.kind === 'text') {
    outZip.file(write.path, write.text);
  } else {
    outZip.file(write.path, new Uint8Array(write.bytes));
  }
}

function getProject(projectId: string): WorkerProject {
  const project = projects.get(projectId);
  if (!project) throw new Error('The loaded project is no longer available. Re-upload the zip and try again.');
  return project;
}

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isJunkPath(path: string): boolean {
  return (
    path.includes('__MACOSX/') ||
    path.endsWith('/__MACOSX') ||
    path.endsWith('.DS_Store') ||
    path.endsWith('/Thumbs.db')
  );
}

function postProgress(id: number, progress: number): void {
  postMessage({ type: 'progress', id, progress } satisfies ProjectWorkerResponse);
}

function postResponse(id: number, result: unknown): void {
  const response = { type: 'response', id, result } satisfies ProjectWorkerResponse;
  if (result instanceof ArrayBuffer) {
    postWorkerMessage(response, [result]);
    return;
  }
  postWorkerMessage(response);
}

function postError(id: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  postMessage({ type: 'error', id, message, stack } satisfies ProjectWorkerResponse);
}

function postWorkerMessage(message: ProjectWorkerResponse, transfer: Transferable[] = []): void {
  const scope = self as unknown as {
    postMessage(value: ProjectWorkerResponse, transferables?: Transferable[]): void;
  };
  scope.postMessage(message, transfer);
}
