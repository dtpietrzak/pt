// Phase 2: check-in forms -> schema-valid records, due logic, and the store -> engine pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tidyReasons, checklist, dueNow, buildCheckIn, formFromCheckIn, effectiveDate, noFlags, redGuidance, summaryLine, eveningFromLogs, keepEveningPressure, eveningLogsNote } from "../public/js/checkins.js";
import { evaluate, engineConfig, templateItems, nextStrengthTemplate, buildSession, clearRed } from "../public/js/pipeline.js";
import { evaluateCheckIn, initState } from "../public/js/engine.js";
import { postureCheckinData } from "../public/js/posture.js";
import { validate } from "../public/js/schema.js";
import { isoLocal } from "../public/js/util.js";

const j = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const levels = j("../public/data/levels.json"), tests = j("../public/data/tests.json"), config = j("../public/data/decision-config.json");
const posture = j("../public/data/posture-cycle.json");
const profile = j("../public/data/profile.json");
const docs = { levels, tests, config, posture };
const SCHEMA = j("../public/data/schemas/checkin.schema.json");
const SESSION = j("../public/data/schemas/session.schema.json");
const B = profile.baselines;
const at = (d, hm) => new Date(`${d}T${hm}:00-06:00`);
let n = 0;
const ctx = (now, extra = {}) => ({ now, id: `C${++n}`, ...extra });
const ok = (rec) => assert.deepEqual(validate(SCHEMA, rec).errors, [], JSON.stringify(rec));

function memStore() {
  const m = { kv: new Map(), checkins: new Map(), sessions: new Map(), log: new Map(), days: new Map() };
  const keyOf = { checkins: "id", sessions: "id", log: "id", days: "local_date" };
  return {
    async get(s, k) { return m[s].get(k); },
    async all(s) { return [...m[s].values()]; },
    async put(s, v) { m[s].set(v[keyOf[s]], structuredClone(v)); return v; },
    async kvGet(k) { return m.kv.get(k); }, async kvSet(k, v) { m.kv.set(k, structuredClone(v)); },
  };
}

test("every check-in type builds a schema-valid record", () => {
  const d = "2026-12-01";
  const blocks = [{ phase: "stand", prescribed_min: 30, actual_min: 30, started_at: `${d}T09:00:00-06:00`, ended_at: `${d}T09:30:00-06:00`, ended_how: "alarm", snoozes: 0 }, { phase: "sit", prescribed_min: 20, actual_min: 20, started_at: `${d}T10:00:00-06:00`, ended_at: `${d}T10:20:00-06:00`, ended_how: "alarm", snoozes: 0 }];
  const pc = postureCheckinData(blocks, [], { stand_min: 30, sit_min: 20, walk_min: 5, decomp_min: 3 });
  const recs = [
    buildCheckIn("morning", { pain: 2, stiffness_min: 25, sleep_hours: 7, sleep_quality: 4, woke: 0, window_ok: true, leg: "none", flags: noFlags() }, ctx(at(d, "08:30"), { wake_time: "07:15" })),
    buildCheckIn("morning", { pain: 3, stiffness_min: 90, stiffness_still: true, sleep_hours: 6, sleep_quality: 2, woke: 1, hip_shift: true, leg: "buttock", leg_trend: "centralizing", sharp: true, sharp_context: "ordinary_movement", sharp_settle_min: 10, scary: true, flags: { ...noFlags(), new_leg_weakness: true }, oddities: " slept on couch ", tags: ["illness"] }, ctx(at(d, "08:30"))),
    buildCheckIn("post_workout", { pain: 3, rpe: 6, settle: "lt_30", pain15: 1, form_breakdown: true, leg: "none", items: [{ item_key: "L1_strength_A_X", completed: true, rung_done: 0 }, { item_key: "L1_strength_A_Y", completed: true, rung_done: 1, problem: true, pain_peak: 4, sharp: true, form: true }] }, ctx(at(d, "17:45"), { session_id: "S1" })),
    buildCheckIn("evening", { pain: 2, upright_h: 7.5, no_pressure: true, breaks: 4, decomp: 2, walk_min: 30, forced_rest: 0, leg: "none", sit_on: true, sit_no_pressure: false, sit_first_min: 15, sit_total_min: 240, sit_flared: false }, ctx(at(d, "19:00"), { posture: pc })),
    buildCheckIn("evening", { pain: 1, upright_h: 6, no_pressure: false, first_pressure_h: 4.5, leg: "none" }, ctx(at(d, "19:00"))),
    buildCheckIn("night", { pain: 1, ready: true, leg: "none" }, ctx(at(d, "22:00"))),
  ];
  for (const r of recs) ok(r);
  assert.equal(recs[1].data.stiffness_still_present, true);
  assert.equal(recs[1].oddities, "slept on couch");
  assert.equal(recs[3].data.sitting.prescribed_block_min, 20);
  assert.equal(recs[3].data.posture_cycle.work_mode_used, true);
  assert.equal(recs[4].data.sitting, undefined);
  assert.equal(recs[0].ts, "2026-12-01T08:30:00-06:00");
  assert.equal(recs[0].data.wake_time, "07:15");
  assert.ok(Object.keys(recs[0].red_flags).length === 10 && !Object.values(recs[0].red_flags).some(Boolean));
});

