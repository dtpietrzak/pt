// Glue between the synced IndexedDB store and the pure engine. No DOM; takes any store with get/all/put/kvGet/kvSet,
// so Node tests run it against an in-memory store.
import { runEngine, manualEvent, levelById, SESSION_BLOCKS, currentDose } from "./engine.js";
import { isoLocal, ulid, clone } from "./util.js";

const SESSION_MODS = new Set(["poor_sleep", "illness", "unusual_load", "missing_morning_checkin", "pause_mode", "easy_dose"]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// last_evaluated_at moves on every run; it alone shouldn't rewrite (and re-sync) the plan state.
const stable = (s) => ({ ...s, last_evaluated_at: null });

/** decision-config with David's pacing setting (profile.settings.clean_exposures_required) applied. */
export function engineConfig(docs, profile) {
  const cfg = clone(docs.config);
  const n = profile?.settings?.clean_exposures_required;
  if (Number.isInteger(n) && n >= 1 && cfg.advance) cfg.advance.clean_exposures_required = n;
  return cfg;
}

export async function loadData(store) {
  const [checkins, sessions, days] = await Promise.all([store.all("checkins"), store.all("sessions"), store.all("days")]);
  return { checkins, sessions, days: Object.fromEntries(days.map((d) => [d.local_date, d])) };
}

/**
 * Run the engine over everything stored and persist what changed: plan state (kv "state"), decision-log entries
 * ("log"), and each session's evaluation. Idempotent. Returns { state, evals, daily, sessEvals, log, changed }.
 */
export async function evaluate(store, docs, profile, { now = new Date(), newId = () => ulid() } = {}) {
  const prev = (await store.kvGet("state"));
  const data = await loadData(store);
  const s = profile?.settings || {};
  data.settings = { cap: s.max_item_changes_per_finalized_session, layoffEnabled: s.layoff_rule_enabled };
  const r = runEngine(prev, data, { levels: docs.levels, tests: docs.tests }, engineConfig(docs, profile), isoLocal(now), newId);
  let changed = false;
  if (!same(stable(prev), stable(r.state))) { await store.kvSet("state", r.state); changed = true; }
  for (const e of r.log) { await store.put("log", e); changed = true; }
  for (const ss of data.sessions) {
    const e = r.sessions[ss.id];
    if (!e) continue;
    const next = { ...ss, status: e.status === "pending" ? "provisional" : e.status, tests: e.tests || {}, modifiers: (e.modifiers || []).filter((m) => SESSION_MODS.has(m)) };
    if (e.final_color) next.final_color = e.final_color; else delete next.final_color;
    if (e.status === "pending") delete next.clean; else next.clean = !!e.clean;
    if (!same(ss, next)) { await store.put("sessions", next); changed = true; }
  }
  return { state: r.state, evals: r.evals, daily: r.daily, sessEvals: r.sessions, log: r.log, changed };
}

/** Items for a workout template at the current level, with the dose now in force. */
export function templateItems(docs, state, template) {
  const lv = levelById(docs.levels, state.level_id);
  const blocks = SESSION_BLOCKS[template] || [];
  return (lv?.items || []).filter((i) => blocks.includes(i.block)).map((item) => ({
    item, rung: Math.min(state.item_state[item.item_key]?.rung ?? item.start_rung, item.rungs.length - 1), dose: currentDose(state, item),
  }));
}

/** Which strength template is next: alternate A/B from the latest strength session (A first). */
export function nextStrengthTemplate(sessions) {
  const last = [...sessions].filter((s) => s.template === "strength_A" || s.template === "strength_B").sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
  return last?.template === "strength_A" ? "strength_B" : "strength_A";
}

export function buildSession({ id, template, state, items, now = new Date(), startedAt }) {
  return {
    id, local_date: isoLocal(now).slice(0, 10), started_at: startedAt || isoLocal(now), ended_at: isoLocal(now), template, level_id: state.level_id,
    items: items.map((i) => ({ item_key: i.item_key, prescribed_rung: i.rung, completed: !!i.completed, skipped: !i.completed })),
    post_workout_checkin_id: null, status: "provisional",
  };
}

/** "Symptoms resolved / a clinician cleared me": the only way out of red stop. Enters settle mode (L0). */
export async function clearRed(store, docs, profile, note, { now = new Date(), newId = () => ulid() } = {}) {
  const prev = await store.kvGet("state");
  const r = manualEvent(prev, docs.levels, engineConfig(docs, profile), { type: "red_clear", note: note || "" }, isoLocal(now), newId);
  await store.kvSet("state", r.state);
  for (const e of r.log) await store.put("log", e);
  return r;
}
