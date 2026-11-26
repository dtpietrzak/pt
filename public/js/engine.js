// Deterministic PT decision engine (plan.md sections 7-8). Pure: no I/O, clock and ids injected.
// Runs in the browser and in Node (tests reproduce seed/test-vectors.json).
import { initPostureState, applyPosture, postureColor, postureEventFromEvening, postureConfig } from "./posture.js";
import { RANK, worst, clone, addDays, dayDiff, hoursBetween, daysBetweenTs, median, round5, localDate } from "./util.js";
import { isItemFlagged, sessionFlagEvents, dailyFlagEvents, consecutiveFlagStreak, FLAG_STREAK_TO_REGRESS } from "./pain-flags.js";

export const EMERGENCY_DEFAULT = ["saddle_numbness", "bladder_bowel_change"];
export const CLINICIAN_DEFAULT = ["new_leg_weakness", "new_numbness_tingling", "fever_with_back_pain", "unexplained_weight_loss",
  "night_pain_unrelieved", "bilateral_leg_symptoms", "trauma_since_last_checkin"];
const STRENGTH_TEMPLATES = new Set(["strength_A", "strength_B"]);
const SESSION_BLOCKS = { strength_A: ["strength_A"], strength_B: ["strength_B"], conditioning: ["conditioning"], core_only: ["daily_core"] };
export { SESSION_BLOCKS };

// =====================================================================================
// 1. Check-in colors (plan.md 7.3) — mirrors reference/ref_checkin.py
// =====================================================================================
const painColor = (p, cfg) => (p <= cfg.pain.green_max ? "green" : p <= cfg.pain.yellow_max ? "yellow" : "orange");
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));

/**
 * evaluateCheckIn(ci, baselines, cfg, ctx) -> { color, red_kind, reasons, modifiers, incident }
 * ctx: { recent_ordinary_sharp_days, prior_leg_checkins, prior_hip_shift_checkins, prior_incidents_7d }
 */
export function evaluateCheckIn(ci, B, cfg, ctx = {}) {
  const d = ci.data || {};
  const reasons = [], mods = [];
  let incident = false, red = null;
  const cols = ["green"];
  const add = (c, why) => { cols.push(c); if (c !== "green") reasons.push(`${c[0].toUpperCase() + c.slice(1)}: ${why}`); };
  const emergency = cfg.red?.emergency || EMERGENCY_DEFAULT, clinician = cfg.red?.clinician || CLINICIAN_DEFAULT;
  const rf = ci.red_flags || {};
  for (const k of emergency) if (rf[k]) { red = "emergency"; add("red", `red flag: ${k.replace(/_/g, " ")}`); }
  for (const k of clinician) if (rf[k]) { red = red || "clinician"; add("red", `red flag: ${k.replace(/_/g, " ")}`); }
  const sy = d.symptoms;
  if (sy) {
    add(painColor(sy.pain_now, cfg), `pain now ${sy.pain_now}/10`);
    const leg = sy.leg_symptoms;
    if (leg === "below_knee" || leg === "foot") { red = red || "clinician"; add("red", `leg symptoms ${leg.replace("_", " ")}`); }
    else if (leg === "buttock" || leg === "thigh") {
      if ((ctx.prior_leg_checkins || 0) >= 2) { red = red || "clinician"; add("red", "leg symptoms in 3 consecutive check-ins"); }
      else add("orange", `leg symptoms (${leg})`);
    }
    if (sy.numbness_tingling) { red = red || "clinician"; add("red", "new numbness or tingling"); }
    if (sy.sharp_electrical) {
      const c = sy.sharp_context || "exercise";
      if (c === "exercise") add("orange", "sharp/electrical during exercise");
      else if (c === "accidental_bend_twist") {
        const g = cfg.incidents.accidental_bend_twist.yellow_if;
        const ok = (sy.sharp_settle_min ?? 999) <= g.settle_max_min && sy.pain_now <= g.pain_peak_max && leg === "none";
        const many = (ctx.prior_incidents_7d || 0) + 1 >= (cfg.incidents.accidental_bend_twist.orange_if_count_in_7_days_at_least || 2);
        if (ok && !many) { incident = true; add("yellow", "accidental sharp catch that settled (incident)"); }
        else if (ok) { incident = true; add("orange", "second accidental sharp incident within 7 days"); }
        else add("orange", "accidental sharp pain that did not settle quickly");
      } else if (c === "ordinary_movement") {
        if ((ctx.recent_ordinary_sharp_days || 0) >= 1 || leg !== "none") { red = red || "clinician"; add("red", "sharp/electrical with ordinary movement again (or with leg symptoms)"); }
        else add("orange", "sharp/electrical with ordinary movement");
      } else if (c === "at_rest") {
        if (sy.pain_now >= cfg.incidents.at_rest.red_clinician_if_pain_peak_at_least) { red = red || "clinician"; add("red", "severe sharp pain at rest"); }
        else add("orange", "sharp/electrical at rest");
      }
    }
  }
  const t = ci.type;
  if (t === "morning") {
    add(painColor(d.pain_on_waking, cfg), `pain on waking ${d.pain_on_waking}/10`);
    const s = d.stiffness_min;
    if (s !== null && s !== undefined) {
      const g = B.stiffness_min + cfg.stiffness.green_slack_min;
      const y = Math.max(cfg.stiffness.yellow_mult * B.stiffness_min, B.stiffness_min + cfg.stiffness.yellow_add_min);
      const c = s <= g ? "green" : s <= y ? "yellow" : "orange";
      add(c, c === "yellow" ? `morning stiffness ${s} min is above the ${fmt(g)} min green limit` : `morning stiffness ${s} min is above the ${fmt(y)} min limit`);
    }
    if (d.hip_shift) {
      if ((ctx.prior_hip_shift_checkins || 0) >= 2) { red = red || "clinician"; add("red", "hip shift in 3 consecutive check-ins"); }
      else add("orange", "lateral hip shift");
    }
    const w = d.woke_from_pain_count || 0;
    if (w >= 2 && d.pain_on_waking >= 5) add("orange", "woke from pain repeatedly");
    else if (w >= 1) add("yellow", "woke from pain");
    if ((d.sleep_hours ?? 8) < cfg.sleep.block_advance_if_hours_below || (d.sleep_quality ?? 5) <= cfg.sleep.block_advance_if_quality_at_or_below) mods.push("poor_sleep");
  } else if (t === "post_workout") {
    add(painColor(d.pain_peak, cfg), `peak pain ${d.pain_peak}/10`);
    if ("pain_15min_after" in d) add(painColor(d.pain_15min_after, cfg), `pain 15 min after ${d.pain_15min_after}/10`);
    if (d.settle_bucket === "gt_120") add("yellow", "symptoms took over 120 min to settle");
    if (d.form_breakdown || (d.completed_items || []).some((i) => i.form_breakdown)) add("yellow", "form breakdown");
    if ((d.rpe || 0) > cfg.rpe.yellow_if_over) add("yellow", `effort ${d.rpe}/10 is above the plan`);
    for (const i of d.completed_items || []) {
      if (i.sharp_electrical) add("orange", `sharp/electrical on ${i.item_key}`);
      if ((i.pain_peak || 0) >= (cfg.pain.orange_min ?? 5)) add("orange", `pain ${i.pain_peak}/10 on ${i.item_key}`);
    }
  } else if (t === "evening") {
    add(painColor(d.pain_peak_today, cfg), `pain peak today ${d.pain_peak_today}/10`);
    const r = standingRatio(d, B);
    if (r !== null) {
      const c = r >= cfg.standing.green_ratio - 1e-9 ? "green" : r >= cfg.standing.orange_ratio - 1e-9 ? "yellow" : "orange";
      add(c, `standing tolerance ${r.toFixed(2)} of baseline`);
    }
    const sc = sittingColor(d, B, cfg);
    if (sc) add(sc, `sitting tolerance ${sc}${d.sitting?.flared ? " (flared)" : ""}`);
    const f = d.forced_rest_count || 0;
    if (f >= cfg.forced_rest.orange_at) add("orange", `${f} forced rests`);
    else if (f >= cfg.forced_rest.yellow_at) add("yellow", `${f} forced rest(s)`);
    if (d.activity_limited) add("yellow", "activity limited by the back");
    if (d.hip_shift) add("orange", "lateral hip shift");
  } else if (t === "night") {
    add(painColor(d.bedtime_pain, cfg), `bedtime pain ${d.bedtime_pain}/10`);
  }
  for (const tag of ci.oddity_tags || []) if (tag === "illness" || tag === "unusual_load") mods.push(tag);
  return { color: worst(cols), red_kind: red, reasons, modifiers: [...new Set(mods)], incident };
}

