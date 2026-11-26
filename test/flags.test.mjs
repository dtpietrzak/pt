import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSerious, needsRedGuidance, newFlag, flagsOf, flagsForItem, flagsForSession,
  upsertFlag, removeFlag, toItemFields, mergeFlagsIntoItems, sessionFlagHints,
  holdsCoreDay, holdsWalkDay, flagSummary, REST_SEC, restCuesToPlay, needsRestAfter,
} from "../public/js/pain-flags.js";
import { setPlan, timedPlan } from "../public/js/dose.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const flag = (over = {}) => newFlag({ pain: 3, location: "low_back", type: "ache", ts: "2026-11-25T12:00:00", ...over });

test("newFlag clamps pain, drops empty notes, and keeps keys", () => {
  const f = newFlag({ item_key: "core_a", session_key: "wk:A", pain: 12, location: "leg", type: "nerve", note: "  zing  ", ts: "t" });
  assert.equal(f.pain, 10);
  assert.equal(f.item_key, "core_a");
  assert.equal(f.session_key, "wk:A");
  assert.equal(f.note, "zing");
  assert.ok(f.id);
  const bare = newFlag({ pain: -2, location: "hip", type: "sharp", ts: "t", note: "   " });
  assert.equal(bare.pain, 0);
  assert.equal(bare.item_key, undefined);
  assert.equal(bare.note, undefined);
});

test("isSerious matches the post-workout orange threshold, plus radiating/nerve", () => {
  assert.equal(isSerious(flag({ pain: 4 })), false);
  assert.equal(isSerious(flag({ pain: 5 })), true);
  assert.equal(isSerious(flag({ pain: 2, type: "sharp" })), true);
  assert.equal(isSerious(flag({ pain: 2, type: "nerve" })), true);
  assert.equal(isSerious(flag({ pain: 2, location: "leg" })), true);
});

test("needsRedGuidance covers radiating, nerve, sharp, or pain >= 7", () => {
  assert.equal(needsRedGuidance(flag({ pain: 6, type: "ache" })), false);
  assert.equal(needsRedGuidance(flag({ pain: 7, type: "ache" })), true);
  assert.equal(needsRedGuidance(flag({ pain: 2, location: "leg" })), true);
  assert.equal(needsRedGuidance(flag({ pain: 2, type: "nerve" })), true);
  assert.equal(needsRedGuidance(flag({ pain: 2, type: "sharp" })), true);
});

test("flagsOf / upsert / remove keep a dated list on the day doc", () => {
  assert.deepEqual(flagsOf(null), []);
  const a = flag({ id: "a", item_key: "x", ts: "2026-11-25T10:00:00" });
  const b = flag({ id: "b", item_key: "y", ts: "2026-11-25T09:00:00" });
  let day = upsertFlag({ local_date: "2026-11-25", checklist: [] }, a);
  day = upsertFlag(day, b);
  assert.deepEqual(day.pain_flags.map((f) => f.id), ["b", "a"]);
  assert.equal(flagsForItem(day, "x").length, 1);
  assert.equal(flagsForSession(day, "wk:A").length, 0);
  day = upsertFlag(day, { ...a, pain: 8 });
  assert.equal(flagsForItem(day, "x")[0].pain, 8);
  assert.equal(day.pain_flags.length, 2);
  day = removeFlag(day, "a");
  assert.deepEqual(day.pain_flags.map((f) => f.id), ["b"]);
});

test("session flags are those with a session_key and no item_key", () => {
  const day = {
    pain_flags: [
      flag({ id: "i", item_key: "x", session_key: "wk:A" }),
      flag({ id: "s", session_key: "wk:A" }),
    ],
  };
  assert.equal(flagsForSession(day, "wk:A").map((f) => f.id).join(), "s");
  assert.equal(flagsForItem(day, "x").map((f) => f.id).join(), "i");
});

test("mergeFlagsIntoItems prefills problem/pain/sharp without clearing a worse value", () => {
  const flags = [
    flag({ item_key: "a", pain: 4, type: "ache" }),
    flag({ item_key: "a", pain: 6, type: "sharp" }),
    flag({ item_key: "b", pain: 3, type: "nerve" }),
  ];
  const items = mergeFlagsIntoItems([
    { item_key: "a", completed: true, pain_peak: 2 },
    { item_key: "b", completed: true },
    { item_key: "c", completed: true },
  ], flags);
  assert.equal(items[0].problem, true);
  assert.equal(items[0].pain_peak, 6);
  assert.equal(items[0].sharp, true);
  assert.equal(items[1].pain_peak, 3);
  assert.equal(items[1].sharp, true);
  assert.equal(items[2].problem, undefined);
  assert.deepEqual(toItemFields(flag({ pain: 2, type: "nerve" })), { problem: true, pain_peak: 2, sharp: true });
});

