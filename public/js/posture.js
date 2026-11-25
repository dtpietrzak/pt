// Work posture-cycle: doses, progression (R16) and the pure timer state machine.
// Ports reference/ref_posture.py (src/posture_cycle.py); seed/posture-cycle.json is the config.
// No I/O: the clock is always passed in, so it runs identically in the browser and in Node tests.

import { localDate, localTime } from "./util.js";

let CFG = null;
/** Engine hooks (flare preset, settle exit) use this when no cfg is passed. data.js sets it at boot. */
export function setPostureConfig(cfg) { CFG = cfg; }
export const postureConfig = () => CFG;
const phaseMap = (cfg) => Object.fromEntries(cfg.phases.map((p) => [p.id, p]));

export function initPostureState(cfg = CFG, level = "L1") {
  const P = phaseMap(cfg);
  const d = level === "L0" ? { ...cfg.flare_preset } : {
    stand_min: P.stand.default_min, sit_min: P.sit.default_min, walk_min: P.walk.default_min, decomp_min: P.decompress.default_min,
    decomp_frequency: cfg.progression.default_decomp_frequency,
  };
  return { ...d, stand_clean_days: 0, sit_clean_days: 0, decomp_restore_clean_days: 0, saved_pre_flare: null };
}
export const clampPhase = (cfg, id, v) => { const p = phaseMap(cfg)[id]; return Math.max(p.floor_min, Math.min(p.cap_min, v)); };

function blockRatio(b) {
  if (!b) return null;
  const presc = b.prescribed_min || 0;
  if (b.actual_min === null || b.actual_min === undefined || presc <= 0) return null;
  return b.actual_min / presc;
}

/** Color for one posture. Missing data returns null (do not advance, do not change check-in color). */
export function postureColor(firstPressure, baseline, { flared = false, soreEarly = false, actual = null, prescribed = null, ratios, censored = false, painPeak = null } = {}) {
  const hasFp = firstPressure !== null && firstPressure !== undefined;
  let r = null;
  if (hasFp && baseline) r = firstPressure / baseline;
  else if (censored && (painPeak === null || painPeak === undefined || painPeak <= 2) && !flared) r = 1.0;
  else if (actual !== null && actual !== undefined && prescribed) r = actual / prescribed;
  if (r === null && !flared && !soreEarly) return null;
  if (r === null) return "orange";
  let color = r >= ratios.green_ratio - 1e-9 ? "green" : r >= ratios.orange_ratio - 1e-9 ? "yellow" : "orange";
  if (flared && color === "green") color = "yellow";
  if (flared && r < ratios.orange_ratio - 1e-9) color = "orange";
  if (soreEarly && r < ratios.orange_ratio - 1e-9) color = "orange";
  else if (soreEarly && color === "green") color = "yellow";
  return color;
}

const SAVE_KEYS = ["stand_min", "sit_min", "walk_min", "decomp_min", "decomp_frequency"];
const COLOR_ORDER = { green: 0, yellow: 1, orange: 2, red: 3 };
const worse = (a, b) => ((COLOR_ORDER[a] ?? -1) >= (COLOR_ORDER[b] ?? -1) ? a : b);