test("editing keeps id, ts and date; the form round-trips", () => {
  const d = "2026-12-01";
  const rec = buildCheckIn("evening", { pain: 3, upright_h: 7, no_pressure: false, first_pressure_h: 4, breaks: 3, decomp: 1, walk_min: 20, forced_rest: 1, limited: true, leg: "thigh", leg_trend: "same", sit_on: true, sit_no_pressure: true, sit_total_min: 120 }, ctx(at(d, "19:00")));
  const again = buildCheckIn("evening", formFromCheckIn(rec), ctx(at("2026-12-02", "09:00"), { existing: rec }));
  assert.deepEqual(again, rec);
  const post = buildCheckIn("post_workout", { pain: 2, rpe: 5, settle: "not_yet", items: [{ item_key: "a", completed: true, rung_done: 1, problem: true, pain_peak: 3, form: true }] }, ctx(at(d, "17:45"), { session_id: "S" }));
  assert.deepEqual(buildCheckIn("post_workout", formFromCheckIn(post), ctx(at(d, "20:00"), { existing: post })), post);
});

test("each check-in rolls up to the right color", () => {
  const e = (type, f, x = {}) => evaluateCheckIn(buildCheckIn(type, { leg: "none", flags: noFlags(), ...f }, ctx(at("2026-12-01", "09:00"), x)), B, config);
  assert.equal(e("morning", { pain: 1, stiffness_min: 30, sleep_hours: 7, sleep_quality: 4 }).color, "green");
  assert.equal(e("morning", { pain: 4, stiffness_min: 30, sleep_hours: 7, sleep_quality: 4 }).color, "yellow");
  assert.equal(e("morning", { pain: 6, stiffness_min: 30, sleep_hours: 7, sleep_quality: 4 }).color, "orange");
  assert.equal(e("evening", { pain: 1, upright_h: 4, no_pressure: false, first_pressure_h: 2 }).color, "orange");
  const red = e("night", { pain: 1, scary: true, flags: { ...noFlags(), saddle_numbness: true } });
  assert.equal(red.color, "red");
  assert.equal(red.red_kind, "emergency");
  assert.match(redGuidance({ kind: "emergency" }).title, /emergency/i);
  assert.doesNotMatch(JSON.stringify([redGuidance({ kind: "clinician" }), redGuidance({ kind: "emergency" })]), /\d{3}[-.\s]\d{4}|@/);
  assert.match(summaryLine(buildCheckIn("night", { pain: 3, leg: "none" }, ctx(at("2026-12-01", "22:00")))), /pain 3\/10/);
});