test("sessionFlagHints take the worst pain and radiating/nerve cues", () => {
  assert.equal(sessionFlagHints([]), null);
  const h = sessionFlagHints([
    flag({ pain: 4, type: "ache", location: "low_back" }),
    flag({ pain: 6, type: "nerve", location: "leg" }),
  ]);
  assert.equal(h.pain, 6);
  assert.equal(h.sharp, true);
  assert.equal(h.leg, "new");
});

test("holdsCoreDay / holdsWalkDay only fire on a serious flag for that item", () => {
  const flags = [
    flag({ item_key: "core_req", pain: 5 }),
    flag({ item_key: "core_opt", pain: 8 }),
    flag({ item_key: "walk", pain: 2, type: "ache" }),
  ];
  assert.equal(holdsCoreDay(flags, ["core_req"]), true);
  assert.equal(holdsCoreDay(flags, ["other"]), false);
  assert.equal(holdsCoreDay([flag({ item_key: "core_req", pain: 2 })], ["core_req"]), false);
  assert.equal(holdsWalkDay(flags, "walk"), false);
  assert.equal(holdsWalkDay([flag({ item_key: "walk", location: "leg", pain: 2 })], "walk"), true);
  assert.equal(holdsWalkDay(flags, null), false);
});

test("flagSummary lists pain, type, place, and a note", () => {
  assert.match(flagSummary(flag({ pain: 6, type: "sharp", location: "hip", note: "ouch" }), "Bird dog"), /Bird dog: 6\/10 · Sharp · Hip · ouch/);
});

test("REST_SEC is 15 and rest cues tick at 3-2-1 then go at 0", () => {
  assert.equal(REST_SEC, 15);
  assert.deepEqual(restCuesToPlay(15000, 14900), []);
  assert.deepEqual(restCuesToPlay(3100, 2900), ["tick"]);
  assert.deepEqual(restCuesToPlay(2100, 1900), ["tick"]);
  assert.deepEqual(restCuesToPlay(1100, 900), ["tick"]);
  assert.deepEqual(restCuesToPlay(200, 0), ["go"]);
  assert.deepEqual(restCuesToPlay(3500, 0), ["tick", "tick", "tick", "go"]);
  assert.deepEqual(restCuesToPlay(0, 0), []);
  assert.equal(needsRestAfter(0, 3), true);
  assert.equal(needsRestAfter(1, 3), true);
  assert.equal(needsRestAfter(2, 3), false);
  assert.equal(needsRestAfter(0, 1), false);
});

test("setPlan counts untimed sets and leaves timed holds alone", () => {
  assert.equal(setPlan({ sets: 3, hold_s: 10 }), null);
  assert.deepEqual(setPlan({ sets: 3, reps: 6 }), { sets: 3 });
  assert.deepEqual(setPlan({ pyr_top: 4, hold_s: 8 }), null); // pyramid holds are timed
  assert.deepEqual(setPlan({ sets: 4, reps: 8, load_lb: 25 }), { sets: 4 });
  assert.deepEqual(setPlan({ reps: 10 }), { sets: 1 });
  assert.equal(setPlan({ distance_m: 20 }), null);
  assert.equal(timedPlan({ sets: 3, reps: 6 }), null);
});

test("go and tick wavs are short distinct PCM cues", () => {
  for (const [name, minS, maxS] of [["tick.wav", 0.05, 0.3], ["go.wav", 0.35, 1.2]]) {
    const path = join(root, "public/sounds", name);
    assert.equal(existsSync(path), true, name);
    const buf = readFileSync(path);
    assert.equal(buf.toString("ascii", 0, 4), "RIFF");
    assert.equal(buf.toString("ascii", 8, 12), "WAVE");
    const rate = buf.readUInt32LE(24);
    const channels = buf.readUInt16LE(22);
    const bits = buf.readUInt16LE(34);
    assert.equal(channels, 1);
    assert.equal(bits, 16);
    const dataSize = buf.readUInt32LE(40);
    const seconds = dataSize / (rate * channels * (bits / 8));
    assert.ok(seconds >= minS && seconds <= maxS, `${name} duration ${seconds}`);
  }
  const ding = readFileSync(join(root, "public/sounds/ding.wav"));
  const go = readFileSync(join(root, "public/sounds/go.wav"));
  const tick = readFileSync(join(root, "public/sounds/tick.wav"));
  assert.notEqual(Buffer.compare(ding, go), 0);
  assert.notEqual(Buffer.compare(go, tick), 0);
});
