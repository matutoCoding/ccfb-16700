import type { CompareCase, WorkspacePlan } from '../types';

const DB_NAME = 'solar-insight-studio';
const DB_VERSION = 1;
const STORE_PLANS = 'plans';
const STORE_CASES = 'cases';
const STORE_KV = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PLANS)) db.createObjectStore(STORE_PLANS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_CASES)) db.createObjectStore(STORE_CASES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

export async function idbPutPlan(plan: WorkspacePlan): Promise<void> {
  await tx(STORE_PLANS, 'readwrite', (s) => s.put(plan));
}

export async function idbGetPlan(id: string): Promise<WorkspacePlan | undefined> {
  return tx<WorkspacePlan | undefined>(STORE_PLANS, 'readonly', (s) => s.get(id) as IDBRequest<WorkspacePlan | undefined>);
}

export async function idbGetAllPlans(): Promise<WorkspacePlan[]> {
  return tx<WorkspacePlan[]>(STORE_PLANS, 'readonly', (s) => s.getAll() as IDBRequest<WorkspacePlan[]>);
}

export async function idbDeletePlan(id: string): Promise<void> {
  await tx(STORE_PLANS, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function idbPutCompareCase(item: CompareCase): Promise<void> {
  await tx(STORE_CASES, 'readwrite', (s) => s.put(item));
}

export async function idbGetAllCases(): Promise<CompareCase[]> {
  return tx<CompareCase[]>(STORE_CASES, 'readonly', (s) => s.getAll() as IDBRequest<CompareCase[]>);
}

export async function idbDeleteCase(id: string): Promise<void> {
  await tx(STORE_CASES, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function idbSetKV<T>(key: string, value: T): Promise<void> {
  await tx(STORE_KV, 'readwrite', (s) => s.put(value, key));
}

export async function idbGetKV<T>(key: string): Promise<T | undefined> {
  return tx<T | undefined>(STORE_KV, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export async function idbClearAll(): Promise<void> {
  const db = await openDb();
  await Promise.all([STORE_PLANS, STORE_CASES, STORE_KV].map((name) => new Promise<void>((resolve, reject) => {
    const r = db.transaction(name, 'readwrite').objectStore(name).clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  })));
}
