import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validatePatch, applyOps, checkInvariants, migrateState } from "../public/js/patch.js";
import { validate } from "../public/js/schema.js";
import { docHash, clone } from "../public/js/util.js";
import { initState } from "../public/js/engine.js";

const j = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const levels = j("../public/data/levels.json"), exercises = j("../public/data/exercises.json"), tests = j("../public/data/tests.json");
const hashes = j("../public/data/hashes.json");
const S = (n) => j(`../public/data/schemas/${n}.schema.json`);
const schemas = { patch: S("plan-patch"), levels: S("levels"), exercises: S("exercises"), tests: S("tests") };
const example = j("./fixtures/plan-patch.example.json");

test("canonical hashes match the Python generator", async () => {
  assert.equal(await docHash(levels), hashes.levels_sha256);
  assert.equal(await docHash(exercises), hashes.exercises_sha256);
  assert.equal(await docHash(tests), hashes.tests_sha256);
});

test("seed documents validate and satisfy invariants", () => {
  for (const [d, s] of [[levels, schemas.levels], [exercises, schemas.exercises], [tests, schemas.tests]]) assert.deepEqual(validate(s, d).errors, []);
  assert.deepEqual(checkInvariants(levels, exercises, tests), []);
});

test("example patch validates and applies", async () => {
  const r = await validatePatch(example, { levels, exercises, tests }, schemas);
  assert.deepEqual(r.errors, []);
  assert.ok(r.ok);
  assert.ok(r.diff.length > 0);
});

test("stale base hashes are rejected", async () => {
  const p = clone(example); p.base.levels_sha256 = "0".repeat(64);
  const r = await validatePatch(p, { levels, exercises, tests }, schemas);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /rebase/);
});

test("removing an avoid entry is rejected; lowering clean streak needs safety review", async () => {
  const base = { plan_version: 1, levels_sha256: hashes.levels_sha256, exercises_sha256: hashes.exercises_sha256 };
  const mk = (ops, safety = false) => ({ ...clone(example), base, safety_review_required: safety, documents: [{ target: "levels", ops }] });
  let r = await validatePatch(mk([{ op: "remove", path: "/levels/1/avoid/0" }]), { levels, exercises, tests }, schemas);
  assert.equal(r.ok, false); assert.match(r.errors.join(" "), /avoid/);
  r = await validatePatch(mk([{ op: "replace", path: "/levels/1/exit/clean_streak_sessions", value: 2 }]), { levels, exercises, tests }, schemas);
  assert.equal(r.ok, false); assert.match(r.errors.join(" "), /safety_review_required/);
  r = await validatePatch(mk([{ op: "replace", path: "/levels/1/exit/clean_streak_sessions", value: 2 }], true), { levels, exercises, tests }, schemas);
  assert.ok(r.ok, r.errors.join("; ")); assert.ok(r.safety.length);
});

test("rung invariant: two fields changing at once is rejected", async () => {
  const base = { plan_version: 1, levels_sha256: hashes.levels_sha256, exercises_sha256: hashes.exercises_sha256 };
  const idx = levels.levels[1].items.findIndex((i) => i.rungs.length > 1);
  const it = levels.levels[1].items[idx];
  const bad = { ...it.rungs[1] };
  for (const k of Object.keys(bad)) bad[k] = bad[k] + 1;
  bad.sets = (bad.sets || 1) + 1;
  const p = { ...clone(example), base, documents: [{ target: "levels", ops: [{ op: "replace", path: `/levels/1/items/${idx}/rungs/1`, value: bad }] }] };
  const r = await validatePatch(p, { levels, exercises, tests }, schemas);
  assert.equal(r.ok, false);
});

test("migration clamps rungs and adds new items", () => {
  const s = initState(levels, "L1");
  const k = levels.levels[1].items[0].item_key;
  s.item_state[k].rung = 99;
  const next = applyOps(levels, [{ op: "replace", path: "/plan_version", value: 2 }]);
  const m = migrateState(s, levels, next, false);
  assert.equal(m.item_state[k].rung, levels.levels[1].items[0].rungs.length - 1);
  assert.equal(m.plan_version, 2);
});