/** R16: apply one day's work-posture result. Returns { state, result }. */
export function applyPosture(state, event, cfg = CFG) {
  const prog = cfg.progression, P = phaseMap(cfg);
  const s = { ...state };
  const reasons = [], changes = {};
  let outcome = "none";
  const clamp = (id, v) => clampPhase(cfg, id, v);
  const resetDays = () => { s.stand_clean_days = s.sit_clean_days = s.decomp_restore_clean_days = 0; };

  if (event.flare) {
    if (s.saved_pre_flare == null) s.saved_pre_flare = Object.fromEntries(SAVE_KEYS.map((k) => [k, s[k]]));
    Object.assign(s, cfg.flare_preset); resetDays();
    return { state: s, result: { outcome: "flare_preset", changes: { stand_min: s.stand_min, sit_min: s.sit_min, decomp_frequency: s.decomp_frequency }, reasons: ["entered flare / L0; use shorter blocks and more frequent decompression"] } };
  }
  if (event.settle_exit) {
    const saved = s.saved_pre_flare || Object.fromEntries(SAVE_KEYS.map((k) => [k, s[k]]));
    const step = cfg.settle_exit_step_min ?? 5;
    s.stand_min = clamp("stand", saved.stand_min - step);
    s.sit_min = clamp("sit", saved.sit_min - step);
    s.walk_min = saved.walk_min ?? 2; s.decomp_min = saved.decomp_min ?? 5;
    s.decomp_frequency = saved.decomp_frequency ?? prog.default_decomp_frequency;
    s.saved_pre_flare = null; resetDays();
    return { state: s, result: { outcome: "settle_exit", changes: { stand_min: s.stand_min, sit_min: s.sit_min }, reasons: ["settle exit: restore previous doses minus 5 min, not below the floor"] } };
  }
  if (!event.work_mode_used) return { state: s, result: { outcome: "none", changes: {}, reasons: ["work mode was off; posture doses unchanged"] } };

  const daily = event.daily_status ?? "green";
  let standCol = event.standing_color ?? null;
  const sit = event.sitting || {}, stBlock = event.standing_block || {};
  let missingSit = !!(sit.missing || event.missing_sitting);
  let sitCol = event.sitting_color ?? null;
  if (sitCol === null && !missingSit) {
    const bsit = event.baselines?.sitting_min ?? cfg.baselines.sitting_min;
    sitCol = postureColor(sit.first_pressure_min, bsit, {
      flared: !!sit.flared, soreEarly: !!sit.sore_early, actual: sit.actual_min ?? null, prescribed: sit.prescribed_min || s.sit_min,
      ratios: cfg.ratios, censored: !!sit.censored, painPeak: event.pain_peak_today ?? null,
    });
    if (sitCol === null) missingSit = true;
  }
  const standSore = !!stBlock.sore_early, sitSore = !!sit.sore_early, sitFlared = !!sit.flared;
  const orangeR = cfg.ratios.orange_ratio;

  const sr = blockRatio(stBlock);
  if (sr !== null && standSore) {
    const derived = sr < orangeR - 1e-9 ? "orange" : "yellow";
    if (standCol === null || (derived === "orange" && standCol !== "orange")) {
      if (standCol !== "red") standCol = derived;
      if (derived === "orange") standCol = "orange";
    }
  }
  const standSignal = worse(standCol, standSore && sr !== null && sr < orangeR - 1e-9 ? "orange" : standSore ? "yellow" : standCol);
  const sitSignal = sitCol; // ref: worse(sit_col, "orange" if flared and col orange else sit_col) === sit_col

  if (daily === "orange" || daily === "red") {
    s.stand_min = clamp("stand", s.stand_min - prog.orange_step_min);
    s.sit_min = clamp("sit", s.sit_min - prog.orange_step_min);
    s.decomp_frequency = prog.orange_decomp_frequency; resetDays();
    return { state: s, result: { outcome: "posture_regress", changes: { stand_min: s.stand_min, sit_min: s.sit_min, decomp_frequency: s.decomp_frequency }, reasons: [`${daily} daily status: shorter blocks and more frequent decompression`], stand_color: standSignal, sit_color: sitSignal } };
  }
  if (daily === "yellow") {
    resetDays();
    return { state: s, result: { outcome: "posture_hold", changes: {}, reasons: ["yellow day: hold stand and sit doses, reset clean days"], stand_color: standSignal, sit_color: sitSignal } };
  }

  const standOk = (standSignal === null || standSignal === "green") && !standSore;
  const sitOk = !missingSit && sitSignal === "green" && !sitFlared && !sitSore;

  if (standSignal === "orange" || (standSore && sr !== null && sr < orangeR - 1e-9)) {
    s.stand_min = clamp("stand", s.stand_min - prog.orange_step_min); s.stand_clean_days = 0; changes.stand_min = s.stand_min;
    reasons.push("orange standing or early-sore below 60% of the block: stand stepped back 5 min"); outcome = "posture_regress";
  } else if (standSignal === "yellow" || standSore) {
    s.stand_clean_days = 0; reasons.push("yellow standing or early-sore: hold stand dose");
    if (outcome === "none") outcome = "posture_hold";
  } else if (standOk) {
    s.stand_clean_days++;
    if (s.stand_clean_days >= prog.green_days_to_advance) {
      const before = s.stand_min;
      s.stand_min = clamp("stand", s.stand_min + P.stand.step_min); s.stand_clean_days = 0;
      if (s.stand_min !== before) { changes.stand_min = s.stand_min; reasons.push("3 green stand days: stand +5 min"); outcome = "posture_advance"; }
      else reasons.push("stand already at the cap; a long block is not a training goal");
    } else reasons.push(`stand clean day ${s.stand_clean_days} of ${prog.green_days_to_advance}`);
  } else { s.stand_clean_days = 0; reasons.push("stand day not qualifying; dose unchanged"); }

  if (missingSit) { s.sit_clean_days = 0; reasons.push("missing sitting data: sit dose not advanced"); }
  else if (sitSignal === "orange") {
    s.sit_min = clamp("sit", s.sit_min - prog.orange_step_min); s.sit_clean_days = 0; changes.sit_min = s.sit_min;
    reasons.push("orange sitting or a sitting flare at low tolerance: sit stepped back 5 min"); outcome = "posture_regress";
  } else if (sitSignal === "yellow" || sitFlared || sitSore) {
    s.sit_clean_days = 0; reasons.push("sitting flared, was yellow, or was sore early: hold sit dose");
    if (outcome === "none") outcome = "posture_hold";
  } else if (sitOk) {
    s.sit_clean_days++;
    if (s.sit_clean_days >= prog.green_days_to_advance) {
      const before = s.sit_min;
      s.sit_min = clamp("sit", s.sit_min + P.sit.step_min); s.sit_clean_days = 0;
      if (s.sit_min !== before) { changes.sit_min = s.sit_min; reasons.push("3 green sit days with no flare: sit +5 min"); if (outcome !== "posture_regress") outcome = "posture_advance"; }
      else reasons.push("sit already at the cap; a long block is not a training goal");
    } else reasons.push(`sit clean day ${s.sit_clean_days} of ${prog.green_days_to_advance}`);
  } else { s.sit_clean_days = 0; reasons.push("sit day not qualifying; dose unchanged"); }

  if (s.decomp_frequency !== prog.default_decomp_frequency) {
    if (daily === "green" && standOk && (sitOk || (missingSit === false && (sitSignal === null || sitSignal === "green")))) {
      s.decomp_restore_clean_days++;
      if (s.decomp_restore_clean_days >= prog.green_days_to_restore_cycle_decomp) {
        s.decomp_frequency = prog.default_decomp_frequency; s.decomp_restore_clean_days = 0;
        changes.decomp_frequency = s.decomp_frequency; reasons.push("3 green days: decompression returns to once per cycle");
      }
    } else s.decomp_restore_clean_days = 0;
  } else s.decomp_restore_clean_days = 0;

  if (outcome === "none" && Object.keys(changes).length) outcome = "posture_advance";
  return { state: s, result: { outcome, changes, reasons, stand_color: standSignal, sit_color: sitSignal } };
}

