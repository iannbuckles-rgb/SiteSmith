/* ----------------------------------------------------------------------------
 * idb
 * --------------------------------------------------------------------------
 * A tiny, hand-rolled IndexedDB wrapper for project state persistence.
 * No dependency; the wrapper only exposes what MockupSwap needs:
 *
 *   - `loadSession(): Promise<PersistedSession | null>`  — read on boot.
 *   - `saveSession(snapshot): Promise<SaveSessionOutcome>`
 *                                                      — write on every
 *                                                        meaningful mutation
 *                                                        (throttled with a
 *                                                        setTimeout-debounce
 *                                                        by the App layer).
 *   - `clearSession(): Promise<void>`                   — wipe on Reset
 *                                                        Project or fresh
 *                                                        upload.
 *   - checkpoint helpers                                — named project
 *                                                        versions scoped to
 *                                                        a saved project.
 *
 * SCHEMA
 *   One object store `sessions` (keyPath: `'schemaVersion'`). We keep ONE row
 *   at a time, keyed by the active schema version. The whole snapshot is
 *   serialised together so reads and writes are single-key, single-row and
 *   atomic from the caller's POV. `SCHEMA_VERSION` lets older rows be dropped
 *   on read without a migration runtime.
 *
 * Why hand-rolled?  The user data is large (a 5MB zip blob + a few KB of
 *   JSON). We don't need cursors, indexes, or transactions across stores
 *   so the 50 lines we own are clearer than wiring a third-party lib.
 *
 * SAVED FIELDS
 *   - `mutatedZipBlob`  : the project's current zip state (Blob).
 *   - `originalZipBlob` : the pristine upload. Survives the page refresh
 *                         so Reset Project still works.
 *   - `patchesByKey`    : [{ id: string, patch: AppliedPatch }].
 *   - `selection`       : { currentPagePath, selectedDetectionKey,
 *                           leftPanelMode, expandedFolders[] }.
 *   - `projectMeta`     : the file name + summary stats for UI rebuild
 *                         before the zip blob is loaded.
 *   - `theme`           : the user's dark / light UI preference.
 *
 * QUOTA
 *   IndexedDB getQuota returns generous numbers on Chrome (~60% of disk),
 *   but we cannot assume the user wants us to eat 50MB of their hard
 *   drive on every page load. `saveSession` catches `QuotaExceededError`
 *   and reports the outcome so the App can warn the user without crashing.
 * -------------------------------------------------------------------------*/

import type { LeftPanelMode } from '../types';

const DB_NAME = 'mockswap';
const DB_VERSION = 3;
const STORE = 'sessions';
const PROJECTS_STORE = 'projects';
const CHECKPOINTS_STORE = 'checkpoints';
const CHECKPOINTS_PROJECT_INDEX = 'projectId';
const SCHEMA_VERSION = 1;
const KEY = SCHEMA_VERSION;

export const PERSISTENCE_SCHEMA_VERSION = SCHEMA_VERSION;

export type SaveSessionOutcome = 'ok' | 'quota-exceeded' | 'error';
export type PersistedTheme = 'dark' | 'light';

export interface PersistedSelection {
  currentPagePath: string;
  selectedDetectionKey: string | null;
  leftPanelMode: LeftPanelMode;
  expandedFolders: string[];
}

export interface PersistedProjectMeta {
  fileName: string;
  totalFiles: number;
  totalSize: number;
  htmlFiles: number;
  cssFiles: number;
  jsFiles: number;
  imageFiles: number;
}

/** Single-row shape written to IDB. */
interface PersistedSessionV1 {
  schemaVersion: number;
  projectMeta: PersistedProjectMeta | null;
  mutatedZipBlob: Blob | null;
  originalZipBlob: Blob | null;
  /** Each entry is the patch id and its serialised patch. Both are
   *  serialised via JSON.stringify before being put into IDB because
   *  IDB does not serialise Raw JSObjects natively in every browser
   *  (Chromium does via structured clone, but iOS Safari historically
   *  had quirks with Map / Set / Date instances). */
  patches: Array<{ id: string; patch: unknown }>;
  selection: PersistedSelection | null;
  theme?: PersistedTheme;
  savedAt: number;
}

export interface PersistedSession {
  schemaVersion: number;
  projectMeta: PersistedProjectMeta | null;
  mutatedZipBlob: Blob | null;
  originalZipBlob: Blob | null;
  patches: Array<{ id: string; patch: unknown }>;
  selection: PersistedSelection | null;
  theme?: PersistedTheme;
  savedAt: number;
}

export type SavedProject = Omit<PersistedSession, 'schemaVersion'> & {
  id: string;
  name: string;
  thumbnail?: string;
};

