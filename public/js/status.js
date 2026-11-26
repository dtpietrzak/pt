// Phase 3 (pure): level status, gate-test overview/eligibility/results, decision messages, equipment reconfirm.
// No DOM, no I/O. The UI is js/ui/status.js.
import { addDays } from "./util.js";
import { levelById, gatePass } from "./engine.js";

const r5 = (x) => Math.round(x / 5) * 5;
export const REQUIRED_EQUIPMENT = [
  ["barbell", "Barbell"], ["rack_with_safeties", "Rack with safeties"], ["bench", "Bench"],
  ["pull_up_bar", "Pull-up bar"], ["blocks", "Blocks for pulling from raised height"], ["track_or_field", "Track or open field (for later levels)"],
];
export const levelNumber = (id) => Number(String(id).replace("L", ""));
/** Barbell work starts at L6, so reconfirm equipment once the plan is at L6 or beyond. */
export const needsEquipConfirm = (state, confirmed) => levelNumber(state.level_id) >= 6 && !confirmed;

// ---------------------------------------------------------------- thresholds with live body weight
const PCT = /(\d+(?:\.\d+)?)\s*%\s*BW/;
/** Pounds for a "NN% BW" threshold at the profile's body weight, snapped to 5 lb (null when it isn't a BW target). */
export function resolvedLb(thr, bw) {
  const m = typeof thr?.value === "string" ? PCT.exec(thr.value) : null;
  return m ? r5((Number(m[1]) / 100) * bw) : null;
}
const UNIT = { min: "min", s: "s", reps: "reps", "reps/leg": "reps per leg", "reps/side": "reps per side", "hours upright": "hours upright", contacts: "contacts", "hops/leg": "hops per leg", "LSI %": "% limb symmetry", effort: "" };
/** "3x5 @ 75% BW (≈ 135 lb)" or "30 min" - what to hit, with pounds recomputed from the live body weight. */
export function thresholdText(test, thr, bw) {
  const v = thr?.value;
  let s;
  if (typeof v === "number") { const u = UNIT[test?.unit]; s = u === undefined ? String(v) : `${v}${u ? " " + u : ""}`; }
  else if (typeof v === "string") { const lb = resolvedLb(thr, bw); s = lb ? v.replace(PCT, (all) => `${all} (≈ ${lb} lb)`) : v; }
  else s = "see protocol";
  // Notes carry weights worked out at 180 lb; those would be stale, so only keep notes without them.
  const note = (thr?.note || "").split(";").map((x) => x.trim()).filter((x) => x && !/\bat default\b|\d+\s*lb\b/i.test(x)).join("; ");
  return note ? `${s} (${note})` : s;
}
export const isNumericTest = (thr) => typeof thr?.value === "number";

