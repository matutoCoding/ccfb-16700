import type { ScenarioCase, Settings } from '../types';
import { defaultSettings } from '../data/presets';

const DB_NAME = 'solar-insolation-studio';
const DB_VERSION = 1;
const STORE_CASES = 'cases';
const STORE_KV = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CASES)) db.createObjectStore(STORE_CASES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = run(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

export async function getAllCases(): Promise<ScenarioCase[]> {
  return tx<ScenarioCase[]>(STORE_CASES, 'readonly', (s) => s.getAll() as IDBRequest<ScenarioCase[]>);
}
export async function putCase(item: ScenarioCase): Promise<IDBValidKey> {
  return tx(STORE_CASES, 'readwrite', (s) => s.put(item));
}
export async function deleteCase(id: string): Promise<undefined> {
  await tx(STORE_CASES, 'readwrite', (s) => s.delete(id));
}
export async function getSettings(): Promise<Settings> {
  const saved = await tx<Settings | undefined>(STORE_KV, 'readonly', (s) => s.get('settings') as IDBRequest<Settings | undefined>);
  return { ...defaultSettings, ...(saved ?? {}) };
}
export async function saveSettings(settings: Settings): Promise<IDBValidKey> {
  return tx(STORE_KV, 'readwrite', (s) => s.put(settings, 'settings'));
}
