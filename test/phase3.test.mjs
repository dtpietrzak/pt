// Phase 3: level status, gate tests (resolved lb, eligibility, results, confirm -> promote), red report, announcements, equipment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvedLb, thresholdText, levelStatus, gateEligibility, gateResult, buildGateSession, unseenDecisions, decisionCopy, needsEquipConfirm, testable } from "../public/js/status.js";
import { evaluate, recordGate, manual, clearRed } from "../public/js/pipeline.js";
import { buildCheckIn, noFlags } from "../public/js/checkins.js";
import { initState, levelById, evaluateAll, dailyMap } from "../public/js/engine.js";
import { validate } from "../public/js/schema.js";

const j = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const levels = j("../public/data/levels.json"), tests = j("../public/data/tests.json"), config = j("../public/data/decision-config.json");
const profile = j("../public/data/profile.json");
const docs = { levels, tests, config };
const SESSION = j("../public/data/schemas/session.schema.json");
const B = profile.baselines;
const at = (d, hm) => new Date(`${d}T${hm}:00-06:00`);
const T = (id) => tests.tests.find((t) => t.id === id);
const exitTest = (lv, id) => levelById(levels, lv).exit.tests.find((t) => t.test_id === id);
let n = 0;

function memStore() {
  const m = { kv: new Map(), checkins: new Map(), sessions: new Map(), log: new Map(), days: new Map() };
  const keyOf = { checkins: "id", sessions: "id", log: "id", days: "local_date" };
  return {
    async get(s, k) { return m[s].get(k); }, async all(s) { return [...m[s].values()]; },
    async put(s, v) { m[s].set(v[keyOf[s]], structuredClone(v)); return v; },
    async kvGet(k) { return m.kv.get(k); }, async kvSet(k, v) { m.kv.set(k, structuredClone(v)); },
  };
}
const f0 = { leg: "none", flags: noFlags() };
const ci = (type, f, when, x = {}) => buildCheckIn(type, { ...f0, ...f }, { now: when, id: `P3C${++n}`, ...x });
const morning = (d, o = {}) => ci("morning", { pain: o.pain ?? 1, stiffness_min: 25, sleep_hours: 7.5, sleep_quality: 4 }, at(d, "08:30"));
const evening = (d) => ci("evening", { pain: 1, upright_h: 6, no_pressure: true }, at(d, "19:00"));
const night = (d) => ci("night", { pain: 1 }, at(d, "22:00"));

test("body-weight targets are recomputed from the live weight and snapped to 5 lb", () => {
  const thr = exitTest("L6", "T_DL_LOAD").threshold;
  assert.equal(resolvedLb(thr, 180), 135);
  assert.equal(resolvedLb(thr, 200), 150);
  assert.equal(resolvedLb(thr, 195), 145); // 146.25 -> 145
  assert.equal(resolvedLb(exitTest("L8", "T_DL_LOAD").threshold, 180), 270);
  assert.equal(resolvedLb(exitTest("L6", "T_CARRY").threshold, 180), 70);
  assert.equal(resolvedLb(exitTest("L1", "T_WALK_CONT").threshold, 180), null);
  assert.match(thresholdText(T("T_DL_LOAD"), thr, 200), /75% BW \(≈ 150 lb\)/);
  assert.doesNotMatch(thresholdText(T("T_DL_LOAD"), thr, 200), /135/, "no stale 180 lb note");
  assert.equal(thresholdText(T("T_WALK_CONT"), exitTest("L1", "T_WALK_CONT").threshold, 180), "30 min");
  assert.equal(T("T_STAND_FUNC"), undefined);
  assert.equal(exitTest("L1", "T_STAND_FUNC"), undefined);
});

