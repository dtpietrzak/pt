// Weekly export for agents (data-model.md section 6): JSON + markdown. Pure.
import { addDays, isoWeek, weekStart, dayDiff, clone } from "./util.js";
import { exportState, standingRatio, levelById } from "./engine.js";

const SESSION_MODS = new Set(["poor_sleep", "illness", "unusual_load", "missing_morning_checkin", "pause_mode", "easy_dose"]);
const SESSION_KEYS = ["id", "local_date", "started_at", "ended_at", "template", "level_id", "items", "gate_test_ids", "gate_results", "post_workout_checkin_id", "status", "tests", "final_color", "clean", "modifiers", "probation"];
const PROFILE_KEYS = ["name", "timezone", "body_weight_lb", "sports", "equipment", "baselines", "notify", "settings"];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

export function weekRange(anyDate) {
  const start = weekStart(anyDate);
  return { start, end: addDays(start, 6) };
}
export function exportStem(start) {
  const { year, week } = isoWeek(start);
  return `pt-export-${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * buildExport(input) -> { json, markdown, stem }
 * input: { start, end, now, appVersion, config, levels, hashes:{levels_sha256, exercises_sha256}, profile, sport,
 *          stateStart, stateEnd, checkins, evals, sessions, days, daily, decisionLog, patchLog, userNotes, agentBrief }
 */
export function buildExport(i) {
  const inWeek = (d) => d >= i.start && d <= i.end;
  const lastDay = i.end < i.today ? i.end : i.today;
  const checkins = i.checkins.filter((c) => inWeek(c.local_date)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const sessions = i.sessions.filter((s) => inWeek(s.local_date)).sort((a, b) => (a.local_date < b.local_date ? -1 : 1)).map((s) => {
    const d = pick(clone(s), SESSION_KEYS);
    if (d.modifiers) d.modifiers = d.modifiers.filter((m) => SESSION_MODS.has(m));
    if (d.status === "pending") d.status = "provisional";
    return d;
  });
  const days = [];
  for (let d = i.start; d <= lastDay; d = addDays(d, 1)) {
    const log = i.days[d] || {};
    const st = i.daily[d];
    const ev = checkins.filter((c) => c.type === "evening" && c.local_date === d).pop();
    const doc = { local_date: d, level_id: log.level_id || i.stateEnd.level_id, checklist: log.checklist || [] };
    const walk = Math.max(log.walk_min ?? 0, ev?.data?.walk_min ?? 0);
    if (walk) doc.walk_min = walk;
    if (log.decomp_breaks_done !== undefined || ev?.data?.standing?.decomp_breaks_done !== undefined) doc.decomp_breaks_done = log.decomp_breaks_done ?? ev.data.standing.decomp_breaks_done;
    if (log.standing_breaks_done !== undefined || ev?.data?.standing?.breaks_taken !== undefined) doc.standing_breaks_done = log.standing_breaks_done ?? ev.data.standing.breaks_taken;
    if (st?.color) { doc.daily_status = st.color; doc.daily_status_reasons = st.reasons; }
    days.push(doc);
  }
  const log = i.decisionLog.filter((e) => inWeek(e.ts.slice(0, 10))).map((e) => pick(e, ["id", "ts", "rule_id", "outcome", "color", "session_id", "checkin_ids", "changes", "message"]));
  const counts = { green: 0, yellow: 0, orange: 0, red: 0 };
  for (const d of days) if (d.daily_status) counts[d.daily_status]++;
  const level = levelById(i.levels, i.stateEnd.level_id);
  const perWeek = level?.frequency?.strength_sessions_per_week ?? 0;
  const nDays = dayDiff(lastDay, i.start) + 1;
  const planned = Math.round((perWeek * nDays) / 7);
  const strengthDone = sessions.filter((s) => s.template === "strength_A" || s.template === "strength_B").length;
  const coreItems = (level?.items || []).filter((x) => x.block === "daily_core" && !x.optional).map((x) => x.item_key);
  const coreDays = days.filter((d) => coreItems.length && coreItems.every((k) => d.checklist.some((c) => c.item_key === k && c.done))).length;
  const coreTarget = parseInt(String(level?.frequency?.core_days_per_week || "5"), 10) || 5;
  const corePlanned = Math.round((coreTarget * nDays) / 7);
  const mornings = checkins.filter((c) => c.type === "morning"), evenings = checkins.filter((c) => c.type === "evening");
  const evals = i.evals;
  const incidents = checkins.filter((c) => evals[c.id]?.incident).length;
  const reds = checkins.filter((c) => evals[c.id]?.color === "red").length;
  const adherenceParts = [planned ? strengthDone / planned : null, corePlanned ? coreDays / corePlanned : null].filter((x) => x !== null);
  const adherence = adherenceParts.length ? Math.round((100 * adherenceParts.reduce((a, b) => a + b, 0)) / adherenceParts.length) : 100;
  const gateRows = sessions.filter((s) => s.template === "gate_test").flatMap((s) => (s.gate_results || []).map((g) => ({ date: s.local_date, ...g, status: i.stateEnd.gate_tests?.[g.test_id]?.status || null })));
  const summary = {
    level_start: i.stateStart.level_id, level_end: i.stateEnd.level_id,
    strength_sessions_planned: planned, strength_sessions_completed: strengthDone,
    core_days_done: coreDays,
    walk_minutes_total: days.reduce((a, d) => a + (d.walk_min || 0), 0),
    daily_status_counts: counts,
    clean_sessions: sessions.filter((s) => s.clean).length,
    advances: log.filter((e) => e.outcome === "advance").length,
    holds: log.filter((e) => e.outcome === "hold").length,
    regress_steps: log.filter((e) => e.outcome === "regress_step").length,
    regress_levels: log.filter((e) => e.outcome === "regress_level").length,
    sharp_incidents: incidents, red_flag_events: reds,
    trend: {
      morning_stiffness_min: mornings.filter((c) => typeof c.data.stiffness_min === "number").map((c) => c.data.stiffness_min),
      morning_pain: mornings.map((c) => c.data.pain_on_waking),
      evening_pain_peak: evenings.map((c) => c.data.pain_peak_today),
      first_pressure_h: evenings.map((c) => c.data.standing?.first_pressure_h ?? null),
      first_sitting_pressure_min: evenings.map((c) => c.data.sitting?.first_pressure_min ?? null),
      stand_block_min: evenings.map((c) => c.data.posture_cycle?.stand_prescribed_min).filter((v) => typeof v === "number"),
      sit_block_min: evenings.map((c) => c.data.posture_cycle?.sit_prescribed_min).filter((v) => typeof v === "number"),
      sleep_hours: mornings.filter((c) => typeof c.data.sleep_hours === "number").map((c) => c.data.sleep_hours),
    },
    gate_tests: gateRows,
    adherence_pct: adherence,
  };
  const attention = buildAttention({ ...i, checkins, sessions, log, summary, days, planned, strengthDone, corePlanned, coreDays, mornings, evenings });
  const stem = exportStem(i.start);
  const profile = pick(clone(i.profile), PROFILE_KEYS);
  const notes = [i.sport ? `Sport: ${i.sport}.` : "", i.userNotes || ""].filter(Boolean).join("\n");
  const json = {
    schema_version: "1.0", kind: "pt-weekly-export",
    meta: {
      export_id: `${stem.replace("pt-export-", "")}-${i.now.slice(0, 19).replace(/[-:T]/g, "")}`,
      week_start: i.start, week_end: i.end, generated_at: i.now, timezone: "America/Chicago",
      app_version: i.appVersion, plan_version: i.levels.plan_version ?? 1,
      levels_sha256: i.hashes.levels_sha256, exercises_sha256: i.hashes.exercises_sha256, config_version: i.config.config_version,
      ...(i.hashes.tests_sha256 ? { tests_sha256: i.hashes.tests_sha256 } : {}),
      ...(i.hashes.profile_sha256 ? { profile_sha256: i.hashes.profile_sha256 } : {}),
      ...(i.hashes.posture_cycle_sha256 ? { posture_cycle_sha256: i.hashes.posture_cycle_sha256 } : {}),
    },
    profile,
    state_start: exportState(i.stateStart), state_end: exportState(i.stateEnd),
    summary, days, sessions, checkins: clone(checkins), decision_log: log, attention,
    user_notes: notes, markdown_summary_file: `${stem}.md`,
    agent_brief: i.agentBrief,
  };
  return { json, markdown: renderMarkdown(json, i), stem };
}

function buildAttention(x) {
  const a = [];
  const add = (severity, code, message, refs) => a.push({ severity, code, message, ...(refs?.length ? { refs } : {}) });
  if (x.summary.red_flag_events) add("action", "RED_FLAG_EVENT", `${x.summary.red_flag_events} red result(s) this week. David should see a clinician.`, x.checkins.filter((c) => x.evals[c.id]?.color === "red").map((c) => c.id));
  if (x.stateEnd.clinician_recommended) add("action", "CLINICIAN_RECOMMENDED", "The engine recommends checking with the physician.");
  if (x.summary.regress_levels) add("action", "LEVEL_REGRESSED", `Level regression this week (${x.summary.level_start} → ${x.summary.level_end}).`);
  const oranges = x.log.filter((e) => e.color === "orange" && (e.rule_id === "R2" || e.rule_id === "R3"));
  if (oranges.length) add("watch", "ORANGE_EVENT", `Orange events: ${oranges.map((e) => `${e.ts.slice(0, 10)}${e.changes?.length ? ` (${e.changes.map((c) => c.item_key).join(", ")})` : ""}`).join("; ")}.`, oranges.map((e) => e.id));
  if (x.stateEnd.lock?.easy_dose) add("watch", "EASY_DOSE_LOCK", "Easy-dose lock is active (3 clean sessions needed to advance).");
  if (x.stateEnd.gate_pending) add("info", "GATE_PENDING", `${x.stateEnd.level_id} criteria met except gate tests.`);
  const failed = Object.entries(x.stateEnd.gate_tests || {}).filter(([, g]) => g.status === "fail").map(([k]) => k);
  if (failed.length) add("watch", "TEST_FAILED", `Failed or unconfirmed gate tests: ${failed.join(", ")}.`);
  const stalled = stalledItems(x);
  if (stalled.length) add("info", "STALLED_ITEM", `Same rung through 6+ exposures: ${stalled.join(", ")}.`);
  const st = x.summary.trend.morning_stiffness_min;
  if (risingRun(st, 3)) add("watch", "STIFFNESS_TRENDING_UP", `Morning stiffness rising over 3+ mornings: ${st.join(", ")} min.`);
  const fp = x.summary.trend.first_pressure_h.filter((v) => v !== null);
  if (risingRun(fp.map((v) => -v), 3)) add("watch", "STANDING_TRENDING_DOWN", `First-pressure hours falling over 3+ evenings: ${fp.join(", ")} h.`);
  if (x.summary.sharp_incidents >= 2) add("watch", "SHARP_INCIDENTS", `${x.summary.sharp_incidents} accidental sharp incidents this week.`);
  const poorSleep = x.mornings.filter((c) => x.evals[c.id]?.modifiers.includes("poor_sleep")).length;
  if (poorSleep >= 3) add("info", "POOR_SLEEP_PATTERN", `${poorSleep} nights with sleep blocking advancement.`);
  if ((x.planned && x.strengthDone / x.planned < 0.7) || (x.corePlanned && x.coreDays / x.corePlanned < 0.7)) add("info", "LOW_ADHERENCE", `Strength ${x.strengthDone}/${x.planned}, core days ${x.coreDays}/${x.corePlanned}.`);
  const missingMornings = x.days.filter((d) => !x.mornings.some((c) => c.local_date === d.local_date)).length;
  if (missingMornings >= 2) add("info", "MISSING_CHECKINS", `${missingMornings} days without a morning check-in.`);
  const applied = (x.patchLog || []).filter((p) => p.status === "applied" && p.applied_at && p.applied_at.slice(0, 10) >= x.start && p.applied_at.slice(0, 10) <= x.end);
  if (applied.length) add("info", "PLAN_PATCH_APPLIED", `Patches applied: ${applied.map((p) => p.patch_id).join(", ")}.`, applied.map((p) => p.patch_id));
  return a;
}
function risingRun(xs, n) {
  let run = 1;
  for (let k = 1; k < xs.length; k++) { run = xs[k] > xs[k - 1] ? run + 1 : 1; if (run >= n) return true; }
  return false;
}
function stalledItems(x) {
  // Count exposures (sessions in which the item was done) since the item's rung last changed.
  const out = [];
  const st = x.stateEnd.item_state || {};
  for (const [k, v] of Object.entries(st)) {
    const lvl = levelById(x.levels, x.stateEnd.level_id);
    const it = lvl?.items.find((i) => i.item_key === k);
    if (!it || v.rung >= it.target_rung) continue;
    const done = x.allSessions.filter((s) => s.items.some((i) => i.item_key === k && i.prescribed_rung === v.rung && i.completed !== false)).length;
    if (done >= 6) out.push(k);
  }
  return out;
}

const cell = (s) => String(s ?? "-").replace(/\|/g, "/").replace(/\n/g, " ");
export function renderMarkdown(x, i) {
  const s = x.summary, e = x.state_end;
  const L = [];
  L.push(`# PT weekly summary: ${x.meta.week_start} to ${x.meta.week_end}`, "");
  L.push("> Self-management log, not medical advice. Generated by pt.davidp.dev.", "");
  L.push("## Status snapshot", "");
  L.push(`- Level: **${s.level_start}** at start, **${s.level_end}** at end · mode: ${e.mode} · plan v${x.meta.plan_version}`);
  L.push(`- Daily statuses: green ${s.daily_status_counts.green}, yellow ${s.daily_status_counts.yellow}, orange ${s.daily_status_counts.orange}, red ${s.daily_status_counts.red}`);
  L.push(`- Strength sessions: ${s.strength_sessions_completed} of ${s.strength_sessions_planned} · clean: ${s.clean_sessions} · core days: ${s.core_days_done} · walking: ${s.walk_minutes_total} min · adherence ${s.adherence_pct}%`);
  L.push(`- Trend (morning stiffness min): [${s.trend.morning_stiffness_min.join(", ")}] · (evening pain peak): [${s.trend.evening_pain_peak.join(", ")}] · (first pressure h): [${s.trend.first_pressure_h.map((v) => (v === null ? "censored" : v)).join(", ")}]`);
  if ((s.trend.first_sitting_pressure_min || []).some((v) => v != null) || (s.trend.stand_block_min || []).some((v) => v != null))
    L.push(`- Trend (sitting first pressure min): [${(s.trend.first_sitting_pressure_min || []).map((v) => (v === null ? "censored" : v)).join(", ")}] · (stand block min): [${(s.trend.stand_block_min || []).map((v) => v ?? "-").join(", ")}] · (sit block min): [${(s.trend.sit_block_min || []).map((v) => v ?? "-").join(", ")}]`);
  L.push(`- Baselines: stiffness ${e.baselines.stiffness_min} min, standing ${e.baselines.standing_h} h, sitting ${e.baselines.sitting_min ?? "-"} min, rest pain ${e.baselines.pain_rest ?? "-"}`);
  L.push(`- Lock: ${e.lock.easy_dose ? "easy-dose lock ON" : "off"} · clean streak ${e.level_clean_streak} · gate pending: ${e.gate_pending ? "yes" : "no"}${e.clinician_recommended ? " · **clinician recommended**" : ""}`);
  if (i.sport) L.push(`- Sport goal: ${i.sport}`);
  L.push("", "## Decisions this week", "");
  if (x.decision_log.length) {
    L.push("| When | Rule | Outcome | Color | What happened |", "| --- | --- | --- | --- | --- |");
    for (const d of x.decision_log) L.push(`| ${d.ts.slice(0, 10)} | ${d.rule_id} | ${d.outcome} | ${d.color || "-"} | ${cell(d.message)} |`);
  } else L.push("No engine decisions this week.");
  L.push("", "## Sessions", "");
  if (x.sessions.length) {
    L.push("| Date | Template | Exercise | Recovery | Functional | Final | Clean |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const ss of x.sessions) L.push(`| ${ss.local_date} | ${ss.template} | ${ss.tests?.exercise || "-"} | ${ss.tests?.recovery || "-"} | ${ss.tests?.functional || "-"} | ${ss.final_color || ss.status} | ${ss.clean ? "yes" : "no"} |`);
  } else L.push("No sessions this week.");
  L.push("", "## Day by day", "", "| Date | Status | Walk min | Checklist done | Why |", "| --- | --- | --- | --- | --- |");
  for (const d of x.days) {
    const done = d.checklist.filter((c) => c.done).length;
    L.push(`| ${d.local_date} | ${d.daily_status || "no check-ins"} | ${d.walk_min ?? 0} | ${done}/${d.checklist.length} | ${cell((d.daily_status_reasons || []).join("; ") || "-")} |`);
  }
  L.push("", "## Gate tests", "");
  if (s.gate_tests.length) for (const g of s.gate_tests) L.push(`- ${g.date} ${g.test_id}: ${g.value} (${g.passed ? "provisional pass" : "not passed"}; now ${g.status || "-"})`);
  else L.push("None run this week.");
  L.push("", "## Attention", "");
  if (x.attention.length) for (const a of x.attention) L.push(`- **${a.severity.toUpperCase()} ${a.code}**: ${a.message}`);
  else L.push("- Nothing needs attention.");
  L.push("", "## David's notes and oddities", "");
  const odd = x.checkins.filter((c) => c.oddities || c.oddity_tags?.length);
  if (x.user_notes) L.push(`- Weekly note: ${x.user_notes.replace(/\n/g, " ")}`);
  for (const c of odd) L.push(`- ${c.local_date} ${c.type}: ${c.oddities || ""}${c.oddity_tags?.length ? ` [${c.oddity_tags.join(", ")}]` : ""}`);
  if (!x.user_notes && !odd.length) L.push("- None.");
  L.push("", "## Questions for the agent", "");
  L.push("1. Did any exercise stall or progress too easily? Propose ladder changes with evidence.");
  L.push("2. Should any item be swapped for a regression or alternative given the oddities above?");
  L.push("3. Any app changes that would make check-ins easier or more informative?");
  L.push("", "## What the agent may and may not do", "");
  L.push("- May propose a structured patch against `levels.json`, `exercises.json`, `tests.json` and app change requests.");
  L.push("- May not touch safety thresholds, red-flag texts, the morning window, decision state, or add loaded flexion; red flags mean see a clinician.");
  L.push(`- Reply with ONE JSON document (kind \`pt-plan-patch\`) based on meta: plan_version ${x.meta.plan_version}, levels_sha256 \`${x.meta.levels_sha256}\`, exercises_sha256 \`${x.meta.exercises_sha256}\`.`);
  L.push("");
  return L.join("\n");
}

/** Pull a pt-plan-patch JSON document out of pasted text (plain JSON, or JSON plus trailing markdown, or a fenced block). */
export function extractPatch(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "Nothing to read." };
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  const candidates = [...fences];
  const brace = raw.indexOf("{");
  if (brace >= 0) candidates.push(raw.slice(brace));
  candidates.push(raw);
  let lastErr = "";
  for (const c of candidates) {
    const obj = parseJsonLoose(c);
    if (!obj) {
      try { JSON.parse(c); } catch (e) { lastErr = e.message; }
      continue;
    }
    if (obj.kind === "pt-plan-patch" || (obj.schema_version && obj.documents && obj.base)) return { ok: true, patch: obj };
    lastErr = "That JSON is not a plan patch (kind should be pt-plan-patch).";
  }
  return { ok: false, error: lastErr ? `Not valid JSON: ${lastErr}` : "Couldn't find a plan-patch JSON document." };
}
function parseJsonLoose(s) {
  try { return JSON.parse(s); } catch { /* fall through and take the first balanced object */ }
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { start = -1; }
      }
    }
  }
  return null;
}

/**
 * The week that just finished is due starting Sunday at the evening reminder time, and stays due
 * until it is marked exported. Mid-week, the previous complete week can still be due.
 * hasWeekData(start) is optional; if provided and returns false, we don't nag about an empty week.
 */
export function dueExportWeek({ today, timeHM = "00:00", evening = "15:30", exported, hasWeekData } = {}) {
  const current = weekStart(today);
  const finished = today === addDays(current, 6) && timeHM >= evening ? current : addDays(current, -7);
  const end = addDays(finished, 6);
  if (exported === finished) return { due: false, start: finished, end };
  if (hasWeekData && !hasWeekData(finished)) return { due: false, start: finished, end };
  return { due: true, start: finished, end };
}
