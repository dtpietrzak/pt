// Node has no localStorage; give UI tests a tiny in-memory stand-in.
if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
}
if (typeof globalThis.navigator === "undefined") {
  globalThis.navigator = { onLine: true };
}
