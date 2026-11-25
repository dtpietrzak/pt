// Check-in UI: the Today card, the four quick forms, the workout log, the red banner, History, due badges and reminders.
// Data goes through ctx.store (the synced store), so everything here syncs like the rest of the app.
import { evaluateAll, dailyMap } from "../engine.js";
import { isoLocal, localDate, localTime, ulid } from "../util.js";
import { checklist, dueNow, buildCheckIn, formFromCheckIn, summaryLine, redGuidance, tidyReasons, RED_FLAGS, TYPES, LABEL, noFlags } from "../checkins.js";
import { evaluate, engineConfig, templateItems, nextStrengthTemplate, buildSession, clearRed } from "../pipeline.js";
import { postureCheckinData, postureLogKey } from "../posture.js";
import { formatDose, missingEquipment } from "../dose.js";
import { askNotifications } from "../timer-ui.js";
import { $, esc, openSheet, closeSheet, toast, fmtDate, confirmSheet } from "./dom.js";

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const TITLES = { morning: "Morning check-in", post_workout: "Post-workout check-in", evening: "Evening check-in", night: "Night check-in" };
const SUBTITLES = {
  morning: "Within about an hour of getting up. Takes a minute.",
  post_workout: "About how the workout felt. Fill it in right after, and you can add the 15-minute pain later.",
  evening: "How today went: standing, sitting and pain.",
  night: "Last one of the day, right before bed.",
};

// ---------------------------------------------------------------- data for the views
export async function loadView(ctx, now = new Date()) {
  const [checkins, sessions, logs] = await Promise.all([ctx.store.all("checkins"), ctx.store.all("sessions"), ctx.store.all("log")]);
  const date = localDate(now);
  const wake = await ctx.store.kvGet(`wake:${date}`);
  const cfg = engineConfig(ctx.docs, ctx.profile);
  const evals = evaluateAll(checkins, ctx.state.baselines, cfg);
  const daily = dailyMap(checkins, evals);
  const list = checklist({ now, profile: ctx.profile, checkins, sessions, wake });
  return { now, date, wake, checkins, sessions, logs, evals, daily, list, cfg };
}

/** Run the engine over everything and re-render when it changed something. */
export async function refreshEngine(ctx) {
  const r = await evaluate(ctx.store, ctx.docs, ctx.profile);
  ctx.state = r.state;
  return r;
}

const isLocked = (ctx, c) => {
  const x = ctx.state.x || {};
  return (x.processed_days || []).includes(c.local_date) || (c.session_id && (x.processed_sessions || []).includes(c.session_id));
};

