// Agent plan patches (data-model.md section 8): RFC 6902 subset, validation, safety review, state migration. Pure.
import { validate } from "./schema.js";
import { clone, docHash } from "./util.js";

const unesc = (s) => s.replace(/~1/g, "/").replace(/~0/g, "~");
export function parsePointer(p) {
  if (p === "") return [];
  if (!p.startsWith("/")) throw new Error(`Bad JSON Pointer "${p}"`);
  return p.slice(1).split("/").map(unesc);
}
export function getAt(doc, path) {
  let o = doc;
  for (const k of parsePointer(path)) {
    if (o === null || typeof o !== "object" || !(Array.isArray(o) ? /^\d+$/.test(k) && +k < o.length : k in o)) return { found: false };
    o = o[Array.isArray(o) ? +k : k];
  }
  return { found: true, value: o };
}
/** Apply ops to a copy; throws a readable error on the first op that does not apply. */
export function applyOps(doc, ops) {
  const out = clone(doc);
  ops.forEach((op, n) => {
    const keys = parsePointer(op.path);
    const where = `op ${n + 1} (${op.op} ${op.path})`;
    if (op.op === "test") {
      const g = getAt(out, op.path);
      if (!g.found) throw new Error(`${where}: path not found`);
      if (JSON.stringify(g.value) !== JSON.stringify(op.value)) throw new Error(`${where}: current value differs from the expected value`);
      return;
    }
    if (!keys.length) throw new Error(`${where}: cannot change the whole document`);
    const last = keys.pop();
    let parent = out;
    for (const k of keys) {
      parent = parent?.[Array.isArray(parent) ? +k : k];
      if (parent === undefined || parent === null || typeof parent !== "object") throw new Error(`${where}: parent path not found`);
    }
    if (Array.isArray(parent)) {
      const i = last === "-" ? parent.length : +last;
      if (!(last === "-" || /^\d+$/.test(last))) throw new Error(`${where}: bad array index`);
      if (op.op === "add") { if (i > parent.length) throw new Error(`${where}: index out of range`); parent.splice(i, 0, clone(op.value)); }
      else { if (i >= parent.length) throw new Error(`${where}: index out of range`); if (op.op === "replace") parent[i] = clone(op.value); else parent.splice(i, 1); }
    } else {
      if (op.op === "add") parent[last] = clone(op.value);
      else { if (!(last in parent)) throw new Error(`${where}: path not found`); if (op.op === "replace") parent[last] = clone(op.value); else delete parent[last]; }
    }
  });
  return out;
}

/** Invariants from data-model.md 8.4 */
export function checkInvariants(levels, exercises, tests) {
  const errs = [];
  const exIds = new Set(), testIds = new Set(tests.tests.map((t) => t.id));
  for (const e of exercises.exercises) { if (exIds.has(e.id)) errs.push(`duplicate exercise id ${e.id}`); exIds.add(e.id); }
  if (testIds.size !== tests.tests.length) errs.push("duplicate test ids");
  for (const e of exercises.exercises) for (const r of [...(e.regressions || []), ...(e.progressions || [])]) if (!exIds.has(r)) errs.push(`${e.id}: unknown regression/progression ${r}`);
  const keys = new Set(), levelIds = new Set();
  for (const l of levels.levels) {
    if (levelIds.has(l.id)) errs.push(`duplicate level ${l.id}`); levelIds.add(l.id);
    const inLevel = new Set(l.items.map((i) => i.item_key));
    for (const i of l.items) {
      if (keys.has(i.item_key)) errs.push(`duplicate item_key ${i.item_key}`); keys.add(i.item_key);
      if (!exIds.has(i.exercise_id)) errs.push(`${i.item_key}: unknown exercise ${i.exercise_id}`);
      if (!i.rungs?.length) errs.push(`${i.item_key}: empty rungs`);
      if (i.start_rung !== 0) errs.push(`${i.item_key}: start_rung must be 0`);
      if (i.target_rung !== i.rungs.length - 1) errs.push(`${i.item_key}: target_rung must be the last rung index`);
      for (let n = 1; n < (i.rungs || []).length; n++) {
        const a = i.rungs[n - 1], b = i.rungs[n];
        const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
        if (diff.length !== 1) errs.push(`${i.item_key}: rungs ${n - 1}→${n} change ${diff.length} fields (must be exactly 1)`);
      }
      for (const r of i.requires || []) if (!inLevel.has(r)) errs.push(`${i.item_key}: requires ${r} which is not in ${l.id}`);
    }
    for (const t of l.exit?.tests || []) if (!testIds.has(t.test_id)) errs.push(`${l.id}: unknown test ${t.test_id}`);
  }
  return errs;
}