test("new post-workout check-ins omit settle time and 15-min pain; old values still color and round-trip", () => {
  const fresh = buildCheckIn("post_workout", { pain: 1, rpe: 5, leg: "none", items: [] }, ctx(at("2026-12-01", "17:45"), { session_id: "S1" }));
  ok(fresh);
  assert.equal("pain_15min_after" in fresh.data, false);
  assert.equal("settle_bucket" in fresh.data, false);
  const ev = evaluateCheckIn(fresh, B, config);
  assert.equal(ev.color, "green");
  assert.equal(ev.reasons.some((r) => /15 min after|120 min to settle/.test(r)), false);

  const old = buildCheckIn("post_workout", { pain: 1, rpe: 5, settle: "gt_120", pain15: 5, leg: "none", items: [] }, ctx(at("2026-12-01", "17:50"), { session_id: "S1" }));
  ok(old);
  assert.equal(old.data.pain_15min_after, 5);
  assert.equal(old.data.settle_bucket, "gt_120");
  const evOld = evaluateCheckIn(old, B, config);
  assert.equal(evOld.color, "orange");
  assert.ok(evOld.reasons.some((r) => /pain 15 min after 5\/10/.test(r)));
  assert.ok(evOld.reasons.some((r) => /symptoms took over 120 min to settle/.test(r)));
  assert.deepEqual(buildCheckIn("post_workout", formFromCheckIn(old), ctx(at("2026-12-01", "20:00"), { existing: old })), old);
});

test("due logic follows the profile notify times", () => {
  const d = "2026-12-01";
  const state = (now, o = {}) => checklist({ now, profile, checkins: [], sessions: [], ...o });
  const get = (l, t) => l.find((x) => x.type === t);
  let l = state(at(d, "07:00"));
  assert.deepEqual(l.map((x) => [x.type, x.state]), [["morning", "later"], ["evening", "later"], ["night", "later"]]);
  l = state(at(d, "08:00"));
  assert.equal(get(l, "morning").state, "due");
  assert.equal(get(l, "evening").state, "later");
  assert.equal(get(state(at(d, "08:20"), { wake: "07:30" }), "morning").state, "due");
  assert.equal(get(state(at(d, "08:10"), { wake: "08:00" }), "morning").at, "08:45");
  assert.equal(get(state(at(d, "08:10"), { wake: "08:00" }), "morning").state, "later");
  l = state(at(d, "15:30"));
  assert.equal(get(l, "evening").state, "due");
  assert.equal(dueNow(state(at(d, "21:05"))).length, 3);
  // done check-ins stop being due
  const m = buildCheckIn("morning", { pain: 1, leg: "none" }, ctx(at(d, "08:20")));
  assert.equal(get(state(at(d, "09:00"), { checkins: [m] }), "morning").state, "done");
  // custom times
  assert.equal(get(checklist({ now: at(d, "06:05"), profile: { notify: { morning: "06:00", evening: "12:00", night: "20:00" } }, checkins: [], sessions: [] }), "morning").state, "due");
  // after midnight the night check-in still belongs to last evening
  l = state(at("2026-12-02", "00:40"));
  assert.equal(l[0].type, "night");
  assert.equal(l[0].date, d);
  assert.equal(l[0].state, "due");
  assert.equal(effectiveDate("night", at("2026-12-02", "00:40")), d);
  assert.equal(effectiveDate("night", at("2026-12-02", "21:40")), "2026-12-02");
  assert.equal(effectiveDate("evening", at("2026-12-02", "00:40")), "2026-12-02");
});

test("a finished session prompts a post-workout check-in until one exists", () => {
  const d = "2026-12-01";
  const s = { id: "S1", local_date: d, started_at: `${d}T17:00:00-06:00`, ended_at: `${d}T17:40:00-06:00`, post_workout_checkin_id: null };
  let l = checklist({ now: at(d, "17:41"), profile, checkins: [], sessions: [s] });
  const p = l.find((x) => x.type === "post_workout");
  assert.equal(p.state, "due");
  assert.equal(p.session_id, "S1");
  const c = buildCheckIn("post_workout", { pain: 1, leg: "none", items: [] }, ctx(at(d, "17:45"), { session_id: "S1" }));
  l = checklist({ now: at(d, "17:46"), profile, checkins: [c], sessions: [s] });
  assert.deepEqual(l.filter((x) => x.type === "post_workout").map((x) => x.state), ["done"], "a finished one still shows, as done");
  l = checklist({ now: at("2026-12-04", "10:00"), profile, checkins: [], sessions: [s] });
  assert.equal(l.some((x) => x.type === "post_workout"), false, "stale sessions stop prompting");
});