/** Build the R16 event for one day from its evening check-in (and the day's rolled-up color). */
export function postureEventFromEvening(evening, dailyStatus, baselines, standColor) {
  const d = evening.data || {}, pc = d.posture_cycle || {};
  const sw = pc.early_switches || [];
  const soreOf = (ph) => sw.filter((x) => x.phase === ph && x.reason === "sore_early");
  const last = (a) => a[a.length - 1];
  const sitSw = last(soreOf("sit")), standSw = last(soreOf("stand"));
  const sit = d.sitting;
  return {
    work_mode_used: !!pc.work_mode_used,
    daily_status: dailyStatus,
    standing_color: standColor ?? null,
    sitting: sit ? {
      flared: !!sit.flared, first_pressure_min: sit.first_pressure_min ?? null, censored: !!sit.censored,
      sore_early: !!sitSw, actual_min: sitSw?.actual_min ?? null, prescribed_min: sitSw?.prescribed_min ?? sit.prescribed_block_min ?? pc.sit_prescribed_min ?? null, missing: false,
    } : { missing: true },
    standing_block: { sore_early: !!standSw, actual_min: standSw?.actual_min ?? null, prescribed_min: standSw?.prescribed_min ?? pc.stand_prescribed_min ?? null },
    flare: false, settle_exit: false,
    baselines: { sitting_min: baselines?.sitting_min }, pain_peak_today: d.pain_peak_today,
  };
}