const STEP = { hold_s: 5, pyr_top: 1, reps: 2, sets: 1, time_s: 10, distance_m: 5, time_min: 5, effort_pct: 10, load_lb: 5, load_bw: 0.10 };
const FLEXION = /flexion|toe touch|sit-?up|crunch|forward fold|knee-to-chest|end-range/i;

/** Protected and safety-review checks comparing documents before/after. */
export function reviewChanges(before, after, patch) {
  const rejects = [], safety = [];
  const ex = Object.fromEntries(after.exercises.exercises.map((e) => [e.id, e]));
  const lvB = Object.fromEntries(before.levels.levels.map((l) => [l.id, l]));
  const firstLevelOf = {};
  for (const l of before.levels.levels) for (const i of l.items) if (!(i.exercise_id in firstLevelOf)) firstLevelOf[i.exercise_id] = l.number;
  for (const doc of patch.documents) for (const op of doc.ops) {
    if (doc.target === "levels" && /^\/levels\/0(\/|$)/.test(op.path) && op.op !== "test") safety.push("edits L0 (settle level)");
    if (/red.?flag|morning.?window/i.test(op.path)) rejects.push(`${op.path}: red-flag texts and the morning-window rule are protected`);
  }
  for (const la of after.levels.levels) {
    const lb = lvB[la.id];
    if (!lb) { safety.push(`adds level ${la.id}`); continue; }
    const avB = lb.avoid || [], avA = la.avoid || [];
    if (avB.some((t) => !avA.includes(t))) rejects.push(`${la.id}: the avoid list may not be removed or weakened`);
    if ((la.exit?.clean_streak_sessions ?? 0) < (lb.exit?.clean_streak_sessions ?? 0)) safety.push(`${la.id}: lowers clean_streak_sessions`);
    const tB = Object.fromEntries((lb.exit?.tests || []).map((t) => [t.test_id, t]));
    const tA = Object.fromEntries((la.exit?.tests || []).map((t) => [t.test_id, t]));
    for (const id of Object.keys(tB)) {
      if (!tA[id]) safety.push(`${la.id}: drops gate test ${id}`);
      else if (typeof tB[id].threshold?.value === "number" && typeof tA[id].threshold?.value === "number" && tA[id].threshold.value < tB[id].threshold.value) safety.push(`${la.id}: lowers ${id} threshold`);
      else if (JSON.stringify(tA[id].threshold) !== JSON.stringify(tB[id].threshold) && typeof tB[id].threshold?.value === "string") safety.push(`${la.id}: changes ${id} threshold text`);
    }
    const itemsB = Object.fromEntries(lb.items.map((i) => [i.item_key, i]));
    for (const i of la.items) {
      const e = ex[i.exercise_id];
      const old = itemsB[i.item_key];
      if (!old && !i.optional && ["daily_mobility", "daily_core", "strength_A", "strength_B", "conditioning"].includes(i.block) && e && (e.category === "stretch" || FLEXION.test(`${e.name} ${(e.cues || []).join(" ")}`)))
        safety.push(`${la.id}: adds ${i.exercise_id} (flexion/end-range pattern) to a default block`);
      if (!old && e && (e.category === "impact" || e.category === "speed") && firstLevelOf[i.exercise_id] !== undefined && la.number < firstLevelOf[i.exercise_id])
        safety.push(`${la.id}: adds impact/speed item ${i.exercise_id} earlier than before`);
      if (!old && e && (e.category === "impact" || e.category === "speed") && firstLevelOf[i.exercise_id] === undefined && la.number < 4)
        safety.push(`${la.id}: adds a new impact/speed item ${i.exercise_id} before L4`);
      for (let n = 1; n < i.rungs.length; n++) {
        const a = i.rungs[n - 1], b = i.rungs[n];
        for (const k of Object.keys(STEP)) {
          if (typeof a[k] === "number" && typeof b[k] === "number" && b[k] - a[k] > STEP[k] + 1e-9 && !(k === "hold_s" && b[k] - a[k] <= 5)) {
            const wasSame = old && old.rungs[n - 1]?.[k] === a[k] && old.rungs[n]?.[k] === b[k];
            if (!wasSame) safety.push(`${i.item_key}: rung ${n} raises ${k} by ${+(b[k] - a[k]).toFixed(2)} (step size ${STEP[k]})`);
          }
        }
      }
      if (old && i.rungs.length > old.rungs.length && JSON.stringify(i.rungs.at(-1)) !== JSON.stringify(old.rungs.at(-1))) {
        const last = old.rungs.at(-1), nl = i.rungs.at(-1);
        if (Object.keys(STEP).some((k) => typeof last[k] === "number" && typeof nl[k] === "number" && nl[k] > last[k])) safety.push(`${i.item_key}: raises the target dose`);
      }
    }
  }
  // tests.json threshold changes
  const tbB = Object.fromEntries(before.tests.tests.map((t) => [t.id, t]));
  for (const t of after.tests.tests) {
    const o = tbB[t.id];
    if (!o) continue;
    for (const [lv, th] of Object.entries(o.thresholds)) {
      const n = t.thresholds[lv];
      if (!n) safety.push(`${t.id}: drops the ${lv} threshold`);
      else if (typeof th.value === "number" && typeof n.value === "number" && n.value < th.value) safety.push(`${t.id}: lowers the ${lv} threshold`);
    }
  }
  for (const id of Object.keys(tbB)) if (!after.tests.tests.some((t) => t.id === id)) safety.push(`removes test ${id}`);
  return { rejects: [...new Set(rejects)], safety: [...new Set(safety)] };
}

