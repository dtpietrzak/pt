import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isItemFlagged, flagsOf, flagsForItem, flaggedItemKeys, setItemFlagged,
  consecutiveFlagStreak, sessionFlagEvents, dailyFlagEvents, FLAG_STREAK_TO_REGRESS,
  REST_SEC, restCuesToPlay, needsRestAfter,
} from "../public/js/pain-flags.js";
import { initState, applySessionFinal } from "../public/js/engine.js";
import { setPlan, timedPlan } from "../public/js/dose.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const j = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const levels = j("../public/data/levels.json");
const config = j("../public/data/decision-config.json");
const ITEM = "L1_strength_A_EX_GLUTE_BRIDGE";
const ITEMS = [
  "L1_strength_A_EX_GLUTE_BRIDGE",
  "L1_strength_A_EX_BOX_SQUAT_STRAP",
  "L1_strength_A_EX_HINGE_DOWEL",
  "L1_strength_A_EX_SIDE_STEP_BAND",
  "L1_strength_A_EX_CALF_RAISE",
];
const ev = (over = {}) => ({
  color: "green",
  clean: true,
  items: ITEMS,
  ts: "2026-12-01T12:00:00-06:00",
  session_id: "S1",
  template: "strength_A",
  ...over,
});

test("FLAG_STREAK_TO_REGRESS is 2 consecutive flagged completed sessions", () => {
  assert.equal(FLAG_STREAK_TO_REGRESS, 2);
});

test("isItemFlagged treats any stored record with that item_key as checked, including old detailed flags", () => {
  const day = {
    pain_flags: [
      { id: "old", item_key: "core_a", pain: 6, location: "low_back", type: "ache", note: "old form", ts: "t" },
      { id: "sess", session_key: "wk:A", pain: 4, ts: "t" },
    ],
  };
  assert.equal(isItemFlagged(day, "core_a"), true);
  assert.equal(isItemFlagged(day, "core_b"), false);
  assert.equal(isItemFlagged(null, "core_a"), false);
  assert.deepEqual(flaggedItemKeys(day), ["core_a"]);
  assert.equal(flagsForItem(day, "core_a").length, 1);
  assert.deepEqual(flagsOf(null), []);
});

test("setItemFlagged toggles a simple record and preserves an existing detailed one", () => {
  let day = setItemFlagged({ local_date: "2026-11-25", checklist: [] }, "x", true, { id: "a", ts: "t" });
  assert.equal(isItemFlagged(day, "x"), true);
  assert.equal(day.pain_flags[0].item_key, "x");
  assert.equal(day.pain_flags[0].id, "a");
  const detailed = { id: "old", item_key: "y", pain: 5, location: "hip", type: "sharp", ts: "t" };
  day = { ...day, pain_flags: [...day.pain_flags, detailed] };
  day = setItemFlagged(day, "y", true);
  assert.equal(day.pain_flags.filter((f) => f.item_key === "y").length, 1);
  assert.equal(day.pain_flags.find((f) => f.item_key === "y").pain, 5);
  day = setItemFlagged(day, "y", false);
  assert.equal(isItemFlagged(day, "y"), false);
  assert.equal(isItemFlagged(day, "x"), true);
});

test("consecutiveFlagStreak counts a trailing run and resets after an unflagged done session", () => {
  assert.equal(consecutiveFlagStreak([]), 0);
  assert.equal(consecutiveFlagStreak([{ done: true, flagged: true }]), 1);
  assert.equal(consecutiveFlagStreak([{ done: true, flagged: true }, { done: true, flagged: true }]), 2);
  assert.equal(consecutiveFlagStreak([{ done: true, flagged: true }, { done: true, flagged: false }, { done: true, flagged: true }]), 1);
  assert.equal(consecutiveFlagStreak([{ done: true, flagged: true }, { done: true, flagged: true }, { done: true, flagged: false }]), 0);
});