// =====================================================================================
// Timer state machine. Wall-clock only: every function takes `now` (epoch ms) and the state stores
// timestamps, so a reload, a throttled background tab or a sleeping laptop can't make it drift.
//
// timer = {
//   v, active, session_id, local_date, started_at, device_id, override_quiet,
//   phase, phase_started_at, phase_min, queue: [phase ids forced next], snoozes, snooze_until,
//   blocks: [{ phase, prescribed_min, actual_min, started_at, ended_at, ended_how, snoozes }],
//   early_switches: [{ phase, prescribed_min, actual_min, reason }], stopped_at, stopped_how
// }
// A phase "falls due" at its deadline: the alarm rings and stays until the user switches, snoozes
// (settings.snooze_min, at most max_snoozes_per_phase per phase), taps sore early, or skips.
// The next phase's clock starts when the user switches.
// =====================================================================================
export const MIN = 60000;
export const TIMER_KEY = "timer";
export const LAST_FALLBACK_KEY = "posture:last_fallback_date";
export const postureLogKey = (ymd) => `posture:log:${ymd}`;

export const SORENESS_LEVELS = [
  { id: "none", score: 0, label: "Good", hint: "0–1 · no soreness", color: "green" },
  { id: "mild", score: 1, label: "Mild", hint: "2–3 · tight or light ache", color: "yellow" },
  { id: "moderate", score: 2, label: "Moderate", hint: "4–5 · noticeable soreness", color: "orange" },
  { id: "flare", score: 3, label: "Flare", hint: "6+ · sharp or flaring up", color: "red" },
];
const SORENESS_SCORE = Object.fromEntries(SORENESS_LEVELS.map((s) => [s.id, s.score]));
const SORENESS_LABEL = Object.fromEntries(SORENESS_LEVELS.map((s) => [s.id, s.label]));

/** The instant (epoch ms) of HH:MM on a YYYY-MM-DD in America/Chicago. */
export function chicagoInstant(ymd, hm) {
  for (const off of ["-05:00", "-06:00"]) {
    const t = new Date(`${ymd}T${hm}:00${off}`);
    if (localDate(t) === ymd && localTime(t) === hm) return t.getTime();
  }
  return new Date(`${ymd}T${hm}:00-06:00`).getTime();
}
const hmToMin = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
export function inWorkHours(now, st) {
  const m = hmToMin(localTime(new Date(now)));
  return m >= hmToMin(st.work_start) && m < hmToMin(st.work_end);
}
/** profile.settings.posture_cycle with the seed defaults filled in. */
export function timerSettings(profile, cfg = CFG) {
  return { ...cfg.timer, ...(profile?.settings?.posture_cycle || {}) };
}
const round1 = (n) => Math.round(n * 10) / 10;
const isoAt = (ms) => new Date(ms).toISOString();

export const phaseName = (cfg, id) => cfg.phases.find((p) => p.id === id)?.name ?? id;
export function phaseMinutes(doses, id, cfg = CFG) {
  return { stand: doses.stand_min, walk: doses.walk_min, sit: doses.sit_min, decompress: doses.decomp_min }[id]
    ?? cfg.phases.find((p) => p.id === id).default_min;
}

/** What comes after the current phase. how: "alarm" | "manual" | "sore_early". Returns { next, queue }. */
export function followingPhase(cfg, t, doses, how = "alarm") {
  if (how === "sore_early" && (t.phase === "stand" || t.phase === "sit")) {
    const seq = t.phase === "stand" ? cfg.order_after_stand_sore_early : cfg.order_after_sit_sore_early;
    return { next: seq[0], queue: seq.slice(1) };
  }
  if (t.queue?.length) return { next: t.queue[0], queue: t.queue.slice(1) };
  if (doses.decomp_frequency === "after_each_block") {
    // decompression after each stand (following the walk) and each sit
    if (t.phase === "stand") return { next: "walk", queue: [] };
    if (t.phase === "walk") return { next: "decompress", queue: ["sit"] };
    if (t.phase === "sit") return { next: "decompress", queue: [] };
    if (t.phase === "decompress") return { next: "stand", queue: [] };
  }
  const i = cfg.order.indexOf(t.phase);
  return { next: cfg.order[(i + 1) % cfg.order.length], queue: [] };
}

