// End-to-end engine flow: a simulated week through runEngine, then the weekly export validated against its schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initState, runEngine, levelById, manualEvent } from "../public/js/engine.js";
import { buildExport } from "../public/js/export.js";
import { validate } from "../public/js/schema.js";
import { addDays, docHash } from "../public/js/util.js";

const j = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const levels = j("../public/data/levels.json"), exercises = j("../public/data/exercises.json"), tests = j("../public/data/tests.json");
const config = j("../public/data/decision-config.json"), brief = j("../public/data/agent-brief.json");
const S = (n) => j(`../public/data/schemas/${n}.schema.json`);
const L1 = levelById(levels, "L1");
const A = L1.items.filter((i) => i.block === "strength_A");
const CORE = L1.items.filter((i) => i.block === "daily_core");
const sym = (p = 1) => ({ pain_now: p, sharp_electrical: false, leg_symptoms: "none", numbness_tingling: false });
const RF = { saddle_numbness: false, bladder_bowel_change: false, new_leg_weakness: false, new_numbness_tingling: false, fever_with_back_pain: false, night_pain_unrelieved: false, bilateral_leg_symptoms: false, trauma_since_last_checkin: false };
let n = 0; const id = (p) => `${p}${++n}`;
const morning = (d, o = {}) => ({ type: "morning", id: id("M"), ts: `${d}T08:30:00-06:00`, local_date: d, session_id: null, red_flags: { ...RF, ...(o.rf || {}) }, data: { wake_time: "07:30", protection_window_respected: true, pain_on_waking: o.pain ?? 1, stiffness_min: o.stiff ?? 30, sleep_hours: 7.5, sleep_quality: 4, woke_from_pain_count: 0, hip_shift: false, symptoms: sym(o.pain ?? 1) } });
const evening = (d, o = {}) => ({ type: "evening", id: id("E"), ts: `${d}T19:30:00-06:00`, local_date: d, session_id: null, data: { standing: { first_pressure_h: o.first ?? 5, censored: false, upright_h_total: 7 }, walk_min: o.walk ?? 30, pain_peak_today: o.peak ?? 1, forced_rest_count: 0, activity_limited: false, hip_shift: false, symptoms: sym(1) } });
const night = (d) => ({ type: "night", id: id("N"), ts: `${d}T22:00:00-06:00`, local_date: d, session_id: null, red_flags: RF, data: { bedtime_pain: 1, symptoms: sym(1) } });
const post = (d, sid, o = {}) => ({ type: "post_workout", id: id("P"), ts: `${d}T17:45:00-06:00`, local_date: d, session_id: sid, data: { completed_items: A.map((i) => ({ item_key: i.item_key, completed: true, rung_done: 0, pain_peak: 1 })), pain_peak: o.peak ?? 1, rpe: 5, settle_bucket: "lt_30", form_breakdown: false, symptoms: sym(1) } });
const sess = (d, sid, pid) => ({ id: sid, local_date: d, started_at: `${d}T17:00:00-06:00`, ended_at: `${d}T17:40:00-06:00`, template: "strength_A", level_id: "L1", items: A.map((i) => ({ item_key: i.item_key, prescribed_rung: 0, completed: true, skipped: false })), post_workout_checkin_id: pid, status: "provisional" });

