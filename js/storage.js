// 자동 저장: IndexedDB (기기 안에만 저장)
const DB = 'coloring-book', STORE = 'kv';
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), st = t.objectStore(STORE);
    const req = fn(st);
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
export const get = key => tx('readonly', s => s.get(key));
export const set = (key, val) => tx('readwrite', s => s.put(val, key));
export const del = key => tx('readwrite', s => s.delete(key));

// 설정은 localStorage
export const prefs = {
  get(k, d) { try { const v = localStorage.getItem('cb.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cb.' + k, JSON.stringify(v)); } catch {} },
};
