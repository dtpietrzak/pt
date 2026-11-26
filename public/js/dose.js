// Turn a rung's dose object into readable text. Pure.
import { BODY_WEIGHT_LB } from "./defaults.js";
const r5 = (x) => Math.round(x / 5) * 5;
function nearest(x, sizes) {
  if (!sizes?.length) return r5(x);
  return sizes.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
}
export function formatDose(dose, item, profile = {}) {
  const p = [];
  const side = item?.per_side ? " per side" : "";
  if (dose.pyr_top) {
    const gap = dose.pyr_gap ?? 2, sets = [];
    for (let k = 0; k < 3; k++) sets.push(Math.max(1, dose.pyr_top - k * gap));
    p.push(`${sets.join("-")} holds of ${dose.hold_s ?? 10} s${side}`);
  } else if (dose.sets && dose.reps) p.push(`${dose.sets}x${dose.reps}${item?.reps_label ? " " + item.reps_label : ""}${side}${dose.hold_s ? ` (${dose.hold_s} s hold)` : ""}`);
  else if (dose.sets && dose.hold_s) p.push(`${dose.sets}x${dose.hold_s} s hold${side}`);
  else if (dose.reps) p.push(`${dose.reps} reps${side}${dose.hold_s ? ` (${dose.hold_s} s hold)` : ""}`);
  else if (dose.hold_s) p.push(`${dose.hold_s} s hold${side}`);
  const bare = dose.sets && !dose.reps && !dose.hold_s && !dose.pyr_top;
  const unit = dose.time_s ? `${dose.time_s} s` : dose.distance_m ? `${dose.distance_m} m` : dose.time_min ? `${dose.time_min} min` : "";
  if (bare && unit) p.push(`${dose.sets}x${unit}${side}`);
  else {
    if (bare) p.push(`${dose.sets} sets`);
    if (dose.time_s) p.push(`${dose.time_s} s${side && !p.length ? side : ""}`);
    if (dose.time_min) p.push(`${dose.time_min} min`);
    if (dose.distance_m) p.push(`${dose.distance_m} m`);
  }
  if (dose.effort_pct) p.push(`${dose.effort_pct}% effort`);
  const id = item?.exercise_id || "";
  const sizes = /PALLOF|BAND_ROW|CABLE/i.test(id) ? profile.equipment?.cable_stack_lb
    : /kettlebell|kb/i.test(id) ? profile.equipment?.kettlebells_lb
    : /barbell/i.test(id) ? null : profile.equipment?.dumbbells_lb;
  if (dose.load_lb) p.push(`@ ${nearest(dose.load_lb, sizes)} lb${item?.load_note ? " " + item.load_note : ""}`);
  if (dose.load_bw) {
    p.push(`@ ${Math.round(dose.load_bw * 100)}% BW ≈ ${nearest(dose.load_bw * BODY_WEIGHT_LB, sizes)} lb${item?.load_note ? " " + item.load_note : ""}`);
  }
  return p.join(" · ") || "as prescribed";
}

// Map the free-text equipment names in exercises.json to profile.equipment flags.
const NEEDS = [
  [/barbell/i, (e) => e.barbell], [/plates/i, (e) => e.barbell],
  [/rack/i, (e) => e.rack_with_safeties], [/^bench$/i, (e) => e.bench], [/pull-up bar/i, (e) => e.pull_up_bar],
  [/cones/i, (e) => e.cones], [/track|field/i, (e) => e.track_or_field], [/^blocks$/i, (e) => e.blocks],
  [/^(mini )?band$/i, (e) => e.bands], [/^cable stack$/i, (e) => e.cable_stack !== false && (e.cable_stack_lb == null || e.cable_stack_lb.length > 0 || e.cable_stack)], [/^step$/i, (e) => (e.step_box_in ?? [1]).length > 0],
];
export function missingEquipment(exercise, equipment = {}) {
  return (exercise?.equipment || []).filter((name) => {
    if (/later|\bor\b/i.test(name)) return false; // alternatives / later-level notes
    const rule = NEEDS.find(([re]) => re.test(name.trim()));
    return rule ? !rule[1](equipment) : false;
  });
}


/** Pyramid hold counts (same rule formatDose uses): pyr_top 4, default gap 2 → [4, 2, 1]. */
export function pyramidCounts(dose) {
  if (!dose?.pyr_top) return null;
  const gap = dose.pyr_gap ?? 2, out = [];
  for (let k = 0; k < 3; k++) out.push(Math.max(1, dose.pyr_top - k * gap));
  return out;
}

function intervalSeconds(dose) {
  if (typeof dose.time_min === "number" && dose.time_min > 0) return { seconds: Math.round(dose.time_min * 60), kind: "time" };
  if (typeof dose.time_s === "number" && dose.time_s > 0) return { seconds: dose.time_s, kind: "time" };
  if (typeof dose.hold_s === "number" && dose.hold_s > 0) return { seconds: dose.hold_s, kind: "hold" };
  return null;
}

/**
 * If this dose is a timed set (a hold, seconds, or minutes — never by exercise id), return a countdown plan.
 * steps cover multi-set doses and, when item.per_side, left then right for each set.
 * @returns {{ seconds: number, kind: "hold"|"time", steps: { label: string, set: number, of: number, side?: string }[], rest_s?: number } | null}
 */
export function timedPlan(dose, item = {}) {
  if (!dose) return null;
  const iv = intervalSeconds(dose);
  if (!iv) return null;
  const pyr = pyramidCounts(dose);
  const n = pyr ? pyr.reduce((a, b) => a + b, 0)
    : dose.sets && dose.reps ? dose.sets * dose.reps
    : dose.sets ? dose.sets
    : dose.reps ? dose.reps
    : 1;
  const unit = iv.kind === "hold" ? "Hold" : "Set";
  const sides = item.per_side ? ["left", "right"] : [null];
  const steps = [];
  for (let i = 1; i <= n; i++) {
    for (const side of sides) {
      let label;
      if (n === 1 && !side) label = iv.kind === "hold" ? `${iv.seconds} s hold` : (iv.seconds % 60 === 0 ? `${iv.seconds / 60} min` : `${iv.seconds} s`);
      else if (n === 1 && side) label = side === "left" ? "Left" : "Right";
      else label = `${unit} ${i} of ${n}${side ? ` · ${side}` : ""}`;
      steps.push({ label, set: i, of: n, ...(side ? { side } : {}) });
    }
  }
  const rest_s = item.rest_s > 0 && steps.length > 1 ? item.rest_s : undefined;
  return { seconds: iv.seconds, kind: iv.kind, steps, ...(rest_s ? { rest_s } : {}) };
}

/**
 * Set counter for untimed (rep-based) doses. Timed holds use timedPlan instead.
 * @returns {{ sets: number } | null}
 */
export function setPlan(dose) {
  if (!dose || timedPlan(dose)) return null;
  if (dose.sets && dose.sets > 0) return { sets: dose.sets };
  const pyr = pyramidCounts(dose);
  if (pyr) return { sets: pyr.length };
  if (dose.reps && dose.reps > 0) return { sets: 1 };
  return null;
}