// ---------------------------------------------------------------- small form controls
const pv = (v) => (v === undefined || v === null ? "" : esc(v));
function qSlider(name, label, val, { min = 0, max = 10, hint = "", pain = true } = {}) {
  return `<label class="ci-q"><span class="ci-label">${esc(label)}<b class="ci-val" data-val-for="${name}"${pain ? " data-pain" : ""}>${pv(val)}</b></span>
    ${hint ? `<small class="ci-hint">${esc(hint)}</small>` : ""}
    <input type="range" name="${name}" min="${min}" max="${max}" step="1" value="${pv(val)}" /></label>`;
}
function qStep(name, label, val, { step = 1, min = 0, unit = "", hint = "" } = {}) {
  return `<div class="ci-q"><span class="ci-label">${esc(label)}${unit ? ` <small>(${esc(unit)})</small>` : ""}</span>
    ${hint ? `<small class="ci-hint">${esc(hint)}</small>` : ""}
    <div class="ci-step"><button type="button" class="btn icon" data-ci-step="-${step}" data-for="${name}" aria-label="less">−</button>
    <input type="number" inputmode="decimal" name="${name}" step="any" min="${min}" value="${pv(val)}" />
    <button type="button" class="btn icon" data-ci-step="${step}" data-for="${name}" aria-label="more">+</button></div></div>`;
}
function qChips(name, label, options, val, { hint = "", show = "" } = {}) {
  return `<div class="ci-q"${show ? ` data-show="${show}"` : ""}><span class="ci-label">${esc(label)}</span>${hint ? `<small class="ci-hint">${esc(hint)}</small>` : ""}
    <div class="chips">${options.map(([v, l]) => `<label class="chip-opt"><input type="radio" name="${name}" value="${esc(v)}"${String(v) === String(val) ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div></div>`;
}
function qToggle(name, label, on, { hint = "", show = "" } = {}) {
  return `<label class="toggle ci-toggle"${show ? ` data-show="${show}"` : ""}><input type="checkbox" name="${name}"${on ? " checked" : ""} /><span>${esc(label)}${hint ? `<small class="ci-hint">${esc(hint)}</small>` : ""}</span></label>`;
}
const when = (cond, html) => `<div class="ci-sub" data-show="${cond}">${html}</div>`;
const more = (summary, html, open = false) => `<details class="ci-more"${open ? " open" : ""}><summary>${esc(summary)}</summary>${html}</details>`;

function symptomsHtml(f) {
  const hasAny = (f.leg && f.leg !== "none") || f.numb || f.sharp;
  return more("Leg symptoms, numbness or sharp pain?", `
    ${qChips("leg", "Symptoms in a leg?", [["none", "None"], ["buttock", "Buttock"], ["thigh", "Thigh"], ["below_knee", "Below knee"], ["foot", "Foot"]], f.leg || "none")}
    ${qChips("leg_trend", "Compared with before", [["centralizing", "Moving toward the back"], ["same", "Same"], ["peripheralizing", "Moving further down"]], f.leg_trend, { show: "leg!=none" })}
    ${qToggle("numb", "Numbness or tingling", f.numb)}
    ${qToggle("sharp", "Sharp or electrical pain", f.sharp)}
    ${when("sharp", `${qChips("sharp_context", "When did it happen?", [["exercise", "During exercise"], ["accidental_bend_twist", "An awkward bend or twist"], ["ordinary_movement", "Ordinary movement"], ["at_rest", "At rest"]], f.sharp_context || "accidental_bend_twist")}
      ${qStep("sharp_settle_min", "Minutes until it settled", f.sharp_settle_min, { step: 5, unit: "min", hint: "Leave blank if it hasn't settled." })}`)}`, hasAny);
}
function redFlagsHtml(f) {
  return `${qToggle("scary", "Anything new or scary?", f.scary, { hint: "Tap yes for anything below." })}
    ${when("scary", `<p class="ci-hint">Tap everything that's true right now.</p>${RED_FLAGS.map(([k, l]) => qToggle(`flag_${k}`, l, f.flags?.[k])).join("")}`)}`;
}
function oddHtml(f) {
  const tags = new Set(f.tags || []);
  return more("Anything odd today?", `
    <div class="chips">${[["illness", "Sick or run down"], ["unusual_load", "Unusually heavy day"]].map(([v, l]) => `<label class="chip-opt"><input type="checkbox" name="tag" value="${v}"${tags.has(v) ? " checked" : ""} /><span>${l}</span></label>`).join("")}</div>
    <label class="ci-q"><span class="ci-label">Note</span><textarea name="oddities" rows="2" placeholder="Anything worth remembering">${esc(f.oddities || "")}</textarea></label>`, !!(f.oddities || tags.size));
}

// ---------------------------------------------------------------- the four forms
async function todayExtras(ctx, date) {
  const [log, day] = await Promise.all([ctx.store.kvGet(postureLogKey(date)), ctx.store.get("days", date)]);
  const blocks = log?.blocks || [], early = log?.early_switches || [];
  const doses = ctx.state.posture_cycle;
  const posture = blocks.length && doses ? postureCheckinData(blocks, early, doses) : null;
  const upMin = blocks.filter((b) => b.phase === "stand" || b.phase === "walk").reduce((a, b) => a + (b.actual_min || 0), 0);
  const sitMin = blocks.filter((b) => b.phase === "sit").reduce((a, b) => a + (b.actual_min || 0), 0);
  return { posture, day, upH: Math.round((upMin / 60) * 2) / 2, sitMin: Math.round(sitMin) };
}

function formHtml(ctx, type, f, x = {}) {
  const B = ctx.state.baselines;
  let body = "";
  if (type === "morning") {
    body = `${qSlider("pain", "Back pain right now", f.pain, { hint: "0 is none, 10 is the worst." })}
      ${qStep("stiffness_min", "Morning stiffness", f.stiffness_min, { step: 5, unit: "min", hint: `How long until you loosened up. Your usual is about ${B.stiffness_min} min.` })}
      ${qToggle("stiffness_still", "Still stiff right now", f.stiffness_still, { hint: "Then enter how long it's been so far." })}
      ${qStep("sleep_hours", "Sleep last night", f.sleep_hours, { step: 0.5, unit: "hours" })}
      ${qChips("sleep_quality", "Sleep quality", [[1, "1 Awful"], [2, "2"], [3, "3"], [4, "4"], [5, "5 Great"]], f.sleep_quality)}
      ${qStep("woke", "Times pain woke you", f.woke, { step: 1 })}
      ${qToggle("hip_shift", "Hips feel shifted to one side", f.hip_shift)}
      ${qToggle("window_ok", "Kept the easy morning (no bending, lifting or stretching early)", f.window_ok)}
      ${symptomsHtml(f)}${redFlagsHtml(f)}${oddHtml(f)}`;
  } else if (type === "post_workout") {
    const rows = (f.items || []).map((i) => {
      const ex = ctx.exById[ctx.docs.levels.levels.flatMap((l) => l.items).find((it) => it.item_key === i.item_key)?.exercise_id] || {};
      const k = esc(i.item_key);
      return `<div class="ci-item"><div class="ci-item-top"><label class="toggle"><input type="checkbox" name="done_${k}"${i.completed !== false ? " checked" : ""} /><span>${esc(ex.name || i.item_key)}</span></label>
        <label class="chip-opt small"><input type="checkbox" name="prob_${k}"${i.problem ? " checked" : ""} /><span>Problem</span></label></div>
        ${when(`prob_${k}`, `${qSlider(`pp_${k}`, "Pain on this exercise", i.pain_peak ?? 0)}${qToggle(`sharp_${k}`, "Sharp or electrical", i.sharp)}${qToggle(`form_${k}`, "Form fell apart", i.form)}`)}</div>`;
    }).join("");
    body = `${qSlider("pain", "Worst back pain during the workout", f.pain)}
      ${qSlider("rpe", "How hard was it overall?", f.rpe, { min: 1, max: 10, pain: false, hint: "1 is very easy, 10 is all out." })}
      ${qChips("settle", "How long did any soreness take to settle?", [["lt_30", "Under 30 min"], ["30_120", "30 to 120 min"], ["gt_120", "Over 2 hours"], ["not_yet", "Still settling"]], f.settle)}
      ${qToggle("form_breakdown", "My form broke down at some point", f.form_breakdown)}
      ${qToggle("has15", "It's been 15+ minutes since I finished", f.pain15 !== undefined && f.pain15 !== null)}
      ${when("has15", qSlider("pain15", "Back pain now, 15 minutes after", f.pain15 ?? 0))}
      <div class="ci-items"><span class="ci-label">What you did</span>${rows || '<p class="ci-hint">No exercises were logged.</p>'}</div>
      ${symptomsHtml(f)}${redFlagsHtml(f)}${oddHtml(f)}`;
  } else if (type === "evening") {
    body = `${qSlider("pain", "Worst back pain today", f.pain)}
      ${qStep("upright_h", "Total time on your feet", f.upright_h, { step: 0.5, unit: "hours", hint: "Standing and walking, all day." })}
      ${qChips("std", "Standing: did pressure build in your back?", [["none", "No, it stayed comfortable"], ["yes", "Yes, it built up"]], f.no_pressure ? "none" : "yes")}
      ${when("std=yes", qStep("first_pressure_h", "Hours on your feet when it reached 3/10", f.first_pressure_h, { step: 0.25, unit: "hours", hint: `Your usual is about ${B.standing_h} h.` }))}
      ${qStep("breaks", "Standing breaks taken", f.breaks, { step: 1 })}
      ${qStep("decomp", "Decompression breaks done", f.decomp, { step: 1 })}
      ${qStep("walk_min", "Walking today", f.walk_min, { step: 5, unit: "min" })}
      ${qStep("forced_rest", "Times you had to stop and rest", f.forced_rest, { step: 1 })}
      ${qToggle("limited", "My back limited what I wanted to do", f.limited)}
      ${qToggle("hip_shift", "Hips feel shifted to one side", f.hip_shift)}
      ${qToggle("sit_on", "Add sitting", f.sit_on, { hint: "For days you sat for work." })}
      ${when("sit_on", `${qChips("sit_std", "Sitting: did pressure build?", [["none", "No, it stayed comfortable"], ["yes", "Yes, it built up"]], f.sit_no_pressure ? "none" : "yes")}
        ${when("sit_std=yes", qStep("sit_first_min", "Minutes seated when it reached 3/10", f.sit_first_min, { step: 5, unit: "min", hint: `Your usual is about ${B.sitting_min ?? 20} min.` }))}
        ${qStep("sit_total_min", "Total time seated", f.sit_total_min, { step: 15, unit: "min" })}
        ${qToggle("sit_flared", "Sitting flared my symptoms", f.sit_flared)}`)}
      ${symptomsHtml(f)}${redFlagsHtml(f)}${oddHtml(f)}`;
  } else {
    body = `${qSlider("pain", "Back pain right now", f.pain)}
      ${qToggle("ready", "I feel ready for tomorrow", f.ready)}
      ${symptomsHtml(f)}${redFlagsHtml(f)}${oddHtml(f)}`;
  }
  return `<h2>${esc(TITLES[type])}</h2><p class="muted small">${esc(SUBTITLES[type])}</p>
    <form id="ci-form" class="ci-form" novalidate>${body}
      <div class="sheet-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`;
}

/** Form values for a brand-new check-in (sensible, baseline-ish starting points). */
async function defaultsFor(ctx, type, v, entry) {
  const B = ctx.state.baselines;
  const f = { leg: "none", flags: noFlags(), tags: [], pain: B.pain_rest ?? 1 };
  if (type === "morning") Object.assign(f, { stiffness_min: B.stiffness_min, sleep_hours: 7, sleep_quality: 3, woke: 0, window_ok: true });
  if (type === "post_workout") {
    const s = v.sessions.find((x) => x.id === entry.session_id);
    const minsAgo = s?.ended_at ? (v.now - new Date(s.ended_at)) / 60000 : 999;
    const keyed = ctx.docs.levels.levels.flatMap((l) => l.items);
    Object.assign(f, { pain: 0, rpe: 5, settle: minsAgo < 60 ? "not_yet" : "lt_30", items: (s?.items || []).map((i) => ({ item_key: i.item_key, completed: !!i.completed, rung_done: i.prescribed_rung, problem: false })).filter((i) => keyed.some((k) => k.item_key === i.item_key)) });
  }
  if (type === "evening") {
    const x = await todayExtras(ctx, entry.date);
    Object.assign(f, { no_pressure: true, upright_h: x.upH || 6, breaks: x.day?.standing_breaks_done ?? 0, decomp: x.day?.decomp_breaks_done ?? 0, walk_min: x.day?.walk_min ?? 0, forced_rest: 0, sit_on: !!x.posture?.actual_blocks?.some((b) => b.phase === "sit"), sit_no_pressure: true, sit_total_min: x.sitMin || undefined });
  }
  if (type === "night") Object.assign(f, { ready: true });
  return f;
}

export async function openForm(ctx, type, { existing = null, entry = {}, v = null, after = null } = {}) {
  v = v || await loadView(ctx);
  const f = existing ? formFromCheckIn(existing) : await defaultsFor(ctx, type, v, { date: v.date, ...entry });
  if (existing?.type === "post_workout") f.items = f.items || [];
  const root = openSheet(formHtml(ctx, type, f));
  const form = $("#ci-form", root);
  wireForm(ctx, form);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = $("button[type=submit]", form); btn.disabled = true;
    try { await save(ctx, type, form, { existing, session_id: entry.session_id ?? existing?.session_id ?? null, date: entry.date || v.date }); after?.(); }
    catch (e) { console.error(e); toast(`Couldn't save: ${e.message}`); btn.disabled = false; }
  };
}