/** Sitting tolerance color from the evening check-in's optional sitting{} and posture_cycle{} (null when absent or unknown). */
export function sittingColor(d, B, cfg) {
  const sit = d.sitting;
  if (!sit) return null;
  const sc = cfg.sitting || {};
  const bsit = B.sitting_min ?? sc.baseline_min ?? 20;
  const ratios = { green_ratio: sc.green_ratio ?? 0.9, orange_ratio: sc.orange_ratio ?? 0.6 };
  const sw = (d.posture_cycle?.early_switches || []).filter((x) => x.phase === "sit" && x.reason === "sore_early");
  const common = { flared: !!sit.flared, ratios, censored: !!sit.censored, painPeak: d.pain_peak_today };
  if (sw.length) {
    const last = sw[sw.length - 1];
    return postureColor(sit.first_pressure_min ?? null, bsit, { ...common, soreEarly: true, actual: last.actual_min ?? null, prescribed: last.prescribed_min || sit.prescribed_block_min || null });
  }
  return postureColor(sit.first_pressure_min ?? null, bsit, { ...common, soreEarly: false, actual: null, prescribed: sit.prescribed_block_min || null });
}

/** first_pressure_h / B_stand, or 1.0 when censored with low pain; null when unknown */
export function standingRatio(eveningData, B) {
  const st = eveningData?.standing || {};
  if (st.first_pressure_h !== null && st.first_pressure_h !== undefined) return st.first_pressure_h / B.standing_h;
  if (st.censored && eveningData.pain_peak_today <= 2) return 1.0;
  return null;
}

const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

/** History context for one check-in from the check-ins saved before it. */
export function checkInContext(ci, all) {
  const prior = all.filter((c) => c.id !== ci.id && c.ts < ci.ts).sort(byTs);
  const ctx = { recent_ordinary_sharp_days: 0, prior_leg_checkins: 0, prior_hip_shift_checkins: 0, prior_incidents_7d: 0 };
  const days = new Set();
  for (const c of prior) {
    const s = c.data?.symptoms;
    if (s?.sharp_electrical && s.sharp_context === "ordinary_movement") {
      const dd = dayDiff(ci.local_date, c.local_date);
      if (dd >= 1 && dd <= 2) days.add(c.local_date);
    }
    if (s?.sharp_electrical && s.sharp_context === "accidental_bend_twist" && daysBetweenTs(ci.ts, c.ts) <= 7) ctx.prior_incidents_7d++;
  }
  ctx.recent_ordinary_sharp_days = days.size;
  for (let i = prior.length - 1; i >= 0; i--) {
    const s = prior[i].data?.symptoms;
    if (!s) continue;
    if (["buttock", "thigh", "below_knee", "foot"].includes(s.leg_symptoms)) ctx.prior_leg_checkins++; else break;
  }
  for (let i = prior.length - 1; i >= 0; i--) {
    const c = prior[i];
    if (c.type !== "morning" && c.type !== "evening") continue;
    if (c.data?.hip_shift) ctx.prior_hip_shift_checkins++; else break;
  }
  return ctx;
}

export function evaluateAll(checkins, B, cfg) {
  const out = {};
  for (const c of checkins) out[c.id] = evaluateCheckIn(c, B, cfg, checkInContext(c, checkins));
  return out;
}

/** Worst color across a day's check-in evaluations (incidents already count yellow+). */
export function dailyStatus(evals) {
  if (!evals.length) return null;
  return worst(evals.map((e) => e.color));
}

// =====================================================================================
// 2. Session color (plan.md 7.4)
// =====================================================================================
/** Session color = worst of the three tests; clean = green, all three present, no blocking modifier. */
export function combineSessionTests(tests, modifiers = [], cfg) {
  const present = ["exercise", "recovery", "functional"].filter((k) => tests[k]);
  const final_color = worst(present.map((k) => tests[k]));
  const blocking = new Set(cfg?.advance?.blocked_by || ["poor_sleep", "illness", "unusual_load", "missing_morning_checkin", "pause_mode"]);
  const clean = final_color === "green" && present.length === 3 && !modifiers.some((m) => blocking.has(m));
  return { final_color, clean };
}

/**
 * evaluateSession(session, checkins, evals, cfg, now) -> { status, tests, final_color, clean, modifiers, culprits, checkin_ids, finalized_on }
 * status: "pending" (no post-workout yet) | "provisional" | "final" | "unevaluated"
 */
export function evaluateSession(s, checkins, evals, cfg, now, extraMods = []) {
  const post = checkins.find((c) => c.id === s.post_workout_checkin_id) || checkins.find((c) => c.type === "post_workout" && c.session_id === s.id);
  if (!post) return { status: "pending", tests: {}, modifiers: [], culprits: [], checkin_ids: [] };
  const D = s.local_date, D1 = addDays(D, 1);
  const on = (type, date) => checkins.filter((c) => c.type === type && c.local_date === date).sort(byTs).pop();
  const night = on("night", D), evening = on("evening", D), morningSame = on("morning", D), morning = on("morning", D1), eveningNext = on("evening", D1);
  const col = (c) => (c ? evals[c.id]?.color : undefined);
  const tests = { exercise: col(post) };
  if (evening) tests.functional = col(evening);
  const mods = new Set(extraMods);
  for (const c of [post, night, evening, morningSame, morning]) for (const m of (c && evals[c.id]?.modifiers) || []) mods.add(m);
  if (!morningSame) mods.add("missing_morning_checkin");
  const ids = [post, evening, night, morning, eveningNext].filter(Boolean).map((c) => c.id);
  const endTs = s.ended_at || post.ts;
  const limit = cfg.missing_data?.session_unevaluated_after_hours ?? 36;
  let status;
  if (!morning) {
    status = hoursBetween(now, endTs) > limit ? "unevaluated" : "provisional";
    tests.recovery = night ? col(night) : undefined;
    if (status !== "final") {
      const r = combineSessionTests(tests, [...mods], cfg);
      return { status, tests: prune(tests), final_color: r.final_color, clean: false, modifiers: [...mods], culprits: culpritsOf(post, cfg), checkin_ids: ids };
    }
  }
  let recovery = worst([col(night), col(morning)]);
  let finalized_on = morning.ts;
  if (RANK[col(morning)] >= RANK.yellow) {
    // Late rule: wait for the next evening; pain 3+ or yellow+ then means recovery orange.
    if (!eveningNext) {
      const st = hoursBetween(now, morning.ts) > limit ? "unevaluated" : "provisional";
      tests.recovery = recovery;
      const r = combineSessionTests(tests, [...mods], cfg);
      return { status: st, tests: prune(tests), final_color: r.final_color, clean: false, modifiers: [...mods], culprits: culpritsOf(post, cfg), checkin_ids: ids };
    }
    finalized_on = eveningNext.ts;
    if ((eveningNext.data?.pain_peak_today ?? 0) >= 3 || RANK[col(eveningNext)] >= RANK.yellow) recovery = "orange";
  }
  tests.recovery = recovery;
  const r = combineSessionTests(tests, [...mods], cfg);
  return { status: "final", tests: prune(tests), final_color: r.final_color, clean: r.clean, modifiers: [...mods], culprits: culpritsOf(post, cfg), checkin_ids: ids, finalized_on };
}
const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
function culpritsOf(post, cfg) {
  return (post.data?.completed_items || [])
    .filter((i) => i.sharp_electrical || (i.pain_peak || 0) >= (cfg.pain?.orange_min ?? 5))
    .map((i) => i.item_key);
}

// =====================================================================================
// 3. State
// =====================================================================================
export const levelById = (levelsDoc, id) => levelsDoc.levels.find((l) => l.id === id);
export const levelsMap = (levelsDoc) => Object.fromEntries(levelsDoc.levels.map((l) => [l.id, l]));

