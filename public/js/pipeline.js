// Glue between the synced IndexedDB store and the pure engine. No DOM; takes any store with get/all/put/kvGet/kvSet,
// so Node tests run it against an in-memory store.
import { runEngine, manualEvent, levelById, SESSION_BLOCKS, currentDose, recordGateResults, evaluateCheckIn } from "./engine.js";
import { isoLocal, ulid, clone, localDate, addDays, docHash } from "./util.js";
import { buildExport } from "./export.js";
import { BODY_WEIGHT_LB, SPORTS } from "./defaults.js";
import { validatePatch, migrateState } from "./patch.js";

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
  if (!same(stable(prev), stable(r.state))) {
    const written = await writeState(store, r.state);
    if (written !== r.state) return { state: written, evals: r.evals, daily: r.daily, sessEvals: r.sessions, log: [], changed: false };
    changed = true;
  }
  await snapshotStateAt(store, now, r.state);
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
  if ((await writeState(store, r.state)) !== r.state) return { ...r, state: await store.kvGet("state"), log: [] };
  for (const e of r.log) await store.put("log", e);
  return r;
}

/** Any manual engine event (flare, pause, resume, skip_optional_test, red_report). Persists state and log. */
export async function manual(store, docs, profile, ev, { now = new Date(), newId = () => ulid() } = {}) {
  const prev = await store.kvGet("state");
  const r = manualEvent(prev, docs.levels, engineConfig(docs, profile), ev, isoLocal(now), newId);
  if ((await writeState(store, r.state)) !== r.state) return { ...r, state: await store.kvGet("state"), log: [] };
  for (const e of r.log) await store.put("log", e);
  return r;
}

/**
 * Record a gate-test session's results against the plan state (provisional pass or fail) and save the session with
 * each result's pass/fail. Call when the session is saved, and again once its post-workout check-in exists (that
 * check-in's symptoms can turn a pass into a fail). Returns the updated state.
 */
export async function recordGate(store, docs, profile, sessionId, { now = new Date(), newId = () => ulid() } = {}) {
  const session = await store.get("sessions", sessionId);
  if (!session || session.template !== "gate_test") return null;
  const state = await store.kvGet("state");
  // Once the engine has confirmed one of these tests, its result is settled; don't reopen it.
  if ((session.gate_results || []).some((g) => state.gate_tests?.[g.test_id]?.status === "pass_confirmed" && state.gate_tests[g.test_id].session_id === sessionId)) return null;
  const cfg = engineConfig(docs, profile);
  const post = session.post_workout_checkin_id ? await store.get("checkins", session.post_workout_checkin_id) : null;
  const postEval = post ? evaluateCheckIn(post, state.baselines, cfg, {}) : null;
  const ss = clone(session);
  const r = recordGateResults(state, ss, docs.levels, docs.tests, postEval);
  if ((await writeState(store, r.state)) !== r.state) return { ...r, state: await store.kvGet("state"), log: [] };
  await store.put("sessions", ss);
  // Called at gate save and again after the post-workout check-in; don't log the same line twice.
  const seen = new Set((await store.all("log")).filter((l) => (l.session_id ?? sessionId) === sessionId).map((l) => l.message));
  for (const e of r.log) if (!seen.has(e.message)) await store.put("log", { id: newId(), ts: isoLocal(now), session_id: sessionId, ...e });
  return r;
}

/** Persist plan state, but never let a stale in-memory copy overwrite a newer "Restart at level". */
export async function writeState(store, next) {
  const cur = await store.kvGet("state");
  const a = cur?.x?.restarted_at, b = next?.x?.restarted_at;
  if (a && (!b || a > b)) return cur;
  await store.kvSet("state", next);
  return next;
}

async function snapshotStateAt(store, now, state) {
  const key = `state_at:${localDate(now)}`;
  const prev = await store.kvGet(key);
  if (!prev || !same(stable(prev), stable(state))) await store.kvSet(key, state);
}

