// Reproduces every case in seed/test-vectors.json (copied to test/fixtures by scripts/sync-seed.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateCheckIn, combineSessionTests, initState, applySessionFinal, summarize } from "../public/js/engine.js";

const j = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const vectors = j("./fixtures/test-vectors.json").vectors;
const config = j("../public/data/decision-config.json");
const levels = j("../public/data/levels.json");

test("fixture has vectors", () => assert.ok(vectors.length >= 51, `${vectors.length} vectors`));

for (const v of vectors) {
  test(`${v.id} ${v.kind}: ${v.description}`, () => {
    if (v.kind === "checkin_color") {
      const got = evaluateCheckIn(v.input.checkin, v.input.baselines, config, v.input.context || {});
      assert.equal(got.color, v.expect.color, JSON.stringify(got.reasons));
      if ("red_kind" in v.expect) assert.equal(got.red_kind, v.expect.red_kind);
      for (const m of v.expect.modifiers || []) assert.ok(got.modifiers.includes(m), `modifier ${m}`);
    } else if (v.kind === "session_color") {
      const got = combineSessionTests(v.input, [], config);
      assert.equal(got.final_color, v.expect.final_color);
      assert.equal(got.clean, v.expect.clean);
    } else if (v.kind === "engine_sequence") {
      let s = initState(levels, v.initial.level);
      const cap = v.initial.config?.max_item_changes_per_finalized_session ?? 3;
      const outcomes = [];
      for (const ev of v.events) {
        const r = applySessionFinal(s, levels, ev, { config, cap });
        s = r.state; outcomes.push(r.out);
      }
      assert.deepEqual(summarize(s), v.expect);
      (v.per_event_outcomes || []).forEach((exp, i) => {
        for (const [k, val] of Object.entries(exp)) {
          if (k === "outcome") assert.equal(outcomes[i].outcome, val, `event ${i} outcome`);
          else assert.deepEqual([...outcomes[i][k]].sort(), [...val].sort(), `event ${i} ${k}`);
        }
      });
    } else assert.fail(`unknown vector kind ${v.kind}`);
  });
}