export interface Checkpoint {
  id: string;
  projectId: string;
  label: string;
  savedAt: number;
  mutatedZipBlob: Blob;
  patches: Array<{ id: string; patch: unknown }>;
}

// ---------------------------------------------------------------------------
// Browser IDB plumbing (the standard mozilla-recipe promise wrapper).
// ---------------------------------------------------------------------------
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'schemaVersion' });
      }
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHECKPOINTS_STORE)) {
        const store = db.createObjectStore(CHECKPOINTS_STORE, { keyPath: 'id' });
        store.createIndex(CHECKPOINTS_PROJECT_INDEX, CHECKPOINTS_PROJECT_INDEX);
      } else {
        const tx = req.transaction;
        if (tx) {
          const store = tx.objectStore(CHECKPOINTS_STORE);
          if (!store.indexNames.contains(CHECKPOINTS_PROJECT_INDEX)) {
            store.createIndex(CHECKPOINTS_PROJECT_INDEX, CHECKPOINTS_PROJECT_INDEX);
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

function getDb(): Promise<IDBDatabase | null> {
  // SSR / very old browsers / browsers with storage disabled gracefully
  // degrade to "no persistence" rather than throwing.
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return openDb().catch(() => null);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Read the persisted session, if any. Returns null if there is no row,
 *  if the schema version is older than the runtime, or if IDB itself is
 *  unavailable. The caller decides whether to surface a "Restore" banner. */
export async function loadSession(): Promise<PersistedSession | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    return await readSession(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Write the persisted session. Best-effort: quota errors do not throw.
 *  The caller MAY debounce calls to amortise multiple writes per second. */
export async function saveSession(snapshot: Omit<PersistedSession, 'schemaVersion' | 'savedAt'>): Promise<SaveSessionOutcome> {
  const db = await getDb();
  if (!db) return 'error';
  try {
    const session: PersistedSessionV1 = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: Date.now(),
      ...snapshot,
      // Already on the type, but spread is required for the structural
      // V1 envelope. Type-cast through unknown keeps TS happy without
      // any/runtime.
    } as PersistedSessionV1;
    await writeSession(db, session);
    return 'ok';
  } catch (err) {
    // QuotaExceededError: drop the save. The app keeps working from
    // in-memory state; the user just won't have persistence on the
    // current overflow. The caller surfaces the warning.
    if (isQuotaExceededError(err)) {
      // eslint-disable-next-line no-console
      console.warn('[mockswap] IndexedDB quota exhausted; persistence disabled for this session.');
      return 'quota-exceeded';
    }
    // Other errors (structured-clone rejection, etc.) are equally
    // best-effort: report the failed outcome and move on.
    // eslint-disable-next-line no-console
    console.warn('[mockswap] IndexedDB write failed:', err);
    return 'error';
  } finally {
    db.close();
  }
}

/** Wipe the persisted session. Called on Reset Project, on Reload, and
 *  whenever the user uploads a different zip from disk. */
export async function clearSession(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const req = tx.objectStore(STORE).delete(SCHEMA_VERSION as unknown as IDBValidKey);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('IndexedDB delete failed'));
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mockswap] IndexedDB clear failed:', err);
  } finally {
    db.close();
  }
}

export async function listProjects(): Promise<SavedProject[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const projects = await readProjects(db);
    return projects.sort((a, b) => b.savedAt - a.savedAt).map(stripProjectBlobs);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export async function loadProjectRecord(id: string): Promise<SavedProject | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    return await readProject(db, id);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function saveProjectRecord(record: SavedProject): Promise<SaveSessionOutcome> {
  const db = await getDb();
  if (!db) return 'error';
  try {
    await writeProject(db, record);
    return 'ok';
  } catch (err) {
    if (isQuotaExceededError(err)) {
      // eslint-disable-next-line no-console
      console.warn('[mockswap] IndexedDB quota exhausted; project persistence disabled for this save.');
      return 'quota-exceeded';
    }
    // eslint-disable-next-line no-console
    console.warn('[mockswap] IndexedDB project write failed:', err);
    return 'error';
  } finally {
    db.close();
  }
}

export async function deleteProjectRecord(id: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PROJECTS_STORE, 'readwrite');
      const req = tx.objectStore(PROJECTS_STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('IndexedDB project delete failed'));
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mockswap] IndexedDB project delete failed:', err);
  } finally {
    db.close();
  }
}

export async function renameProjectRecord(id: string, name: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    const project = await readProject(db, id);
    if (!project) return;
    await writeProject(db, { ...project, name });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mockswap] IndexedDB project rename failed:', err);
  } finally {
    db.close();
  }
}

