// Plan documents: loaded from /data (copied from PT Bot's seed by scripts/sync-seed.sh), versioned in IndexedDB.
import { docHash, clone } from "./util.js";
import { migrateState } from "./patch.js";
import { initState } from "./engine.js";
import { setPostureConfig, initPostureState } from "./posture.js";
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
  // posture-cycle.json is not part of plan patches, so it stays out of the plan hash and is refreshed on its own.
  const posture = await fetchJson("data/posture-cycle.json").catch(() => null);
  return { levels, exercises, tests, config, posture, hash };
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
  // Posture-cycle config (timer phases and R16): always follows the bundled seed, even when an agent patch was applied to the plan.
  if (seed?.posture && docs && JSON.stringify(docs.posture) !== JSON.stringify(seed.posture)) { docs = { ...docs, posture: seed.posture }; await store.kvSet("docs", docs); }
  // Phase B migration for data saved before the work timer existed.
  const B0 = { sitting_min: DEFAULT_PROFILE.baselines.sitting_min };
  if (profile) {
    let dirty = false;
    if (profile.baselines && profile.baselines.sitting_min === undefined) { profile.baselines.sitting_min = B0.sitting_min; dirty = true; }
    if (!profile.settings?.posture_cycle) { profile.settings = { ...(profile.settings || {}), posture_cycle: clone(DEFAULT_PROFILE.settings.posture_cycle) }; dirty = true; }
    if (profile.equipment && profile.equipment.cable_stack === undefined) { profile.equipment.cable_stack = true; dirty = true; }
    if (profile.equipment && profile.equipment.cable_stack_lb === undefined) { profile.equipment.cable_stack_lb = (DEFAULT_PROFILE.equipment.cable_stack_lb || []).slice(); dirty = true; }
    if (dirty) await store.kvSet("profile", profile);
  }
  if (docs?.posture) {
    setPostureConfig(docs.posture);
    if (state) {
      let dirty = false;
      if (!state.posture_cycle) { state.posture_cycle = initPostureState(docs.posture, state.level_id); dirty = true; }
      if (state.baselines && state.baselines.sitting_min === undefined) { state.baselines = { ...state.baselines, sitting_min: profile?.baselines?.sitting_min ?? 20 }; dirty = true; }
      if (dirty) await store.kvSet("state", state);
    }
  }
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
  if (docs?.posture) setPostureConfig(docs.posture);
  if (!state && docs) {
    state = newState(docs, profile, app.start_level || "L2", now);
    await store.kvSet("state", state);
  }
  return { docs, profile, app, state, resynced };
}

export function newState(docs, profile, levelId, now) {
  const st = initState(docs.levels, levelId, { now, baselines: profile.baselines });
  if (docs.posture) st.posture_cycle = initPostureState(docs.posture, levelId);
  return st;
}
