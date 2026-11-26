// Phase 4: weekly export (JSON + markdown, posture meta/trends) and plan-patch apply / revert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildExport, extractPatch, dueExportWeek, exportStem, weekRange } from "../public/js/export.js";
import { validatePatch } from "../public/js/patch.js";
import { gatherExport, applyPlanPatch, revertPlanPatch, rejectPlanPatch, writeState } from "../public/js/pipeline.js";
import { validate } from "../public/js/schema.js";
import { docHash, addDays } from "../public/js/util.js";
import { initState } from "../public/js/engine.js";

const j = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const levels = j("../public/data/levels.json"), exercises = j("../public/data/exercises.json"), tests = j("../public/data/tests.json");
const config = j("../public/data/decision-config.json"), posture = j("../public/data/posture-cycle.json");
const profile = j("../public/data/profile.json"), brief = j("../public/data/agent-brief.json");
const hashes = j("../public/data/hashes.json");
const example = j("./fixtures/plan-patch.example.json");
const S = (n) => j(`../public/data/schemas/${n}.schema.json`);
const schemas = { patch: S("plan-patch"), levels: S("levels"), exercises: S("exercises"), tests: S("tests") };

function memStore() {
  const m = { kv: new Map(), checkins: new Map(), sessions: new Map(), log: new Map(), days: new Map(), patches: new Map(), snapshots: new Map() };
  const keyOf = { checkins: "id", sessions: "id", log: "id", days: "local_date", patches: "patch_id", snapshots: "id" };
  return {
    async get(s, k) { return m[s].get(k); },
    async all(s) { return [...m[s].values()]; },
    async put(s, v) { m[s].set(v[keyOf[s]], structuredClone(v)); return v; },
    async kvGet(k) { return m.kv.get(k); }, async kvSet(k, v) { m.kv.set(k, structuredClone(v)); },
  };
}

test("dueExportWeek is Sunday evening of the finishing week, and stays due until marked", () => {
  const r = dueExportWeek({ today: "2026-11-29", timeHM: "15:30", evening: "15:30" });
  assert.equal(r.due, true);
  assert.equal(r.start, "2026-11-23");
  assert.equal(r.end, "2026-11-29");
  const early = dueExportWeek({ today: "2026-11-29", timeHM: "12:00", evening: "15:30" });
  assert.equal(early.start, "2026-11-16", "before Sunday evening, last complete week is due");
  const mid = dueExportWeek({ today: "2026-11-25", timeHM: "16:00", evening: "15:30", exported: "2026-11-16" });
  assert.equal(mid.due, false);
  const still = dueExportWeek({ today: "2026-11-30", timeHM: "08:00", evening: "15:30" });
  assert.equal(still.start, "2026-11-23");
  assert.equal(still.due, true);
});

test("extractPatch reads plain JSON, a fenced block, and JSON followed by markdown", () => {
  const raw = JSON.stringify(example);
  assert.equal(extractPatch(raw).ok, true);
  assert.equal(extractPatch("Here is the patch:\n```json\n" + raw + "\n```\nThanks.").patch.patch_id, example.patch_id);
  assert.equal(extractPatch(raw + "\n\n## Why\nLooks good to me.\n").patch.patch_id, example.patch_id);
  assert.equal(extractPatch("").ok, false);
  assert.equal(extractPatch("{ not json").ok, false);
  assert.match(extractPatch("{ \"kind\": \"nope\" }").error, /not a plan patch/i);
});

test("buildExport includes posture hashes, sports, and sitting / block trends", async () => {
  const start = "2026-11-23";
  const ev = {
    type: "evening", id: "E1", ts: "2026-11-23T19:00:00-06:00", local_date: start, session_id: null,
    data: {
      standing: { first_pressure_h: 5, censored: false, upright_h_total: 7 },
      sitting: { first_pressure_min: 18, censored: false, seated_min_total: 200 },
      posture_cycle: { work_mode_used: true, stand_prescribed_min: 40, sit_prescribed_min: 20, cycles_completed: 3 },
      pain_peak_today: 1, forced_rest_count: 0, activity_limited: false, hip_shift: false,
      symptoms: { pain_now: 1, sharp_electrical: false, leg_symptoms: "none", numbness_tingling: false },
    },
  };
  const state = initState(levels, "L1", { now: "2026-11-23T07:00:00-06:00", baselines: profile.baselines });
  const out = buildExport({
    start, end: "2026-11-29", today: "2026-11-25", now: "2026-11-25T16:00:00-06:00", appVersion: "test", config, levels,
    hashes: { levels_sha256: hashes.levels_sha256, exercises_sha256: hashes.exercises_sha256, tests_sha256: hashes.tests_sha256, profile_sha256: hashes.profile_sha256, posture_cycle_sha256: hashes.posture_cycle_sha256 },
    profile, sport: "soccer + football",
    stateStart: state, stateEnd: state, checkins: [ev], evals: {}, sessions: [], allSessions: [], days: {}, daily: {},
    decisionLog: [], patchLog: [], userNotes: "", agentBrief: brief,
  });
  assert.deepEqual(validate(S("weekly-export"), out.json).errors, []);
  assert.equal(out.json.meta.tests_sha256, hashes.tests_sha256);
  assert.equal(out.json.meta.posture_cycle_sha256, hashes.posture_cycle_sha256);
  assert.equal(out.json.meta.profile_sha256, hashes.profile_sha256);
  assert.deepEqual(out.json.profile.sports, ["soccer", "football"]);
  assert.deepEqual(out.json.summary.trend.first_sitting_pressure_min, [18]);
  assert.deepEqual(out.json.summary.trend.stand_block_min, [40]);
  assert.deepEqual(out.json.summary.trend.sit_block_min, [20]);
  assert.match(out.markdown, /sitting first pressure min/);
  assert.equal(out.stem, exportStem(start));
  assert.equal(weekRange(start).end, "2026-11-29");
});