/** Build the weekly export from everything in the store. Runs the engine once so colors are current. */
export async function gatherExport(store, docs, profile, {
  start, end, now = new Date(), userNotes = "", appVersion = "pt.davidp.dev", agentBrief,
} = {}) {
  const today = localDate(now);
  const r = await evaluate(store, docs, profile, { now });
  const [checkins, sessions, days, decisionLog, patchLog] = await Promise.all([
    store.all("checkins"), store.all("sessions"), store.all("days"), store.all("log"), store.all("patches").catch(() => []),
  ]);
  const dayMap = Object.fromEntries(days.map((d) => [d.local_date, d]));
  const stateEnd = today <= end ? r.state : (await store.kvGet(`state_at:${end}`)) || r.state;
  const stateStart = (await store.kvGet(`state_at:${addDays(start, -1)}`)) || (await store.kvGet(`state_at:${start}`)) || r.state;
  const hashes = {
    levels_sha256: await docHash(docs.levels),
    exercises_sha256: await docHash(docs.exercises),
    tests_sha256: await docHash(docs.tests),
  };
  if (profile) hashes.profile_sha256 = await docHash(profile);
  if (docs.posture) hashes.posture_cycle_sha256 = await docHash(docs.posture);
  const sport = SPORTS.join(" + ");
  const exportProfile = profile ? { ...profile, body_weight_lb: BODY_WEIGHT_LB, sports: SPORTS.slice() } : profile;
  return buildExport({
    start, end, today, now: isoLocal(now), appVersion, config: docs.config, levels: docs.levels, hashes,
    profile: exportProfile, sport, stateStart, stateEnd, checkins, evals: r.evals, sessions, allSessions: sessions,
    days: dayMap, daily: r.daily, decisionLog, patchLog, userNotes, agentBrief,
  });
}

/** Apply a validated plan patch: snapshot, increment plan_version, migrate state, record the log. */
export async function applyPlanPatch(store, docs, profile, patch, schemas, { now = new Date(), confirmSafety = false, newId = () => ulid() } = {}) {
  const current = { levels: docs.levels, exercises: docs.exercises, tests: docs.tests };
  const review = await validatePatch(patch, current, schemas);
  if (!review.ok) return { ok: false, review };
  if (review.safety.length && !confirmSafety) return { ok: false, needsSafetyConfirm: true, review };
  const snapId = newId();
  const snapshot = {
    id: snapId, ts: isoLocal(now), patch_id: patch.patch_id,
    docs: { levels: docs.levels, exercises: docs.exercises, tests: docs.tests, seed_hash: docs.seed_hash, patched: !!docs.patched, hash: docs.hash },
    state: await store.kvGet("state"),
  };
  await store.put("snapshots", snapshot);
  const nextLevels = { ...review.next.levels, plan_version: (docs.levels.plan_version ?? 1) + 1 };
  const nextDocs = { ...docs, levels: nextLevels, exercises: review.next.exercises, tests: review.next.tests, patched: true };
  const testsChanged = JSON.stringify(docs.tests) !== JSON.stringify(review.next.tests);
  const prevState = await store.kvGet("state");
  const state = prevState ? migrateState(prevState, docs.levels, nextLevels, testsChanged) : prevState;
  await store.kvSet("docs", nextDocs);
  if (state) await store.kvSet("state", state);
  const rec = {
    ...patch, status: "applied", applied_at: isoLocal(now), snapshot_id: snapId,
    plan_version_before: docs.levels.plan_version ?? 1, plan_version_after: nextLevels.plan_version,
    safety: review.safety,
  };
  await store.put("patches", rec);
  return { ok: true, docs: nextDocs, state, review, rec };
}

/** Roll back the most recent applied patch from its snapshot. Later training is kept; item state is migrated. */
export async function revertPlanPatch(store, docs, patchId, { now = new Date() } = {}) {
  const rec = await store.get("patches", patchId);
  if (!rec || rec.status !== "applied") return { ok: false, error: "That patch is not currently applied." };
  const applied = (await store.all("patches")).filter((p) => p.status === "applied").sort((a, b) => (a.applied_at < b.applied_at ? 1 : -1));
  if (applied[0]?.patch_id !== patchId) return { ok: false, error: "Revert the most recent applied patch first." };
  const snap = await store.get("snapshots", rec.snapshot_id);
  if (!snap?.docs) return { ok: false, error: "The snapshot for this patch is missing." };
  const oldDocs = { ...docs, levels: snap.docs.levels, exercises: snap.docs.exercises, tests: snap.docs.tests, seed_hash: snap.docs.seed_hash, patched: !!snap.docs.patched, hash: snap.docs.hash };
  const prevState = await store.kvGet("state");
  const state = prevState ? migrateState(prevState, docs.levels, oldDocs.levels, JSON.stringify(docs.tests) !== JSON.stringify(oldDocs.tests)) : prevState;
  await store.kvSet("docs", oldDocs);
  if (state) await store.kvSet("state", state);
  await store.put("patches", { ...rec, status: "reverted", reverted_at: isoLocal(now) });
  return { ok: true, docs: oldDocs, state };
}

export async function rejectPlanPatch(store, patch, reason, { now = new Date() } = {}) {
  const rec = { ...patch, status: "rejected", rejected_at: isoLocal(now), rejected_reason: reason || "Discarded" };
  await store.put("patches", rec);
  return rec;
}