function readForm(form, type) {
  const fd = new FormData(form), g = (n) => fd.get(n), b = (n) => fd.has(n);
  const n = (k) => (fd.get(k) === null || fd.get(k) === "" ? undefined : Number(fd.get(k)));
  const f = { pain: n("pain"), leg: g("leg") || "none", leg_trend: g("leg_trend") || undefined, numb: b("numb"), sharp: b("sharp"), sharp_context: g("sharp_context") || undefined,
    sharp_settle_min: n("sharp_settle_min"), scary: b("scary"), flags: Object.fromEntries(RED_FLAGS.map(([k]) => [k, b(`flag_${k}`)])), oddities: g("oddities") || "", tags: fd.getAll("tag") };
  if (type === "morning") Object.assign(f, { stiffness_min: n("stiffness_min"), stiffness_still: b("stiffness_still"), sleep_hours: n("sleep_hours"), sleep_quality: n("sleep_quality"), woke: n("woke"), hip_shift: b("hip_shift"), window_ok: b("window_ok") });
  if (type === "post_workout") {
    Object.assign(f, { rpe: n("rpe"), settle: g("settle") || undefined, form_breakdown: b("form_breakdown"), pain15: b("has15") ? n("pain15") : undefined });
    f.items = [...form.querySelectorAll("[name^=done_]")].map((el) => {
      const k = el.name.slice(5);
      return { item_key: k, completed: el.checked, rung_done: 0, problem: b(`prob_${k}`), pain_peak: n(`pp_${k}`), sharp: b(`sharp_${k}`), form: b(`form_${k}`) };
    });
  }
  if (type === "evening") Object.assign(f, { upright_h: n("upright_h"), no_pressure: g("std") !== "yes", first_pressure_h: n("first_pressure_h"), breaks: n("breaks"), decomp: n("decomp"), walk_min: n("walk_min"), forced_rest: n("forced_rest"), limited: b("limited"), hip_shift: b("hip_shift"),
    sit_on: b("sit_on"), sit_no_pressure: g("sit_std") !== "yes", sit_first_min: n("sit_first_min"), sit_total_min: n("sit_total_min"), sit_flared: b("sit_flared") });
  if (type === "night") Object.assign(f, { ready: b("ready") });
  return f;
}

