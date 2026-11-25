// Work posture timer (wall-clock state machine) and R16 wiring in the engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  setPostureConfig, initPostureState, startTimer, switchPhase, soreEarly, snooze, stopTimer, tick, isDue, deadlineOf, remainingMs, snoozesLeft,
  chicagoInstant, timerSettings, postureCheckinData, postureDailyLog, MIN,
} from "../public/js/posture.js";
import { initState, runEngine, manualEvent, evaluateCheckIn } from "../public/js/engine.js";
import { validate } from "../public/js/schema.js";
import { addDays } from "../public/js/util.js";

const j = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const cfg = j("../public/data/posture-cycle.json"), config = j("../public/data/decision-config.json");
const levels = j("../public/data/levels.json"), tests = j("../public/data/tests.json");
setPostureConfig(cfg);
const settings = timerSettings({}, cfg);
const doses = () => initPostureState(cfg, "L1");
// Wednesday 2026-12-02 10:00 Chicago (CST, UTC-6)
const T0 = chicagoInstant("2026-12-02", "10:00");
const at = (min) => T0 + min * MIN;

test("chicagoInstant handles CST and CDT", () => {
  assert.equal(new Date(chicagoInstant("2026-12-02", "17:00")).toISOString(), "2026-12-02T23:00:00.000Z");
  assert.equal(new Date(chicagoInstant("2026-07-01", "17:00")).toISOString(), "2026-07-01T22:00:00.000Z");
});

test("start inside work hours keeps quiet hours; outside overrides them", () => {
  assert.equal(startTimer(doses(), at(0), { cfg, settings }).override_quiet, false);
  assert.equal(startTimer(doses(), chicagoInstant("2026-12-05", "19:00"), { cfg, settings }).override_quiet, true);
  assert.equal(startTimer(doses(), at(0), { cfg, settings: { ...settings, quiet_outside_work_hours: false } }).override_quiet, true);
});

test("countdown comes from stored timestamps, so a reload or a throttled tab can't drift", () => {
  let t = startTimer(doses(), at(0), { cfg, settings });
  assert.equal(t.phase, "stand"); assert.equal(t.phase_min, 40);
  t = JSON.parse(JSON.stringify(t)); // reload
  assert.equal(remainingMs(t, at(0)), 40 * MIN);
  assert.equal(remainingMs(t, at(25.5)), 14.5 * MIN);
  assert.equal(isDue(t, at(39.99)), false);
  assert.equal(isDue(t, at(40)), true);
  assert.equal(isDue(t, at(55)), true, "stays due however late we look");
});

test("default cycle: stand 40, walk 2, sit 20, decompress 5, repeat; blocks are logged", () => {
  let t = startTimer(doses(), at(0), { cfg, settings });
  const seq = [];
  let now = 0;
  for (let i = 0; i < 5; i++) { seq.push([t.phase, t.phase_min]); now += t.phase_min; t = switchPhase(t, at(now), doses(), "alarm", cfg); }
  assert.deepEqual(seq, [["stand", 40], ["walk", 2], ["sit", 20], ["decompress", 5], ["stand", 40]]);
  assert.equal(t.blocks.length, 5);
  assert.deepEqual(t.blocks.slice(0, 2).map((b) => [b.phase, b.prescribed_min, b.actual_min, b.ended_how]), [["stand", 40, 40, "alarm"], ["walk", 2, 2, "alarm"]]);
  assert.equal(t.early_switches.length, 0);
});

test("a changed dose applies from the next phase start", () => {
  let t = startTimer(doses(), at(0), { cfg, settings });
  t = switchPhase(t, at(40), { ...doses(), sit_min: 25 }, "alarm", cfg);
  t = switchPhase(t, at(42), { ...doses(), sit_min: 25 }, "alarm", cfg);
  assert.equal(t.phase, "sit"); assert.equal(t.phase_min, 25);
});

