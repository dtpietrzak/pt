// Plan documents: loaded from /data (copied from PT Bot's seed by scripts/sync-seed.sh), versioned in IndexedDB.
import { docHash, clone } from "./util.js";
import { migrateState } from "./patch.js";
import { initState } from "./engine.js";
import { DEFAULT_PROFILE, DEFAULT_APP } from "./defaults.js";

const FILES = ["levels", "exercises", "tests", "decision-config"];
async function fetchJson(path) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
export async function fetchSeed() {
  const [levels, exercises, tests, config] = await Promise.all(FILES.map((f) => fetchJson(`data/${f}.json`)));
  const hash = await docHash({ levels, exercises, tests, config });
  return { levels, exercises, tests, config, hash };
}
async function seedProfile() {
  try { return await fetchJson("data/profile.json"); } catch { return null; }
}
const deepMerge = (a, b) => {
  if (!b || typeof b !== "object" || Array.isArray(b)) return b ?? a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = a && typeof a[k] === "object" && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  return out;
};

/** Load or initialise everything. Returns { docs, profile, app, state, resynced }. */
export async function boot(store, now) {
  let docs = await store.kvGet("docs");
  let state = await store.kvGet("state");
  let profile = await store.kvGet("profile");
  let app = await store.kvGet("app");
  let seed = null, resynced = false;
  try { seed = await fetchSeed(); } catch (e) { if (!docs) throw e; }
  if (!profile) {
    // seed/profile.json from PT Bot is the default profile; the built-in copy is only an offline fallback.
    profile = deepMerge(clone(DEFAULT_PROFILE), await seedProfile());
    app = clone(DEFAULT_APP);
    await store.kvSet("profile", profile); await store.kvSet("app", app);
  }
  if (profile && "clinician_contact" in profile) { delete profile.clinician_contact; await store.kvSet("profile", profile); } // dropped by David
  app = { ...DEFAULT_APP, ...(app || {}) };
  if (!docs && seed) {
    docs = { ...seed, seed_hash: seed.hash, patched: false };
    await store.kvSet("docs", docs);
  } else if (seed && docs.seed_hash !== seed.hash && !docs.patched) {
    // PT Bot updated the seed and no agent patch has been applied locally: take the new plan.
    const old = docs.levels;
    docs = { ...seed, seed_hash: seed.hash, patched: false };
    await store.kvSet("docs", docs);
    if (state && docs.levels.levels.some((l) => l.id === state.level_id)) {
      state = migrateState(state, old, docs.levels, true);
      await store.kvSet("state", state);
    }
    resynced = true;
  }
  return { docs, profile, app, state, resynced };
}

export function newState(docs, profile, levelId, now) {
  return initState(docs.levels, levelId, { now, baselines: profile.baselines });
}
