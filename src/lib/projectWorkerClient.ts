import type { ZipAsyncType } from './archiveTypes';
import type { AppliedPatch, ImageDetection } from '../types';
import type {
  ArchiveMutations,
  ParseProjectResult,
  ProjectWorkerRequest,
  ProjectWorkerResponse,
  WorkerExportResult,
} from '../workers/projectWorkerProtocol';
import { createAbortError } from './cancellation';

type RequestWithoutId = ProjectWorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (percent: number) => void;
  cleanup?: () => void;
}

interface RequestOptions {
  signal?: AbortSignal;
  terminateWorkerOnAbort?: boolean;
}

export class ProjectWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest<unknown>>();

  constructor() {
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL('../workers/projectWorker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<ProjectWorkerResponse>) => {
      this.handleMessage(event.data);
    });
    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'Project worker failed.');
      this.resetWorker(error);
    });
    return worker;
  }

  parseProject(file: File, options: RequestOptions = {}): Promise<ParseProjectResult> {
    return this.request<ParseProjectResult>({ type: 'parse-project', file }, undefined, options);
  }

  readFile(projectId: string, path: string, format: ZipAsyncType): Promise<string | ArrayBuffer | Blob> {
    return this.request<string | ArrayBuffer | Blob>({
      type: 'read-file',
      projectId,
      path,
      format,
    });
  }

  buildExport(input: {
    projectId: string;
    fileName: string;
    patches: AppliedPatch[];
    detections: ImageDetection[];
    mutations: ArchiveMutations;
    onProgress?: (percent: number) => void;
  }): Promise<WorkerExportResult> {
    return this.request<WorkerExportResult>(
      {
        type: 'build-export',
        projectId: input.projectId,
        fileName: input.fileName,
        patches: input.patches,
        detections: input.detections,
        mutations: input.mutations,
      },
      input.onProgress,
    );
  }

  generateZip(input: {
    projectId: string;
    mutations: ArchiveMutations;
    compression?: string;
    compressionLevel?: number;
  }): Promise<Blob> {
    return this.request<Blob>({
      type: 'generate-zip',
      projectId: input.projectId,
      mutations: input.mutations,
      compression: input.compression,
      compressionLevel: input.compressionLevel,
    });
  }

  disposeProject(projectId: string): Promise<void> {
    return this.request<void>({ type: 'dispose-project', projectId });
  }

  private request<T>(
    message: RequestWithoutId,
    onProgress?: (percent: number) => void,
    options: RequestOptions = {},
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(createAbortError());

    const id = this.nextId++;
    const request = { ...message, id } as ProjectWorkerRequest;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest<unknown> = {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress,
      };
      if (options.signal) {
        const onAbort = () => {
          const current = this.pending.get(id);
          if (!current) return;
          this.pending.delete(id);
          current.cleanup?.();
          current.reject(createAbortError());
          if (options.terminateWorkerOnAbort) {
            this.resetWorker(createAbortError('Project analysis was canceled.'));
          } else {
            this.worker.postMessage({ type: 'cancel', id } satisfies ProjectWorkerRequest);
          }
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        pending.cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      }
      this.pending.set(id, pending);
      this.worker.postMessage(request);
    });
  }

  private handleMessage(message: ProjectWorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;

    if (message.type === 'progress') {
      pending.onProgress?.(message.progress);
      return;
    }

    this.pending.delete(message.id);
    pending.cleanup?.();
    if (message.type === 'error') {
      const error = new Error(message.message);
      if (message.stack) error.stack = message.stack;
      pending.reject(error);
      return;
    }
    pending.resolve(message.result);
  }

  private resetWorker(errorForPending: Error): void {
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      pending.cleanup?.();
      pending.reject(errorForPending);
    }
    this.pending.clear();
    this.worker = this.createWorker();
  }
}

let projectWorkerClient: ProjectWorkerClient | null = null;

export function getProjectWorkerClient(): ProjectWorkerClient {
  if (!projectWorkerClient) projectWorkerClient = new ProjectWorkerClient();
  return projectWorkerClient;
}