function freshItemState(level, rungOf = (i) => i.start_rung) {
  return Object.fromEntries(level.items.map((i) => [i.item_key, { rung: rungOf(i), clean_exposures: 0, held_out: false, last_bump_session_id: null }]));
}
function walkStart(level, rungs) {
  const w = level.items.find((i) => i.block === "walking");
  if (!w) return 0;
  const r = rungs?.[w.item_key]?.rung ?? w.start_rung;
  return w.rungs[Math.min(r, w.rungs.length - 1)]?.time_min ?? 0;
}

/** Initial DecisionState (schema fields) plus an internal `x` block that the export strips. */
export function initState(levelsDoc, levelId, opts = {}) {
  const level = levelById(levelsDoc, levelId);
  const item_state = freshItemState(level);
  return {
    schema_version: "1.0",
    plan_version: levelsDoc.plan_version ?? 1,
    level_id: levelId,
    mode: levelId === "L0" ? "settle" : "active",
    item_state,
    core_clean_days: 0,
    walk: { current_min: walkStart(level, item_state), clean_days: 0 },
    advance_stack: [],
    lock: { easy_dose: false, clean_required: 2 },
    orange_events: [],
    level_regress_events: [],
    incident_log: [],
    consecutive_yellow_sessions: 0,
    probation_sessions_remaining: 0,
    level_clean_streak: 0,
    baselines: clone(opts.baselines || { pain_rest: 1, stiffness_min: 30, standing_h: 5, sitting_min: 20 }),
    posture_cycle: postureConfig() ? initPostureState(postureConfig(), levelId) : undefined,
    gate_tests: gateTestsFor(level),
    gate_pending: false,
    settle: { resume_level: null, resume_item_state: null, green_days_in_row: 0 },
    red: { kind: null, since: null, flags: [], cleared_at: null, clearance_note: null },
    clinician_recommended: false,
    ...(opts.now ? { last_evaluated_at: opts.now } : {}),
    x: {
      lock_clean_count: 0, last_level_regress: null, easy_dose_sessions_remaining: 0, step_regressed: false,
      orange_days_in_row: 0, standing_low_evenings: 0, held_out_green_days: {}, need_clean_after_pause: 0,
      processed_sessions: [], processed_days: [], seen_checkins: [], orange_dates: [],
      level_started_on: opts.now ? localDate(opts.now) : null, layoff_anchor: null, layoff_step_for: null,
      settle_since: levelId === "L0" ? opts.now || null : null, baseline_proposals: [], start_date: opts.now ? localDate(opts.now) : null,
    },
  };
}
/** Flare preset on entering L0 / settle exit restores the previous posture doses minus 5 min (R16). */
function posturePreset(s, event, push, ts) {
  const cfg = postureConfig();
  if (!cfg) return;
  if (!s.posture_cycle) s.posture_cycle = initPostureState(cfg, "L1");
  const r = applyPosture(s.posture_cycle, event, cfg);
  s.posture_cycle = r.state;
  if (push) push({ rule_id: "R16", outcome: r.result.outcome, message: `Work posture cycle: ${r.result.reasons.join("; ")}. Stand ${s.posture_cycle.stand_min} / sit ${s.posture_cycle.sit_min} min, decompress ${s.posture_cycle.decomp_frequency === "after_each_block" ? "after each block" : "once per cycle"}.` });
}
function gateTestsFor(level) {
  return Object.fromEntries((level?.exit?.tests || []).map((t) => [t.test_id, { status: "not_started", value: null, session_id: null, retest_after_clean_sessions: 0 }]));
}

/** DecisionState document for exports (schema fields only). */
export function exportState(s) {
  const { x, ...doc } = clone(s);
  return doc;
}

/** Shape used by seed/test-vectors.json engine expectations (reference summarize()). */
export function summarize(s) {
  const is = s.item_state;
  return {
    level: s.level_id, mode: s.mode,
    rungs: Object.fromEntries(Object.entries(is).filter(([, v]) => v.rung || v.held_out).map(([k, v]) => [k, v.rung])),
    exposures: Object.fromEntries(Object.entries(is).filter(([, v]) => v.clean_exposures).map(([k, v]) => [k, v.clean_exposures])),
    held_out: Object.entries(is).filter(([, v]) => v.held_out).map(([k]) => k),
    lock: s.lock.easy_dose, stack_depth: s.advance_stack.length,
    consecutive_yellow: s.consecutive_yellow_sessions, clean_streak: s.level_clean_streak,
    orange_events: s.orange_events.length, level_regress: s.x.last_level_regress,
  };
}

// =====================================================================================
// 4. Outcome rules R2-R5 + R8a on a finalized session (mirrors reference/ref_engine.py)
// =====================================================================================
function popGroup(s, track = "strength") {
  for (let i = s.advance_stack.length - 1; i >= 0; i--) {
    const g = s.advance_stack[i];
    if ((g.track || "strength") !== track) continue;
    s.advance_stack.splice(i, 1);
    for (const c of g.changes) if (s.item_state[c.item_key]) s.item_state[c.item_key].rung = c.from_rung;
    return g.changes;
  }
  return [];
}
const lockOn = (s, cfg) => { s.lock = { easy_dose: true, clean_required: cfg?.advance?.clean_exposures_required_when_locked ?? 3 }; s.x.lock_clean_count = 0; };
const lockOff = (s, cfg) => { s.lock = { easy_dose: false, clean_required: cfg?.advance?.clean_exposures_required ?? 2 }; s.x.lock_clean_count = 0; };

/**
 * applySessionFinal(state, levelsDoc, ev, opts) -> { state, out, log }
 * ev: { color, clean, items[], culprits[], ts, session_id, template }
 */