/**
 * validatePatch(patch, current, schemas) -> { ok, errors[], safety[], next: {levels, exercises, tests}, diff[] }
 * current: { levels, exercises, tests, plan_version }
 */
export async function validatePatch(patch, current, schemas) {
  const errors = [];
  const sv = validate(schemas.patch, patch);
  if (!sv.valid) return { ok: false, errors: sv.errors.map((e) => `Schema: ${e}`), safety: [], diff: [] };
  for (const d of patch.documents) if (!["levels", "exercises", "tests"].includes(d.target)) errors.push(`Target ${d.target} is protected`);
  const lh = await docHash(current.levels), eh = await docHash(current.exercises);
  if (patch.base.levels_sha256 !== lh || patch.base.exercises_sha256 !== eh)
    errors.push("The patch was written against a different plan (base hashes do not match). Ask the agent to rebase on the latest export.");
  if (patch.base.plan_version !== (current.levels.plan_version ?? 1)) errors.push(`Base plan_version ${patch.base.plan_version} does not match the current ${current.levels.plan_version}.`);
  if (errors.length) return { ok: false, errors, safety: [], diff: [] };
  const next = { levels: current.levels, exercises: current.exercises, tests: current.tests };
  const diff = [];
  try {
    for (const d of patch.documents) {
      const before = next[d.target];
      for (const op of d.ops) diff.push(describeOp(d.target, op, before));
      next[d.target] = applyOps(before, d.ops);
    }
  } catch (e) { return { ok: false, errors: [`Does not apply cleanly: ${e.message}`], safety: [], diff }; }
  for (const [k, sch] of [["levels", schemas.levels], ["exercises", schemas.exercises], ["tests", schemas.tests]]) {
    const r = validate(sch, next[k]);
    if (!r.valid) errors.push(...r.errors.slice(0, 10).map((e) => `${k}.json after patch: ${e}`));
  }
  errors.push(...checkInvariants(next.levels, next.exercises, next.tests));
  const rv = reviewChanges(current, next, patch);
  errors.push(...rv.rejects);
  if (rv.safety.length && !patch.safety_review_required) errors.push(`Needs safety_review_required: true because it ${rv.safety.join("; ")}.`);
  return { ok: errors.length === 0, errors, safety: rv.safety, next, diff };
}

