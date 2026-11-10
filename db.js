// IndexedDB wrapper: keeps recordings and unsent reports on the device,
// so nothing is lost when the network is down.
const DB_NAME = "saadaxa";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("recordings")) db.createObjectStore("recordings", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  put: (store, value, key) => tx(store, "readwrite", (s) => (key !== undefined ? s.put(value, key) : s.put(value))),
  get: (store, key) => tx(store, "readonly", (s) => s.get(key)),
  del: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
  all: (store) => tx(store, "readonly", (s) => s.getAll()),
  clear: (store) => tx(store, "readwrite", (s) => s.clear()),
};
