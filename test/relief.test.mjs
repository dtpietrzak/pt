import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RELIEF_OPTIONS, newReliefEntry, addReliefEntry, removeLatestOfType, reliefLogOf, countByType,
  reliefRangeSummary, decompFromReliefLogs, reliefById,
} from "../public/js/relief.js";
import { reliefCardHtml } from "../public/js/ui/relief.js";
import { eveningFromLogs } from "../public/js/checkins.js";
import { advanceTimerByNext } from "../public/js/pain-flags.js";
import { RED_FLAGS } from "../public/js/checkins.js";
import { CLINICIAN_DEFAULT } from "../public/js/engine.js";

const j = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const exercises = j("../public/data/exercises.json");
const config = j("../public/data/decision-config.json");
const byId = Object.fromEntries(exercises.exercises.map((e) => [e.id, e]));

test("relief options cover the seven listed positions, including the inversion table", () => {
  const ids = RELIEF_OPTIONS.map((o) => o.exercise_id);
  assert.deepEqual(ids, [
    "EX_DECOMP_90_90", "EX_SIDELYING_REST", "EX_DECOMP_PRONE_ELBOWS",
    "EX_STAND_EXTENSION", "EX_DOOR_HANG", "EX_KNEE_TO_CHEST_RELIEF", "EX_INVERSION_TABLE",
  ]);
  for (const id of ids) assert.ok(byId[id], id);
  const inv = byId.EX_INVERSION_TABLE;
  assert.match(inv.name, /Inversion table/i);
  assert.equal(inv.category, "relief");
  assert.ok(inv.cues.length >= 2);
  assert.equal(/diagnos|treat|cure|heal|decompress the disc/i.test(inv.cues.join(" ")), false);
  assert.ok(RELIEF_OPTIONS.find((o) => o.exercise_id === "EX_INVERSION_TABLE").timed);
  assert.ok(RELIEF_OPTIONS.find((o) => o.exercise_id === "EX_DECOMP_90_90").timed);
  assert.equal(RELIEF_OPTIONS.find((o) => o.exercise_id === "EX_STAND_EXTENSION").timed, false);
});

test("relief logs stay off the checklist and count by day and type", () => {
  const a = newReliefEntry({ exercise_id: "EX_DECOMP_90_90", ts: "2026-11-25T08:00:00-06:00", timed: true, duration_s: 300, id: "a" });
  const b = newReliefEntry({ exercise_id: "EX_STAND_EXTENSION", ts: "2026-11-25T12:00:00-06:00", timed: false, id: "b" });
  const c = newReliefEntry({ exercise_id: "EX_DECOMP_90_90", ts: "2026-11-26T09:00:00-06:00", timed: false, id: "c" });
  let d1 = addReliefEntry({ local_date: "2026-11-25", checklist: [] }, a);
  d1 = addReliefEntry(d1, b);
  const d2 = addReliefEntry({ local_date: "2026-11-26", checklist: [] }, c);
  assert.equal(d1.checklist.length, 0);
  assert.equal(reliefLogOf(d1).length, 2);
  const week = reliefRangeSummary({ "2026-11-25": d1, "2026-11-26": d2 }, "2026-11-23", "2026-11-29");
  assert.equal(week.total, 3);
  assert.equal(week.by_type.EX_DECOMP_90_90, 2);
  assert.equal(week.by_type.EX_STAND_EXTENSION, 1);
  assert.equal(week.by_day.length, 2);
  assert.deepEqual(countByType(reliefLogOf(d1)), { EX_DECOMP_90_90: 1, EX_STAND_EXTENSION: 1 });
});

test("evening decomp_breaks_done comes from relief_log when that array is present", () => {
  const day = { relief_log: [newReliefEntry({ exercise_id: "EX_DECOMP_90_90", ts: "t", id: "a" })], decomp_breaks_done: 9 };
  assert.equal(decompFromReliefLogs(day), 1);
  const f = eveningFromLogs({ day, blocks: [] }, { pain: 2, forced_rest: 0, leg: "none" });
  assert.equal(f.decomp, 1);
  // no log array: previous work-timer / day field mapping still applies
  const f2 = eveningFromLogs({ day: { decomp_breaks_done: 2 }, blocks: [] }, { pain: 2, forced_rest: 0, leg: "none" });
  assert.equal(f2.decomp, 2);
  const f3 = eveningFromLogs({ day: {} }, { pain: 2, forced_rest: 0, leg: "none" });
  assert.equal(f3.decomp, undefined);
});