async function setup(level = "L1") {
  const store = memStore();
  const state = initState(levels, level, { now: "2026-12-01T07:00:00-06:00", baselines: B });
  await store.kvSet("state", state);
  return { store, state };
}
const put = (store, rec) => store.put("checkins", rec);

test("pipeline: a full session day finalizes after the next morning, and re-running is idempotent", async () => {
  const { store, state } = await setup();
  const [d, d2] = ["2026-12-01", "2026-12-02"];
  const tpl = nextStrengthTemplate([]);
  assert.equal(tpl, "strength_A");
  const items = templateItems(docs, state, tpl);
  assert.ok(items.length > 0);
  const ses = buildSession({ id: "S1", template: tpl, state, items: items.map((i) => ({ item_key: i.item.item_key, rung: i.rung, completed: true })), now: at(d, "17:40") });
  assert.deepEqual(validate(SESSION, ses).errors, []);
  await store.put("sessions", ses);
  assert.equal(nextStrengthTemplate([ses]), "strength_B");
  const f = { leg: "none", flags: noFlags() };
  const post = buildCheckIn("post_workout", { ...f, pain: 1, rpe: 5, settle: "lt_30", items: items.map((i) => ({ item_key: i.item.item_key, completed: true, rung_done: i.rung })) }, ctx(at(d, "17:45"), { session_id: "S1" }));
  await put(store, post);
  await store.put("sessions", { ...ses, post_workout_checkin_id: post.id });
  await put(store, buildCheckIn("morning", { ...f, pain: 1, stiffness_min: 25, sleep_hours: 7.5, sleep_quality: 4 }, ctx(at(d, "08:30"))));
  await put(store, buildCheckIn("evening", { ...f, pain: 1, upright_h: 6, no_pressure: true }, ctx(at(d, "19:00"))));
  await put(store, buildCheckIn("night", { ...f, pain: 1 }, ctx(at(d, "22:00"))));
  let r = await evaluate(store, docs, profile, { now: at(d, "22:30") });
  let s = await store.get("sessions", "S1");
  assert.equal(s.status, "provisional");
  assert.deepEqual(validate(SESSION, s).errors, []);
  await put(store, buildCheckIn("morning", { ...f, pain: 1, stiffness_min: 25, sleep_hours: 7.5, sleep_quality: 4 }, ctx(at(d2, "08:30"))));
  r = await evaluate(store, docs, profile, { now: at(d2, "09:00") });
  s = await store.get("sessions", "S1");
  assert.equal(s.status, "final");
  assert.equal(s.final_color, "green");
  assert.equal(s.clean, true);
  assert.deepEqual(validate(SESSION, s).errors, []);
  const logCount = (await store.all("log")).length;
  const again = await evaluate(store, docs, profile, { now: at(d2, "09:05") });
  assert.equal(again.changed, false);
  assert.equal((await store.all("log")).length, logCount);
  assert.equal(r.state.mode, "active");
});

test("pipeline: a red check-in freezes the plan, and clearing it enters settle mode", async () => {
  const { store } = await setup("L2");
  const d = "2026-12-01";
  await put(store, buildCheckIn("night", { pain: 1, leg: "none", scary: true, flags: { ...noFlags(), bladder_bowel_change: true } }, ctx(at(d, "22:00"))));
  const r = await evaluate(store, docs, profile, { now: at(d, "22:05") });
  assert.equal(r.state.mode, "red_stop");
  assert.equal(r.state.red.kind, "emergency");
  assert.ok((await store.all("log")).some((e) => e.rule_id === "R1" && e.outcome === "red"));
  assert.equal((await store.kvGet("state")).mode, "red_stop");
  const c = await clearRed(store, docs, profile, "cleared by clinician", { now: at("2026-12-03", "10:00") });
  assert.equal(c.state.mode, "settle");
  assert.equal(c.state.level_id, "L0");
  assert.equal((await store.kvGet("state")).mode, "settle");
});

