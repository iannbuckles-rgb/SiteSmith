import type { ZipArchiveLike, ZipFileLike, ZipWriteData } from './archiveTypes';
import type { ProjectWorkerClient } from './projectWorkerClient';
import type { ArchiveMutations, SerializedZipWrite } from '../workers/projectWorkerProtocol';
import type { ZipEntryMeta } from '../types';

type StoredWrite = string | Uint8Array | ArrayBuffer | Blob;

export class WorkerZipArchive implements ZipArchiveLike {
  readonly files: Record<string, { dir: boolean }> = {};

  private readonly writes = new Map<string, StoredWrite>();
  private readonly removed = new Set<string>();

  constructor(
    readonly projectId: string,
    private readonly client: ProjectWorkerClient,
    entries: ZipEntryMeta[],
  ) {
    for (const entry of entries) {
      this.files[normalizeZipPath(entry.path)] = { dir: entry.isDirectory };
    }
  }

  file(path: string): ZipFileLike | null;
  file(path: string, data: ZipWriteData): this;
  file(path: string, data?: ZipWriteData): ZipFileLike | this | null {
    const normalized = normalizeZipPath(path);
    if (!normalized) return data === undefined ? null : this;

    if (data !== undefined) {
      this.writes.set(normalized, cloneWriteData(data));
      this.removed.delete(normalized);
      this.files[normalized] = { dir: false };
      return this;
    }

    const meta = this.files[normalized];
    if (!meta || meta.dir || this.removed.has(normalized)) return null;
    return new WorkerZipFile(this.client, this.projectId, normalized, () => this.writes.get(normalized));
  }

  remove(path: string): this {
    const normalized = normalizeZipPath(path);
    if (!normalized) return this;
    this.writes.delete(normalized);
    this.removed.add(normalized);
    delete this.files[normalized];
    return this;
  }

  forEach(callback: (relativePath: string, zipEntry: ZipFileLike) => void): void {
    for (const path of Object.keys(this.files).sort((a, b) => a.localeCompare(b))) {
      const meta = this.files[path];
      if (!meta || this.removed.has(path)) continue;
      callback(path, new WorkerZipFile(this.client, this.projectId, path, () => this.writes.get(path), meta.dir));
    }
  }

  async generateAsync(options: {
    type: 'blob';
    compression?: 'STORE' | 'DEFLATE';
    compressionOptions?: { level: number };
  }): Promise<Blob> {
    if (options.type !== 'blob') {
      throw new Error('WorkerZipArchive only supports blob generation.');
    }
    return this.client.generateZip({
      projectId: this.projectId,
      mutations: await this.snapshotMutations(),
      compression: options.compression,
      compressionLevel: options.compressionOptions?.level,
    });
  }

  async snapshotMutations(): Promise<ArchiveMutations> {
    const writes: SerializedZipWrite[] = [];
    for (const [path, value] of this.writes) {
      if (this.removed.has(path)) continue;
      writes.push(await serializeWrite(path, value));
    }
    return {
      writes,
      removed: Array.from(this.removed),
    };
  }
}

class WorkerZipFile implements ZipFileLike {
  constructor(
    private readonly client: ProjectWorkerClient,
    private readonly projectId: string,
    private readonly path: string,
    private readonly getOverride: () => StoredWrite | undefined,
    readonly dir = false,
  ) {}

  async async(type: 'text'): Promise<string>;
  async async(type: 'uint8array'): Promise<Uint8Array>;
  async async(type: 'blob'): Promise<Blob>;
  async async(type: 'base64'): Promise<string>;
  async async(type: 'text' | 'uint8array' | 'blob' | 'base64'): Promise<string | Uint8Array | Blob> {
    const override = this.getOverride();
    if (override !== undefined) {
      return readStoredWrite(override, type);
    }

    const result = await this.client.readFile(this.projectId, this.path, type);
    if (type === 'uint8array') {
      if (result instanceof ArrayBuffer) return new Uint8Array(result);
      if (result instanceof Uint8Array) return result;
      throw new Error(`Unexpected worker response for ${this.path}.`);
    }
    if (type === 'text' || type === 'base64') {
      if (typeof result === 'string') return result;
      throw new Error(`Unexpected worker response for ${this.path}.`);
    }
    if (result instanceof Blob) return result;
    if (result instanceof ArrayBuffer) return new Blob([result]);
    throw new Error(`Unexpected worker response for ${this.path}.`);
  }
}

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function cloneWriteData(data: ZipWriteData): StoredWrite {
  if (typeof data === 'string' || data instanceof Blob) return data;
  if (data instanceof Uint8Array) return data.slice();
  return data.slice(0);
}

async function serializeWrite(path: string, value: StoredWrite): Promise<SerializedZipWrite> {
  if (typeof value === 'string') return { path, kind: 'text', text: value };
  const bytes = await writeToArrayBuffer(value);
  return { path, kind: 'bytes', bytes };
}

async function readStoredWrite(
  value: StoredWrite,
  type: 'text' | 'uint8array' | 'blob' | 'base64',
): Promise<string | Uint8Array | Blob> {
  if (type === 'text') {
    if (typeof value === 'string') return value;
    return new TextDecoder().decode(await writeToUint8Array(value));
  }
  if (type === 'uint8array') {
    return writeToUint8Array(value);
  }
  if (type === 'blob') {
    if (value instanceof Blob) return value;
    return new Blob([await writeToArrayBuffer(value)]);
  }
  return bytesToBase64(await writeToUint8Array(value));
}

async function writeToUint8Array(value: StoredWrite): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(value.slice(0));
}

async function writeToArrayBuffer(value: StoredWrite): Promise<ArrayBuffer> {
  const bytes = await writeToUint8Array(value);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