export async function listCheckpoints(projectId: string): Promise<Checkpoint[]> {
  const db = await getDb();
  if (!db) return [];
  try {
    const checkpoints = await readCheckpointsForProject(db, projectId);
    return checkpoints.sort((a, b) => b.savedAt - a.savedAt).map(stripCheckpointBlob);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export async function saveCheckpoint(cp: Checkpoint): Promise<SaveSessionOutcome> {
  const db = await getDb();
  if (!db) return 'error';
  try {
    await writeCheckpoint(db, cp);
    return 'ok';
  } catch (err) {
    if (isQuotaExceededError(err)) {
      // eslint-disable-next-line no-console
      console.warn('[mockswap] IndexedDB quota exhausted; checkpoint persistence disabled for this save.');
      return 'quota-exceeded';
    }
    // eslint-disable-next-line no-console
    console.warn('[mockswap] IndexedDB checkpoint write failed:', err);
    return 'error';
  } finally {
    db.close();
  }
}

export async function loadCheckpoint(id: string): Promise<Checkpoint | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    return await readCheckpoint(db, id);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function deleteCheckpoint(id: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHECKPOINTS_STORE, 'readwrite');
      const req = tx.objectStore(CHECKPOINTS_STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('IndexedDB checkpoint delete failed'));
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[mockswap] IndexedDB checkpoint delete failed:', err);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Inner helpers
// ---------------------------------------------------------------------------

function readSession(db: IDBDatabase): Promise<PersistedSession | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY as IDBValidKey);
    req.onsuccess = () => {
      const row = req.result as PersistedSessionV1 | undefined;
      if (!row) {
        resolve(null);
        return;
      }
      if (row.schemaVersion !== SCHEMA_VERSION) {
        // Migration hook: future versions can upgrade here.
        resolve(null);
        return;
      }
      resolve(row as PersistedSession);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
  });
}

function writeSession(db: IDBDatabase, session: PersistedSessionV1): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    const store = tx.objectStore(STORE);
    // Always write at a fixed keyPath value — the object store's keyPath
    // is `schemaVersion` so we must keep that field. Override-on-put is
    // the standard IDB way to "upsert" a single row.
    const row = { ...session, schemaVersion: SCHEMA_VERSION };
    const req = store.put(row);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB write failed'));
  });
}

function readProjects(db: IDBDatabase): Promise<SavedProject[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, 'readonly');
    const req = tx.objectStore(PROJECTS_STORE).getAll();
    req.onsuccess = () => resolve(req.result as SavedProject[]);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB projects read failed'));
  });
}

function readProject(db: IDBDatabase, id: string): Promise<SavedProject | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, 'readonly');
    const req = tx.objectStore(PROJECTS_STORE).get(id);
    req.onsuccess = () => resolve((req.result as SavedProject | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB project read failed'));
  });
}

function writeProject(db: IDBDatabase, record: SavedProject): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB project transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB project transaction aborted'));
    const req = tx.objectStore(PROJECTS_STORE).put(record);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB project write failed'));
  });
}

function readCheckpointsForProject(db: IDBDatabase, projectId: string): Promise<Checkpoint[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHECKPOINTS_STORE, 'readonly');
    const req = tx.objectStore(CHECKPOINTS_STORE).index(CHECKPOINTS_PROJECT_INDEX).getAll(projectId);
    req.onsuccess = () => resolve(req.result as Checkpoint[]);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB checkpoints read failed'));
  });
}

function readCheckpoint(db: IDBDatabase, id: string): Promise<Checkpoint | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHECKPOINTS_STORE, 'readonly');
    const req = tx.objectStore(CHECKPOINTS_STORE).get(id);
    req.onsuccess = () => resolve((req.result as Checkpoint | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB checkpoint read failed'));
  });
}

function writeCheckpoint(db: IDBDatabase, cp: Checkpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHECKPOINTS_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB checkpoint transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB checkpoint transaction aborted'));
    const req = tx.objectStore(CHECKPOINTS_STORE).put(cp);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB checkpoint write failed'));
  });
}

function stripProjectBlobs(project: SavedProject): SavedProject {
  const metadata = { ...project } as Partial<SavedProject>;
  delete metadata.mutatedZipBlob;
  delete metadata.originalZipBlob;
  return metadata as SavedProject;
}

function stripCheckpointBlob(checkpoint: Checkpoint): Checkpoint {
  const metadata = { ...checkpoint } as Partial<Checkpoint>;
  delete metadata.mutatedZipBlob;
  return metadata as Checkpoint;
}

function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'QuotaExceededError' ||
    candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    candidate.code === 22 ||
    candidate.code === 1014
  );
}
