import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearItemProgress, finishBarHtml, itemSheetTailHtml } from "../public/js/item-progress.js";
import { timedPlan, setPlan } from "../public/js/dose.js";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("every item details sheet gets a Finish bar, with unexpected pain after it", () => {
  const bar = finishBarHtml();
  assert.match(bar, /data-ex-finish/);
  assert.match(bar, />Finish</);
  assert.doesNotMatch(bar, /Start over/i);
  const tail = itemSheetTailHtml('<div class="pain-flag" id="pain-flag">Unexpected pain</div>');
  assert.ok(tail.indexOf("data-ex-finish") < tail.indexOf("pain-flag"));
  assert.ok(tail.indexOf("pain-flag") < tail.indexOf("Unexpected pain"));
  assert.equal(tail.trim().endsWith("</div>"), true);
});

test("exercise details source always renders the Finish tail and no longer says Start over", () => {
  const js = src("../public/js/ui/exercise-timer.js");
  assert.match(js, /itemSheetTailHtml/);
  assert.match(js, /data-ex-finish/);
  assert.doesNotMatch(js, /Start over/);
  const show = js.slice(js.indexOf("export async function showExercise"), js.indexOf("function autoToggleHtml"));
  assert.ok(show.indexOf("itemSheetTailHtml") > show.indexOf("Ladder"), "Finish/pain tail comes after the ladder");
  assert.match(show, /pain-flag/);
});

test("unchecking a Today row clears that item's set progress and leaves other items alone", () => {
  const day = {
    local_date: "2026-11-26",
    checklist: [{ item_key: "A", done: false }, { item_key: "B", done: true }],
    set_progress: { A: { current: 2, done: true }, B: { current: 1, done: false } },
  };
  const next = clearItemProgress(day, "A");
  assert.equal("A" in next.set_progress, false);
  assert.deepEqual(next.set_progress.B, { current: 1, done: false });
  assert.equal(day.set_progress.A.current, 2, "original day is not mutated");
  assert.equal(clearItemProgress(next, "A"), next, "clearing a missing key is a no-op");
  assert.equal(clearItemProgress(day, "Z").set_progress.A.current, 2);
});

test("multi-set and multi-bout items previously only labeled Finish on the last step", () => {
  const multiSet = setPlan({ sets: 2, reps: 8 });
  const oneSet = setPlan({ reps: 8 });
  const multiTime = timedPlan({ sets: 5, hold_s: 10 }, {});
  const oneTime = timedPlan({ time_min: 5 }, {});
  assert.equal(multiSet.sets, 2);
  assert.equal(oneSet.sets, 1);
  assert.ok(multiTime.steps.length > 1);
  assert.equal(oneTime.steps.length, 1);
});