async function save(ctx, type, form, { existing, session_id, date }) {
  const f = readForm(form, type);
  // Keep an existing item's rung when editing a post-workout check-in.
  if (type === "post_workout" && existing) for (const i of f.items) i.rung_done = existing.data.completed_items?.find((x) => x.item_key === i.item_key)?.rung_done ?? 0;
  if (type === "post_workout" && !existing) {
    const s = (await ctx.store.get("sessions", session_id));
    for (const i of f.items) i.rung_done = s?.items.find((x) => x.item_key === i.item_key)?.prescribed_rung ?? 0;
  }
  const x = type === "evening" ? await todayExtras(ctx, date) : {};
  const wake = await ctx.store.kvGet(`wake:${date}`);
  const rec = buildCheckIn(type, f, { now: new Date(), id: ulid(), session_id, wake_time: wake, posture: type === "evening" ? (existing?.data?.posture_cycle ?? x.posture ?? undefined) : undefined, existing });
  // A night check-in done after midnight belongs to the evening before; a day's check-in keeps the date it was opened for.
  if (!existing && type !== "night" && date) rec.local_date = date;
  await ctx.store.put("checkins", rec);
  if (type === "post_workout" && session_id) {
    const s = await ctx.store.get("sessions", session_id);
    if (s && s.post_workout_checkin_id !== rec.id) await ctx.store.put("sessions", { ...s, post_workout_checkin_id: rec.id });
  }
  closeSheet();
  const was = ctx.state.mode;
  await refreshEngine(ctx);
  const v = await loadView(ctx);
  const color = v.evals[rec.id]?.color || "green";
  ctx.render();
  refreshBadges(ctx, v);
  if (ctx.state.mode === "red_stop" && was !== "red_stop") toast("Red check-in: see the notice at the top of Today.");
  else toast(`${LABEL[type]} saved · ${cap(color)}`);
}