test("sore early on stand: walk 2, decompress, then sit; logs actual minutes", () => {
  let t = startTimer(doses(), at(0), { cfg, settings });
  t = soreEarly(t, at(20), doses(), cfg);
  assert.equal(t.phase, "walk");
  assert.deepEqual(t.early_switches, [{ phase: "stand", prescribed_min: 40, actual_min: 20, reason: "sore_early" }]);
  assert.equal(t.blocks[0].ended_how, "sore_early");
  t = switchPhase(t, at(22), doses(), "alarm", cfg); assert.equal(t.phase, "decompress");
  t = switchPhase(t, at(27), doses(), "alarm", cfg); assert.equal(t.phase, "sit");
  t = switchPhase(t, at(47), doses(), "alarm", cfg); assert.equal(t.phase, "decompress");
  t = switchPhase(t, at(52), doses(), "alarm", cfg); assert.equal(t.phase, "stand");
});

test("sore early on sit: decompress, then stand", () => {
  let t = startTimer(doses(), at(0), { cfg, settings });
  t = switchPhase(t, at(40), doses(), "alarm", cfg); t = switchPhase(t, at(42), doses(), "alarm", cfg);
  t = soreEarly(t, at(50), doses(), cfg);
  assert.equal(t.phase, "decompress");
  assert.deepEqual(t.early_switches.at(-1), { phase: "sit", prescribed_min: 20, actual_min: 8, reason: "sore_early" });
  t = switchPhase(t, at(55), doses(), "alarm", cfg); assert.equal(t.phase, "stand");
});

test("a manual skip is logged as an early switch but not as sore", () => {
  let t = startTimer(doses(), at(0), { cfg, settings });
  t = switchPhase(t, at(10), doses(), "manual", cfg);
  assert.equal(t.phase, "walk");
  assert.equal(t.early_switches[0].reason, "manual");
  assert.equal(postureDailyLog(t.blocks, t.early_switches, doses()).stand_early_switches, 0);
});

test("snooze: 5 min, at most twice per phase, then the alarm stays", () => {
  let t = startTimer(doses(), at(0), { cfg, settings });
  assert.equal(snooze(t, at(10), settings), t, "can't snooze before it is due");
  t = snooze(t, at(40), settings);
  assert.equal(deadlineOf(t), at(45)); assert.equal(isDue(t, at(44)), false); assert.equal(isDue(t, at(45)), true);
  t = snooze(t, at(46), settings); // late tap: five minutes from now
  assert.equal(deadlineOf(t), at(51)); assert.equal(snoozesLeft(t, settings), 0);
  const same = snooze(t, at(52), settings);
  assert.equal(same, t, "third snooze refused");
  t = switchPhase(t, at(53), doses(), "alarm", cfg);
  assert.equal(t.blocks[0].ended_how, "snooze_then_switch"); assert.equal(t.blocks[0].snoozes, 2);
  assert.equal(t.snoozes, 0, "snoozes reset for the next phase");
  assert.equal(snoozesLeft(t, settings), 2);
});

test("decompression after each block when R16 made it more frequent", () => {
  const d = { ...doses(), decomp_frequency: "after_each_block" };
  let t = startTimer(d, at(0), { cfg, settings });
  const seq = []; let now = 0;
  for (let i = 0; i < 7; i++) { seq.push(t.phase); now += t.phase_min; t = switchPhase(t, at(now), d, "alarm", cfg); }
  assert.deepEqual(seq, ["stand", "walk", "decompress", "sit", "decompress", "stand", "walk"]);
});

