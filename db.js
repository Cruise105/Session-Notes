// IndexedDB storage. Everything lives on this device.
//
// SHARED ROSTER: the Bestiary (same GitHub Pages site, so same browser origin)
// can read the party straight from here: database "session-notes", store "pcs".
// Each record: { id, campaignId, name, ancestry, classes, maxHp, ac, pp, active, deleted, updatedAt, ... }

const DB_NAME = 'session-notes';
const DB_VERSION = 4;
export const STORES = ['campaigns', 'pcs', 'sessions', 'ink', 'locations', 'weather', 'diseases', 'cases', 'outbreaks', 'training', 'trades', 'cards'];
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  all: store => tx(store, 'readonly', s => reqP(s.getAll())),
  get: (store, id) => tx(store, 'readonly', s => reqP(s.get(id))),
  put: (store, rec) => tx(store, 'readwrite', s => { s.put(rec); }),
  putMany: (store, list) => tx(store, 'readwrite', s => { list.forEach(r => s.put(r)); }),
  del: (store, id) => tx(store, 'readwrite', s => { s.delete(id); }),
  getMeta: key => tx('meta', 'readonly', s => reqP(s.get(key))),
  setMeta: (key, val) => tx('meta', 'readwrite', s => { s.put(val, key); }),
};

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