// ---------------------------------------------------------------- form behaviour (delegated per form)
function wireForm(ctx, form) {
  const P = ctx.docs.config.pain || { green_max: 2, yellow_max: 4 };
  const paintVal = (el) => {
    const out = form.querySelector(`[data-val-for="${el.name}"]`);
    if (!out) return;
    out.textContent = el.value;
    if (out.hasAttribute("data-pain")) {
      const n = Number(el.value);
      out.className = `ci-val ${n <= P.green_max ? "green" : n <= P.yellow_max ? "yellow" : "orange"}`;
    }
  };
  const sync = () => {
    for (const el of form.querySelectorAll("[data-show]")) {
      const m = /^([\w-]+)(!?=)?(.*)$/.exec(el.dataset.show);
      const ctl = form.elements[m[1]];
      let on;
      if (!m[2]) on = !!ctl?.checked;
      else { const val = ctl?.value ?? ""; on = m[2] === "=" ? val === m[3] : val !== m[3]; }
      el.hidden = !on;
    }
  };
  form.addEventListener("input", (e) => { if (e.target.type === "range") paintVal(e.target); });
  form.addEventListener("change", sync);
  form.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ci-step]");
    if (!b) return;
    const input = form.elements[b.dataset.for];
    const step = Number(b.dataset.ciStep);
    const min = Number(input.min || 0);
    const cur = input.value === "" ? Number(input.defaultValue || 0) : Number(input.value);
    input.value = String(Math.max(min, Math.round((cur + step) * 100) / 100));
  });
  form.querySelectorAll("input[type=range]").forEach(paintVal);
  sync();
}

