import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteCheckpoint,
  deleteProjectRecord,
  listCheckpoints,
  listProjects,
  loadCheckpoint,
  loadProjectRecord,
  loadSession,
  PERSISTENCE_SCHEMA_VERSION,
  renameProjectRecord,
  saveCheckpoint,
  saveProjectRecord,
  type Checkpoint,
  type PersistedProjectMeta,
  type PersistedSelection,
  type PersistedSession,
  type SavedProject,
} from '../src/lib/idb';

const DB_NAME = 'mockswap';

describe('idb project records', () => {
  let fakeIndexedDb: FakeIndexedDb;

  beforeEach(() => {
    fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the projects store during v2 upgrade without touching existing sessions data', async () => {
    const session = makePersistedSession();
    fakeIndexedDb.seed(DB_NAME, 1, {
      sessions: { keyPath: 'schemaVersion', records: [session] },
    });

    await expect(saveProjectRecord(makeProject({ id: 'project-1' }))).resolves.toBe('ok');

    const restoredSession = await loadSession();
    expect(restoredSession?.projectMeta?.fileName).toBe('session.zip');
    await expect(restoredSession?.mutatedZipBlob?.text()).resolves.toBe('session-mutated');
  });

  it('lists projects newest first without returning zip blobs', async () => {
    await saveProjectRecord(makeProject({ id: 'old', name: 'Old project', savedAt: 100 }));
    await saveProjectRecord(makeProject({ id: 'new', name: 'New project', savedAt: 300 }));

    const projects = await listProjects();

    expect(projects.map((project) => project.id)).toEqual(['new', 'old']);
    expect(projects[0]).toMatchObject({
      id: 'new',
      name: 'New project',
      projectMeta: expect.objectContaining({ fileName: 'new.zip' }),
      savedAt: 300,
      thumbnail: 'data:image/png;base64,thumb',
    });
    expect('mutatedZipBlob' in projects[0]).toBe(false);
    expect('originalZipBlob' in projects[0]).toBe(false);
  });

  it('loads full project records including blobs', async () => {
    await saveProjectRecord(makeProject({ id: 'project-1' }));

    const project = await loadProjectRecord('project-1');

    expect(project?.name).toBe('Project project-1');
    await expect(project?.mutatedZipBlob?.text()).resolves.toBe('project-1-mutated');
    await expect(project?.originalZipBlob?.text()).resolves.toBe('project-1-original');
  });

  it('renames projects without dropping the stored blobs', async () => {
    await saveProjectRecord(makeProject({ id: 'project-1', name: 'Before' }));

    await renameProjectRecord('project-1', 'After');

    const project = await loadProjectRecord('project-1');
    expect(project?.name).toBe('After');
    await expect(project?.mutatedZipBlob?.text()).resolves.toBe('project-1-mutated');
  });

  it('deletes project records and their checkpoints', async () => {
    await saveProjectRecord(makeProject({ id: 'project-1' }));
    await saveCheckpoint(makeCheckpoint({ id: 'checkpoint-1', projectId: 'project-1' }));
    await saveCheckpoint(makeCheckpoint({ id: 'checkpoint-2', projectId: 'project-1' }));
    await saveCheckpoint(makeCheckpoint({ id: 'checkpoint-other', projectId: 'project-2' }));

    await deleteProjectRecord('project-1');

    await expect(loadProjectRecord('project-1')).resolves.toBeNull();
    await expect(listCheckpoints('project-1')).resolves.toEqual([]);
    await expect(loadCheckpoint('checkpoint-1')).resolves.toBeNull();
    await expect(loadCheckpoint('checkpoint-2')).resolves.toBeNull();
    await expect(loadCheckpoint('checkpoint-other')).resolves.toMatchObject({ id: 'checkpoint-other' });
  });

  it('creates the checkpoints store and projectId index during v3 upgrade', async () => {
    const checkpoint = makeCheckpoint({ id: 'checkpoint-1', projectId: 'project-1' });
    fakeIndexedDb.seed(DB_NAME, 2, {
      sessions: { keyPath: 'schemaVersion', records: [makePersistedSession()] },
      projects: { keyPath: 'id', records: [makeProject({ id: 'project-1' })] },
      checkpoints: { keyPath: 'id', records: [checkpoint] },
    });

    const checkpoints = await listCheckpoints('project-1');

    expect(checkpoints.map((cp) => cp.id)).toEqual(['checkpoint-1']);
    expect(checkpoints[0].label).toBe('Checkpoint checkpoint-1');
  });

  it('lists checkpoints newest first through projectId without returning zip blobs', async () => {
    await saveCheckpoint(makeCheckpoint({ id: 'old', projectId: 'project-1', savedAt: 100 }));
    await saveCheckpoint(makeCheckpoint({ id: 'new', projectId: 'project-1', savedAt: 300 }));
    await saveCheckpoint(makeCheckpoint({ id: 'other-project', projectId: 'project-2', savedAt: 500 }));

    const checkpoints = await listCheckpoints('project-1');

    expect(checkpoints.map((cp) => cp.id)).toEqual(['new', 'old']);
    expect(checkpoints[0]).toMatchObject({
      id: 'new',
      projectId: 'project-1',
      label: 'Checkpoint new',
      savedAt: 300,
      patches: [{ id: 'new-patch', patch: { action: 'replace' } }],
    });
    expect('mutatedZipBlob' in checkpoints[0]).toBe(false);
  });

  it('loads full checkpoint records including the frozen zip blob', async () => {
    await saveCheckpoint(makeCheckpoint({ id: 'checkpoint-1' }));

    const checkpoint = await loadCheckpoint('checkpoint-1');

    expect(checkpoint?.label).toBe('Checkpoint checkpoint-1');
    await expect(checkpoint?.mutatedZipBlob.text()).resolves.toBe('checkpoint-1-mutated');
  });

  it('deletes checkpoint records', async () => {
    await saveCheckpoint(makeCheckpoint({ id: 'checkpoint-1' }));

    await deleteCheckpoint('checkpoint-1');

    await expect(loadCheckpoint('checkpoint-1')).resolves.toBeNull();
  });
});

