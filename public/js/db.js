// IndexedDB storage: the source of truth on each device (works offline and signed out).
// When signed in, js/sync.js mirrors every store to Firestore; per-record sync metadata lives in META.
const NAME = "pt", VERSION = 2;
export const STORES = { kv: "key", days: "local_date", checkins: "id", sessions: "id", log: "id", patches: "patch_id", snapshots: "id" };

export const META = "sync"; // { id: "store/docId", store, key, u, dirty, del }

export function openDb(idb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const req = idb.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, keyPath] of Object.entries(STORES)) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

export function createStore(db) {
  return {
    async get(store, key) { return wrap(db.transaction(store).objectStore(store).get(key)); },
    async all(store) { return wrap(db.transaction(store).objectStore(store).getAll()); },
    async put(store, value) { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value); await done(tx); return value; },
    async del(store, key) { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).delete(key); await done(tx); },
    async kvGet(key) { return (await this.get("kv", key))?.value; },
    async kvSet(key, value) { return this.put("kv", { key, value }); },
    async clearAll() { const names = [...Object.keys(STORES), META]; const tx = db.transaction(names, "readwrite"); for (const n of names) tx.objectStore(n).clear(); await done(tx); },
    async dump() { const out = {}; for (const n of Object.keys(STORES)) out[n] = await this.all(n); return out; },
  };
}