test("quiet hours: work mode stops at work end with one reminder; a manual after-hours session keeps going", () => {
  let t = startTimer(doses(), chicagoInstant("2026-12-02", "16:30"), { cfg, settings });
  let r = tick(t, chicagoInstant("2026-12-02", "16:59"), settings);
  assert.deepEqual(r.events, []); assert.equal(r.timer.active, true);
  r = tick(t, chicagoInstant("2026-12-02", "17:00") + 20 * 1000, settings);
  assert.deepEqual(r.events, ["work_end_reminder"]);
  assert.equal(r.timer.active, false); assert.equal(r.timer.stopped_how, "work_end");
  assert.equal(r.timer.blocks.at(-1).ended_how, "work_end");
  assert.deepEqual(tick(r.timer, chicagoInstant("2026-12-02", "17:05"), settings).events, [], "only one reminder");
  // laptop was asleep: stale session stops silently
  assert.deepEqual(tick(t, chicagoInstant("2026-12-02", "19:00"), settings).events, ["work_end_silent"]);
  // started by hand at night: overrides quiet hours
  const night = startTimer(doses(), chicagoInstant("2026-12-02", "20:00"), { cfg, settings });
  assert.deepEqual(tick(night, chicagoInstant("2026-12-02", "22:30"), settings).events, []);
  // quiet hours off: never auto-stops
  const loud = { ...settings, quiet_outside_work_hours: false };
  assert.deepEqual(tick(startTimer(doses(), at(0), { cfg, settings: loud }), chicagoInstant("2026-12-02", "18:00"), loud).events, []);
});

test("stopTimer logs the running block", () => {
  let t = startTimer(doses(), at(0), { cfg, settings });
  t = stopTimer(t, at(12), "manual");
  assert.equal(t.active, false); assert.equal(t.blocks[0].actual_min, 12); assert.equal(t.blocks[0].ended_how, "manual");
});

// ---------------------------------------------------------------- evening check-in data and R16 in the engine
const S = (n) => j(`../public/data/schemas/${n}.schema.json`);
const sym = { pain_now: 1, sharp_electrical: false, leg_symptoms: "none", numbness_tingling: false };
const RF = { saddle_numbness: false, bladder_bowel_change: false, new_leg_weakness: false, new_numbness_tingling: false, fever_with_back_pain: false, night_pain_unrelieved: false, bilateral_leg_symptoms: false, trauma_since_last_checkin: false };
let n = 0;
const morning = (d) => ({ type: "morning", id: `M${++n}`, ts: `${d}T08:30:00-06:00`, local_date: d, session_id: null, red_flags: RF, data: { wake_time: "07:30", protection_window_respected: true, pain_on_waking: 1, stiffness_min: 30, sleep_hours: 7.5, sleep_quality: 4, woke_from_pain_count: 0, hip_shift: false, symptoms: sym } });
const evening = (d, o = {}) => ({ type: "evening", id: `E${++n}`, ts: `${d}T19:30:00-06:00`, local_date: d, session_id: null, data: {
  standing: { first_pressure_h: 5, censored: false, upright_h_total: 7 }, walk_min: 30, pain_peak_today: 1, forced_rest_count: 0, activity_limited: false, hip_shift: false, symptoms: sym,
  sitting: o.sitting ?? { first_pressure_min: 20, censored: false, flared: false, prescribed_block_min: 20 },
  ...(o.noSit ? { sitting: undefined } : {}),
  posture_cycle: o.pc ?? { work_mode_used: true, cycles_completed: 6, stand_prescribed_min: 40, sit_prescribed_min: 20, decomp_done: 6, early_switches: [] },
} });
const night = (d) => ({ type: "night", id: `N${++n}`, ts: `${d}T22:00:00-06:00`, local_date: d, session_id: null, red_flags: RF, data: { bedtime_pain: 1, symptoms: sym } });

test("timer output fits the evening check-in and daily-log schemas", () => {
  let t = startTimer(doses(), at(0), { cfg, settings });
  t = soreEarly(t, at(20), doses(), cfg); t = switchPhase(t, at(22), doses(), "alarm", cfg);
  const pc = postureCheckinData(t.blocks, t.early_switches, doses());
  assert.equal(pc.work_mode_used, true);
  const ci = evening("2026-12-02", { pc }); ci.data.sitting = { first_pressure_min: 20, censored: false, flared: false, prescribed_block_min: 20 };
  assert.deepEqual(validate(S("checkin"), ci).errors, []);
  const dl = { local_date: "2026-12-02", level_id: "L1", checklist: [], posture_cycle: postureDailyLog(t.blocks, t.early_switches, doses()) };
  assert.deepEqual(validate(S("daily-log"), dl).errors, []);
});