export function applySessionFinal(state, levelsDoc, ev, opts = {}) {
  const cfg = opts.config;
  const cap = opts.cap ?? cfg?.advance?.max_item_changes_per_finalized_session ?? 3;
  const s = clone(state);
  const L = levelsMap(levelsDoc);
  const level = L[s.level_id];
  const items = Object.fromEntries(level.items.map((i) => [i.item_key, i]));
  const order = Object.fromEntries(level.items.map((i, n) => [i.item_key, n]));
  const keys = (ev.items || []).filter((k) => s.item_state[k] && items[k]);
  const isStrength = !ev.template || STRENGTH_TEMPLATES.has(ev.template);
  const out = { outcome: "none", bumped: [], popped: [] };
  const log = [];
  const L_ = (rule_id, outcome, message, changes) => log.push({ rule_id, outcome, color: ev.color, session_id: ev.session_id ?? null, message, ...(changes?.length ? { changes } : {}) });

  if (isStrength && !ev.template_gate) {
    if (s.x.easy_dose_sessions_remaining > 0) s.x.easy_dose_sessions_remaining--;
  }
  const probation = s.probation_sessions_remaining > 0 && isStrength;
  if (probation) s.probation_sessions_remaining--;

  const flagged = new Set(ev.flagged || []);
  const streaks = ev.flag_streaks || {};
  if (ev.color === "green" && ev.clean) {
    s.consecutive_yellow_sessions = 0;
    for (const k of keys) if (!flagged.has(k)) s.item_state[k].clean_exposures++;
    const req = s.lock.easy_dose ? s.lock.clean_required : (cfg?.advance?.clean_exposures_required ?? 2);
    const paused = s.x.need_clean_after_pause > 0;
    const elig = paused ? [] : keys.filter((k) => {
      const st = s.item_state[k], it = items[k];
      return !flagged.has(k) && st.clean_exposures >= req && !st.held_out && st.rung < it.target_rung &&
        (it.requires || []).every((r) => s.item_state[r] && items[r] && s.item_state[r].rung === items[r].target_rung);
    });
    if (paused) s.x.need_clean_after_pause--;
    elig.sort((a, b) => (items[b].target_rung - s.item_state[b].rung) - (items[a].target_rung - s.item_state[a].rung) || order[a] - order[b]);
    const picked = []; let barbell = false;
    for (const k of elig) {
      if (picked.length === cap) break;
      if (items[k].exercise_id.startsWith("EX_BARBELL")) { if (barbell) continue; barbell = true; }
      picked.push(k);
    }
    const changes = picked.map((k) => {
      const st = s.item_state[k];
      const c = { item_key: k, from_rung: st.rung, to_rung: st.rung + 1 };
      st.rung++; st.clean_exposures = 0; st.last_bump_session_id = ev.session_id ?? null;
      return c;
    });
    if (changes.length) s.advance_stack.push({ event_id: `E${s.advance_stack.length + 1}`, session_id: ev.session_id ?? null, track: "strength", changes });
    if (isStrength) s.level_clean_streak++;
    for (const t of Object.values(s.gate_tests)) if (t.retest_after_clean_sessions > 0) t.retest_after_clean_sessions--;
    if (s.lock.easy_dose) {
      s.x.lock_clean_count++;
      if (s.x.lock_clean_count >= 3) { lockOff(s, cfg); L_("R3", "none", "Easy-dose lock lifted after 3 clean sessions."); }
    }
    out.outcome = changes.length ? "advance" : "none";
    out.bumped = changes.map((c) => c.item_key);
    const need = keys.filter((k) => !picked.includes(k) && items[k].target_rung > s.item_state[k].rung).length;
    L_("R5", out.outcome, changes.length
      ? `Clean session. Advanced ${changes.length} item(s) one rung: ${changes.map((c) => items[c.item_key].exercise_id).join(", ")}.`
      : paused ? "Clean session after pause: exposures recorded, no advance yet (R12)." : `Clean session. Clean exposure recorded for ${keys.length} item(s)${need ? ` (${req} needed to advance)` : ""}.`, changes);
  } else if (ev.color === "green") {
    L_("R13", "none", "Green but not clean (missing test or an advance-blocking modifier): nothing advances.");
  } else if (ev.color === "yellow") {
    for (const k of keys) s.item_state[k].clean_exposures = 0;
    s.consecutive_yellow_sessions++; if (isStrength) s.level_clean_streak = 0;
    out.outcome = "hold";
    if (s.consecutive_yellow_sessions >= (cfg?.hold?.consecutive_yellow_sessions_to_regress_one_step ?? 3)) {
      const popped = popGroup(s);
      out.popped = popped.map((c) => c.item_key); s.consecutive_yellow_sessions = 0; out.outcome = "regress_step";
      if (popped.length) s.x.step_regressed = true;
      L_("R4", "regress_step", "Third yellow session in a row: stall, undo the last advance group.", popped.map(rev));
    } else L_("R4", "hold", "Yellow session: hold the same dose; exposures for these items reset.");
  } else if (ev.color === "orange") {
    const r = applyOrange(s, levelsDoc, { ts: ev.ts, culprits: ev.culprits || [], session_id: ev.session_id, color: "orange", probation, alreadyCounted: ev.alreadyCounted }, cfg);
    Object.assign(out, r.out); log.push(...r.log);
  }
  if (flagged.size && ev.color !== "orange") {
    for (const k of keys) {
      if (!flagged.has(k)) continue;
      const st = s.item_state[k], it = items[k];
      const streak = streaks[k] ?? 1;
      const start = it.start_rung ?? 0;
      st.clean_exposures = 0;
      if (streak >= FLAG_STREAK_TO_REGRESS && st.rung > start) {
        const c = { item_key: k, from_rung: st.rung, to_rung: st.rung - 1 };
        st.rung -= 1;
        out.outcome = "regress_step";
        out.popped = [...(out.popped || []), k];
        L_("R17", "regress_step", `Unexpected pain flagged in ${streak} sessions in a row: ${it.exercise_id} stepped back one rung.`, [c]);
      } else {
        if (out.outcome === "none") out.outcome = "hold";
        L_("R17", "hold", `Unexpected pain flagged: ${it.exercise_id} will not advance this time.`);
      }
    }
  }
  return { state: s, out, log };
}
const rev = (c) => ({ item_key: c.item_key, from_rung: c.to_rung, to_rung: c.from_rung });

/** R2 (+R3, R8a/b, R15) on an orange session or orange day. Mutates s. */
function applyOrange(s, levelsDoc, o, cfg) {
  const out = { outcome: "regress_step", popped: [] };
  const log = [];
  const L_ = (rule_id, outcome, message, changes) => log.push({ rule_id, outcome, color: "orange", session_id: o.session_id ?? null, message, ...(changes?.length ? { changes } : {}) });
  if (o.alreadyCounted) {
    // Same orange episode already recorded for this date: only drop new culprits.
    const ch = dropCulprits(s, o.culprits, new Set());
    L_("R2", "none", "Orange episode already recorded today; culprit items dropped one rung.", ch);
    out.outcome = "none";
    return { out, log };
  }
  const popped = popGroup(s);
  const poppedKeys = new Set(popped.map((c) => c.item_key));
  const culpritChanges = dropCulprits(s, o.culprits, poppedKeys);
  out.popped = popped.map((c) => c.item_key);
  for (const st of Object.values(s.item_state)) st.clean_exposures = 0;
  s.level_clean_streak = 0; s.consecutive_yellow_sessions = 0;
  s.orange_events.push(o.ts);
  s.x.easy_dose_sessions_remaining = 2;
  if (s.walk && s.walk.current_min) s.walk.current_min = Math.max(5, round5(s.walk.current_min * 0.75));
  if (s.walk) s.walk.clean_days = 0;
  s.gate_pending = false;
  if (popped.length) s.x.step_regressed = true;
  L_("R2", "regress_step", `Orange: undo the last advance group${o.culprits.length ? ", drop culprit items" : ""}; next 2 strength sessions one set easier; walking cut to ${s.walk?.current_min ?? "-"} min.`, [...popped.map(rev), ...culpritChanges]);
  const within = (n) => s.orange_events.filter((t) => daysBetweenTs(o.ts, t) <= n);
  if (within(7).length >= (cfg?.regress?.orange_events_in_7_days_for_easy_dose_lock ?? 2)) {
    const p2 = popGroup(s);
    out.popped.push(...p2.map((c) => c.item_key));
    lockOn(s, cfg);
    L_("R3", "regress_step", "Second orange within 7 days: one more step back and the easy-dose lock (3 clean sessions to advance).", p2.map(rev));
  }
  if (within(14).length >= (cfg?.regress?.orange_events_in_14_days_for_level_regress ?? 3)) {
    const before = s.level_id;
    log.push(...regressLevel(s, levelsDoc, o.ts, "3 orange events within 14 days", cfg));
    if (s.level_id !== before) out.outcome = "regress_level";
  } else if (o.probation) {
    log.push(...regressLevel(s, levelsDoc, o.ts, "orange during probation after a promotion", cfg));
    out.outcome = "regress_level";
  }
  return { out, log };
}
function dropCulprits(s, culprits, skip) {
  const ch = [];
  for (const k of culprits) {
    if (skip.has(k) || !s.item_state[k]) continue;
    const st = s.item_state[k];
    if (st.rung > 0) { ch.push({ item_key: k, from_rung: st.rung, to_rung: st.rung - 1 }); st.rung--; }
    else { st.held_out = true; s.x.held_out_green_days[k] = 0; }
  }
  return ch;
}

/** R8 level regression. Mutates s, returns log entries. */
export function regressLevel(s, levelsDoc, ts, why, cfg) {
  const L = levelsMap(levelsDoc);
  const level = L[s.level_id];
  const prev = level.regress_to;
  if (!prev || !L[prev]) {
    s.clinician_recommended = true;
    return [{ rule_id: "R15", outcome: "none", color: "orange", session_id: null, message: `Stuck: ${why} while already at ${s.level_id}. Please check with your physician.` }];
  }
  const log = [];
  if (s.level_regress_events.some((t) => daysBetweenTs(ts, t) <= 14)) {
    s.clinician_recommended = true;
    log.push({ rule_id: "R15", outcome: "none", color: "orange", session_id: null, message: "Second level regression within 14 days: please check with your physician." });
  }
  const resumeLevel = s.level_id, resumeItems = clone(s.item_state);
  s.level_id = prev; s.x.last_level_regress = prev; s.orange_events = [];
  s.level_regress_events.push(ts);
  const lv = L[prev];
  s.item_state = freshItemState(lv, (i) => Math.max(0, i.target_rung - 1));
  s.advance_stack = []; lockOn(s, cfg);
  s.level_clean_streak = 0; s.consecutive_yellow_sessions = 0; s.probation_sessions_remaining = 0;
  s.gate_tests = gateTestsFor(lv); s.gate_pending = false; s.x.step_regressed = false; s.x.orange_days_in_row = 0; s.x.standing_low_evenings = 0;
  s.walk = { current_min: walkStart(lv, s.item_state), clean_days: 0 };
  s.core_clean_days = 0;
  s.x.level_started_on = localDate(ts); s.x.layoff_anchor = localDate(ts);
  if (prev === "L0") {
    s.mode = "settle";
    s.settle = { resume_level: resumeLevel, resume_item_state: resumeItems, green_days_in_row: 0 };
    s.x.settle_since = ts;
    posturePreset(s, { flare: true }, (e) => log.push(e));
  }
  log.unshift({ rule_id: "R8", outcome: "regress_level", color: "orange", session_id: null, message: `Level regression to ${prev}: ${why}. Items reset to one rung below the ${prev} targets; 3 clean sessions needed to advance.` });
  return log;
}