test("Next on an idle timed bout advances the count without running the clock", () => {
  const plan = { seconds: 5, steps: [{ label: "Hold 1" }, { label: "Hold 2" }, { label: "Hold 3" }] };
  const idle = { plan, step: 0, status: "idle", remain: 5000, endsAt: null };
  const r = advanceTimerByNext(idle, 1_000_000);
  assert.equal(r.sess.status, "idle");
  assert.equal(r.sess.step, 1);
  assert.equal(r.sess.endsAt, null);
  assert.equal(r.ding, true);
  assert.equal(r.markDone, false);
  const last = advanceTimerByNext({ ...r.sess, step: 2 }, 1_000_000);
  assert.equal(last.sess.status, "done");
  assert.equal(last.markDone, true);
  assert.equal(last.ding, true);
});

test("Next during rest skips rest and does not start the next countdown", () => {
  const plan = { seconds: 5, steps: [{ label: "Hold 1" }, { label: "Hold 2" }] };
  const r = advanceTimerByNext({ plan, step: 0, status: "rest", remain: 0, restEndsAt: 1_015_000 }, 1_000_000);
  assert.equal(r.sess.status, "idle");
  assert.equal(r.sess.step, 1);
  assert.equal(r.sess.endsAt, null);
  assert.equal(r.ding, false);
});

test("new swelling in the back is on the clinician list", () => {
  assert.ok(RED_FLAGS.some(([k, l, kind]) => k === "new_swelling_in_back" && kind === "clinician" && /swelling in the back/i.test(l)));
  assert.ok(CLINICIAN_DEFAULT.includes("new_swelling_in_back"));
  assert.ok(config.red.clinician.includes("new_swelling_in_back"));
  assert.ok(!config.red.emergency.includes("new_swelling_in_back"));
});

test("heavy squat, deadlift and swing cues carry the breathing guidance", () => {
  const throughL5 = ["EX_BOX_SQUAT_STRAP", "EX_BOX_SQUAT", "EX_GOBLET_BOX_SQUAT", "EX_GOBLET_SQUAT", "EX_KB_DL_BLOCK", "EX_KB_DL_FLOOR", "EX_SPLIT_SQUAT_SUP", "EX_SPLIT_SQUAT_LOADED", "EX_SL_RDL"];
  const later = ["EX_BARBELL_DL_BLOCK", "EX_BARBELL_DL_FLOOR", "EX_BARBELL_SQUAT", "EX_KB_SWING"];
  for (const id of throughL5) {
    const cues = (byId[id].cues || []).join(" ");
    assert.match(cues, /Keep breathing; no long breath-hold \(Valsalva\)\./, id);
  }
  for (const id of later) {
    const cues = (byId[id].cues || []).join(" ");
    assert.match(cues, /Brief brace only, no long strain/, id);
  }
});

test("minus removes the most recent log of that type and will not go below zero", () => {
  const a = newReliefEntry({ exercise_id: "EX_DECOMP_90_90", ts: "2026-11-25T08:00:00-06:00", id: "a" });
  const b = newReliefEntry({ exercise_id: "EX_STAND_EXTENSION", ts: "2026-11-25T09:00:00-06:00", id: "b" });
  const c = newReliefEntry({ exercise_id: "EX_DECOMP_90_90", ts: "2026-11-25T10:00:00-06:00", id: "c" });
  let day = { local_date: "2026-11-25", checklist: [], relief_log: [a, b, c] };
  day = removeLatestOfType(day, "EX_DECOMP_90_90");
  assert.deepEqual(reliefLogOf(day).map((e) => e.id), ["a", "b"]);
  day = removeLatestOfType(day, "EX_DECOMP_90_90");
  assert.deepEqual(reliefLogOf(day).map((e) => e.id), ["b"]);
  const same = removeLatestOfType(day, "EX_DECOMP_90_90");
  assert.equal(same, day);
  assert.deepEqual(reliefLogOf(same).map((e) => e.id), ["b"]);
});

test("the Today Relief card is a collapsed accordion with a stepper per option", () => {
  const html = reliefCardHtml({ exById: byId }, {
    relief_log: [
      newReliefEntry({ exercise_id: "EX_DECOMP_90_90", ts: "t", id: "a" }),
      newReliefEntry({ exercise_id: "EX_DECOMP_90_90", ts: "t2", id: "b" }),
    ],
  });
  assert.match(html, /data-toggle-block="relief"/);
  assert.match(html, />2 today</);
  assert.equal(/section-card open/.test(html), false);
  assert.match(html, /hidden/);
  assert.equal(/data-relief-open|Log relief|relief-picker/.test(html), false);
  for (const o of RELIEF_OPTIONS) {
    assert.match(html, new RegExp(`data-relief-step="${o.exercise_id}"`));
  }
  assert.match(html, /data-relief-val="EX_DECOMP_90_90">2</);
  assert.match(html, /data-block="relief"/);
});
