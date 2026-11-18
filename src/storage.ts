import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AppConfig } from './config';
import { PovtorError } from './errors';
import { isSaneSet, toCsv, validateSet } from './history';
import type { RepRecord, SetRecord } from './types';

export interface Settings {
  key: 'main';
  voiceEnabled: boolean;
  modelVariant: 'auto' | 'lite' | 'full';
}

export const DEFAULT_SETTINGS: Settings = { key: 'main', voiceEnabled: true, modelVariant: 'auto' };

interface PovtorDB extends DBSchema {
  sets: { key: string; value: SetRecord; indexes: { byStart: string } };
  reps: { key: [string, number]; value: RepRecord; indexes: { bySet: string } };
  settings: { key: string; value: Settings };
}

let dbPromise: Promise<IDBPDatabase<PovtorDB>> | null = null;

function db(): Promise<IDBPDatabase<PovtorDB>> {
  if (!('indexedDB' in globalThis)) return Promise.reject(new PovtorError('STORAGE_UNAVAILABLE', 'no indexedDB'));
  dbPromise ??= openDB<PovtorDB>('povtor', 1, {
    upgrade(d) {
      const sets = d.createObjectStore('sets', { keyPath: 'id' });
      sets.createIndex('byStart', 'startedAt');
      const reps = d.createObjectStore('reps', { keyPath: ['setId', 'index'] });
      reps.createIndex('bySet', 'setId');
      d.createObjectStore('settings', { keyPath: 'key' });
    },
    // браузер оборвал соединение (бывает на iOS после фона) — в следующий раз откроем заново
    terminated() {
      dbPromise = null;
    },
    // другая вкладка открывает новую версию базы — уступаем ей, сами переоткроемся при следующем обращении
    blocking(_current, _next, event) {
      (event.target as IDBDatabase).close();
      dbPromise = null;
    },
  }).catch((e) => {
    dbPromise = null;
    throw new PovtorError('STORAGE_UNAVAILABLE', String(e));
  });
  return dbPromise;
}

function wrap(e: unknown): PovtorError {
  if (e instanceof PovtorError) return e;
  const name = (e as DOMException)?.name;
  if (name === 'QuotaExceededError') return new PovtorError('STORAGE_FULL', name);
  // соединение закрыто — следующая попытка откроет базу заново
  if (name === 'InvalidStateError') dbPromise = null;
  return new PovtorError('STORAGE_UNAVAILABLE', String(e));
}

let persistAsked = false;
/** Просим браузер не удалять историю при нехватке места (Safari иначе может стереть её через 7 дней без посещений). */
function askPersist(): void {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => undefined);
}

/** Сохраняет подход и повторения одной транзакцией. */
export async function saveSet(set: SetRecord, reps: RepRecord[], config: AppConfig): Promise<void> {
  const problems = validateSet(set, reps, config);
  if (problems.length) {
    console.error('VALIDATION', problems, set, reps);
    throw new PovtorError('VALIDATION', problems.join(', '));
  }
  try {
    const d = await db();
    const tx = d.transaction(['sets', 'reps'], 'readwrite');
    const store = tx.objectStore('reps');
    // черновик подхода мог сохранить больше повторений, чем итог (не бывает, но лишние не оставляем)
    const old = await store.index('bySet').getAllKeys(set.id);
    await Promise.all([
      tx.objectStore('sets').put(set),
      ...old.filter(([, i]) => i > reps.length).map((k) => store.delete(k)),
      ...reps.map((r) => store.put(r)),
      tx.done,
    ]);
  } catch (e) {
    throw wrap(e);
  }
  askPersist();
}

/** Все подходы, новые сверху. Испорченные записи пропускаются. */
export async function listSets(): Promise<SetRecord[]> {
  try {
    const d = await db();
    const all = await d.getAllFromIndex('sets', 'byStart');
    return all.filter(isSaneSet).reverse();
  } catch (e) {
    throw wrap(e);
  }
}

export async function exportCsv(config: AppConfig): Promise<Blob> {
  try {
    const d = await db();
    const sets = (await d.getAllFromIndex('sets', 'byStart')).filter(isSaneSet).reverse();
    const reps = await d.getAll('reps');
    const bySet = new Map<string, RepRecord[]>();
    for (const r of reps) bySet.set(r.setId, [...(bySet.get(r.setId) ?? []), r]);
    return new Blob([toCsv(sets, bySet, config)], { type: 'text/csv;charset=utf-8' });
  } catch (e) {
    throw wrap(e);
  }
}

export async function clearHistory(): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(['sets', 'reps'], 'readwrite');
    await Promise.all([tx.objectStore('sets').clear(), tx.objectStore('reps').clear(), tx.done]);
  } catch (e) {
    throw wrap(e);
  }
}

export async function loadSettings(): Promise<Settings> {
  try {
    const d = await db();
    return { ...DEFAULT_SETTINGS, ...((await d.get('settings', 'main')) ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  try {
    const d = await db();
    await d.put('settings', s);
  } catch {
    /* настройки не критичны */
  }
}
