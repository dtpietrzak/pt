// Sync merge logic: last-write-wins per record, first sign-in upload, boot defaults never win.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STORES, META } from "../public/js/db.js";
import { createSyncedStore, createSyncEngine, decide, docIdFor, syncable, BOOT_U, LEGACY_U } from "../public/js/sync.js";

// In-memory stand-in for db.js createStore().
function memStore() {
  const data = Object.fromEntries([...Object.keys(STORES), META].map((s) => [s, new Map()]));
  const kp = (s) => (s === META ? "id" : STORES[s]);
  return {
    data,
    async get(s, k) { const v = data[s].get(k); return v === undefined ? undefined : structuredClone(v); },
    async all(s) { return [...data[s].values()].map((v) => structuredClone(v)); },
    async put(s, v) { data[s].set(v[kp(s)], structuredClone(v)); return v; },
    async del(s, k) { data[s].delete(k); },
    async kvGet(key) { return (await this.get("kv", key))?.value; },
    async kvSet(key, value) { return this.put("kv", { key, value }); },
  };
}
// Firestore stand-in: one shared "server" that several devices subscribe to.
function fakeServer() {
  const docs = new Map(); // "store/docId" -> rec
  const subs = new Set();
  return {
    docs,
    remote() {
      return {
        subscribe(s, cb) {
          const sub = { s, cb };
          subs.add(sub);
          cb([...docs].filter(([k]) => k.startsWith(s + "/")).map(([, v]) => structuredClone(v)), false);
          return () => subs.delete(sub);
        },
        async pushIfNewer(s, id, rec) {
          const cur = docs.get(`${s}/${id}`);
          if (cur && cur.u > rec.u) return { applied: false, remote: structuredClone(cur) };
          if (!cur || cur.u < rec.u) {
            docs.set(`${s}/${id}`, structuredClone(rec));
            for (const sub of subs) if (sub.s === s) sub.cb([structuredClone(rec)], false);
          }
          return { applied: true };
        },
      };
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
async function device(server, clock, { legacy = {}, boot = {} } = {}) {
  const base = memStore();
  for (const [s, vals] of Object.entries(legacy)) for (const v of vals) await base.put(s, v);
  const store = createSyncedStore(base, { now: () => clock.t });
  for (const [k, v] of Object.entries(boot)) await store.kvSet(k, v);
  store.endBoot();
  let applied = 0;
  const engine = createSyncEngine(store, server.remote(), { onApplied: () => applied++ });
  return { base, store, engine, get applied() { return applied; } };
}

test("decide is last-write-wins", () => {
  assert.equal(decide(5, 9), "pull");
  assert.equal(decide(9, 5), "push");
  assert.equal(decide(5, 5), "same");
  assert.equal(decide(0, 1), "pull");
});

test("doc ids are Firestore-safe", () => {
  assert.equal(docIdFor("wake:2026-11-25"), "wake%3A2026-11-25");
  assert.equal(docIdFor("a/b"), "a%2Fb");
  assert.equal(docIdFor(".."), "%2E%2E");
});

test("the unpatched plan never syncs, a patched one does", () => {
  assert.equal(syncable("kv", { key: "docs", value: { patched: false } }), false);
  assert.equal(syncable("kv", { key: "docs", value: { patched: true } }), true);
  assert.equal(syncable("days", { local_date: "2026-11-25" }), true);
});

test("first sign-in uploads existing local data; a second device's boot defaults don't overwrite it", async () => {
  const server = fakeServer(), clock = { t: 1_800_000_000_000 };
  const phone = await device(server, clock, { legacy: {
    kv: [{ key: "profile", value: { body_weight_lb: 182 } }, { key: "state", value: { level_id: "L1" } }, { key: "docs", value: { patched: false } }],
    days: [{ local_date: "2026-11-24", checklist: ["a"] }],
  } });
  await phone.engine.start(); await settle();
  assert.equal(server.docs.get("kv/profile").u, LEGACY_U);
  assert.ok(server.docs.has("days/2026-11-24"));
  assert.ok(!server.docs.has("kv/docs"), "unpatched plan is not uploaded");

  // Laptop: fresh install, boot wrote default profile before sign-in.
  const laptop = await device(server, clock, { boot: { profile: { body_weight_lb: 180 }, app: { start_level: "L1" } } });
  assert.equal((await laptop.base.get(META, "kv/profile")).u, BOOT_U);
  await laptop.engine.start(); await settle();
  assert.deepEqual(await laptop.store.kvGet("profile"), { body_weight_lb: 182 }, "phone's real profile wins");
  assert.deepEqual(await laptop.store.kvGet("state"), { level_id: "L1" });
  assert.deepEqual(await laptop.base.get("days", "2026-11-24"), { local_date: "2026-11-24", checklist: ["a"] });
  assert.equal(server.docs.get("kv/profile").d, JSON.stringify({ key: "profile", value: { body_weight_lb: 182 } }));
  assert.ok(laptop.applied > 0, "app is told to reload");
});

test("live edits flow both ways and the newest write wins", async () => {
  const server = fakeServer(), clock = { t: 1_800_000_000_000 };
  const a = await device(server, clock), b = await device(server, clock);
  await a.engine.start(); await b.engine.start(); await settle();

  clock.t += 1000;
  await a.store.put("days", { local_date: "2026-11-25", checklist: ["walk"] });
  await a.engine.push(); await settle();
  assert.deepEqual(await b.base.get("days", "2026-11-25"), { local_date: "2026-11-25", checklist: ["walk"] });

  // b edits later (newer) while a edits earlier but pushes last: b's newer write must survive.
  clock.t += 1000; await a.store.put("days", { local_date: "2026-11-25", checklist: ["walk", "core"] });
  clock.t += 1000; await b.store.put("days", { local_date: "2026-11-25", checklist: ["walk", "relief"] });
  await b.engine.push(); await settle();
  await a.engine.push(); await settle();
  const want = { local_date: "2026-11-25", checklist: ["walk", "relief"] };
  assert.equal(server.docs.get("days/2026-11-25").d, JSON.stringify(want));
  assert.deepEqual(await a.base.get("days", "2026-11-25"), want, "older local edit is replaced");
  assert.equal((await a.base.get(META, "days/2026-11-25")).dirty, false);
});

test("deletes sync as tombstones", async () => {
  const server = fakeServer(), clock = { t: 1_800_000_000_000 };
  const a = await device(server, clock), b = await device(server, clock);
  await a.engine.start(); await b.engine.start(); await settle();
  clock.t += 1000; await a.store.kvSet("wake:2026-11-25", "07:10"); await a.engine.push(); await settle();
  assert.equal(await b.store.kvGet("wake:2026-11-25"), "07:10");
  clock.t += 1000; await a.store.del("kv", "wake:2026-11-25"); await a.engine.push(); await settle();
  const rec = server.docs.get("kv/wake%3A2026-11-25");
  assert.equal(rec.del, true); assert.equal(rec.d, null);
  assert.equal(await b.store.kvGet("wake:2026-11-25"), undefined);
});

test("nothing is pushed before the first server snapshot (offline start)", async () => {
  const clock = { t: 1_800_000_000_000 };
  let pushed = 0;
  const remote = { subscribe(s, cb) { cb([], true); return () => {}; }, async pushIfNewer() { pushed++; return { applied: true }; } };
  const base = memStore();
  await base.put("kv", { key: "profile", value: {} });
  const store = createSyncedStore(base, { now: () => clock.t }); store.endBoot();
  const engine = createSyncEngine(store, remote);
  await engine.start(); await engine.push(); await settle();
  assert.equal(pushed, 0);
  assert.equal(engine.ready, false);
});

test("restart at a level syncs; a later stale write from the other device does not overwrite it", async () => {
  const { writeState } = await import("../public/js/pipeline.js");
  const server = fakeServer(), clock = { t: 1_800_000_000_000 };
  const phone = await device(server, clock, { legacy: { kv: [{ key: "state", value: { level_id: "L2", x: {} } }] } });
  const laptop = await device(server, clock);
  await phone.engine.start(); await laptop.engine.start(); await settle();
  clock.t += 1000;
  // Phone restarts at L1 (Settings > Restart), stamped after endBoot so it is a real edit.
  const restarted = { level_id: "L1", mode: "active", x: { restarted_at: "2026-11-25T16:40:00-06:00" } };
  await phone.store.kvSet("state", restarted);
  await phone.engine.push(); await settle();
  assert.deepEqual(await laptop.store.kvGet("state"), restarted, "laptop pulls the restart");

  // Laptop still had L2 in memory (timer / engine mid-write) and tries to save it later.
  clock.t += 1000;
  const stale = { level_id: "L2", mode: "active", x: {} };
  const written = await writeState(laptop.store, stale);
  assert.equal(written.level_id, "L1", "writeState keeps the newer restart");
  await laptop.engine.push(); await settle();
  assert.equal((await phone.store.kvGet("state")).level_id, "L1", "phone is not overwritten");
  assert.equal(JSON.parse(server.docs.get("kv/state").d).value.level_id, "L1");
});