test("gatherExport, apply the example patch, and revert it", async () => {
  const store = memStore();
  const docs = { levels, exercises, tests, config, posture, patched: false, seed_hash: "x" };
  const state = initState(levels, "L1", { now: "2026-11-23T07:00:00-06:00", baselines: profile.baselines });
  await store.kvSet("state", state);
  const morning = {
    type: "morning", id: "M1", ts: "2026-11-23T08:30:00-06:00", local_date: "2026-11-23", session_id: null,
    red_flags: { saddle_numbness: false, bladder_bowel_change: false, new_leg_weakness: false, new_numbness_tingling: false, fever_with_back_pain: false, night_pain_unrelieved: false, bilateral_leg_symptoms: false, trauma_since_last_checkin: false },
    data: { wake_time: "07:30", protection_window_respected: true, pain_on_waking: 1, stiffness_min: 30, sleep_quality: 4, woke_from_pain_count: 0, hip_shift: false, symptoms: { pain_now: 1, sharp_electrical: false, leg_symptoms: "none", numbness_tingling: false } },
  };
  await store.put("checkins", morning);

  const built = await gatherExport(store, docs, profile, { start: "2026-11-23", end: "2026-11-29", now: new Date("2026-11-25T16:00:00-06:00"), userNotes: "ok", agentBrief: brief });
  assert.deepEqual(validate(S("weekly-export"), built.json).errors, []);
  assert.ok(built.json.meta.posture_cycle_sha256);
  assert.equal(built.json.checkins.length, 1);
  assert.deepEqual(built.json.summary.trend.woke_from_pain_count, [0]);
  assert.match(built.markdown, /soreness when flipping over/);

  const beforeItems = docs.levels.levels.find((l) => l.id === "L2").items.length;
  const applied = await applyPlanPatch(store, docs, profile, example, schemas);
  assert.equal(applied.ok, true, (applied.review?.errors || []).join("; "));
  assert.equal(applied.docs.patched, true);
  assert.equal(applied.docs.levels.plan_version, (levels.plan_version ?? 1) + 1);
  assert.ok(applied.docs.levels.levels.find((l) => l.id === "L2").items.length > beforeItems, "optional item added");
  assert.equal((await store.get("patches", example.patch_id)).status, "applied");
  assert.ok(await store.get("snapshots", applied.rec.snapshot_id));
  // A later agent must rebase: hashes no longer match the pre-patch plan.
  const stale = await validatePatch(example, { levels: applied.docs.levels, exercises: applied.docs.exercises, tests: applied.docs.tests }, schemas);
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join(" "), /rebase/);

  const undone = await revertPlanPatch(store, applied.docs, example.patch_id);
  assert.equal(undone.ok, true, undone.error);
  assert.equal(undone.docs.levels.plan_version, levels.plan_version ?? 1);
  assert.equal(undone.docs.patched, false);
  assert.equal(undone.docs.levels.levels.find((l) => l.id === "L2").items.length, beforeItems);
  assert.equal((await store.get("patches", example.patch_id)).status, "reverted");
});

test("a rejected patch is stored with the reason, and a failing review is not applied", async () => {
  const store = memStore();
  const docs = { levels, exercises, tests, config, posture, patched: false };
  await store.kvSet("state", initState(levels, "L1", { now: "2026-11-23T07:00:00-06:00", baselines: profile.baselines }));
  const bad = { ...example, base: { ...example.base, levels_sha256: "0".repeat(64) } };
  const r = await applyPlanPatch(store, docs, profile, bad, schemas);
  assert.equal(r.ok, false);
  assert.equal(docs.patched, false);
  const rec = await rejectPlanPatch(store, bad, "Hashes did not match");
  assert.equal(rec.status, "rejected");
  assert.equal((await store.get("patches", bad.patch_id)).rejected_reason, "Hashes did not match");
});

test("writeState does not let a stale copy overwrite a newer restart", async () => {
  const store = memStore();
  await store.kvSet("state", { level_id: "L1", x: { restarted_at: "2026-11-25T16:40:00-06:00" } });
  const written = await writeState(store, { level_id: "L2", x: {} });
  assert.equal(written.level_id, "L1");
  assert.equal((await store.kvGet("state")).level_id, "L1");
  const ok = await writeState(store, { level_id: "L1", mode: "active", x: { restarted_at: "2026-11-25T16:41:00-06:00" } });
  assert.equal(ok.mode, "active");
});