// ---------------------------------------------------------------- viewing a saved check-in
export async function openView(ctx, id, v = null) {
  v = v || await loadView(ctx);
  const c = v.checkins.find((x) => x.id === id);
  if (!c) return;
  const e = v.evals[c.id];
  const locked = isLocked(ctx, c);
  const root = openSheet(`<h2>${esc(LABEL[c.type])}</h2>
    <p class="muted small">${esc(fmtDate(c.local_date))} · ${esc(localTime(c.ts))}</p>
    <p><span class="pill ${e.color}">${cap(e.color)}</span> <span class="small">${esc(summaryLine(c))}</span></p>
    ${e.reasons.length ? `<ul class="reasons">${tidyReasons(e.reasons).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : '<p class="small muted">Nothing flagged.</p>'}
    ${c.oddities ? `<p class="small">Note: ${esc(c.oddities)}</p>` : ""}
    ${locked ? '<p class="small muted">The plan has already counted this one, so it can\'t be edited.</p>' : ""}
    <div class="sheet-actions"><button class="btn" type="button" data-close>Close</button>${locked ? "" : '<button class="btn primary" type="button" data-edit>Edit</button>'}</div>`);
  const edit = $("[data-edit]", root);
  if (edit) edit.onclick = () => { openForm(ctx, c.type, { existing: c, entry: { date: c.local_date, session_id: c.session_id }, v }); };
}

// ---------------------------------------------------------------- the Today pieces
export function redBannerHtml(ctx) {
  if (ctx.state.mode !== "red_stop") return "";
  const g = redGuidance(ctx.state.red);
  const why = (ctx.state.red?.flags || []).filter((x) => x.startsWith("Red")).map((x) => x.replace(/^Red:\s*/, ""));
  return `<section class="card red-banner" role="alert"><h2>${esc(g.title)}</h2><p>${esc(g.body)}</p>
    ${why.length ? `<ul class="reasons">${why.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <p class="small">Your plan is paused until this is sorted out. Keep doing check-ins.</p>
    <button class="btn" type="button" data-red-clear>Symptoms resolved, or a clinician cleared me</button></section>`;
}

export function checkinCardHtml(v) {
  const day = v.daily[v.date];
  const pill = day ? `<span class="pill ${day.color}">${cap(day.color)} so far</span>` : '<span class="pill none">No check-ins yet</span>';
  const rows = v.list.map((e) => {
    const c = e.checkin, ev = c && v.evals[c.id];
    const dot = ev ? ev.color : e.state;
    const label = e.type === "night" && e.date !== v.date ? "Night (last night)" : e.label;
    const sub = c ? summaryLine(c) : e.type === "post_workout" ? "Due now, after your workout" : e.state === "due" ? `Due since ${e.at}` : `Opens at ${e.at}`;
    const btn = c ? `<button class="btn" type="button" data-ci-view="${esc(c.id)}">View</button>`
      : `<button class="btn${e.state === "due" ? " primary" : ""}" type="button" data-ci-new="${e.type}" data-date="${e.date}" data-session="${esc(e.session_id || "")}">Check in</button>`;
    return `<div class="ci-row"><span class="dot ${dot}" aria-hidden="true"></span><div class="ci-row-copy"><b>${esc(label)}</b><small>${esc(sub)}</small></div>${btn}</div>`;
  }).join("");
  const reasons = tidyReasons(day?.reasons).slice(0, 3);
  const remind = typeof Notification !== "undefined" && Notification.permission === "default"
    ? '<button class="link" type="button" data-ci-remind>Turn on reminders while the app is open</button>' : "";
  return `<section class="card ci-card"><div class="ci-head"><h2>Check-ins</h2>${pill}<a class="link" href="#/history">History</a></div>
    <div class="ci-rows">${rows}</div>
    ${reasons.length ? `<ul class="reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}${remind}</section>`;
}

const WORKOUT_NAMES = { strength_A: "Strength A", strength_B: "Strength B", conditioning: "Conditioning" };
export function availableTemplates(ctx) {
  if (ctx.state.mode !== "active") return [];
  return Object.keys(WORKOUT_NAMES).filter((t) => templateItems(ctx.docs, ctx.state, t).length);
}
export function workoutCardHtml(ctx, v) {
  const ts = availableTemplates(ctx);
  if (!ts.length) return "";
  const next = ts.includes(nextStrengthTemplate(v.sessions)) ? nextStrengthTemplate(v.sessions) : ts[0];
  const today = v.sessions.filter((s) => s.local_date === v.date);
  const done = today.map((s) => `${WORKOUT_NAMES[s.template] || s.template} at ${localTime(s.ended_at || s.started_at)}`);
  return `<section class="card workout-card"><div class="ci-head"><h2>Workout</h2></div>
    ${done.length ? `<p class="small muted">Logged today: ${esc(done.join(", "))}</p>` : ""}
    <p class="small">${esc(WORKOUT_NAMES[next])} is next, ${templateItems(ctx.docs, ctx.state, next).length} exercises.</p>
    <button class="btn primary" type="button" data-workout="${next}">Start ${esc(WORKOUT_NAMES[next])}</button>
    ${ts.filter((t) => t !== next).map((t) => `<button class="btn" type="button" data-workout="${t}">${esc(WORKOUT_NAMES[t])}</button>`).join("")}</section>`;
}

export function openWorkout(ctx, template) {
  const startedAt = isoLocal();
  const its = templateItems(ctx.docs, ctx.state, template);
  const rows = its.map(({ item, dose, rung }, n) => {
    const ex = ctx.exById[item.exercise_id] || { name: item.exercise_id };
    const miss = missingEquipment(ex, ctx.profile.equipment);
    return `<label class="toggle wk-row"><input type="checkbox" name="wk${n}"${miss.length ? "" : " checked"} />
      <span>${esc(ex.name)}<small class="ci-hint">${esc(formatDose(dose, item, ctx.profile))}${item.rungs.length > 1 ? ` · rung ${rung + 1}/${item.rungs.length}` : ""}${miss.length ? ` · needs ${esc(miss.join(", "))}` : ""}</small></span></label>`;
  }).join("");
  const root = openSheet(`<h2>${esc(WORKOUT_NAMES[template])}</h2><p class="muted small">Untick anything you skipped, then finish to log it. The post-workout check-in comes next.</p>
    <form id="wk-form">${rows}<div class="sheet-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Finish and check in</button></div></form>`);
  $("#wk-form", root).onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const items = its.map(({ item, rung }, n) => ({ item_key: item.item_key, rung, completed: fd.has(`wk${n}`) }));
    if (!items.some((i) => i.completed)) { toast("Tick at least one exercise you did."); return; }
    const s = buildSession({ id: ulid(), template, state: ctx.state, items, startedAt });
    await ctx.store.put("sessions", s);
    closeSheet();
    await refreshEngine(ctx);
    ctx.render();
    setTimeout(() => openForm(ctx, "post_workout", { entry: { session_id: s.id, date: s.local_date } }), 260);
  };
}

function openRedClear(ctx) {
  const root = openSheet(`<h2>Clear the red notice?</h2>
    <p class="sheet-copy">Only do this if the symptoms have gone away or a clinician has cleared you to train. The plan restarts in settle mode, a gentle level, and builds back up.</p>
    <form id="rc-form"><label class="ci-q"><span class="ci-label">Note (optional)</span><input name="note" placeholder="e.g. cleared by my doctor" /></label>
    <div class="sheet-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Clear it</button></div></form>`);
  $("#rc-form", root).onsubmit = async (ev) => {
    ev.preventDefault();
    const note = new FormData(ev.target).get("note");
    const r = await clearRed(ctx.store, ctx.docs, ctx.profile, String(note || ""));
    ctx.state = r.state;
    closeSheet();
    ctx.render();
    toast("Cleared. Settle mode starts now.");
  };
}

/** Delegated clicks for everything above. Resolves true when it handled the event. */
export async function onClick(ctx, e) {
  const t = e.target;
  let el;
  if ((el = t.closest("[data-ci-new]"))) { await openForm(ctx, el.dataset.ciNew, { entry: { date: el.dataset.date, session_id: el.dataset.session || null } }); return true; }
  if ((el = t.closest("[data-ci-view]"))) { await openView(ctx, el.dataset.ciView); return true; }
  if ((el = t.closest("[data-workout]"))) { openWorkout(ctx, el.dataset.workout); return true; }
  if (t.closest("[data-red-clear]")) { openRedClear(ctx); return true; }
  if (t.closest("[data-ci-remind]")) { await askNotifications(); ctx.render(); return true; }
  return false;
}

// ---------------------------------------------------------------- history
export async function renderHistory(ctx, main) {
  const v = await loadView(ctx);
  const dates = new Set([...v.checkins.map((c) => c.local_date), ...v.sessions.map((s) => s.local_date), ...v.logs.map((l) => localDate(l.ts))]);
  const days = [...dates].sort().reverse().slice(0, 30);
  const logsBy = {};
  for (const l of v.logs) (logsBy[localDate(l.ts)] ||= []).push(l);
  const card = (d) => {
    const day = v.daily[d];
    const cis = v.checkins.filter((c) => c.local_date === d).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    const ss = v.sessions.filter((s) => s.local_date === d);
    const decisions = (logsBy[d] || []).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    return `<section class="card hist-day"><div class="ci-head"><h2>${esc(fmtDate(d))}</h2>${day ? `<span class="pill ${day.color}">${cap(day.color)}</span>` : '<span class="pill none">No check-ins</span>'}</div>
      <div class="chips">${cis.map((c) => `<button class="chip-btn ${v.evals[c.id].color}" type="button" data-ci-view="${esc(c.id)}">${esc(LABEL[c.type])}</button>`).join("")}</div>
      ${day?.reasons.length ? `<ul class="reasons">${tidyReasons(day.reasons).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${ss.map((s) => `<p class="small">🏋️ ${esc(WORKOUT_NAMES[s.template] || s.template)}${s.final_color ? ` · ${cap(s.final_color)}${s.status === "final" ? "" : " so far"}` : " · waiting on check-ins"}${s.clean ? " · counts toward advancing" : ""}</p>`).join("")}
      ${decisions.length ? `<div class="decisions"><small class="muted">Plan decisions</small>${decisions.map((l) => `<p class="small">${esc(l.message || `${l.rule_id}: ${l.outcome}`)}</p>`).join("")}</div>` : ""}</section>`;
  };
  main.innerHTML = `${redBannerHtml(ctx)}<p><a class="link" href="#/today">← Today</a></p>
    ${days.length ? days.map(card).join("") : '<section class="card"><p class="muted">Nothing here yet. Your check-ins and plan decisions will show up by day.</p></section>'}`;
  main.onclick = (e) => { onClick(ctx, e); };
  main.onchange = null;
}

// ---------------------------------------------------------------- due badges and reminders
let tickT = null, lastEngineRun = 0;
const NOTIFIED = "pt:ci-notified";
const readNotified = () => { try { return JSON.parse(localStorage.getItem(NOTIFIED) || "{}"); } catch { return {}; } };

export function refreshBadges(ctx, v) {
  const due = dueNow(v.list);
  const nav = document.querySelector('.nav a[data-page="today"]');
  if (nav) { nav.classList.toggle("has-due", due.length > 0); nav.dataset.due = String(due.length); }
  try { if (due.length) navigator.setAppBadge?.(due.length); else navigator.clearAppBadge?.(); } catch { /* not supported */ }
}

async function notify(title, body, tag) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const opts = { body, tag, icon: "icons/icon-192.png", badge: "icons/icon-192.png" };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) return await reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch { try { new Notification(title, opts); } catch { /* ignore */ } }
}

/** Every 30 s while the app is open: update the badge and fire a local notification for a check-in that just became due. */
export function startReminders(ctx, { isActive = () => true, onRemoteQuiet = () => true } = {}) {
  async function tick() {
    if (!ctx.state || !isActive()) return;
    const v = await loadView(ctx);
    refreshBadges(ctx, v);
    // Re-evaluate now and then so a session's 36 h "unevaluated" cutoff and similar clock-based rules land without a new check-in.
    if (Date.now() - lastEngineRun > 10 * 60000 && onRemoteQuiet()) {
      lastEngineRun = Date.now();
      const r = await refreshEngine(ctx);
      if (r.changed) ctx.render();
    }
    const seen = readNotified();
    const cutoff = Date.now() - 3 * 86400000;
    for (const k of Object.keys(seen)) if (seen[k] < cutoff) delete seen[k];
    let fired = false;
    for (const e of v.list) {
      if (e.state !== "due" || e.type === "post_workout" || seen[e.key]) continue;
      const [h, m] = e.at.split(":").map(Number), [nh, nm] = localTime(v.now).split(":").map(Number);
      const late = e.date === v.date ? nh * 60 + nm - (h * 60 + m) : 0;
      seen[e.key] = Date.now();
      fired = true;
      if (late <= 180) await notify(`${LABEL[e.type]} check-in`, "Takes about a minute.", `pt-ci-${e.type}`);
    }
    if (fired) localStorage.setItem(NOTIFIED, JSON.stringify(seen));
  }
  const run = () => tick().catch((e) => console.warn("Reminder check failed:", e));
  clearInterval(tickT);
  tickT = setInterval(run, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) run(); });
  run();
  return run;
}

export { TYPES };