function short(v) {
  if (v === undefined) return "(nothing)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 240 ? s.slice(0, 240) + "…" : s;
}
export function describeOp(target, op, doc) {
  const g = getAt(doc, op.path);
  const label = humanPath(target, op.path, doc);
  if (op.op === "test") return { op: "test", label, text: `Check ${label} is ${short(op.value)}` };
  if (op.op === "remove") return { op: "remove", label, before: short(g.value), after: "(removed)" };
  if (op.op === "add") return { op: "add", label, before: g.found && !Array.isArray(getAt(doc, op.path.replace(/\/[^/]*$/, "")).value) ? short(g.value) : "(new)", after: short(op.value) };
  return { op: "replace", label, before: short(g.value), after: short(op.value) };
}
function humanPath(target, path, doc) {
  const k = parsePointer(path);
  if (target === "levels" && k[0] === "levels") {
    const l = doc.levels[+k[1]];
    let s = l ? l.id : `level ${k[1]}`;
    if (k[2] === "items" && l?.items[+k[3]]) s += ` · ${l.items[+k[3]].exercise_id}`;
    else if (k[2] === "items") s += " · new item";
    const rest = k.slice(k[2] === "items" ? 4 : 2);
    return rest.length ? `${s} · ${rest.join(".")}` : s;
  }
  if (target === "exercises" && k[0] === "exercises") {
    const e = doc.exercises[+k[1]];
    return `${e ? e.id : "new exercise"}${k.length > 2 ? " · " + k.slice(2).join(".") : ""}`;
  }
  if (target === "tests" && k[0] === "tests") {
    const t = doc.tests[+k[1]];
    return `${t ? t.id : "new test"}${k.length > 2 ? " · " + k.slice(2).join(".") : ""}`;
  }
  return `${target}${path}`;
}

/** Migrate decision state after an approved patch (data-model.md 8, "On approve"). */
export function migrateState(state, oldLevels, newLevels, testsChanged) {
  const s = clone(state);
  const level = newLevels.levels.find((l) => l.id === s.level_id);
  const keys = new Set(level.items.map((i) => i.item_key));
  for (const k of Object.keys(s.item_state)) if (!keys.has(k)) delete s.item_state[k];
  for (const i of level.items) {
    const st = s.item_state[i.item_key];
    if (!st) s.item_state[i.item_key] = { rung: 0, clean_exposures: 0, held_out: false, last_bump_session_id: null };
    else st.rung = Math.max(0, Math.min(st.rung, i.rungs.length - 1));
  }
  s.advance_stack = s.advance_stack.map((g) => ({ ...g, changes: g.changes.filter((c) => keys.has(c.item_key)) })).filter((g) => g.changes.length);
  const oldL = oldLevels.levels.find((l) => l.id === s.level_id);
  const testsDiff = JSON.stringify(oldL?.exit?.tests) !== JSON.stringify(level.exit?.tests);
  if (testsChanged || testsDiff) {
    s.gate_pending = false;
    const gt = {};
    for (const t of level.exit?.tests || []) gt[t.test_id] = s.gate_tests[t.test_id] || { status: "not_started", value: null, session_id: null, retest_after_clean_sessions: 0 };
    s.gate_tests = gt;
  }
  s.plan_version = newLevels.plan_version;
  return s;
}