function makePersistedSession(): PersistedSession {
  return {
    schemaVersion: PERSISTENCE_SCHEMA_VERSION,
    projectMeta: makeProjectMeta('session.zip'),
    mutatedZipBlob: new Blob(['session-mutated']),
    originalZipBlob: new Blob(['session-original']),
    patches: [{ id: 'patch-1', patch: { action: 'remove' } }],
    selection: makeSelection(),
    theme: 'dark',
    savedAt: 50,
  };
}

function makeProject(overrides: Partial<SavedProject> = {}): SavedProject {
  const id = overrides.id ?? 'project-1';
  return {
    id,
    name: `Project ${id}`,
    projectMeta: makeProjectMeta(`${id}.zip`),
    mutatedZipBlob: new Blob([`${id}-mutated`]),
    originalZipBlob: new Blob([`${id}-original`]),
    patches: [{ id: `${id}-patch`, patch: { action: 'placeholder' } }],
    selection: makeSelection(),
    theme: 'light',
    savedAt: 100,
    thumbnail: 'data:image/png;base64,thumb',
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  const id = overrides.id ?? 'checkpoint-1';
  return {
    id,
    projectId: 'project-1',
    label: `Checkpoint ${id}`,
    savedAt: 100,
    mutatedZipBlob: new Blob([`${id}-mutated`]),
    patches: [{ id: `${id}-patch`, patch: { action: 'replace' } }],
    ...overrides,
  };
}

function makeProjectMeta(fileName: string): PersistedProjectMeta {
  return {
    fileName,
    totalFiles: 10,
    totalSize: 1024,
    htmlFiles: 1,
    cssFiles: 2,
    jsFiles: 3,
    imageFiles: 4,
  };
}

function makeSelection(): PersistedSelection {
  return {
    currentPagePath: 'index.html',
    selectedDetectionKey: null,
    leftPanelMode: 'images',
    expandedFolders: ['assets'],
  };
}

type FakeStoreSeed = {
  keyPath: string;
  records: unknown[];
  indexes?: Record<string, string>;
};

type FakeStoreState = {
  keyPath: string;
  indexes: Map<string, string>;
  records: Map<IDBValidKey, unknown>;
};

type FakeDatabaseState = {
  version: number;
  stores: Map<string, FakeStoreState>;
};

class FakeIndexedDb {
  private readonly databases = new Map<string, FakeDatabaseState>();

  open(name: string, version?: number): IDBOpenDBRequest {
    const request = createOpenRequest();

    queueMicrotask(() => {
      let database = this.databases.get(name);
      const oldVersion = database?.version ?? 0;
      const nextVersion = version ?? (oldVersion || 1);
      const shouldUpgrade = !database || nextVersion > oldVersion;

      if (!database) {
        database = { version: nextVersion, stores: new Map() };
        this.databases.set(name, database);
      } else {
        database.version = nextVersion;
      }

      assignRequestResult(request, new FakeDatabase(database) as unknown as IDBDatabase);
      if (shouldUpgrade) {
        assignOpenRequestTransaction(request, new FakeUpgradeTransaction(database) as unknown as IDBTransaction);
        request.onupgradeneeded?.call(request, new Event('upgradeneeded') as IDBVersionChangeEvent);
        assignOpenRequestTransaction(request, null);
      }
      request.onsuccess?.call(request, new Event('success'));
    });

    return request;
  }

  seed(name: string, version: number, stores: Record<string, FakeStoreSeed>): void {
    const database: FakeDatabaseState = { version, stores: new Map() };

    for (const [storeName, seed] of Object.entries(stores)) {
      const store: FakeStoreState = {
        keyPath: seed.keyPath,
        indexes: new Map(Object.entries(seed.indexes ?? {})),
        records: new Map(),
      };
      for (const record of seed.records) {
        const key = (record as Record<string, unknown>)[seed.keyPath];
        if (!isIdbKey(key)) throw new Error(`Invalid fake IDB key for ${storeName}`);
        store.records.set(key, record);
      }
      database.stores.set(storeName, store);
    }

    this.databases.set(name, database);
  }
}

class FakeDatabase {
  constructor(private readonly database: FakeDatabaseState) {}

  get objectStoreNames(): DOMStringList {
    return {
      contains: (name: string) => this.database.stores.has(name),
    } as DOMStringList;
  }

  createObjectStore(name: string, options?: IDBObjectStoreParameters): IDBObjectStore {
    if (this.database.stores.has(name)) {
      throw new DOMException(`Object store already exists: ${name}`, 'ConstraintError');
    }
    const keyPath = options?.keyPath;
    if (typeof keyPath !== 'string') {
      throw new DOMException('Fake IDB only supports string keyPath stores', 'DataError');
    }
    const store: FakeStoreState = { keyPath, indexes: new Map(), records: new Map() };
    this.database.stores.set(name, store);
    return new FakeObjectStore(store, null) as unknown as IDBObjectStore;
  }

  transaction(storeNames: string | string[]): IDBTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const stores = new Map<string, FakeStoreState>();
    for (const storeName of names) {
      const store = this.database.stores.get(storeName);
      if (!store) throw new DOMException(`Missing object store: ${storeName}`, 'NotFoundError');
      stores.set(storeName, store);
    }
    return new FakeTransaction(stores) as unknown as IDBTransaction;
  }

  close(): void {
    // No-op for the in-memory fake.
  }
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null;

  constructor(private readonly stores: Map<string, FakeStoreState>) {}

  objectStore(storeName?: string): IDBObjectStore {
    const store = storeName
      ? this.stores.get(storeName)
      : this.stores.size === 1
        ? Array.from(this.stores.values())[0]
        : undefined;
    if (!store) throw new DOMException(`Missing object store: ${storeName ?? ''}`, 'NotFoundError');
    return new FakeObjectStore(store, this) as unknown as IDBObjectStore;
  }

  completeSoon(): void {
    queueMicrotask(() => {
      this.oncomplete?.call(this as unknown as IDBTransaction, new Event('complete'));
    });
  }

  fail(error: DOMException): void {
    this.error = error;
    this.onerror?.call(this as unknown as IDBTransaction, new Event('error'));
    this.onabort?.call(this as unknown as IDBTransaction, new Event('abort'));
  }
}