test("sessionFlagEvents only includes completed sessions of that item, in order, through the current one", () => {
  const sessions = [
    { id: "S1", local_date: "2026-12-01", started_at: "2026-12-01T12:00:00", items: [{ item_key: ITEM, completed: true }] },
    { id: "S2", local_date: "2026-12-03", started_at: "2026-12-03T12:00:00", items: [{ item_key: ITEM, completed: true }] },
    { id: "S3", local_date: "2026-12-05", started_at: "2026-12-05T12:00:00", items: [{ item_key: ITEM, skipped: true }] },
    { id: "S4", local_date: "2026-12-07", started_at: "2026-12-07T12:00:00", items: [{ item_key: ITEM, completed: true }] },
  ];
  const days = {
    "2026-12-01": { pain_flags: [{ item_key: ITEM }] },
    "2026-12-03": { pain_flags: [{ item_key: ITEM }] },
    "2026-12-07": { pain_flags: [] },
  };
  const all = sessionFlagEvents(ITEM, sessions, days);
  assert.deepEqual(all.map((e) => e.id), ["S1", "S2", "S4"]);
  assert.deepEqual(all.map((e) => e.flagged), [true, true, false]);
  const through = sessionFlagEvents(ITEM, sessions, days, sessions[1]);
  assert.deepEqual(through.map((e) => e.id), ["S1", "S2"]);
  assert.equal(consecutiveFlagStreak(through), 2);
});

test("dailyFlagEvents counts checklist or walk minutes as done", () => {
  const item = { item_key: "core_a", block: "daily_core" };
  const walk = { item_key: "walk", block: "walking" };
  const days = {
    "2026-12-01": { checklist: [{ item_key: "core_a", done: true }], walk_min: 10, pain_flags: [{ item_key: "core_a" }] },
    "2026-12-02": { checklist: [{ item_key: "core_a", done: false }], walk_min: 10, pain_flags: [{ item_key: "walk" }] },
    "2026-12-03": { checklist: [{ item_key: "core_a", done: true }], walk_min: 0, pain_flags: [{ item_key: "core_a" }] },
  };
  const core = dailyFlagEvents(item, days, "2026-12-03");
  assert.deepEqual(core.map((e) => e.date), ["2026-12-01", "2026-12-03"]);
  assert.equal(consecutiveFlagStreak(core), 2);
  const w = dailyFlagEvents(walk, days, "2026-12-02");
  assert.deepEqual(w.map((e) => [e.date, e.flagged]), [["2026-12-01", false], ["2026-12-02", true]]);
  assert.equal(consecutiveFlagStreak(w), 1);
});

test("a flagged item does not advance on a clean session", () => {
  let s = initState(levels, "L1");
  s.item_state[ITEM].rung = 1;
  s.item_state[ITEM].clean_exposures = 1;
  const r = applySessionFinal(s, levels, ev({ flagged: [ITEM], flag_streaks: { [ITEM]: 1 } }), { config });
  assert.equal(r.state.item_state[ITEM].rung, 1);
  assert.equal(r.state.item_state[ITEM].clean_exposures, 0);
  assert.ok(!r.out.bumped.includes(ITEM));
  const r17 = r.log.filter((e) => e.rule_id === "R17");
  assert.equal(r17.length, 1);
  assert.equal(r17[0].outcome, "hold");
  assert.match(r17[0].message, /will not advance/);
});

test("two consecutive flagged completed sessions regress one rung when above the first rung", () => {
  let s = initState(levels, "L1");
  s.item_state[ITEM].rung = 1;
  const first = applySessionFinal(s, levels, ev({ session_id: "S1", flagged: [ITEM], flag_streaks: { [ITEM]: 1 } }), { config });
  assert.equal(first.state.item_state[ITEM].rung, 1);
  assert.equal(first.log.find((e) => e.rule_id === "R17").outcome, "hold");
  const second = applySessionFinal(first.state, levels, ev({ session_id: "S2", ts: "2026-12-03T12:00:00-06:00", flagged: [ITEM], flag_streaks: { [ITEM]: 2 } }), { config });
  assert.equal(second.state.item_state[ITEM].rung, 0);
  const r17 = second.log.filter((e) => e.rule_id === "R17");
  assert.equal(r17.length, 1);
  assert.equal(r17[0].outcome, "regress_step");
  assert.match(r17[0].message, /2 sessions in a row/);
  assert.match(r17[0].message, /stepped back one rung/);
  assert.equal(second.out.outcome, "regress_step");
});