// ---------------------------------------------------------------- level status: what's needed to advance
const MODE_TEXT = {
  active: "Training as planned.",
  settle: "Settle mode: rest, gentle walks and relief positions until things calm down.",
  red_stop: "Plan frozen by a red flag.",
  paused: "Paused: nothing advances, regresses or counts toward a layoff.",
  maintenance: "Maintenance: you finished the plan. Keep training, and the app keeps watching.",
};
export function levelStatus(state, levelsDoc, cfg, testsDoc) {
  const level = levelById(levelsDoc, state.level_id);
  const exit = level?.exit || {};
  const req = state.lock?.easy_dose ? state.lock.clean_required : (cfg?.advance?.clean_exposures_required ?? 2);
  const all = (level?.items || []).filter((i) => !i.optional && i.block !== "relief");
  const rows = all.map((i) => {
    const st = state.item_state[i.item_key] || {};
    return { key: i.item_key, exercise_id: i.exercise_id, block: i.block, rung: st.rung ?? i.start_rung, target: i.target_rung, rungs: i.rungs.length, held_out: !!st.held_out, exposures: st.clean_exposures || 0, needed: req, atTarget: (st.rung ?? i.start_rung) >= i.target_rung && !st.held_out };
  });
  const notAt = rows.filter((r) => !r.atTarget);
  const streak = state.level_clean_streak || 0, streakNeed = exit.clean_streak_sessions ?? 0;
  const gates = (exit.tests || []).map((t) => {
    const g = state.gate_tests?.[t.test_id] || { status: "not_started" };
    return { ...t, status: g.status, value: g.value, retestAfter: g.retest_after_clean_sessions || 0, test: (testsDoc?.tests || []).find((x) => x.id === t.test_id) };
  });
  const nonOptional = gates.filter((g) => !g.optional);
  const confirmed = nonOptional.filter((g) => g.status === "pass_confirmed").length;
  const checks = [
    { id: "items", ok: notAt.length === 0, label: "Every required exercise at its target", detail: notAt.length ? `${rows.length - notAt.length} of ${rows.length} there` : `All ${rows.length} there` },
    { id: "streak", ok: streak >= streakNeed, label: `${streakNeed} clean strength sessions in a row`, detail: `${Math.min(streak, streakNeed)} of ${streakNeed}` },
    { id: "gates", ok: nonOptional.length > 0 && confirmed === nonOptional.length, label: "Gate tests passed and confirmed", detail: state.gate_pending ? `${confirmed} of ${nonOptional.length} confirmed` : "Unlock once the two above are done" },
  ];
  const next = state.mode !== "active" ? MODE_TEXT[state.mode] : notAt.length ? "Keep logging clean sessions; exercises step up after consecutive clean exposures." : streak < streakNeed ? `Keep logging clean sessions (${streak} of ${streakNeed}).` : state.gate_pending ? "Gate tests are next." : "Criteria met; gate tests unlock on the next evaluation.";
  return {
    level, mode: state.mode, modeText: MODE_TEXT[state.mode] || "", checks, rows, notAt, streak, streakNeed, gates, gatePending: !!state.gate_pending, next,
    probation: state.probation_sessions_remaining || 0, lock: state.lock?.easy_dose ? { clean_required: state.lock.clean_required } : null,
    clinician: !!state.clinician_recommended, extra: exit.extra || [], isLast: levelNumber(state.level_id) >= 8,
  };
}

export const GATE_STATUS = {
  not_started: ["Not tested yet", "later"], pass_provisional: ["Passed, waiting on a green morning", "yellow"], pass_confirmed: ["Confirmed", "green"],
  fail: ["Not passed", "orange"], skipped_optional: ["Skipped", "later"],
};
export const GROUP_LABEL = { core: "Core endurance", strength: "Strength", function: "Function", impact: "Impact", speed: "Speed and agility", balance: "Balance", pattern: "Movement patterns", sport: "Sport" };

/** Tests that can be run now: never tested, or failed with the retest wait served. */
export const testable = (g) => g.status === "not_started" || (g.status === "fail" && g.retestAfter === 0);

/** Which groups can be tested, and whether today is a valid day (yesterday and this morning green). */
export function gateEligibility({ state, status, daily = {}, evals = {}, checkins = [], today }) {
  if (state.mode !== "active") return { ok: false, why: "Gate tests wait until you're back in normal training.", groups: [] };
  if (!state.gate_pending) return { ok: false, why: "Not yet: finish the level's other criteria first.", groups: [] };
  const todo = status.gates.filter(testable);
  const byGroup = {};
  for (const g of todo) (byGroup[g.test?.category || "function"] ||= []).push(g);
  const groups = Object.entries(byGroup).map(([k, tests]) => ({ id: k, label: GROUP_LABEL[k] || k, tests }));
  if (!groups.length) return { ok: false, why: "Nothing to test right now. Passed tests are waiting on a green morning, or failed ones on more clean sessions.", groups };
  const y = daily[addDays(today, -1)];
  if (!y || y.color !== "green") return { ok: false, why: "Test days need a green yesterday. Wait for a day with all-green check-ins.", groups };
  const m = checkins.filter((c) => c.type === "morning" && c.local_date === today).sort((a, b) => (a.ts < b.ts ? -1 : 1)).pop();
  if (!m) return { ok: false, why: "Do this morning's check-in first.", groups };
  if (evals[m.id]?.color !== "green") return { ok: false, why: "Test days need a green morning check-in. Not today.", groups };
  return { ok: true, why: "Yesterday and this morning are green. Today is a good day to test.", groups };
}