/** Start work mode now. Starting outside work hours (or with quiet hours off) is a manual override of quiet hours for this session. */
export function startTimer(doses, now, { cfg = CFG, settings, deviceId = null, id = `W${now}` } = {}) {
  const st = settings || cfg.timer;
  const inside = inWorkHours(now, st);
  return {
    v: 1, active: true, session_id: id, local_date: localDate(new Date(now)), started_at: now, device_id: deviceId,
    override_quiet: !(st.quiet_outside_work_hours && inside),
    phase: cfg.order[0], phase_started_at: now, phase_min: phaseMinutes(doses, cfg.order[0], cfg), queue: [], snoozes: 0, snooze_until: null,
    blocks: [], early_switches: [], stopped_at: null, stopped_how: null,
  };
}

/** When the current phase falls due (including snoozes). */
export const deadlineOf = (t) => t.phase_started_at + t.phase_min * MIN + (t.snooze_total_ms || 0);
export const isDue = (t, now) => !!t?.active && now >= deadlineOf(t);
export const remainingMs = (t, now) => deadlineOf(t) - now;
export function snoozesLeft(t, settings) { return Math.max(0, (settings.max_snoozes_per_phase ?? 2) - (t.snoozes || 0)); }

function closeBlock(t, now, how, soreness = null) {
  const actual = round1((now - t.phase_started_at) / MIN);
  const b = { phase: t.phase, prescribed_min: t.phase_min, actual_min: actual, started_at: isoAt(t.phase_started_at), ended_at: isoAt(now), ended_how: how, snoozes: t.snoozes || 0 };
  if (soreness && Object.prototype.hasOwnProperty.call(SORENESS_SCORE, soreness)) {
    b.soreness = soreness;
    b.soreness_score = SORENESS_SCORE[soreness];
  }
  return b;
}

/**
 * Leave the current phase. how: "alarm" (switched when it fell due), "manual" (switched early, not sore),
 * "sore_early". Optional soreness: "none" | "mild" | "moderate" | "flare". Returns a new timer.
 */
export function switchPhase(t, now, doses, how, cfg = CFG, soreness = null) {
  if (!t.active) return t;
  const ended = how === "alarm" && (t.snoozes || 0) > 0 ? "snooze_then_switch" : how;
  const block = closeBlock(t, now, ended, soreness);
  const early = how === "sore_early" || how === "manual";
  const { next, queue } = followingPhase(cfg, t, doses, how);
  return {
    ...t, blocks: [...t.blocks, block],
    early_switches: early ? [...t.early_switches, { phase: t.phase, prescribed_min: t.phase_min, actual_min: block.actual_min, reason: how }] : t.early_switches,
    phase: next, phase_started_at: now, phase_min: phaseMinutes(doses, next, cfg), queue, snoozes: 0, snooze_total_ms: 0, snooze_until: null,
  };
}
export const soreEarly = (t, now, doses, cfg = CFG, soreness = null) => switchPhase(t, now, doses, "sore_early", cfg, soreness);

/** Snooze the alarm. Only valid while due and with snoozes left. */
export function snooze(t, now, settings) {
  if (!isDue(t, now) || snoozesLeft(t, settings) <= 0) return t;
  const add = (settings.snooze_min ?? 5) * MIN;
  // the phase falls due again snooze_min from now
  const total = (t.snooze_total_ms || 0) + (now - deadlineOf(t)) + add;
  return { ...t, snoozes: (t.snoozes || 0) + 1, snooze_total_ms: total, snooze_until: now + add };
}

/** End work mode. how: "manual" | "work_end". */
export function stopTimer(t, now, how = "manual", soreness = null) {
  if (!t.active) return t;
  return { ...t, blocks: [...t.blocks, closeBlock(t, now, how === "work_end" ? "work_end" : "manual", soreness)], active: false, stopped_at: now, stopped_how: how };
}