test("a clean week advances strength items and exports a valid document", async () => {
  const start = "2026-11-30";
  let state = initState(levels, "L1", { now: `${start}T07:00:00-06:00` });
  const stateStart = structuredClone(state);
  const checkins = [], sessions = [], days = {}, log = [];
  for (let k = 0; k < 7; k++) {
    const d = addDays(start, k);
    checkins.push(morning(d));
    days[d] = { local_date: d, level_id: "L1", checklist: CORE.map((i) => ({ item_key: i.item_key, done: true })), walk_min: 30 };
    if (k === 0 || k === 2 || k === 4) {
      const sid = `S${k}`; const p = post(d, sid);
      checkins.push(p); sessions.push(sess(d, sid, p.id));
    }
    checkins.push(evening(d), night(d));
    const r = runEngine(state, { checkins, sessions, days }, { levels, tests }, config, `${d}T22:30:00-06:00`);
    state = r.state; log.push(...r.log);
  }
  const r = runEngine(state, { checkins, sessions, days }, { levels, tests }, config, `2026-12-07T09:00:00-06:00`);
  state = r.state; log.push(...r.log);
  const adv = log.filter((e) => e.rule_id === "R5" && e.outcome === "advance");
  assert.ok(adv.length >= 1, JSON.stringify(log.map((e) => e.message)));
  assert.equal(state.mode, "active");
  for (const ss of sessions) Object.assign(ss, r.sessions[ss.id]);
  const out = buildExport({
    start, end: "2026-12-06", today: "2026-12-07", now: "2026-12-07T09:00:00-06:00", appVersion: "test", config, levels,
    hashes: { levels_sha256: await docHash(levels), exercises_sha256: await docHash(exercises) },
    profile: { timezone: "America/Chicago", body_weight_lb: 180, baselines: { pain_rest: 1, stiffness_min: 30, standing_h: 5 } }, sport: "soccer + football",
    stateStart, stateEnd: state, checkins, evals: r.evals, sessions, allSessions: sessions, days, daily: r.daily, decisionLog: log, patchLog: [], userNotes: "test", agentBrief: brief,
  });
  const v = validate(S("weekly-export"), out.json);
  assert.deepEqual(v.errors, []);
  assert.match(out.markdown, /## Status snapshot/);
  assert.equal(out.stem, "pt-export-2026-W49");
});

test("example export from PT Bot validates with our validator", () => {
  assert.deepEqual(validate(S("weekly-export"), j("./fixtures/weekly-export.example.json")).errors, []);
  for (const c of j("./fixtures/checkins.example.json")) assert.deepEqual(validate(S("checkin"), c).errors, []);
});

test("a red flag freezes the plan; clearance enters L0 settle", () => {
  let state = initState(levels, "L2", { now: "2026-12-01T07:00:00-06:00" });
  const ci = [morning("2026-12-01", { rf: { saddle_numbness: true } })];
  const r = runEngine(state, { checkins: ci, sessions: [], days: {} }, { levels, tests }, config, "2026-12-01T09:00:00-06:00");
  assert.equal(r.state.mode, "red_stop");
  assert.equal(r.state.red.kind, "emergency");
  const c = manualEvent(r.state, levels, config, { type: "red_clear", note: "seen by doctor" }, "2026-12-02T09:00:00-06:00");
  assert.equal(c.state.level_id, "L0");
  assert.equal(c.state.mode, "settle");
  assert.equal(c.state.settle.resume_level, "L1");
});

test("orange day steps back and two green days exit settle", () => {
  let state = initState(levels, "L1", { now: "2026-12-01T07:00:00-06:00" });
  state = manualEvent(state, levels, config, { type: "flare" }, "2026-12-01T07:00:00-06:00").state;
  assert.equal(state.level_id, "L0");
  const ci = [morning("2026-12-01"), evening("2026-12-01"), morning("2026-12-02"), evening("2026-12-02"), morning("2026-12-03")];
  const r = runEngine(state, { checkins: ci, sessions: [], days: {} }, { levels, tests }, config, "2026-12-03T09:00:00-06:00");
  assert.equal(r.state.level_id, "L1");
  assert.equal(r.state.mode, "active");
  assert.equal(r.state.lock.easy_dose, true);
});

test("engine pass is idempotent", () => {
  let state = initState(levels, "L1", { now: "2026-12-01T07:00:00-06:00" });
  const ci = [morning("2026-12-01", { stiff: 50 }), evening("2026-12-01"), morning("2026-12-02")];
  const a = runEngine(state, { checkins: ci, sessions: [], days: {} }, { levels, tests }, config, "2026-12-02T09:00:00-06:00");
  const b = runEngine(a.state, { checkins: ci, sessions: [], days: {} }, { levels, tests }, config, "2026-12-02T09:05:00-06:00");
  assert.ok(a.log.some((e) => e.rule_id === "R2"));
  assert.equal(b.log.length, 0);
  assert.equal(b.state.orange_events.length, 1);
});