/** One entered result -> the gate_results entry stored on the session. `value` is a number or "met" / "not met". */
export function gateResult(test, thr, input) {
  const numeric = isNumericTest(thr);
  const value = numeric ? Number(input.value) : input.met ? "met" : "not met";
  const g = { test_id: test.id, value: Number.isFinite(value) || !numeric ? value : 0, form_ok: input.form_ok !== false };
  g.pain_peak = Math.max(0, Math.min(10, Math.round(Number(input.pain_peak) || 0)));
  g.passed = gatePass(g, thr, null);
  return g;
}
export function buildGateSession({ id, state, tests, results, now, startedAt, endedAt }) {
  return {
    id, local_date: endedAt.slice(0, 10), started_at: startedAt, ended_at: endedAt, template: "gate_test", level_id: state.level_id,
    items: [], gate_test_ids: tests.map((t) => t.id), gate_results: results, post_workout_checkin_id: null, status: "provisional",
  };
}

// ---------------------------------------------------------------- decisions to announce
export const MAJOR = new Set(["promote", "regress_level", "settle_enter", "settle_exit", "red", "gate_pending"]);
const isMajor = (e) => MAJOR.has(e.outcome) || e.rule_id === "R17" || (e.rule_id === "R15" && /physician|clinician/i.test(e.message || ""));
/** Log entries newer than the last acknowledged moment that deserve a full-screen explanation, oldest first. */
export function unseenDecisions(log, ackTs) {
  const t = (x) => new Date(x).getTime();
  return log.filter((e) => isMajor(e) && (!ackTs || t(e.ts) > t(ackTs))).sort((a, b) => t(a.ts) - t(b.ts) || (a.id < b.id ? -1 : 1));
}
const lvName = (levelsDoc, id) => levelById(levelsDoc, id)?.name || id;
/** What the announcement screen says for a decision. state is the plan state right now. */
export function decisionCopy(e, state, levelsDoc) {
  const lv = levelById(levelsDoc, state.level_id);
  if (e.rule_id === "R17") {
    return e.outcome === "regress_step"
      ? { tone: "down", icon: "↩️", title: "Stepping that exercise back", body: e.message, points: ["It stays at this dose until you complete it without the unexpected-pain flag."] }
      : { tone: "info", icon: "ℹ️", title: "Holding this exercise", body: e.message, points: ["A second flagged session in a row will step it back one rung, if it has one to step back from."] };
  }
  switch (e.outcome) {
    case "promote": return {
      tone: "up", icon: "🎉", title: `Level up: ${state.level_id} ${lvName(levelsDoc, state.level_id)}`, body: e.message,
      points: [lv?.goal, `Probation: your first ${state.probation_sessions_remaining || 2} sessions here must not be orange, or you step back.`, "Every exercise starts at its first rung. Take the easy start."].filter(Boolean),
      equip: levelNumber(state.level_id) >= 6 };
    case "regress_level": return {
      tone: "down", icon: "↩️", title: `Stepping back to ${state.level_id} ${lvName(levelsDoc, state.level_id)}`, body: e.message,
      points: ["This is the plan protecting your back, not a failure.", "Exercises restart one rung below their old target.", "Easy-dose mode is on: you need 3 clean sessions before anything advances again."] };
    case "settle_enter": return {
      tone: "settle", icon: "🌿", title: "Settle mode", body: e.message,
      points: ["Strength work pauses. Rest, gentle walking and relief positions are the work now.", "It ends after 2 green days in a row with standing tolerance back above 70% of normal.", "After that you resume one rung easier. If it isn't settling after a week, see your clinician."] };
    case "settle_exit": return { tone: "up", icon: "☀️", title: "Back to training", body: e.message, points: ["You resume one rung easier, with 3 clean sessions needed before advancing."] };
    case "gate_pending": return { tone: "info", icon: "✅", title: `${state.level_id} criteria met`, body: e.message, points: ["Open Status to see the gate tests. Test on a day when yesterday and this morning are green."], link: "#/status" };
    case "red": return { tone: "red", icon: "⚠️", title: "Red flag: plan frozen", body: e.message, points: ["Open the red-flag screen for what to do now."], link: "#/red" };
    default: return { tone: "info", icon: "ℹ️", title: "Heads up", body: e.message, points: [] };
  }
}

/** Plain-language decision line for Status / History. */
export const ruleLabel = (e) => `${e.rule_id || ""}${e.outcome && e.outcome !== "none" ? ` · ${e.outcome.replace(/_/g, " ")}` : ""}`.replace(/^ · /, "");
