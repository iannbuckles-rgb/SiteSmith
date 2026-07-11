import type { ZipAsyncType } from '../lib/archiveTypes';
import type { AppliedPatch, ImageDetection, LogoCandidate, ProjectSummary, ZipEntryMeta } from '../types';

export type SerializedZipWrite =
  | { path: string; kind: 'text'; text: string }
  | { path: string; kind: 'bytes'; bytes: ArrayBuffer };

export interface ArchiveMutations {
  writes: SerializedZipWrite[];
  removed: string[];
}

export interface ParseProjectResult {
  projectId: string;
  fileName: string;
  entries: ZipEntryMeta[];
  summary: ProjectSummary;
  detections: ImageDetection[];
  logoCandidates: LogoCandidate[];
}

export interface WorkerExportResult {
  blob: Blob;
  filename: string;
  reportText: string;
  fileCount: number;
}

export interface WorkerProgressMessage {
  type: 'progress';
  id: number;
  progress: number;
}

export type ProjectWorkerRequest =
  | { type: 'parse-project'; id: number; file: File }
  | { type: 'read-file'; id: number; projectId: string; path: string; format: ZipAsyncType }
  | {
      type: 'build-export';
      id: number;
      projectId: string;
      fileName: string;
      patches: AppliedPatch[];
      detections: ImageDetection[];
      mutations: ArchiveMutations;
    }
  | {
      type: 'generate-zip';
      id: number;
      projectId: string;
      mutations: ArchiveMutations;
      compression?: string;
      compressionLevel?: number;
    }
  | { type: 'dispose-project'; id: number; projectId: string }
  | { type: 'cancel'; id: number };

export type ProjectWorkerResponse =
  | { type: 'response'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string; stack?: string }
  | WorkerProgressMessage;