test("sit sore-early on the evening check-in lowers its color", () => {
  const ci = evening("2026-12-02", { pc: { work_mode_used: true, early_switches: [{ phase: "sit", prescribed_min: 20, actual_min: 8, reason: "sore_early" }] } });
  const r = evaluateCheckIn(ci, { stiffness_min: 30, standing_h: 5, pain_rest: 1, sitting_min: 20 }, config, {});
  assert.notEqual(r.color, "green");
});

function runDays(state, from, count, mk) {
  const checkins = [], days = {};
  let log = [];
  for (let k = 0; k < count; k++) {
    const d = addDays(from, k);
    checkins.push(morning(d), mk(d, k), night(d));
    days[d] = { local_date: d, level_id: state.level_id, checklist: [], walk_min: 30 };
    const r = runEngine(state, { checkins, sessions: [], days }, { levels, tests }, config, `${d}T22:30:00-06:00`);
    state = r.state; log.push(...r.log);
  }
  const r = runEngine(state, { checkins, sessions: [], days }, { levels, tests }, config, `${addDays(from, count + 1)}T09:00:00-06:00`);
  return { state: r.state, log: [...log, ...r.log] };
}

test("R16 in the engine: three green work days raise stand and sit 5 min", () => {
  const s0 = initState(levels, "L1", { now: "2026-12-01T07:00:00-06:00" });
  assert.equal(s0.posture_cycle.stand_min, 40);
  const { state, log } = runDays(s0, "2026-12-01", 3, (d) => evening(d));
  assert.equal(state.posture_cycle.stand_min, 45); assert.equal(state.posture_cycle.sit_min, 25);
  const e = log.find((x) => x.rule_id === "R16");
  assert.equal(e.outcome, "posture_advance");
  assert.deepEqual(validate(S("decision-log-entry"), { id: "L1", ts: "2026-12-04T09:00:00-06:00", session_id: null, ...e }).errors, []);
});

test("R16 in the engine: missing sitting data never advances sit; a day without work mode changes nothing", () => {
  const s0 = initState(levels, "L1", { now: "2026-12-01T07:00:00-06:00" });
  const a = runDays(s0, "2026-12-01", 3, (d) => evening(d, { noSit: true }));
  assert.equal(a.state.posture_cycle.stand_min, 45); assert.equal(a.state.posture_cycle.sit_min, 20);
  const b = runDays(s0, "2026-12-01", 3, (d) => evening(d, { pc: { work_mode_used: false } }));
  assert.equal(b.state.posture_cycle.stand_min, 40); assert.equal(b.state.posture_cycle.sit_min, 20);
});

test("R16 flare preset on 'I flared', and doses restored minus 5 on settle exit", () => {
  let s = initState(levels, "L1", { now: "2026-12-01T07:00:00-06:00" });
  s.posture_cycle = { ...s.posture_cycle, stand_min: 50, sit_min: 30 };
  const f = manualEvent(s, levels, config, { type: "flare" }, "2026-12-02T09:00:00-06:00");
  assert.equal(f.state.mode, "settle");
  assert.deepEqual([f.state.posture_cycle.stand_min, f.state.posture_cycle.sit_min, f.state.posture_cycle.decomp_frequency], [25, 10, "after_each_block"]);
  assert.ok(f.log.some((e) => e.rule_id === "R16" && e.outcome === "flare_preset"));
  // two green days with good standing end settle mode
  const { state, log } = runDays(f.state, "2026-12-03", 3, (d) => evening(d, { pc: { work_mode_used: false } }));
  assert.equal(state.mode, "active");
  assert.deepEqual([state.posture_cycle.stand_min, state.posture_cycle.sit_min, state.posture_cycle.decomp_frequency], [45, 25, "once_per_cycle"]);
  assert.ok(log.some((e) => e.rule_id === "R16" && e.outcome === "settle_exit"));
});
