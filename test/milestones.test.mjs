// Rehabilitation milestones: L1-L8 in order, back to back, matching the plan's levels.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MILESTONES, milestoneOn } from "../public/js/milestones.js";
import { addDays } from "../public/js/util.js";

const levels = JSON.parse(readFileSync(new URL("../public/data/levels.json", import.meta.url))).levels;

test("milestones cover L1-L8 with no gaps", () => {
  assert.deepEqual(MILESTONES.map((m) => m.id), ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"]);
  for (const m of MILESTONES) assert.ok(levels.some((l) => l.id === m.id), m.id);
  for (let i = 1; i < MILESTONES.length; i++) assert.equal(MILESTONES[i].start, addDays(MILESTONES[i - 1].end, 1));
  assert.equal(MILESTONES.at(-1).end, null);
});

test("milestoneOn finds the target level for a date", () => {
  assert.equal(milestoneOn("2026-12-08").id, "L1");
  assert.equal(milestoneOn("2026-12-09").id, "L2");
  assert.equal(milestoneOn("2030-01-01").id, "L8");
  assert.equal(milestoneOn("2026-01-01"), null);
});