test("pipeline: an orange day is logged by the engine once the next morning arrives", async () => {
  const { store } = await setup("L2");
  const [d, d2] = ["2026-12-01", "2026-12-02"];
  const f = { leg: "none", flags: noFlags() };
  await put(store, buildCheckIn("morning", { ...f, pain: 6, stiffness_min: 30, sleep_hours: 7, sleep_quality: 4 }, ctx(at(d, "08:30"))));
  await put(store, buildCheckIn("morning", { ...f, pain: 1, stiffness_min: 30, sleep_hours: 7, sleep_quality: 4 }, ctx(at(d2, "08:30"))));
  const r = await evaluate(store, docs, profile, { now: at(d2, "09:00") });
  assert.equal(r.daily[d].color, "orange");
  assert.ok(r.log.some((e) => e.rule_id === "R2"), JSON.stringify(r.log.map((e) => e.message)));
});

test("profile pacing setting overrides clean exposures; the stored config is untouched", () => {
  const base = config.advance.clean_exposures_required;
  const cfg = engineConfig(docs, { settings: { clean_exposures_required: 3 } });
  assert.equal(cfg.advance.clean_exposures_required, 3);
  assert.equal(docs.config.advance.clean_exposures_required, base);
  assert.equal(engineConfig(docs, {}).advance.clean_exposures_required, base);
});

test("check-in stores are in the sync list and the Firestore rules allow-list", () => {
  const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
  for (const s of ["checkins", "sessions", "log", "days", "kv"]) assert.match(rules, new RegExp(`'${s}'`));
});

test("tidyReasons drops the echoed pain-now line and lists the worst first", () => {
  const r = tidyReasons(["Yellow: pain now 3/10", "Yellow: pain on waking 3/10", "Orange: standing tolerance 0.40 of baseline"]);
  assert.deepEqual(r, ["Orange: standing tolerance 0.40 of baseline", "Yellow: pain on waking 3/10"]);
  assert.deepEqual(tidyReasons(["Yellow: pain now 3/10"]), ["Yellow: pain now 3/10"]);
});

test("eveningFromLogs fills standing, walking and sitting from Today and the work timer, without inventing pressure", () => {
  const d = "2026-12-01";
  const blocks = [
    { phase: "stand", prescribed_min: 40, actual_min: 40, started_at: `${d}T09:00:00-06:00`, ended_at: `${d}T09:40:00-06:00`, ended_how: "alarm", snoozes: 0 },
    { phase: "walk", prescribed_min: 2, actual_min: 2, started_at: `${d}T09:40:00-06:00`, ended_at: `${d}T09:42:00-06:00`, ended_how: "alarm", snoozes: 0 },
    { phase: "sit", prescribed_min: 20, actual_min: 20, started_at: `${d}T09:42:00-06:00`, ended_at: `${d}T10:02:00-06:00`, ended_how: "alarm", snoozes: 0 },
    { phase: "decompress", prescribed_min: 5, actual_min: 5, started_at: `${d}T10:02:00-06:00`, ended_at: `${d}T10:07:00-06:00`, ended_how: "alarm", snoozes: 0 },
  ];
  const pc = postureCheckinData(blocks, [], { stand_min: 40, sit_min: 20, walk_min: 2, decomp_min: 5 });
  const f = eveningFromLogs({ blocks, posture: pc, day: { walk_min: 30, standing_breaks_done: 5, decomp_breaks_done: 2 } }, { pain: 2, forced_rest: 0, leg: "none" });
  assert.equal(f.upright_h, undefined);
  assert.equal(f.walk_min, 30);
  assert.equal(f.breaks, undefined);
  assert.equal(f.decomp, undefined);
  assert.equal(f.forced_rest, 0);
  assert.equal(f.sit_on, true);
  assert.equal(f.sit_total_min, 20);
  assert.equal(f.no_pressure, undefined);
  assert.equal(f.first_pressure_h, undefined);
  const rec = buildCheckIn("evening", f, ctx(at(d, "19:00"), { posture: pc }));
  ok(rec);
  assert.equal(rec.data.standing, undefined);
  assert.equal(rec.data.walk_min, 30);
  assert.equal(rec.data.forced_rest_count, 0);
  assert.equal(rec.data.sitting.seated_min_total, 20);
  assert.equal("first_pressure_min" in rec.data.sitting, false);
  assert.equal(rec.data.posture_cycle.work_mode_used, true);
  assert.equal(evaluateCheckIn(rec, B, config).color, "green");
  assert.match(eveningLogsNote({ blocks, posture: pc, day: { walk_min: 30, standing_breaks_done: 5, decomp_breaks_done: 2 } }), /walked 30 min/);
});