// =====================================================================================
// 5. Full engine pass
// =====================================================================================
/**
 * runEngine(state, data, docs, cfg, now, newId) -> { state, log, evals, daily, sessions }
 * data: { checkins[], sessions[], days: {date: DailyLog}, settings: { cap, layoffEnabled } }
 * docs: { levels, tests }
 * Idempotent: already-processed sessions/days/check-ins are skipped via state.x.
 */
export function runEngine(state, data, docs, cfg, now, newId = defaultId()) {
  let s = clone(state);
  const log = [];
  const push = (e) => log.push({ id: newId(), ts: now, ...e, session_id: e.session_id ?? null });
  const checkins = [...(data.checkins || [])].sort(byTs);
  const B = s.baselines;
  const evals = evaluateAll(checkins, B, cfg);
  const settings = data.settings || {};
  const cap = settings.cap ?? cfg.advance.max_item_changes_per_finalized_session;

  // (1) red scan on check-ins not seen before
  const seen = new Set(s.x.seen_checkins);
  for (const c of checkins) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const e = evals[c.id];
    if (e.incident) s.incident_log.push({ ts: c.ts, context: c.data?.symptoms?.sharp_context || "accidental_bend_twist", color: e.color });
    if (e.red_kind && s.mode !== "red_stop") {
      s.x.pre_red = { level_id: s.level_id, mode: s.mode };
      s.mode = "red_stop";
      s.red = { kind: e.red_kind, since: c.ts, flags: e.reasons, cleared_at: null, clearance_note: null };
      push({ rule_id: "R1", outcome: "red", color: "red", checkin_ids: [c.id], message: `Red (${e.red_kind}): ${e.reasons.filter((r) => r.startsWith("Red")).join("; ")}. Plan frozen.` });
    }
  }
  s.x.seen_checkins = [...seen];
  const daily = dailyMap(checkins, evals);
  if (s.mode === "red_stop") return finish(s, log, evals, daily, [], now);

  // (2)-(5) sessions and days, in time order
  const sessEvals = {};
  const today = localDate(now);
  const processedS = new Set(s.x.processed_sessions), processedD = new Set(s.x.processed_days);
  const timeline = [];
  for (const ss of data.sessions || []) {
    const e = evaluateSession(ss, checkins, evals, cfg, now, ss.modifiers?.filter((m) => m === "pause_mode") || []);
    sessEvals[ss.id] = e;
    if (!processedS.has(ss.id) && (e.status === "final" || e.status === "unevaluated")) timeline.push({ kind: "session", date: ss.local_date, k: 0, ss, e });
  }
  const dates = Object.keys(daily).sort();
  for (const d of dates) {
    if (processedD.has(d) || (s.x.start_date && d < s.x.start_date)) continue;
    const nextMorning = checkins.some((c) => c.type === "morning" && c.local_date === addDays(d, 1));
    if (nextMorning || dayDiff(today, d) >= 2) timeline.push({ kind: "day", date: d, k: 1 });
  }
  timeline.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.k - b.k));

  for (const t of timeline) {
    if (s.mode === "red_stop") break;
    if (t.kind === "session") {
      processedS.add(t.ss.id);
      s = processSession(s, t.ss, t.e, docs, cfg, cap, push, daily, data);
    } else {
      processedD.add(t.date);
      s = processDay(s, t.date, data, daily, evals, checkins, docs, cfg, push);
    }
  }
  s.x.processed_sessions = [...processedS];
  s.x.processed_days = [...processedD];

  // (7) level exit criteria and promotion
  s = gates(s, docs, cfg, push, now);
  // (8) layoff, settle timeout, baselines
  s = housekeeping(s, data, docs, cfg, push, now, checkins, evals, settings);
  return finish(s, log, evals, daily, sessEvals, now);
}
function finish(s, log, evals, daily, sessions, now) {
  s.last_evaluated_at = now;
  return { state: s, log, evals, daily, sessions };
}
function defaultId() { let n = 0; return () => `LOG${String(++n).padStart(6, "0")}`; }

export function dailyMap(checkins, evals) {
  const m = {};
  for (const c of checkins) {
    const e = evals[c.id];
    (m[c.local_date] ||= { evals: [], reasons: [], ids: [] });
    m[c.local_date].evals.push(e); m[c.local_date].ids.push(c.id);
    m[c.local_date].reasons.push(...e.reasons);
  }
  for (const d of Object.values(m)) { d.color = dailyStatus(d.evals); d.reasons = [...new Set(d.reasons)]; }
  return m;
}


function sessionFlagInfo(ss, data) {
  const days = data?.days || {};
  const sessions = data?.sessions || [];
  const flagged = (ss.items || [])
    .filter((i) => i.completed !== false && !i.skipped && isItemFlagged(days[ss.local_date], i.item_key))
    .map((i) => i.item_key);
  const flag_streaks = {};
  for (const k of flagged) flag_streaks[k] = consecutiveFlagStreak(sessionFlagEvents(k, sessions, days, ss));
  return { flagged, flag_streaks };
}

function processSession(s, ss, e, docs, cfg, cap, push, daily, data) {
  if (e.status === "unevaluated") {
    push({ rule_id: "R13", outcome: "none", session_id: ss.id, message: `Session ${ss.local_date} (${ss.template}) unevaluated: next-morning check-in missing for 36 h. Nothing advances on it.` });
    return s;
  }
  if (s.mode === "paused") {
    push({ rule_id: "R12", outcome: "none", color: e.final_color, session_id: ss.id, message: "Paused: session logged, no advance or regress." });
    return s;
  }
  if (ss.template === "gate_test") return processGateSession(s, ss, e, push);
  if (ss.level_id && ss.level_id !== s.level_id) {
    push({ rule_id: "R13", outcome: "none", color: e.final_color, session_id: ss.id, message: `Session from ${ss.level_id} finalized after a level change; not applied.` });
    return s;
  }
  // Orange dedupe: one orange event per date episode (session day or its next morning).
  const dates = [ss.local_date, addDays(ss.local_date, 1)];
  const alreadyCounted = e.final_color === "orange" && dates.some((d) => s.x.orange_dates.includes(d));
  const items = ss.items.filter((i) => i.completed !== false && !i.skipped).map((i) => i.item_key);
  const r = applySessionFinal(s, docs.levels, { color: e.final_color === "red" ? "orange" : e.final_color, clean: e.clean, items, culprits: e.culprits, ts: e.finalized_on || ss.ended_at, session_id: ss.id, template: ss.template, alreadyCounted, ...sessionFlagInfo(ss, data) }, { config: cfg, cap });
  if (e.final_color === "orange" && !alreadyCounted) r.state.x.orange_dates.push(ss.local_date);
  for (const l of r.log) push({ ...l, checkin_ids: e.checkin_ids });
  return r.state;
}

