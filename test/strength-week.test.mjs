import { test } from "node:test";
import assert from "node:assert/strict";
import {
  weekStartMonday, weekEndSunday, hadStrengthYesterday, strengthCountThisWeek,
  weeklyStrengthTarget, weeklyStrengthLabel, shouldShowStrengthRest, isStrengthTemplate,
} from "../public/js/strength-week.js";

const s = (over) => ({ id: over.id || "s1", template: over.template || "strength_A", local_date: over.local_date, started_at: over.started_at });

test("week is Monday–Sunday in local calendar dates", () => {
  assert.equal(weekStartMonday("2026-11-25"), "2026-11-23"); // Wed
  assert.equal(weekEndSunday("2026-11-25"), "2026-11-29");
  assert.equal(weekStartMonday("2026-11-23"), "2026-11-23"); // Mon
  assert.equal(weekStartMonday("2026-11-29"), "2026-11-23"); // Sun
  assert.equal(weekStartMonday("2026-11-30"), "2026-11-30"); // next Mon
});

test("hadStrengthYesterday is true only for a strength_A/B session on the previous local date", () => {
  const sessions = [
    s({ id: "a", template: "strength_A", local_date: "2026-11-24" }),
    s({ id: "c", template: "conditioning", local_date: "2026-11-24" }),
  ];
  assert.equal(hadStrengthYesterday(sessions, "2026-11-25"), true);
  assert.equal(hadStrengthYesterday(sessions, "2026-11-24"), false);
  assert.equal(hadStrengthYesterday([s({ id: "c", template: "conditioning", local_date: "2026-11-24" })], "2026-11-25"), false);
  assert.equal(hadStrengthYesterday([], "2026-11-25"), false);
  assert.equal(isStrengthTemplate("strength_B"), true);
  assert.equal(isStrengthTemplate("conditioning"), false);
});

test("strengthCountThisWeek counts unique sessions in the Mon–Sun week and ignores other templates", () => {
  const sessions = [
    s({ id: "a", template: "strength_A", local_date: "2026-11-23" }),
    s({ id: "a", template: "strength_A", local_date: "2026-11-23" }), // same session, deduped
    s({ id: "b", template: "strength_B", local_date: "2026-11-25" }),
    s({ id: "c", template: "conditioning", local_date: "2026-11-25" }),
    s({ id: "old", template: "strength_A", local_date: "2026-11-22" }), // previous Sunday
    s({ id: "next", template: "strength_A", local_date: "2026-11-30" }),
  ];
  assert.equal(strengthCountThisWeek(sessions, "2026-11-25"), 2);
  assert.equal(strengthCountThisWeek(sessions, "2026-11-30"), 1);
  assert.equal(strengthCountThisWeek([], "2026-11-25"), 0);
});

test("weeklyStrengthTarget hides 0 or missing and keeps range strings", () => {
  assert.equal(weeklyStrengthTarget({ frequency: { strength_sessions_per_week: 3 } }), 3);
  assert.equal(weeklyStrengthTarget({ frequency: { strength_sessions_per_week: 0 } }), null);
  assert.equal(weeklyStrengthTarget({ frequency: {} }), null);
  assert.equal(weeklyStrengthTarget({}), null);
  assert.equal(weeklyStrengthTarget({ frequency: { strength_sessions_per_week: "2-3" } }), "2-3");
  assert.equal(weeklyStrengthLabel(1, 3), "Strength: 1 of 3 this week");
  assert.equal(weeklyStrengthLabel(2, "2-3"), "Strength: 2 of 2-3 this week");
  assert.equal(weeklyStrengthLabel(0, null), "");
});

test("shouldShowStrengthRest is the day after a strength session, unless today is already logged or started anyway", () => {
  const sessions = [s({ id: "a", template: "strength_A", local_date: "2026-11-24" })];
  assert.equal(shouldShowStrengthRest({ sessions, today: "2026-11-25" }), true);
  assert.equal(shouldShowStrengthRest({ sessions, today: "2026-11-25", startedAnyway: true }), false);
  assert.equal(shouldShowStrengthRest({ sessions, today: "2026-11-25", loggedToday: true }), false);
  assert.equal(shouldShowStrengthRest({ sessions, today: "2026-11-24" }), false);
  assert.equal(shouldShowStrengthRest({ sessions: [], today: "2026-11-25" }), false);
});
