// Dose text and timed-set detection from rung fields (not exercise ids).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatDose, timedPlan, pyramidCounts } from "../public/js/dose.js";

const j = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const levels = j("../public/data/levels.json");

const itemAt = (levelId, exerciseId) => {
  const lv = levels.levels.find((l) => l.id === levelId);
  return lv.items.find((i) => i.exercise_id === exerciseId);
};

test("pyramidCounts matches the 4-2-1 / 3-2-1 display rule", () => {
  assert.deepEqual(pyramidCounts({ pyr_top: 4, hold_s: 8 }), [4, 2, 1]);
  assert.deepEqual(pyramidCounts({ pyr_top: 3, pyr_gap: 1, hold_s: 8 }), [3, 2, 1]);
  assert.equal(pyramidCounts({ hold_s: 8 }), null);
});

test("rep-only or load-only doses are not timed", () => {
  assert.equal(timedPlan({ sets: 3, reps: 10 }), null);
  assert.equal(timedPlan({ sets: 3, reps: 5, load_lb: 25 }), null);
  assert.equal(timedPlan({ distance_m: 20 }), null);
  assert.equal(timedPlan({ hold_s: 0 }), null);
  assert.equal(timedPlan({}), null);
});

test("a minutes walk or decompression is one countdown", () => {
  const walk = timedPlan({ time_min: 20 });
  assert.equal(walk.seconds, 1200);
  assert.equal(walk.kind, "time");
  assert.equal(walk.steps.length, 1);
  assert.match(walk.steps[0].label, /20 min/);
  const decomp = timedPlan({ time_min: 3 });
  assert.equal(decomp.seconds, 180);
});

test("multi-set holds get a set counter, and per-side adds left then right", () => {
  const brace = timedPlan({ sets: 5, hold_s: 10 });
  assert.equal(brace.seconds, 10);
  assert.equal(brace.kind, "hold");
  assert.deepEqual(brace.steps.map((s) => s.label), ["Hold 1 of 5", "Hold 2 of 5", "Hold 3 of 5", "Hold 4 of 5", "Hold 5 of 5"]);

  const stretch = timedPlan({ sets: 2, hold_s: 20 }, { per_side: true, rest_s: 60 });
  assert.equal(stretch.steps.length, 4);
  assert.equal(stretch.rest_s, 60);
  assert.deepEqual(stretch.steps.map((s) => `${s.set}:${s.side}`), ["1:left", "1:right", "2:left", "2:right"]);
  assert.match(stretch.steps[0].label, /Hold 1 of 2 · left/);
});

test("pyramid holds expand to one interval per hold", () => {
  const curl = timedPlan({ pyr_top: 4, hold_s: 8 });
  assert.equal(curl.seconds, 8);
  assert.equal(curl.steps.length, 7); // 4+2+1
  const side = timedPlan({ pyr_top: 3, pyr_gap: 1, hold_s: 8 }, { per_side: true });
  assert.equal(side.steps.length, 12); // (3+2+1) * 2 sides
});

test("time_s sets (carries) and reps of time_s (intervals) are timed", () => {
  const carry = timedPlan({ sets: 3, time_s: 20, load_lb: 10 }, { per_side: true });
  assert.equal(carry.seconds, 20);
  assert.equal(carry.kind, "time");
  assert.equal(carry.steps.length, 6);
  assert.match(carry.steps[1].label, /Set 1 of 3 · right/);
  const intervals = timedPlan({ reps: 6, time_s: 60 });
  assert.equal(intervals.seconds, 60);
  assert.equal(intervals.steps.length, 6);
});

test("a short hold on a rep scheme is still a timed hold (field-based, not by id)", () => {
  const bird = timedPlan({ sets: 2, reps: 6, hold_s: 5 }, { per_side: true });
  assert.equal(bird.seconds, 5);
  assert.equal(bird.steps.length, 24);
  assert.equal(timedPlan({ sets: 2, reps: 6 }), null, "the same scheme without hold_s is not timed");
});

test("seed L1 current doses: walk, brace, curl-up, side bridge and bird dog parse as expected", () => {
  const walk = itemAt("L1", "EX_WALK_EASY");
  const pWalk = timedPlan(walk.rungs[0], walk);
  assert.equal(pWalk.seconds, walk.rungs[0].time_min * 60);
  assert.equal(pWalk.steps.length, 1);

  const brace = itemAt("L1", "EX_STAND_BRACE");
  const pBrace = timedPlan(brace.rungs[0], brace);
  assert.equal(pBrace.seconds, 10);
  assert.equal(pBrace.steps.length, 5);

  const curl = itemAt("L1", "EX_CURLUP");
  assert.equal(timedPlan(curl.rungs[0], curl).steps.length, 7);

  const side = itemAt("L1", "EX_SIDE_BRIDGE_KNEES");
  assert.ok(side.per_side);
  assert.equal(timedPlan(side.rungs[0], side).steps.length, 12);

  const bird = itemAt("L1", "EX_BIRD_DOG");
  assert.equal(timedPlan(bird.rungs[0], bird).seconds, 5);

  // A non-timed L1 strength item stays untimed.
  const squat = itemAt("L1", "EX_BOX_SQUAT_STRAP") || itemAt("L1", "EX_SIT_TO_STAND") || levels.levels.find((l) => l.id === "L1").items.find((i) => i.block === "strength_A" && !i.rungs[0].hold_s && !i.rungs[0].time_s && !i.rungs[0].time_min);
  assert.ok(squat, "need an untimed strength item");
  assert.equal(timedPlan(squat.rungs[0], squat), null);
});

test("formatDose still reads the same timed schemes", () => {
  assert.match(formatDose({ sets: 5, hold_s: 10 }), /5x10 s hold/);
  assert.match(formatDose({ time_min: 20 }), /20 min/);
  assert.match(formatDose({ pyr_top: 4, hold_s: 8 }), /4-2-1 holds of 8 s/);
});