function processGateSession(s, ss, e, push) {
  const recoveryGreen = e.tests.recovery === "green";
  for (const g of ss.gate_results || []) {
    const t = s.gate_tests[g.test_id];
    if (!t || t.status === "pass_confirmed") continue;
    if (t.status === "pass_provisional" && t.session_id === ss.id) {
      if (recoveryGreen && e.final_color !== "orange") {
        t.status = "pass_confirmed";
        push({ rule_id: "R10", outcome: "none", color: e.final_color, session_id: ss.id, message: `Gate test ${g.test_id} confirmed by a green next morning.` });
      } else {
        t.status = "fail"; t.retest_after_clean_sessions = 2;
        push({ rule_id: "R10", outcome: "none", color: e.final_color, session_id: ss.id, message: `Gate test ${g.test_id} not confirmed (next morning not green). Retest after 2 clean sessions.` });
      }
    }
  }
  if (e.final_color === "orange") push({ rule_id: "R2", outcome: "none", color: "orange", session_id: ss.id, message: "Gate-test session was orange; the orange day rules apply through the daily status." });
  return s;
}

/** Record a gate result at save time (provisional pass or fail). Pure. */
export function recordGateResults(state, session, levelsDoc, testsDoc, postEval) {
  const s = clone(state);
  const level = levelById(levelsDoc, s.level_id);
  const msgs = [];
  for (const g of session.gate_results || []) {
    const lt = level.exit.tests.find((t) => t.test_id === g.test_id);
    if (!lt) continue;
    const passed = gatePass(g, lt.threshold, postEval);
    g.passed = passed;
    s.gate_tests[g.test_id] = { status: passed ? "pass_provisional" : "fail", value: g.value ?? null, session_id: session.id, retest_after_clean_sessions: passed ? 0 : 2 };
    msgs.push({ rule_id: "R10", outcome: "none", session_id: session.id, message: `Gate test ${g.test_id}: ${passed ? "provisional pass (confirm with a green next morning)" : "not passed; retest after 2 clean sessions"}.` });
  }
  return { state: s, log: msgs };
}
export function gatePass(g, threshold, postEval) {
  const thr = threshold?.value;
  let met;
  if (typeof thr === "number") met = typeof g.value === "number" && g.value >= thr;
  else met = g.value === true || g.value === "met" || (typeof g.value === "string" && g.value.trim().toLowerCase() === String(thr).toLowerCase());
  const symptomsOk = !postEval || !postEval.reasons.some((r) => /sharp|leg symptoms|numbness/.test(r));
  return !!(met && g.form_ok !== false && (g.pain_peak ?? 0) <= 2 && symptomsOk);
}


function applyDailyPainFlags(s, level, data, d, dlog, walkItem, push) {
  const dailyItems = (level.items || []).filter((i) => i.block === "daily_core" || i.block === "daily_mobility");
  for (const it of dailyItems) {
    if (!(dlog?.checklist || []).some((c) => c.item_key === it.item_key && c.done)) continue;
    if (!isItemFlagged(dlog, it.item_key)) continue;
    const st = s.item_state[it.item_key];
    if (!st) continue;
    const streak = consecutiveFlagStreak(dailyFlagEvents(it, data.days, d));
    const start = it.start_rung ?? 0;
    st.clean_exposures = 0;
    if (streak >= FLAG_STREAK_TO_REGRESS && st.rung > start) {
      const c = { item_key: it.item_key, from_rung: st.rung, to_rung: st.rung - 1 };
      st.rung -= 1;
      push({ rule_id: "R17", outcome: "regress_step", message: `Unexpected pain flagged in ${streak} days in a row: ${it.exercise_id} stepped back one rung.`, changes: [c] });
    } else {
      push({ rule_id: "R17", outcome: "hold", message: `Unexpected pain flagged: ${it.exercise_id} will not advance this time.` });
    }
  }
  if (walkItem && s.walk && (dlog?.walk_min ?? 0) > 0 && isItemFlagged(dlog, walkItem.item_key)) {
    const streak = consecutiveFlagStreak(dailyFlagEvents(walkItem, data.days, d));
    const startMin = walkItem.rungs[walkItem.start_rung ?? 0]?.time_min ?? 5;
    if (streak >= FLAG_STREAK_TO_REGRESS && s.walk.current_min > startMin) {
      const from = s.walk.current_min;
      s.walk.current_min = Math.max(startMin, s.walk.current_min - 5);
      s.walk.clean_days = 0;
      const st = s.item_state[walkItem.item_key];
      if (st) { let r = 0; walkItem.rungs.forEach((g, n) => { if ((g.time_min ?? 0) <= s.walk.current_min) r = n; }); st.rung = r; }
      push({ rule_id: "R17", outcome: "regress_step", message: `Unexpected pain flagged in ${streak} days in a row: walking ${from} → ${s.walk.current_min} min.` });
    } else {
      push({ rule_id: "R17", outcome: "hold", message: "Unexpected pain flagged: walking will not advance this time." });
    }
  }
}