test("two consecutive flags at the first rung only hold", () => {
  let s = initState(levels, "L1");
  assert.equal(s.item_state[ITEM].rung, 0);
  const first = applySessionFinal(s, levels, ev({ flagged: [ITEM], flag_streaks: { [ITEM]: 1 } }), { config });
  const second = applySessionFinal(first.state, levels, ev({ session_id: "S2", flagged: [ITEM], flag_streaks: { [ITEM]: 2 } }), { config });
  assert.equal(second.state.item_state[ITEM].rung, 0);
  assert.equal(second.log.find((e) => e.rule_id === "R17").outcome, "hold");
  assert.match(second.log.find((e) => e.rule_id === "R17").message, /will not advance/);
});

test("an unflagged completed session resets the consecutive flag streak", () => {
  let s = initState(levels, "L1");
  s.item_state[ITEM].rung = 1;
  s = applySessionFinal(s, levels, ev({ session_id: "S1", flagged: [ITEM], flag_streaks: { [ITEM]: 1 } }), { config }).state;
  s = applySessionFinal(s, levels, ev({ session_id: "S2", ts: "2026-12-03T12:00:00-06:00" }), { config }).state;
  assert.equal(s.item_state[ITEM].rung, 1);
  const third = applySessionFinal(s, levels, ev({ session_id: "S3", ts: "2026-12-05T12:00:00-06:00", flagged: [ITEM], flag_streaks: { [ITEM]: 1 } }), { config });
  assert.equal(third.state.item_state[ITEM].rung, 1);
  assert.equal(third.log.find((e) => e.rule_id === "R17").outcome, "hold");
});

test("REST_SEC is 15 and rest cues tick at 3-2-1 then go at 0", () => {
  assert.equal(REST_SEC, 15);
  assert.deepEqual(restCuesToPlay(15000, 14900), []);
  assert.deepEqual(restCuesToPlay(3100, 2900), ["tick"]);
  assert.deepEqual(restCuesToPlay(2100, 1900), ["tick"]);
  assert.deepEqual(restCuesToPlay(1100, 900), ["tick"]);
  assert.deepEqual(restCuesToPlay(200, 0), ["go"]);
  assert.deepEqual(restCuesToPlay(3500, 0), ["tick", "tick", "tick", "go"]);
  assert.deepEqual(restCuesToPlay(0, 0), []);
  assert.equal(needsRestAfter(0, 3), true);
  assert.equal(needsRestAfter(1, 3), true);
  assert.equal(needsRestAfter(2, 3), false);
  assert.equal(needsRestAfter(0, 1), false);
});

test("setPlan counts untimed sets and leaves timed holds alone", () => {
  assert.equal(setPlan({ sets: 3, hold_s: 10 }), null);
  assert.deepEqual(setPlan({ sets: 3, reps: 6 }), { sets: 3 });
  assert.deepEqual(setPlan({ pyr_top: 4, hold_s: 8 }), null); // pyramid holds are timed
  assert.deepEqual(setPlan({ sets: 4, reps: 8, load_lb: 25 }), { sets: 4 });
  assert.deepEqual(setPlan({ reps: 10 }), { sets: 1 });
  assert.equal(setPlan({ distance_m: 20 }), null);
  assert.equal(timedPlan({ sets: 3, reps: 6 }), null);
});

test("go and tick wavs are short distinct PCM cues", () => {
  for (const [name, minS, maxS] of [["tick.wav", 0.05, 0.3], ["go.wav", 0.35, 1.2]]) {
    const path = join(root, "public/sounds", name);
    assert.equal(existsSync(path), true, name);
    const buf = readFileSync(path);
    assert.equal(buf.toString("ascii", 0, 4), "RIFF");
    assert.equal(buf.toString("ascii", 8, 12), "WAVE");
    const rate = buf.readUInt32LE(24);
    const channels = buf.readUInt16LE(22);
    const bits = buf.readUInt16LE(34);
    assert.equal(channels, 1);
    assert.equal(bits, 16);
    const dataSize = buf.readUInt32LE(40);
    const seconds = dataSize / (rate * channels * (bits / 8));
    assert.ok(seconds >= minS && seconds <= maxS, `${name} duration ${seconds}`);
  }
  const ding = readFileSync(join(root, "public/sounds/ding.wav"));
  const go = readFileSync(join(root, "public/sounds/go.wav"));
  const tick = readFileSync(join(root, "public/sounds/tick.wav"));
  assert.notEqual(Buffer.compare(ding, go), 0);
  assert.notEqual(Buffer.compare(go, tick), 0);
});