test("level status lists what's needed to advance", () => {
  const state = initState(levels, "L1", { now: "2026-12-01T07:00:00-06:00", baselines: B });
  const st = levelStatus(state, levels, config, tests);
  assert.deepEqual(st.checks.map((c) => c.id), ["items", "streak", "gates"]);
  assert.equal(st.checks[0].ok, false);
  assert.ok(st.rows.length > 0 && st.notAt.length > 0);
  assert.equal(st.gates.length, levelById(levels, "L1").exit.tests.length);
  assert.equal(st.gatePending, false);
  assert.match(st.next, /clean sessions/);
  const settle = levelStatus({ ...state, mode: "settle" }, levels, config, tests);
  assert.match(settle.next, /Settle/);
});

function atTarget(state) {
  const s = structuredClone(state);
  for (const i of levelById(levels, s.level_id).items) if (!i.optional && i.block !== "relief") s.item_state[i.item_key].rung = i.target_rung;
  s.level_clean_streak = levelById(levels, s.level_id).exit.clean_streak_sessions;
  s.gate_pending = true;
  return s;
}

test("gate eligibility needs a green yesterday and a green morning", () => {
  const base = initState(levels, "L1", { now: "2026-12-01T07:00:00-06:00", baselines: B });
  const state = atTarget(base);
  const mk = (cis) => { const evals = evaluateAll(cis, B, config); return { evals, daily: dailyMap(cis, evals), checkins: cis }; };
  const status = levelStatus(state, levels, config, tests);
  const today = "2026-12-03", y = "2026-12-02";
  const g = (cis, st = state) => gateEligibility({ state: st, status, ...mk(cis), today });
  assert.equal(g([]).ok, false);
  assert.match(g([]).why, /green yesterday/);
  assert.match(g([morning(y)]).why, /morning's check-in first/);
  assert.match(g([morning(y), morning(today, { pain: 6 })]).why, /green morning|green yesterday/);
  const ok = g([morning(y), evening(y), night(y), morning(today)]);
  assert.equal(ok.ok, true);
  assert.ok(ok.groups.length >= 2);
  assert.equal(g([morning(y), morning(today)], { ...state, gate_pending: false }).ok, false);
  assert.equal(g([morning(y), morning(today)], { ...state, mode: "settle" }).ok, false);
  assert.equal(testable({ status: "fail", retestAfter: 1 }), false);
  assert.equal(testable({ status: "fail", retestAfter: 0 }), true);
  assert.equal(testable({ status: "pass_provisional", retestAfter: 0 }), false);
});

test("gate results: numeric targets, yes/no targets, form and pain", () => {
  const walk = exitTest("L1", "T_WALK_CONT"), dl = exitTest("L6", "T_DL_LOAD");
  assert.equal(gateResult(T("T_WALK_CONT"), walk.threshold, { value: 30, form_ok: true, pain_peak: 1 }).passed, true);
  assert.equal(gateResult(T("T_WALK_CONT"), walk.threshold, { value: 25, form_ok: true, pain_peak: 1 }).passed, false);
  assert.equal(gateResult(T("T_WALK_CONT"), walk.threshold, { value: 35, form_ok: false, pain_peak: 0 }).passed, false);
  assert.equal(gateResult(T("T_WALK_CONT"), walk.threshold, { value: 35, form_ok: true, pain_peak: 3 }).passed, false);
  const yes = gateResult(T("T_DL_LOAD"), dl.threshold, { met: true, form_ok: true, pain_peak: 0 });
  assert.equal(yes.value, "met");
  assert.equal(yes.passed, true);
  assert.equal(gateResult(T("T_DL_LOAD"), dl.threshold, { met: false, form_ok: true, pain_peak: 0 }).passed, false);
});

test("gate tests flow: results -> provisional -> green morning confirms -> promotion with an announcement", async () => {
  const store = memStore();
  const state = atTarget(initState(levels, "L1", { now: "2026-11-30T07:00:00-06:00", baselines: B }));
  state.x.level_started_on = "2026-11-29"; state.x.layoff_anchor = "2026-11-29";
  await store.kvSet("state", state);
  const L1 = levelById(levels, "L1");
  const tIds = L1.exit.tests.map((t) => t.test_id);
  const runGroup = async (day, ids, passAll = true) => {
    const ts = ids.map((id) => ({ id, thr: exitTest("L1", id).threshold }));
    const results = ts.map(({ id, thr }) => gateResult(T(id), thr, { value: passAll ? thr.value : 0, met: passAll, form_ok: true, pain_peak: 0 }));
    const s = buildGateSession({ id: `GS-${day}`, state: await store.kvGet("state"), tests: ts.map((x) => T(x.id)), results, startedAt: `${day}T17:00:00-06:00`, endedAt: `${day}T17:30:00-06:00` });
    assert.deepEqual(validate(SESSION, s).errors, []);
    await store.put("sessions", s);
    await recordGate(store, docs, profile, s.id);
    const post = ci("post_workout", { pain: 0, rpe: 5, settle: "lt_30", items: [] }, at(day, "17:45"), { session_id: s.id });
    await store.put("checkins", post);
    await store.put("sessions", { ...(await store.get("sessions", s.id)), post_workout_checkin_id: post.id });
    await recordGate(store, docs, profile, s.id);
    return s.id;
  };
  const groups = {};
  for (const id of tIds) (groups[T(id).category] ||= []).push(id);
  const [g1, g2, ...rest] = Object.values(groups);
  assert.equal(rest.length, 0, "L1 has two groups");
  // day 1: group 1, with a green yesterday
  for (const d of ["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"]) {
    await store.put("checkins", morning(d)); await store.put("checkins", evening(d)); await store.put("checkins", night(d));
  }
  const s1 = await runGroup("2026-12-01", g1);
  let st = await store.kvGet("state");
  for (const id of g1) assert.equal(st.gate_tests[id].status, "pass_provisional");
  assert.equal((await store.all("log")).filter((e) => /provisional pass/.test(e.message)).length, g1.length, "provisional lines logged once per test");
  await evaluate(store, docs, profile, { now: at("2026-12-02", "09:00") });
  st = await store.kvGet("state");
  for (const id of g1) assert.equal(st.gate_tests[id].status, "pass_confirmed", `${id}: ${JSON.stringify(st.gate_tests[id])}`);
  assert.equal(st.level_id, "L1");
  // day 3: group 2 -> confirmed on day 4 -> promote
  await runGroup("2026-12-03", g2);
  await evaluate(store, docs, profile, { now: at("2026-12-04", "09:00") });
  st = await store.kvGet("state");
  assert.equal(st.level_id, "L2", JSON.stringify(st.gate_tests));
  assert.equal(st.probation_sessions_remaining, 2);
  assert.ok(s1);
  const log = await store.all("log");
  const fresh = unseenDecisions(log, "2026-11-01T00:00:00-06:00");
  const promo = fresh.find((e) => e.outcome === "promote");
  assert.ok(promo);
  const copy = decisionCopy(promo, st, levels);
  assert.equal(copy.tone, "up");
  assert.match(copy.title, /Level up: L2/);
  assert.equal(unseenDecisions(log, promo.ts).some((e) => e.outcome === "promote"), false, "acknowledged ones stay quiet");
});

test("a failed gate test waits for retests; a symptom on the post-test check-in turns a pass into a fail", async () => {
  const store = memStore();
  const state = atTarget(initState(levels, "L1", { now: "2026-11-30T07:00:00-06:00", baselines: B }));
  await store.kvSet("state", state);
  const thr = exitTest("L1", "T_WALK_CONT").threshold;
  const r = gateResult(T("T_WALK_CONT"), thr, { value: 40, form_ok: true, pain_peak: 0 });
  const s = buildGateSession({ id: "GS1", state, tests: [T("T_WALK_CONT")], results: [r], startedAt: "2026-12-01T17:00:00-06:00", endedAt: "2026-12-01T17:30:00-06:00" });
  await store.put("sessions", s);
  await recordGate(store, docs, profile, "GS1");
  assert.equal((await store.kvGet("state")).gate_tests.T_WALK_CONT.status, "pass_provisional");
  const post = ci("post_workout", { pain: 1, rpe: 4, settle: "lt_30", items: [], leg: "thigh" }, at("2026-12-01", "17:45"), { session_id: "GS1" });
  await store.put("checkins", post);
  await store.put("sessions", { ...(await store.get("sessions", "GS1")), post_workout_checkin_id: post.id });
  await recordGate(store, docs, profile, "GS1");
  const g = (await store.kvGet("state")).gate_tests.T_WALK_CONT;
  assert.equal(g.status, "fail");
  assert.equal(g.retest_after_clean_sessions, 2);
  const saved = await store.get("sessions", "GS1");
  assert.equal(saved.gate_results[0].passed, false);
  assert.deepEqual(validate(SESSION, saved).errors, []);
});

test("red report from the red-flag screen freezes the plan; clearing enters settle mode", async () => {
  const store = memStore();
  await store.kvSet("state", initState(levels, "L2", { now: "2026-12-01T07:00:00-06:00", baselines: B }));
  const r = await manual(store, docs, profile, { type: "red_report", kind: "emergency", flags: ["Numbness in the saddle area"] }, { now: at("2026-12-01", "14:00") });
  assert.equal(r.state.mode, "red_stop");
  assert.equal(r.state.red.kind, "emergency");
  assert.ok((await store.all("log")).some((e) => e.rule_id === "R1" && e.outcome === "red"));
  const again = await manual(store, docs, profile, { type: "red_report", kind: "clinician", flags: ["x"] });
  assert.equal(again.state.red.kind, "emergency", "a second report doesn't overwrite the first");
  const c = await clearRed(store, docs, profile, "cleared");
  assert.equal(c.state.mode, "settle");
});

test("optional tests can be skipped with a reason; flare, pause and resume go through the same path", async () => {
  const store = memStore();
  await store.kvSet("state", initState(levels, "L6", { now: "2026-12-01T07:00:00-06:00", baselines: B }));
  await manual(store, docs, profile, { type: "skip_optional_test", test_id: "T_EXTENSOR_ENDURANCE", note: "extension brought on leg symptoms" });
  const st = await store.kvGet("state");
  assert.equal(st.gate_tests.T_EXTENSOR_ENDURANCE.status, "skipped_optional");
  assert.ok((await store.all("log")).some((e) => /T_EXTENSOR_ENDURANCE/.test(e.message)));
  await manual(store, docs, profile, { type: "pause" });
  assert.equal((await store.kvGet("state")).mode, "paused");
  await manual(store, docs, profile, { type: "resume" });
  assert.equal((await store.kvGet("state")).mode, "active");
  await manual(store, docs, profile, { type: "flare" });
  assert.equal((await store.kvGet("state")).mode, "settle");
});

test("announcement copy for step-back, settle and gates; first-run ack logic", () => {
  const state = initState(levels, "L2", { now: "2026-12-01T07:00:00-06:00", baselines: B });
  const mk = (outcome, message) => ({ id: outcome, ts: "2026-12-05T10:00:00-06:00", rule_id: "R8", outcome, message });
  assert.equal(decisionCopy(mk("regress_level", "Why"), state, levels).tone, "down");
  assert.match(decisionCopy(mk("settle_enter", "Flared"), state, levels).points.join(" "), /70%/);
  assert.equal(decisionCopy(mk("gate_pending", "ready"), state, levels).link, "#/status");
  assert.equal(decisionCopy(mk("red", "x"), state, levels).link, "#/red");
  const log = [mk("none", "minor"), mk("advance", "step"), mk("promote", "up")];
  assert.deepEqual(unseenDecisions(log, null).map((e) => e.outcome), ["promote"]);
  assert.equal(unseenDecisions(log, "2026-12-06T00:00:00-06:00").length, 0);
});

test("barbell equipment is reconfirmed from L6 on, once", () => {
  const s = (id) => ({ level_id: id });
  assert.equal(needsEquipConfirm(s("L5"), false), false);
  assert.equal(needsEquipConfirm(s("L6"), false), true);
  assert.equal(needsEquipConfirm(s("L7"), false), true);
  assert.equal(needsEquipConfirm(s("L6"), true), false);
  assert.equal(needsEquipConfirm(s("L0"), false), false);
});
