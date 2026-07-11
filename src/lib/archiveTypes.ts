export type ZipAsyncType = 'text' | 'uint8array' | 'blob' | 'base64';

export type ZipWriteData = string | Uint8Array | ArrayBuffer | Blob;

export interface ZipFileLike {
  dir: boolean;
  async(type: 'text'): Promise<string>;
  async(type: 'uint8array'): Promise<Uint8Array>;
  async(type: 'blob'): Promise<Blob>;
  async(type: 'base64'): Promise<string>;
}

export interface ZipArchiveLike {
  files: Record<string, { dir: boolean }>;
  file(path: string): ZipFileLike | null;
  file(path: string, data: ZipWriteData): unknown;
  remove(path: string): this;
  forEach(callback: (relativePath: string, zipEntry: ZipFileLike) => void): void;
  generateAsync(options: {
    type: 'blob';
    compression?: 'STORE' | 'DEFLATE';
    compressionOptions?: { level: number };
  }): Promise<Blob>;
}