/**
 * Wall-clock check, called from the UI loop and on load. Returns { timer, events }.
 *  events: "work_end_reminder" (one reminder to decompress, then work mode stops), "work_end_silent" (a stale session stopped without a sound).
 * Phase alarms are not events: the UI rings while isDue(timer, now) on the alarm device.
 */
export function tick(t, now, settings) {
  const events = [];
  if (!t?.active) return { timer: t, events };
  if (settings.quiet_outside_work_hours && !t.override_quiet) {
    const end = chicagoInstant(t.local_date, settings.work_end);
    if (now >= end) {
      const stopped = stopTimer(t, Math.min(now, Math.max(end, t.phase_started_at)), "work_end");
      stopped.stopped_at = now;
      events.push(now - end <= 15 * MIN ? "work_end_reminder" : "work_end_silent");
      return { timer: stopped, events };
    }
  }
  return { timer: t, events };
}

/** Counts for the day: cycles completed (a finished decompress), per-phase early switches. */
export function summarizeBlocks(blocks, earlySwitches = []) {
  const n = (p) => earlySwitches.filter((e) => e.phase === p && e.reason === "sore_early").length;
  return {
    cycles_completed: blocks.filter((b) => b.phase === "decompress" && b.ended_how !== "sore_early").length,
    decomp_done: blocks.filter((b) => b.phase === "decompress").length,
    early_switch_count: earlySwitches.length, stand_early_switches: n("stand"), sit_early_switches: n("sit"),
  };
}
/**
 * Gauge a work day's soreness trajectory across stand/walk/sit/decompress blocks to determine
 * the fallback status for the next day ("green" | "yellow" | "orange").
 */
export function evaluateSorenessTrend(blocks = [], earlySwitches = []) {
  const rated = blocks
    .map((b) => ({
      phase: b.phase,
      soreness: b.soreness,
      score: b.soreness_score ?? (b.soreness ? SORENESS_SCORE[b.soreness] : null),
    }))
    .filter((b) => b.score !== null && b.score !== undefined);

  const soreEarlyList = earlySwitches.filter((e) => e.reason === "sore_early");
  const deepSoreEarly = soreEarlyList.some((e) => e.prescribed_min > 0 && e.actual_min / e.prescribed_min < 0.6 - 1e-9);

  if (!rated.length && !soreEarlyList.length) {
    return {
      status: "green",
      worsening: false,
      rated_count: 0,
      reasons: [],
      next_day: "On track",
    };
  }

  const scores = rated.map((b) => b.score);
  const flareBlocks = rated.filter((b) => b.score >= 3);
  const modBlocks = rated.filter((b) => b.score >= 2);
  const mildBlocks = rated.filter((b) => b.score === 1);
  const last = rated[rated.length - 1];
  const first = rated[0];

  // Detect worsening across the day: second half worse than first half, or climbing into moderate+, or decompress didn't settle it.
  let worsening = false;
  if (scores.length >= 3) {
    const mid = Math.floor(scores.length / 2);
    const avg1 = scores.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
    const avg2 = scores.slice(mid).reduce((a, b) => a + b, 0) / (scores.length - mid);
    if (avg2 >= avg1 + 0.5 && last.score >= 1) worsening = true;
  }
  if (!worsening && scores.length >= 2 && last.score >= 2 && last.score > first.score) {
    worsening = true;
  }
  const decompFailed = rated.some((b) => b.phase === "decompress" && b.score >= 2);
  if (decompFailed) worsening = true;

  const reasons = [];
  let status = "green";

  if (flareBlocks.length > 0) {
    status = "orange";
    reasons.push(`Flare reported after ${flareBlocks[flareBlocks.length - 1].phase}`);
  } else if (modBlocks.length >= 2 || (worsening && last && last.score >= 2) || decompFailed || deepSoreEarly) {
    status = "orange";
    if (decompFailed) reasons.push("Still moderate soreness after decompression");
    if (modBlocks.length >= 2) reasons.push(`${modBlocks.length} blocks rated Moderate`);
    else if (worsening && last && last.score >= 2) reasons.push(`Soreness climbed (${SORENESS_LABEL[first.soreness]} → ${SORENESS_LABEL[last.soreness]})`);
    if (deepSoreEarly) reasons.push("Sore early before 60% of a block");
  } else if (modBlocks.length === 1 || worsening || mildBlocks.length >= 2 || soreEarlyList.length > 0) {
    status = "yellow";
    if (worsening && last) reasons.push(`Soreness ticked up (${SORENESS_LABEL[first.soreness]} → ${SORENESS_LABEL[last.soreness]})`);
    else if (modBlocks.length === 1) reasons.push(`1 block rated Moderate (${modBlocks[0].phase})`);
    else if (mildBlocks.length >= 2) reasons.push(`${mildBlocks.length} blocks rated Mild`);
    if (soreEarlyList.length > 0) reasons.push(`${soreEarlyList.length} sore-early switch${soreEarlyList.length === 1 ? "" : "es"}`);
  } else {
    reasons.push(rated.length === 1 ? "Block felt good" : `All ${rated.length} blocks stayed calm`);
  }

  const next_day = status === "orange"
    ? "Tomorrow steps back 5 min & decompresses after each block"
    : status === "yellow"
      ? "Tomorrow holds current doses"
      : "On track for tomorrow";

  return { status, worsening, rated_count: rated.length, reasons, next_day };
}

