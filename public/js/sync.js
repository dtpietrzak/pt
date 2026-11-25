// Cloud sync core (no Firebase imports, so Node tests can drive it with a fake remote).
//
// Model: IndexedDB stays the source of truth on each device. Every record in every store is
// mirrored to one Firestore doc users/{uid}/{store}/{docId} = { k, d, u, del }:
//   k   original key (string)          d   JSON of the record (null for a tombstone)
//   u   updatedAt in epoch ms          del tombstone flag
// Conflicts resolve last-write-wins per record on u. Local per-record metadata lives in the
// META store: { id, store, key, u, dirty, del }.
import { STORES, META } from "./db.js";

export const SYNC_STORES = Object.keys(STORES);
// Stamps for writes that are not real edits, so a device's real data always beats them:
export const BOOT_U = 1;   // defaults written while the app boots (fresh profile, app settings, ...)
export const LEGACY_U = 2; // data saved before sync existed, adopted on first sign-in

export const docIdFor = (key) => encodeURIComponent(String(key)).replace(/\./g, "%2E");
export const metaId = (store, key) => `${store}/${docIdFor(key)}`;
/** The unpatched plan ("kv/docs") is rebuilt from the bundled seed on every device, so it never syncs. */
export const syncable = (store, value) => !(store === "kv" && value?.key === "docs" && !value?.value?.patched);
/** Last-write-wins: which side should move? */
export function decide(localU, remoteU) {
  if (remoteU > localU) return "pull";
  if (remoteU < localU) return "push";
  return "same";
}
export function toRemote(meta, value) {
  const del = !!meta.del || value === undefined;
  return { k: String(meta.key), d: del ? null : JSON.stringify(value), u: meta.u, del };
}

/** Wraps a db.js store so every put/del is stamped and marked dirty for the next push. */
export function createSyncedStore(base, { now = () => Date.now() } = {}) {
  let booting = true;
  const listeners = new Set();
  async function stamp(store, key, del) {
    const id = metaId(store, key);
    const prev = await base.get(META, id);
    const u = booting ? (prev?.u ?? BOOT_U) : Math.max(now(), (prev?.u ?? 0) + 1);
    await base.put(META, { id, store, key: String(key), u, dirty: true, del });
    listeners.forEach((fn) => fn());
  }
  return {
    ...base,
    base,
    async put(store, value) {
      await base.put(store, value);
      if (store !== META && syncable(store, value)) await stamp(store, value[STORES[store]], false);
      return value;
    },
    async del(store, key) {
      await base.del(store, key);
      if (store !== META) await stamp(store, key, true);
    },
    /** Call once boot is finished: from then on writes are real edits stamped with the clock. */
    endBoot() { booting = false; },
    onDirty(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/**
 * remote: {
 *   subscribe(store, onRecords(records, fromCache), onError) -> unsubscribe
 *   pushIfNewer(store, docId, rec) -> { applied: true } | { applied: false, remote: rec }   (atomic compare on u)
 * }
 */
export function createSyncEngine(store, remote, { onApplied = () => {}, onStatus = () => {} } = {}) {
  const base = store.base ?? store;
  const unsubs = [];
  let stopped = false, ready = false, pushing = null, again = false, lastSync = null, error = null;

  const status = async () => {
    const pending = (await base.all(META)).filter((m) => m.dirty).length;
    onStatus({ ready, pending, lastSync, error });
  };

  async function adoptLegacy() {
    const known = new Set((await base.all(META)).map((m) => m.id));
    for (const s of SYNC_STORES) {
      for (const v of await base.all(s)) {
        if (!syncable(s, v)) continue;
        const key = v[STORES[s]], id = metaId(s, key);
        if (!known.has(id)) await base.put(META, { id, store: s, key: String(key), u: LEGACY_U, dirty: true, del: false });
      }
    }
  }

  /** Merge one remote record into IndexedDB. Returns true when local data changed. */
  async function applyRemote(s, rec) {
    if (!rec || typeof rec.k !== "string" || typeof rec.u !== "number") return false;
    const id = metaId(s, rec.k);
    const m = await base.get(META, id);
    const d = decide(m?.u ?? 0, rec.u);
    if (d === "pull") {
      if (rec.del) await base.del(s, rec.k);
      else await base.put(s, JSON.parse(rec.d));
      await base.put(META, { id, store: s, key: rec.k, u: rec.u, dirty: false, del: !!rec.del });
      return true;
    }
    if (d === "push" && m && !m.dirty) await base.put(META, { ...m, dirty: true });
    return false;
  }

  async function pushOnce() {
    let changed = false;
    for (const m of (await base.all(META)).filter((x) => x.dirty)) {
      if (stopped) return changed;
      const value = m.del ? undefined : await base.get(m.store, m.key);
      if (value !== undefined && !syncable(m.store, value)) { await base.put(META, { ...m, dirty: false }); continue; }
      const res = await remote.pushIfNewer(m.store, docIdFor(m.key), toRemote(m, value));
      if (res.applied) {
        const cur = await base.get(META, m.id);
        if (cur && cur.u === m.u) await base.put(META, { ...cur, dirty: false });
      } else if (res.remote && await applyRemote(m.store, res.remote)) changed = true;
    }
    return changed;
  }

  /** Push every dirty record. Safe to call often; concurrent calls coalesce. */
  async function push() {
    if (!ready || stopped) return;
    if (pushing) { again = true; return pushing; }
    pushing = (async () => {
      try {
        do {
          again = false;
          if (await pushOnce()) onApplied();
        } while (again && !stopped);
        lastSync = new Date(); error = null;
      } catch (e) { error = e; }
      finally { pushing = null; await status(); }
    })();
    return pushing;
  }

  /** Adopt local-only data, subscribe to every store, push once every store has a server snapshot. */
  async function start() {
    await adoptLegacy();
    await status();
    const waiting = new Set(SYNC_STORES);
    let applyQueue = Promise.resolve();
    for (const s of SYNC_STORES) {
      unsubs.push(remote.subscribe(s, (records, fromCache) => {
        applyQueue = applyQueue.then(async () => {
          let changed = false;
          for (const r of records) if (await applyRemote(s, r)) changed = true;
          if (changed && !stopped) onApplied();
          if (!fromCache && waiting.delete(s) && waiting.size === 0) { ready = true; lastSync = new Date(); await push(); }
          else await status();
        }).catch((e) => { error = e; return status(); });
      }, (e) => { error = e; status(); }));
    }
    let t;
    if (store.onDirty) unsubs.push(store.onDirty(() => { clearTimeout(t); t = setTimeout(push, 400); }));
    return applyQueue;
  }

  function stop() { stopped = true; unsubs.splice(0).forEach((u) => u()); }
  return { start, stop, push, applyRemote, adoptLegacy, get ready() { return ready; } };
}