function processDay(s, d, data, daily, evals, checkins, docs, cfg, push) {
  const L = levelsMap(docs.levels);
  const level = L[s.level_id];
  const day = daily[d];
  const status = day?.color || null;
  const nextM = checkins.filter((c) => c.type === "morning" && c.local_date === addDays(d, 1)).pop();
  const nextMorningGreen = nextM ? evals[nextM.id].color === "green" : false;
  const dlog = data.days?.[d];
  const evening = checkins.filter((c) => c.type === "evening" && c.local_date === d).pop();
  if (s.mode === "paused") return s;

  // R16 work posture-cycle doses: after the evening check-in, on days work mode was used. Held at the flare preset while in settle mode.
  if (evening && evening.data?.posture_cycle?.work_mode_used && postureConfig() && s.mode !== "settle" && s.mode !== "red_stop") {
    if (!s.posture_cycle) s.posture_cycle = initPostureState(postureConfig(), s.level_id);
    const sr = standingRatio(evening.data, s.baselines);
    const standColor = sr === null ? null : sr >= cfg.standing.green_ratio - 1e-9 ? "green" : sr >= cfg.standing.orange_ratio - 1e-9 ? "yellow" : "orange";
    const r = applyPosture(s.posture_cycle, postureEventFromEvening(evening, status || "green", s.baselines, standColor), postureConfig());
    s.posture_cycle = r.state;
    if (r.result.outcome !== "none") push({ rule_id: "R16", outcome: r.result.outcome, color: status || "green", checkin_ids: day?.ids, message: `Work posture cycle: ${r.result.reasons.join("; ")}. Now stand ${s.posture_cycle.stand_min} / walk ${s.posture_cycle.walk_min} / sit ${s.posture_cycle.sit_min} / decompress ${s.posture_cycle.decomp_min} min (${s.posture_cycle.decomp_frequency === "after_each_block" ? "after each block" : "once per cycle"}).` });
  }

  // R2 on an orange day
  if (status === "orange") {
    if (!s.x.orange_dates.includes(d) && !s.x.orange_dates.includes(addDays(d, -1))) {
      s.x.orange_dates.push(d);
      const r = applyOrange(s, docs.levels, { ts: `${d}T12:00:00${offsetOf(day, checkins, d)}`, culprits: [], color: "orange", probation: false }, cfg);
      for (const l of r.log) push({ ...l, checkin_ids: day.ids });
    } else if (!s.x.orange_dates.includes(d)) s.x.orange_dates.push(d);
    const pc = popGroup(s, "core");
    if (pc.length) push({ rule_id: "R6", outcome: "regress_step", color: "orange", message: "Orange day: undo the last core bump.", changes: pc.map(rev) });
    s.x.orange_days_in_row++;
    if (s.x.step_regressed && s.x.orange_days_in_row >= (cfg.regress.orange_daily_statuses_in_row_after_step_regress ?? 3) && s.level_id !== "L0") {
      for (const l of regressLevel(s, docs.levels, `${d}T12:00:00${offsetOf(day, checkins, d)}`, "3 orange days in a row after a step regression", cfg)) push(l);
      return s;
    }
  } else s.x.orange_days_in_row = 0;

  // R8d standing below half baseline on 2 consecutive evenings
  if (evening) {
    const r = standingRatio(evening.data, s.baselines);
    if (r !== null && r < (cfg.standing.regress_level_ratio ?? 0.5)) s.x.standing_low_evenings++; else if (r !== null) s.x.standing_low_evenings = 0;
    if (s.x.standing_low_evenings >= (cfg.regress.standing_below_half_baseline_evenings_in_row ?? 2) && s.level_id !== "L0" && s.mode === "active") {
      for (const l of regressLevel(s, docs.levels, evening.ts, "standing tolerance below 50% of baseline on 2 evenings in a row", cfg)) push(l);
      return s;
    }
  }

  // held-out items return after two clean (green) days
  if (status === "green") {
    for (const [k, st] of Object.entries(s.item_state)) {
      if (!st.held_out) continue;
      s.x.held_out_green_days[k] = (s.x.held_out_green_days[k] || 0) + 1;
      if (s.x.held_out_green_days[k] >= 2) { st.held_out = false; st.rung = 0; delete s.x.held_out_green_days[k]; push({ rule_id: "R2", outcome: "none", color: "green", message: `${k} back in at rung 0 after two clean days.` }); }
    }
  }

  // R6 core track
  const core = level.items.filter((i) => i.block === "daily_core");
  const coreDone = core.length > 0 && dlog && core.filter((i) => !i.optional).every((i) => dlog.checklist?.some((c) => c.item_key === i.item_key && c.done));
  if (coreDone && status === "green" && nextMorningGreen) {
    s.core_clean_days++;
    if (s.core_clean_days >= (cfg.advance.core_clean_days_required ?? 3)) {
      s.core_clean_days = 0;
      const order = Object.fromEntries(level.items.map((i, n) => [i.item_key, n]));
      const elig = core.filter((i) => {
        const st = s.item_state[i.item_key];
        return st && !st.held_out && !isItemFlagged(dlog, i.item_key) && st.rung < i.target_rung && (i.requires || []).every((r) => { const ri = level.items.find((x) => x.item_key === r); return ri && s.item_state[r]?.rung === ri.target_rung; });
      }).sort((a, b) => (b.target_rung - s.item_state[b.item_key].rung) - (a.target_rung - s.item_state[a.item_key].rung) || order[a.item_key] - order[b.item_key]);
      if (elig.length) {
        const it = elig[0], st = s.item_state[it.item_key];
        const c = { item_key: it.item_key, from_rung: st.rung, to_rung: st.rung + 1 };
        st.rung++; st.last_bump_session_id = null;
        s.advance_stack.push({ event_id: `C${s.advance_stack.length + 1}`, session_id: null, track: "core", changes: [c] });
        push({ rule_id: "R6", outcome: "advance", color: "green", message: `3 clean core days: ${it.exercise_id} up one rung.`, changes: [c] });
      }
    }
  } else if (status !== "green" || !coreDone || !nextMorningGreen) s.core_clean_days = 0;

  // R7 walking track
  const walkItem = level.items.find((i) => i.block === "walking");
  if (walkItem && s.walk) {
    const cap = walkItem.rungs[walkItem.target_rung]?.time_min ?? s.walk.current_min;
    const walked = Math.max(dlog?.walk_min ?? 0, evening?.data?.walk_min ?? 0);
    const walkFlagged = isItemFlagged(dlog, walkItem.item_key);
    if (status === "green" && walked >= s.walk.current_min && !walkFlagged) {
      s.walk.clean_days++;
      if (s.walk.clean_days >= (cfg.advance.walk_clean_days_required ?? 3)) {
        s.walk.clean_days = 0;
        if (s.walk.current_min < cap) {
          const from = s.walk.current_min;
          s.walk.current_min = Math.min(cap, s.walk.current_min + 5);
          push({ rule_id: "R7", outcome: "advance", color: "green", message: `3 green days with the walking target met: walking ${from} → ${s.walk.current_min} min.` });
        }
      }
    } else if (status !== "green") s.walk.clean_days = 0;
    // keep the walking item's rung in step with the walking minutes
    const st = s.item_state[walkItem.item_key];
    if (st) { let r = 0; walkItem.rungs.forEach((g, n) => { if ((g.time_min ?? 0) <= s.walk.current_min) r = n; }); st.rung = r; }
  }

  applyDailyPainFlags(s, level, data, d, dlog, walkItem, push);

  // R9 settle exit
  if (s.mode === "settle") {
    s.settle.green_days_in_row = status === "green" ? (s.settle.green_days_in_row || 0) + 1 : 0;
    const ratio = evening ? standingRatio(evening.data, s.baselines) : null;
    if (s.settle.green_days_in_row >= (cfg.settle_mode.exit_green_daily_statuses_in_row ?? 2) && ratio !== null && ratio >= (cfg.standing.settle_exit_ratio ?? 0.7)) {
      settleExit(s, docs.levels, cfg, push, `${d}T20:00:00${offsetOf(day, checkins, d)}`);
    }
  }
  return s;
}
function offsetOf(day, checkins, d) {
  const c = checkins.find((x) => x.local_date === d);
  const m = c?.ts.match(/([+-]\d{2}:\d{2}|Z)$/);
  return m ? m[1] : "-06:00";
}

function settleExit(s, levelsDoc, cfg, push, ts) {
  const L = levelsMap(levelsDoc);
  const target = L[s.settle.resume_level] ? s.settle.resume_level : (levelsDoc.levels.find((l) => l.number === 1)?.id || "L1");
  const lv = L[target];
  const saved = s.settle.resume_item_state;
  const back = cfg.settle_mode?.resume_rungs_back ?? 1;
  s.item_state = freshItemState(lv, (i) => {
    const prev = saved?.[i.item_key]?.rung;
    return prev === undefined ? Math.max(0, i.target_rung - 1) : Math.max(0, Math.min(prev, i.target_rung) - back);
  });
  s.level_id = target; s.mode = "active";
  s.advance_stack = []; lockOn(s, cfg);
  s.gate_tests = gateTestsFor(lv); s.gate_pending = false; s.level_clean_streak = 0;
  s.walk = { current_min: walkStart(lv, s.item_state), clean_days: 0 };
  s.settle = { resume_level: null, resume_item_state: null, green_days_in_row: 0 };
  s.x.settle_since = null; s.x.level_started_on = localDate(ts); s.x.layoff_anchor = localDate(ts); s.x.step_regressed = false;
  posturePreset(s, { settle_exit: true }, push, ts);
  push({ rule_id: "R9", outcome: "settle_exit", color: "green", message: `Settled: 2 green days and standing at 70%+ of baseline. Back to ${target}, one rung easier, 3 clean sessions needed to advance.` });
}

function gates(s, docs, cfg, push, now) {
  if (s.mode !== "active") return s;
  const level = levelById(docs.levels, s.level_id);
  if (!level || s.level_id === "L0") return s;
  const exit = level.exit || {};
  const atTarget = level.items.filter((i) => !i.optional && i.block !== "relief")
    .every((i) => s.item_state[i.item_key] && s.item_state[i.item_key].rung >= i.target_rung && !s.item_state[i.item_key].held_out);
  const streakOk = s.level_clean_streak >= (exit.clean_streak_sessions ?? 0);
  if (atTarget && streakOk && !s.gate_pending) {
    s.gate_pending = true;
    push({ rule_id: "R10", outcome: "gate_pending", message: `${s.level_id} criteria met (clean streak ${s.level_clean_streak}, all items at target). Gate tests are next.` });
  }
  if (!s.gate_pending) return s;
  const tests = exit.tests || [];
  const done = tests.every((t) => {
    const g = s.gate_tests[t.test_id];
    return g && (g.status === "pass_confirmed" || (t.optional && g.status === "skipped_optional"));
  });
  if (!done) return s;
  const idx = docs.levels.levels.findIndex((l) => l.id === s.level_id);
  const next = docs.levels.levels[idx + 1];
  if (!next) {
    s.mode = "maintenance"; s.gate_pending = false;
    push({ rule_id: "R10", outcome: "promote", message: `All ${s.level_id} gate tests confirmed: maintenance mode (full athletic training). The engine keeps monitoring.` });
    return s;
  }
  s.level_id = next.id; s.item_state = freshItemState(next); s.advance_stack = [];
  s.probation_sessions_remaining = cfg.promotion_probation_sessions ?? 2; s.level_clean_streak = 0;
  s.gate_tests = gateTestsFor(next); s.gate_pending = false; s.consecutive_yellow_sessions = 0;
  s.walk = { current_min: walkStart(next, s.item_state), clean_days: 0 }; s.core_clean_days = 0;
  s.x.level_started_on = localDate(now); s.x.layoff_anchor = localDate(now); s.x.step_regressed = false;
  push({ rule_id: "R10", outcome: "promote", message: `Promoted to ${next.id} (${next.name}). Probation: the first 2 sessions must not be orange.` });
  return s;
}

