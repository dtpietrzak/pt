// Turn a rung's dose object into readable text. Pure.
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
  const sizes = /kettlebell|kb/i.test(item?.exercise_id || "") ? profile.equipment?.kettlebells_lb
    : /barbell/i.test(item?.exercise_id || "") ? null : profile.equipment?.dumbbells_lb;
  if (dose.load_lb) p.push(`@ ${nearest(dose.load_lb, sizes)} lb${item?.load_note ? " " + item.load_note : ""}`);
  if (dose.load_bw) {
    const bw = profile.body_weight_lb || 180;
    p.push(`@ ${Math.round(dose.load_bw * 100)}% BW ≈ ${nearest(dose.load_bw * bw, sizes)} lb${item?.load_note ? " " + item.load_note : ""}`);
  }
  return p.join(" · ") || "as prescribed";
}

// Map the free-text equipment names in exercises.json to profile.equipment flags.
const NEEDS = [
  [/barbell/i, (e) => e.barbell], [/plates/i, (e) => e.barbell],
  [/rack/i, (e) => e.rack_with_safeties], [/^bench$/i, (e) => e.bench], [/pull-up bar/i, (e) => e.pull_up_bar],
  [/cones/i, (e) => e.cones], [/track|field/i, (e) => e.track_or_field], [/^blocks$/i, (e) => e.blocks],
  [/^(mini )?band$/i, (e) => e.bands], [/^step$/i, (e) => (e.step_box_in ?? [1]).length > 0],
];
export function missingEquipment(exercise, equipment = {}) {
  return (exercise?.equipment || []).filter((name) => {
    if (/later|\bor\b/i.test(name)) return false; // alternatives / later-level notes
    const rule = NEEDS.find(([re]) => re.test(name.trim()));
    return rule ? !rule[1](equipment) : false;
  });
}
