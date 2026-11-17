// Persistência local (fica só neste navegador, neste computador):
// - configurações → localStorage (JSON)
// - gravações, pedaços de gravação em andamento, histórico → IndexedDB

const DB_NAME = 'gravador-de-telas';
const DB_VERSION = 1;
const SETTINGS_KEY = 'gravador-de-telas:config';
const LOG_MAX = 1000;

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('recordings', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['rec', 'seq'] });
      db.createObjectStore('log', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function store(name, mode = 'readonly') {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}
const recRange = (rec) => IDBKeyRange.bound([rec, -Infinity], [rec, Infinity]);

// ---------- configurações ----------

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}; } catch { return {}; }
}
export function saveSettings(obj) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj)); } catch { /* modo privado etc. */ }
}

// ---------- chave/valor (ex.: imagem de fundo da câmera) ----------

export const kv = {
  get: async (key) => done((await store('kv')).get(key)),
  set: async (key, value) => done((await store('kv', 'readwrite')).put(value, key)),
  del: async (key) => done((await store('kv', 'readwrite')).delete(key)),
};

// ---------- gravações ----------

export const recordings = {
  all: async () => done((await store('recordings')).getAll()),
  put: async (rec) => done((await store('recordings', 'readwrite')).put(rec)),
  del: async (id) => done((await store('recordings', 'readwrite')).delete(id)),
};

// Pedaços salvos durante a gravação: se a página recarregar no meio, nada se perde.
export const chunks = {
  add: async (rec, seq, blob) => done((await store('chunks', 'readwrite')).put({ rec, seq, blob })),
  of: async (rec) => (await done((await store('chunks')).getAll(recRange(rec)))).map((c) => c.blob),
  clear: async (rec) => done((await store('chunks', 'readwrite')).delete(recRange(rec))),
  pendingIds: async () => [...new Set((await done((await store('chunks')).getAllKeys())).map((k) => k[0]))],
};

// ---------- histórico ----------

let logCount = 0;
export async function log(event, details = {}) {
  try {
    const entry = { ts: new Date().toISOString(), event, versao: self.APP_VERSION || '0.0.0', ...details };
    await done((await store('log', 'readwrite')).add(entry));
    if (++logCount % 50 === 0) pruneLog();
  } catch { /* histórico é opcional */ }
}
async function pruneLog() {
  const s = await store('log', 'readwrite');
  const keys = await done(s.getAllKeys());
  if (keys.length > LOG_MAX) s.delete(IDBKeyRange.upperBound(keys[keys.length - LOG_MAX - 1]));
}
export async function allLogs() {
  try { return await done((await store('log')).getAll()); } catch { return []; }
}

// ---------- espaço ----------

export async function usage() {
  try {
    const { usage: used = 0, quota = 0 } = await navigator.storage.estimate();
    return { used, quota };
  } catch {
    return null;
  }
}
// Pede ao navegador para não apagar os dados sozinho quando faltar espaço.
export async function askPersistent() {
  try { return (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch { return false; }
}