function housekeeping(s, data, docs, cfg, push, now, checkins, evals, settings) {
  const today = localDate(now);
  // R11 layoff
  const layoffOn = settings.layoffEnabled ?? cfg.layoff?.enabled ?? true;
  const level = levelById(docs.levels, s.level_id);
  const hasStrength = level?.items.some((i) => STRENGTH_TEMPLATES.has(i.block));
  if (layoffOn && s.mode === "active" && hasStrength) {
    const lastStrength = (data.sessions || []).filter((x) => STRENGTH_TEMPLATES.has(x.template) && x.level_id === s.level_id).map((x) => x.local_date).sort().pop();
    const anchor = [lastStrength, s.x.level_started_on, s.x.layoff_anchor].filter(Boolean).sort().pop();
    if (anchor) {
      const gap = dayDiff(today, anchor);
      if (gap >= (cfg.layoff.no_strength_session_days_regress_level ?? 21) && s.x.layoff_level_for !== anchor) {
        s.x.layoff_level_for = anchor;
        for (const l of regressLevel(s, docs.levels, now, `layoff: ${gap} days without a strength session (R11)`, cfg)) push(l);
      } else if (gap >= (cfg.layoff.no_strength_session_days_regress_one_step ?? 10) && s.x.layoff_step_for !== anchor) {
        s.x.layoff_step_for = anchor;
        const p = popGroup(s);
        push({ rule_id: "R11", outcome: "regress_step", message: `Layoff: ${gap} days without a strength session; undo the last advance group.`, changes: p.map(rev) });
      }
    }
  }
  // Flare not settling after a week (plan.md section 9.6)
  if (s.mode === "settle" && s.x.settle_since && daysBetweenTs(now, s.x.settle_since) > 7 && !s.clinician_recommended) {
    s.clinician_recommended = true;
    push({ rule_id: "R15", outcome: "none", message: "Settle mode has lasted over a week: please check with your physician." });
  }
  // R14 baselines: favorable changes apply automatically, unfavorable ones need David's confirmation
  const B = s.baselines, props = [];
  const greenOf = (c) => evals[c.id]?.color === "green";
  const mornings = checkins.filter((c) => c.type === "morning" && greenOf(c) && typeof c.data.stiffness_min === "number").slice(-5);
  if (mornings.length === 5) {
    const m = median(mornings.map((c) => c.data.stiffness_min));
    if (m < B.stiffness_min) { push({ rule_id: "R14", outcome: "none", message: `Stiffness baseline ${B.stiffness_min} → ${m} min (median of the last 5 green mornings).` }); B.stiffness_min = m; }
    else if (m > B.stiffness_min) props.push({ field: "stiffness_min", from: B.stiffness_min, to: m });
  }
  const evs = checkins.filter((c) => c.type === "evening" && typeof c.data.standing?.first_pressure_h === "number" && greenOf(c)).slice(-5);
  if (evs.length === 5) {
    const m = median(evs.map((c) => c.data.standing.first_pressure_h));
    if (m > B.standing_h) { push({ rule_id: "R14", outcome: "none", message: `Standing baseline ${B.standing_h} → ${m} h (median of the last 5 uncensored green evenings).` }); B.standing_h = m; }
    else if (m < B.standing_h) props.push({ field: "standing_h", from: B.standing_h, to: m });
  }
  const pe = checkins.filter((c) => c.type === "evening" && greenOf(c)).slice(-5);
  if (pe.length === 5) {
    const m = Math.round(median(pe.map((c) => c.data.pain_peak_today)));
    if (m !== (B.pain_rest ?? 1)) props.push({ field: "pain_rest", from: B.pain_rest ?? 1, to: m });
  }
  s.x.baseline_proposals = props;
  return s;
}

// =====================================================================================
// 6. Manual events (buttons): flare, red clearance, pause/resume
// =====================================================================================
export function manualEvent(state, levelsDoc, cfg, ev, now, newId = defaultId()) {
  const s = clone(state);
  const log = [];
  const push = (e) => log.push({ id: newId(), ts: now, session_id: null, ...e });
  if (ev.type === "flare" && s.mode !== "red_stop" && s.level_id !== "L0") {
    s.settle = { resume_level: s.level_id, resume_item_state: clone(s.item_state), green_days_in_row: 0 };
    const l0 = levelById(levelsDoc, "L0");
    s.level_id = "L0"; s.mode = "settle"; s.item_state = freshItemState(l0); s.advance_stack = [];
    s.walk = { current_min: walkStart(l0, s.item_state), clean_days: 0 }; s.gate_tests = {}; s.gate_pending = false;
    s.x.settle_since = now;
    posturePreset(s, { flare: true }, push, now);
    push({ rule_id: "R9", outcome: "settle_enter", message: `"I flared" pressed: settle mode (L0). Return to ${s.settle.resume_level} one rung easier after 2 green days.` });
  } else if (ev.type === "red_clear" && s.mode === "red_stop") {
    const pre = s.x.pre_red?.level_id || s.level_id;
    const L = levelsMap(levelsDoc);
    const n = Math.max(1, (L[pre]?.number ?? 1) - 1);
    const resume = levelsDoc.levels.find((l) => l.number === n)?.id || "L1";
    s.red = { ...s.red, cleared_at: now, clearance_note: ev.note || "" };
    const l0 = levelById(levelsDoc, "L0");
    s.settle = { resume_level: resume, resume_item_state: null, green_days_in_row: 0 };
    s.level_id = "L0"; s.mode = "settle"; s.item_state = freshItemState(l0); s.advance_stack = [];
    s.walk = { current_min: walkStart(l0, s.item_state), clean_days: 0 }; s.gate_tests = {}; s.gate_pending = false;
    lockOn(s, cfg); s.x.settle_since = now;
    posturePreset(s, { flare: true }, push, now);
    push({ rule_id: "R1", outcome: "settle_enter", message: `Red cleared (${ev.note || "no note"}). Settle mode (L0); later resume at ${resume}.` });
  } else if (ev.type === "red_report" && s.mode !== "red_stop") {
    // David reported a red flag from the red-flag screen (not through a check-in).
    s.x.pre_red = { level_id: s.level_id, mode: s.mode };
    s.mode = "red_stop";
    s.red = { kind: ev.kind === "emergency" ? "emergency" : "clinician", since: now, flags: (ev.flags || []).map((f) => `Red: ${f}`), cleared_at: null, clearance_note: null };
    push({ rule_id: "R1", outcome: "red", color: "red", message: `Red (${s.red.kind}) reported on the red-flag screen: ${(ev.flags || []).join("; ")}. Plan frozen.` });
  } else if (ev.type === "pause" && s.mode === "active") {
    s.x.pre_pause_mode = s.mode; s.mode = "paused";
    push({ rule_id: "R12", outcome: "none", message: `Paused${ev.note ? ` (${ev.note})` : ""}: no advance, regress or layoff counting.` });
  } else if (ev.type === "resume" && s.mode === "paused") {
    s.mode = s.x.pre_pause_mode || "active"; s.x.need_clean_after_pause = 1; s.x.layoff_anchor = localDate(now);
    push({ rule_id: "R12", outcome: "none", message: "Resumed: one clean session is needed before any advance." });
  } else if (ev.type === "skip_optional_test") {
    if (s.gate_tests[ev.test_id]) { s.gate_tests[ev.test_id].status = "skipped_optional"; push({ rule_id: "R10", outcome: "none", message: `Optional test ${ev.test_id} skipped: ${ev.note || "no reason given"}.` }); }
  }
  return { state: s, log };
}

/** The dose for an item right now (current rung, easy dose = one set fewer on strength items). */
export function currentDose(state, item) {
  const st = state.item_state[item.item_key];
  const r = Math.min(st?.rung ?? item.start_rung, item.rungs.length - 1);
  const dose = { ...item.rungs[r] };
  const easy = (state.x?.easy_dose_sessions_remaining > 0 || state.lock?.easy_dose) && STRENGTH_TEMPLATES.has(item.block);
  if (easy && dose.sets > 1) dose.sets -= 1;
  return { dose, rung: r, easy };
}