/** Build an R16 applyPosture event from a previous day's work posture log. */
export function workDayPostureEvent(log, doses) {
  const blocks = log?.blocks || [];
  const early = log?.early_switches || [];
  const trend = evaluateSorenessTrend(blocks, early);
  const lastOf = (ph) => [...early].reverse().find((e) => e.phase === ph && e.reason === "sore_early");
  const standSw = lastOf("stand");
  const sitSw = lastOf("sit");
  const hasSitBlock = blocks.some((b) => b.phase === "sit");
  const sitRatedBad = blocks.some((b) => b.phase === "sit" && (b.soreness_score ?? 0) >= 2);
  const sitRatedMild = blocks.some((b) => b.phase === "sit" && (b.soreness_score ?? 0) === 1);
  return {
    work_mode_used: blocks.length > 0,
    daily_status: trend.status,
    standing_color: trend.status,
    sitting_color: hasSitBlock ? (sitRatedBad ? "orange" : sitRatedMild ? "yellow" : trend.status) : null,
    sitting: hasSitBlock
      ? { flared: sitRatedBad, sore_early: !!sitSw, actual_min: sitSw?.actual_min ?? null, prescribed_min: sitSw?.prescribed_min ?? doses.sit_min, missing: false }
      : { missing: true },
    standing_block: { sore_early: !!standSw, actual_min: standSw?.actual_min ?? null, prescribed_min: standSw?.prescribed_min ?? doses.stand_min },
    flare: false,
    settle_exit: false,
  };
}

/** The `posture_cycle` object for an evening check-in (checkin.schema), from a day's blocks and the doses then in force. */
export function postureCheckinData(blocks, earlySwitches, doses) {
  const s = summarizeBlocks(blocks, earlySwitches);
  return {
    work_mode_used: blocks.length > 0, cycles_completed: s.cycles_completed,
    stand_prescribed_min: doses.stand_min, sit_prescribed_min: doses.sit_min, decomp_done: s.decomp_done,
    early_switches: earlySwitches.map((e) => ({ phase: e.phase, prescribed_min: e.prescribed_min, actual_min: e.actual_min, reason: e.reason })),
    actual_blocks: blocks.map(({ phase, prescribed_min, actual_min, started_at, ended_at, ended_how, snoozes }) => ({
      phase, prescribed_min, actual_min, started_at, ended_at, ended_how, snoozes,
    })),
  };
}
/** The `posture_cycle` object for the daily log (daily-log.schema). */
export function postureDailyLog(blocks, earlySwitches, doses) {
  const s = summarizeBlocks(blocks, earlySwitches);
  return { work_mode_used: blocks.length > 0, cycles_completed: s.cycles_completed, stand_prescribed_min: doses.stand_min, sit_prescribed_min: doses.sit_min,
    early_switch_count: s.early_switch_count, stand_early_switches: s.stand_early_switches, sit_early_switches: s.sit_early_switches };
}