class FakeUpgradeTransaction {
  constructor(private readonly database: FakeDatabaseState) {}

  objectStore(storeName: string): IDBObjectStore {
    const store = this.database.stores.get(storeName);
    if (!store) throw new DOMException(`Missing object store: ${storeName}`, 'NotFoundError');
    return new FakeObjectStore(store, null) as unknown as IDBObjectStore;
  }
}

class FakeObjectStore {
  constructor(
    private readonly store: FakeStoreState,
    private readonly transaction: FakeTransaction | null,
  ) {}

  get indexNames(): DOMStringList {
    return {
      contains: (name: string) => this.store.indexes.has(name),
    } as DOMStringList;
  }

  createIndex(name: string, keyPath: string | string[]): IDBIndex {
    if (Array.isArray(keyPath)) {
      throw new DOMException('Fake IDB only supports string index keyPath', 'DataError');
    }
    if (this.store.indexes.has(name)) {
      throw new DOMException(`Index already exists: ${name}`, 'ConstraintError');
    }
    this.store.indexes.set(name, keyPath);
    return new FakeIndex(this.store, keyPath, this.transaction) as unknown as IDBIndex;
  }

  index(name: string): IDBIndex {
    const keyPath = this.store.indexes.get(name);
    if (!keyPath) throw new DOMException(`Missing index: ${name}`, 'NotFoundError');
    return new FakeIndex(this.store, keyPath, this.transaction) as unknown as IDBIndex;
  }