test("eveningFromLogs does not invent a 6h comfortable day when nothing was logged", () => {
  const f = eveningFromLogs({}, { pain: 2, forced_rest: 0, leg: "none" });
  assert.equal(f.upright_h, undefined);
  assert.equal(f.walk_min, undefined);
  assert.equal(f.sit_on, undefined);
  assert.equal(f.breaks, undefined);
  assert.equal(f.no_pressure, undefined);
  const rec = buildCheckIn("evening", f, ctx(at("2026-12-01", "19:00")));
  ok(rec);
  assert.equal(rec.data.standing, undefined);
  assert.equal(rec.data.sitting, undefined);
  assert.equal(rec.data.posture_cycle, undefined);
  assert.equal(rec.data.walk_min, undefined);
  const ev = evaluateCheckIn(rec, B, config);
  assert.equal(ev.color, "green");
  assert.ok(!/standing|sitting/i.test((ev.reasons || []).join(" ")), JSON.stringify(ev.reasons));
  assert.match(eveningLogsNote({}), /unreported rather than guessed/);
});

test("a work-timer day does not count scheduled decompress phases as unplanned relief", () => {
  const d = "2026-12-01";
  const blocks = [
    { phase: "stand", prescribed_min: 40, actual_min: 40, started_at: `${d}T09:00:00-06:00`, ended_at: `${d}T09:40:00-06:00`, ended_how: "alarm", snoozes: 0 },
    { phase: "walk", prescribed_min: 2, actual_min: 2, started_at: `${d}T09:40:00-06:00`, ended_at: `${d}T09:42:00-06:00`, ended_how: "alarm", snoozes: 0 },
    { phase: "sit", prescribed_min: 20, actual_min: 20, started_at: `${d}T09:42:00-06:00`, ended_at: `${d}T10:02:00-06:00`, ended_how: "alarm", snoozes: 0 },
    { phase: "decompress", prescribed_min: 5, actual_min: 5, started_at: `${d}T10:02:00-06:00`, ended_at: `${d}T10:07:00-06:00`, ended_how: "alarm", snoozes: 0 },
  ];
  const pc = postureCheckinData(blocks, [], { stand_min: 40, sit_min: 20, walk_min: 2, decomp_min: 5 });
  const f = eveningFromLogs({ blocks, posture: pc, day: {} }, { pain: 1, leg: "none" });
  assert.equal(f.breaks, undefined);
  assert.equal(f.decomp, undefined);
  assert.equal(f.forced_rest, undefined);
  assert.equal(f.upright_h, undefined);
  assert.equal(f.walk_min, undefined);
  const rec = buildCheckIn("evening", { ...f, forced_rest: 0 }, ctx(at(d, "19:00"), { posture: pc }));
  ok(rec);
  assert.equal(rec.data.forced_rest_count, 0);
  assert.equal(rec.data.standing, undefined);
  assert.equal(evaluateCheckIn(rec, B, config).color, "green");
});

test("editing an evening check-in keeps a previously entered first-pressure value", () => {
  const rec = buildCheckIn("evening", { pain: 2, upright_h: 7, no_pressure: false, first_pressure_h: 4, leg: "none" }, ctx(at("2026-12-01", "19:00")));
  const f = keepEveningPressure(eveningFromLogs({}, { pain: 3, forced_rest: 1, leg: "none" }), rec);
  assert.equal(f.first_pressure_h, 4);
  assert.equal(f.upright_h, 7);
  const again = buildCheckIn("evening", f, ctx(at("2026-12-01", "19:30"), { existing: rec }));
  assert.equal(again.data.standing.first_pressure_h, 4);
  assert.equal(again.data.standing.upright_h_total, 7);
  ok(again);
});