  get(key: IDBValidKey): IDBRequest<unknown> {
    const request = createRequest<unknown>();
    queueMicrotask(() => {
      setRequestResult(request, this.store.records.get(key));
      this.transaction?.completeSoon();
    });
    return request;
  }

  getAll(): IDBRequest<unknown[]> {
    const request = createRequest<unknown[]>();
    queueMicrotask(() => {
      setRequestResult(request, Array.from(this.store.records.values()));
      this.transaction?.completeSoon();
    });
    return request;
  }

  put(record: unknown): IDBRequest<IDBValidKey> {
    const request = createRequest<IDBValidKey>();
    queueMicrotask(() => {
      const key = (record as Record<string, unknown>)[this.store.keyPath];
      if (!isIdbKey(key)) {
        const error = new DOMException('Invalid fake IDB key', 'DataError');
        setRequestError(request, error);
        this.transaction?.fail(error);
        return;
      }
      this.store.records.set(key, record);
      setRequestResult(request, key);
      this.transaction?.completeSoon();
    });
    return request;
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    const request = createRequest<undefined>();
    queueMicrotask(() => {
      this.store.records.delete(key);
      setRequestResult(request, undefined);
      this.transaction?.completeSoon();
    });
    return request;
  }
}

class FakeIndex {
  constructor(
    private readonly store: FakeStoreState,
    private readonly keyPath: string,
    private readonly transaction: FakeTransaction | null,
  ) {}

  getAll(query?: IDBValidKey): IDBRequest<unknown[]> {
    const request = createRequest<unknown[]>();
    queueMicrotask(() => {
      const records = Array.from(this.store.records.values());
      const result = query === undefined
        ? records
        : records.filter((record) => (record as Record<string, unknown>)[this.keyPath] === query);
      setRequestResult(request, result);
      this.transaction?.completeSoon();
    });
    return request;
  }
}

function createOpenRequest(): IDBOpenDBRequest {
  return {
    ...createRequest<IDBDatabase>(),
    onblocked: null,
    onupgradeneeded: null,
    transaction: null,
  } as IDBOpenDBRequest;
}

function createRequest<T>(): IDBRequest<T> {
  return {
    error: null,
    onsuccess: null,
    onerror: null,
    readyState: 'pending',
    result: undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  } as unknown as IDBRequest<T>;
}

function assignRequestResult<T>(request: IDBRequest<T>, result: T): void {
  const writable = request as unknown as { result: T; readyState: IDBRequestReadyState };
  writable.result = result;
  writable.readyState = 'done';
}

function assignOpenRequestTransaction(request: IDBOpenDBRequest, transaction: IDBTransaction | null): void {
  const writable = request as unknown as { transaction: IDBTransaction | null };
  writable.transaction = transaction;
}

function setRequestResult<T>(request: IDBRequest<T>, result: T): void {
  assignRequestResult(request, result);
  request.onsuccess?.call(request, new Event('success'));
}

function setRequestError<T>(request: IDBRequest<T>, error: DOMException): void {
  const writable = request as unknown as { error: DOMException; readyState: IDBRequestReadyState };
  writable.error = error;
  writable.readyState = 'done';
  request.onerror?.call(request, new Event('error'));
}

function isIdbKey(value: unknown): value is IDBValidKey {
  return typeof value === 'string' || typeof value === 'number' || value instanceof Date || Array.isArray(value);
}
