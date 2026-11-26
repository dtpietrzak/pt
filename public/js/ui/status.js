// Phase 3 UI: Status page (why the plan decided what it did, what's needed to advance), gate-test sessions,
// the red-flag screen, announcement screens for level changes, and the L6 equipment reconfirm.
import { loadView, refreshEngine, qScale, qStep, qToggle, wireForm, painBands, openForm, onClick as checkinClick, redBannerHtml, checkinCardHtml, refreshBadges } from "./checkins.js";
import { levelStatus, gateEligibility, thresholdText, isNumericTest, gateResult, buildGateSession, GATE_STATUS, GROUP_LABEL, unseenDecisions, decisionCopy, ruleLabel, REQUIRED_EQUIPMENT, needsEquipConfirm, testable } from "../status.js";
import { RED_FLAGS, redGuidance } from "../checkins.js";
import { engineConfig, manual, recordGate } from "../pipeline.js";
import { gatePass } from "../engine.js";
import { isoLocal, localDate, ulid } from "../util.js";
import { DISCLAIMER, BODY_WEIGHT_LB } from "../defaults.js";
import { $, esc, openSheet, closeSheet, confirmSheet, toast, fmtDate } from "./dom.js";

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const exName = (ctx, id) => ctx.exById[id]?.name || id;

export function statusOf(ctx) { return levelStatus(ctx.state, ctx.docs.levels, engineConfig(ctx.docs, ctx.profile), ctx.docs.tests); }

// ---------------------------------------------------------------- the Today card
export function statusCardHtml(ctx, v) {
  const st = statusOf(ctx);
  if (ctx.state.mode === "red_stop") return "";
  const lv = st.level;
  const pct = st.streakNeed ? Math.min(1, st.streak / st.streakNeed) : 0;
  let cta = "";
  if (ctx.state.mode === "active" && st.gatePending) {
    const e = gateEligibility({ state: ctx.state, status: st, daily: v.daily, evals: v.evals, checkins: v.checkins, today: v.date });
    cta = e.groups.length ? `<p class="small">${esc(e.ok ? "Gate tests are ready." : `Gate tests are next. ${e.why}`)}</p>${e.ok ? '<button class="btn primary" type="button" data-gate-start>Run a test session</button>' : ""}` : "";
  }
  const parts = [];
  if (st.mode !== "active") parts.push(st.modeText);
  else {
    parts.push(`${st.streak} of ${st.streakNeed} clean strength sessions`);
    if (st.probation) parts.push(`probation: ${st.probation} session${st.probation > 1 ? "s" : ""} left, none can be orange`);
    if (st.lock) parts.push("easy-dose mode (3 clean sessions to lift)");
  }
  return `<section class="card status-card"><div class="ci-head"><h2>${esc(lv?.id || "")} · ${esc(lv?.name || "")}</h2><a class="link" href="#/status">Details</a></div>
    ${st.mode === "active" && st.streakNeed ? `<div class="meter" aria-hidden="true"><span style="width:${Math.round(pct * 100)}%"></span></div>` : ""}
    <p class="small">${esc(parts.join(" · "))}</p>${cta}</section>`;
}

// ---------------------------------------------------------------- Status page
const dot = (cls) => `<span class="dot ${cls}" aria-hidden="true"></span>`;
export async function renderStatus(ctx, main) {
  const v = await loadView(ctx);
  const st = statusOf(ctx);
  const lv = st.level;
  const elig = gateEligibility({ state: ctx.state, status: st, daily: v.daily, evals: v.evals, checkins: v.checkins, today: v.date });
  const log = [...v.logs].sort((a, b) => (new Date(b.ts) - new Date(a.ts)) || (a.id < b.id ? 1 : -1)).slice(0, 15);
  const pill = (c, t) => `<span class="pill ${c}">${esc(t)}</span>`;

  let html = `${redBannerHtml(ctx)}<p><a class="link" href="#/today">← Today</a></p>
    <section class="card"><div class="ci-head"><h2>${esc(lv?.id)} · ${esc(lv?.name)}</h2>${pill(st.mode === "active" ? "green" : st.mode === "red_stop" ? "red" : "yellow", st.mode.replace("_", " "))}</div>
      <p class="small">${esc(lv?.goal || "")}</p><p class="small muted">${esc(st.modeText)}</p>
      ${st.clinician ? '<p class="small"><b>Please check in with your clinician.</b> The plan has had to pull you back more than once recently, or a flare isn\'t settling.</p>' : ""}</section>`;

  // What's needed to advance
  html += `<section class="card"><h2>${st.isLast ? "Finishing the plan" : "What it takes to move up"}</h2>
    <ul class="checks">${st.checks.map((c) => `<li class="${c.ok ? "ok" : ""}"><span class="tick">${c.ok ? "✓" : "○"}</span><span><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></span></li>`).join("")}</ul>
    ${st.extra.length ? `<p class="small muted">${st.extra.map(esc).join(" · ")}</p>` : ""}
    <p class="small"><b>Right now:</b> ${esc(st.next)}</p>
    ${st.probation ? `<p class="small">Probation: the next ${st.probation} session${st.probation > 1 ? "s" : ""} can't be orange, or you step back a level.</p>` : ""}
    ${st.lock ? '<p class="small">Easy-dose mode is on after a rough patch: strength items use one set fewer until 3 clean sessions.</p>' : ""}
    ${st.rows.length ? `<details class="ci-more"><summary>Exercises: ${st.rows.length - st.notAt.length} of ${st.rows.length} at target</summary>
      ${st.rows.map((r) => `<div class="ex-row">${dot(r.atTarget ? "green" : r.held_out ? "orange" : "later")}<span><b>${esc(exName(ctx, r.exercise_id))}</b><small>${r.held_out ? "Held out for now" : r.atTarget ? "At target" : `Step ${r.rung + 1} of ${r.target + 1} · ${r.exposures}/${r.needed} clean sessions toward the next step`}</small></span></div>`).join("")}</details>` : ""}</section>`;

  // Gate tests
  if (st.gates.length) {
    html += `<section class="card"><h2>Gate tests</h2><p class="small muted">Objective checks that decide the move up. Run on a green day, one group per session. A pass counts once the next morning is green too. Weights are based on 180 lb body weight, rounded to 5 lb.</p>`;
    html += st.gates.map((g) => {
      const [label, cls] = GATE_STATUS[g.status] || [g.status, "later"];
      const retest = g.status === "fail" ? (g.retestAfter > 0 ? ` · retest after ${g.retestAfter} more clean session${g.retestAfter > 1 ? "s" : ""}` : " · ready to retest") : "";
      return `<details class="gate"><summary>${dot(cls)}<span class="gate-copy"><b>${esc(g.test?.name || g.test_id)}${g.optional ? " <small>(optional)</small>" : ""}</b><small>Target: ${esc(thresholdText(g.test, g.threshold, BODY_WEIGHT_LB))}</small><small>${esc(label + retest)}</small></span></summary>
        <p class="small">${esc(g.test?.protocol || "")}</p><p class="small muted">${esc(g.test?.safety || "")}</p>
        ${g.optional && g.status === "not_started" ? `<button class="btn" type="button" data-skip-test="${esc(g.test_id)}">Skip for good (log why)</button>` : ""}</details>`;
    }).join("");
    if (ctx.state.mode === "active" && st.gatePending) {
      html += `<p class="small ${elig.ok ? "" : "muted"}">${esc(elig.why)}</p>${elig.ok && elig.groups.length ? '<button class="btn primary" type="button" data-gate-start>Run a test session</button>' : ""}`;
    } else if (ctx.state.mode === "active") html += `<p class="small muted">Tests unlock once every required exercise is at target and the clean-session streak is met.</p>`;
    html += `</section>`;
  }

  // Decisions
  html += `<section class="card"><h2>Why the plan did what it did</h2>${log.length ? log.map((e) => `<div class="dec"><small class="muted">${esc(fmtDate(localDate(e.ts)))} · ${esc(ruleLabel(e))}</small><p class="small">${esc(e.message || "")}</p></div>`).join("") : '<p class="small muted">Nothing yet. Decisions appear here as your check-ins and sessions come in, each with the reason.</p>'}
    <p class="small"><a class="link" href="#/history">Day-by-day history</a></p></section>`;

  // Actions
  const active = ctx.state.mode === "active" || ctx.state.mode === "maintenance";
  html += `<section class="card"><h2>When something changes</h2>
    ${active && ctx.state.level_id !== "L0" ? '<button class="btn" type="button" data-act="flare">I flared</button>' : ""}
    ${ctx.state.mode === "active" ? '<button class="btn" type="button" data-act="pause">Pause (illness or travel)</button>' : ""}
    ${ctx.state.mode === "paused" ? '<button class="btn primary" type="button" data-act="resume">Resume</button>' : ""}
    <a class="btn" href="#/red">Red-flag screen</a>
    <p class="small muted">"I flared" drops you into settle mode for a few days. Pausing freezes advancing, stepping back and layoff counting.</p></section>`;
  main.innerHTML = html;
  main.onclick = (e) => { onClick(ctx, e); };
  main.onchange = null;
}

// ---------------------------------------------------------------- red-flag screen
export function redGuidanceHtml() {
  const em = RED_FLAGS.filter(([, , k]) => k === "emergency"), cl = RED_FLAGS.filter(([, , k]) => k === "clinician");
  return `<section class="card"><h2>Get emergency care now if you have</h2><ul class="redlist">${em.map(([, l]) => `<li>${esc(l)}</li>`).join("")}</ul>
      <p class="small">These can mean the nerves are being squeezed. Go to an emergency department right away. Don't wait to see if it passes, and don't wait for the app.</p></section>
    <section class="card"><h2>See a clinician soon if you have</h2><ul class="redlist">${cl.map(([, l]) => `<li>${esc(l)}</li>`).join("")}</ul>
      <p class="small">Book a visit within a day or two, and stop training until you've been seen. Rest in whatever position is comfortable. If it gets worse, or any emergency sign above appears, go to emergency care.</p></section>`;
}
export function redSelfScreenHtml() {
  return `<section class="card"><h2>Check yourself now</h2><p class="small muted">Tap anything that's true right now. You'll see what to do.</p>
    <form id="rs-form">${RED_FLAGS.map(([k, l]) => qToggle(`flag_${k}`, l, false)).join("")}
    <div id="rs-result" class="rs-result" hidden></div>
    <button class="btn danger" type="submit" id="rs-pause" hidden>Pause my plan and log this</button></form></section>`;
}
function wireSelfScreen(ctx, root) {
  const form = $("#rs-form", root);
  if (!form) return;
  const upd = () => {
    const on = RED_FLAGS.filter(([k]) => form.elements[`flag_${k}`].checked);
    const kind = on.some(([, , k]) => k === "emergency") ? "emergency" : on.length ? "clinician" : null;
    const res = $("#rs-result", form), btn = $("#rs-pause", form);
    res.hidden = !kind;
    btn.hidden = !kind || ctx.state.mode === "red_stop";
    if (kind) { const g = redGuidance({ kind }); res.className = `rs-result ${kind}`; res.innerHTML = `<b>${esc(g.title)}</b><p>${esc(g.body)}</p>`; }
  };
  form.addEventListener("change", upd);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const on = RED_FLAGS.filter(([k]) => form.elements[`flag_${k}`].checked);
    if (!on.length) return;
    const kind = on.some(([, , k]) => k === "emergency") ? "emergency" : "clinician";
    await manual(ctx.store, ctx.docs, ctx.profile, { type: "red_report", kind, flags: on.map(([, l]) => l) });
    ctx.state = await ctx.store.kvGet("state");
    ctx.render();
    toast("Plan paused.");
  };
}
/** The red screen. Also what replaces Today while the plan is frozen. */
export function redScreenHtml(ctx) {
  return `${redBannerHtml(ctx)}${redGuidanceHtml()}${redSelfScreenHtml()}<p class="disclaimer">${esc(DISCLAIMER)}</p>`;
}
export async function renderRed(ctx, main) {
  main.innerHTML = `<p><a class="link" href="#/today">← Today</a></p>${redScreenHtml(ctx)}`;
  wireSelfScreen(ctx, main);
  main.onclick = (e) => { onClick(ctx, e); };
  main.onchange = null;
}
/** Today while red-stopped: the red screen first, with check-ins still available. */
export async function renderRedToday(ctx, main, view) {
  main.innerHTML = `${redScreenHtml(ctx)}${checkinCardHtml(view)}`;
  wireSelfScreen(ctx, main);
  refreshBadges(ctx, view);
  main.onclick = (e) => { onClick(ctx, e); };
  main.onchange = null;
}

// ---------------------------------------------------------------- gate-test sessions
async function openGateStart(ctx) {
  const v = await loadView(ctx);
  const st = statusOf(ctx);
  const e = gateEligibility({ state: ctx.state, status: st, daily: v.daily, evals: v.evals, checkins: v.checkins, today: v.date });
  const root = openSheet(`<h2>Gate-test session</h2>
    <p class="sheet-copy">${esc(e.why)}</p>
    ${e.groups.length ? `<p class="small muted">One group per session. Warm up with your usual walk and core block only, and stop at the first form breakdown or any symptom.</p>
      ${e.groups.map((g) => `<button class="btn${e.ok ? "" : " disabled"}" type="button" data-gate-group="${esc(g.id)}" ${e.ok ? "" : "disabled"}>${esc(g.label)} <small>(${g.tests.length} test${g.tests.length > 1 ? "s" : ""})</small></button>`).join("")}` : ""}
    <div class="sheet-actions"><button class="btn" type="button" data-close>Close</button></div>`);
  root.onclick = (ev) => { const b = ev.target.closest("[data-gate-group]"); if (b && !b.disabled) openGateSession(ctx, b.dataset.gateGroup); };
}

async function openGateSession(ctx, groupId) {
  const v = await loadView(ctx);
  const st = statusOf(ctx);
  const e = gateEligibility({ state: ctx.state, status: st, daily: v.daily, evals: v.evals, checkins: v.checkins, today: v.date });
  const group = e.groups.find((g) => g.id === groupId);
  if (!e.ok || !group) { toast(e.why); return; }
  const startedAt = isoLocal();
  const P = painBands(ctx);
  const blocks = group.tests.map((g) => {
    const id = g.test_id, t = g.test || { id, name: id };
    const numeric = isNumericTest(g.threshold);
    return `<fieldset class="ci-sec gt" data-test="${esc(id)}"><legend>${esc(t.name)}</legend>
      <p class="small">${esc(t.protocol || "")}</p><p class="small muted">${esc(t.safety || "")}</p>
      <p class="small"><b>Target:</b> ${esc(thresholdText(t, g.threshold, BODY_WEIGHT_LB))}</p>
      ${numeric ? qStep(`v_${id}`, "Your result", "", { step: g.threshold.value >= 30 ? 5 : 1, unit: t.unit && !/[;%]/.test(t.unit) ? t.unit : "" }) : qToggle(`met_${id}`, "I hit the target as written", false)}
      ${qToggle(`form_${id}`, "Form stayed clean the whole way", true)}
      ${qScale(`pain_${id}`, "Worst pain during the test", 0, { P, required: true })}
      <p class="gt-result small" data-result="${esc(id)}"></p></fieldset>`;
  }).join("");
  const root = openSheet(`<h2>${esc(group.label)} tests</h2><p class="muted small">Do these in order. Stop at the first form breakdown or any symptom, and enter what you got.</p>
    <form id="gt-form" class="ci-form" novalidate>${blocks}<div class="sheet-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Save results</button></div></form>`);
  const form = $("#gt-form", root);
  wireForm(ctx, form);
  const read = (g) => {
    const id = g.test_id, fd = new FormData(form);
    const input = { value: fd.get(`v_${id}`), met: fd.has(`met_${id}`), form_ok: fd.has(`form_${id}`), pain_peak: fd.get(`pain_${id}`) };
    return gateResult(g.test || { id }, g.threshold, input);
  };
  const preview = () => {
    for (const g of group.tests) {
      const out = form.querySelector(`[data-result="${g.test_id}"]`);
      const fd = new FormData(form);
      const filled = isNumericTest(g.threshold) ? fd.get(`v_${g.test_id}`) !== "" : true;
      if (!filled || fd.get(`pain_${g.test_id}`) === null) { out.textContent = ""; continue; }
      const r = read(g);
      out.textContent = r.passed ? "Would count as a pass (confirmed after a green next morning)." : "Not a pass yet. Retest after 2 more clean sessions.";
      out.className = `gt-result small ${r.passed ? "pass" : "nopass"}`;
    }
  };
  form.addEventListener("input", preview); form.addEventListener("change", preview);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    if (form.querySelector(".ci-scale-q[data-required]:not(:has(input:checked))")) { toast("Pick a pain number for each test."); return; }
    const results = [];
    for (const g of group.tests) {
      if (isNumericTest(g.threshold) && new FormData(form).get(`v_${g.test_id}`) === "") { toast("Enter a result for each test, or 0 if you couldn't start."); return; }
      results.push(read(g));
    }
    const s = buildGateSession({ id: ulid(), state: ctx.state, tests: group.tests.map((g) => g.test || { id: g.test_id }), results, startedAt, endedAt: isoLocal() });
    await ctx.store.put("sessions", s);
    await recordGate(ctx.store, ctx.docs, ctx.profile, s.id);
    ctx.state = await ctx.store.kvGet("state");
    closeSheet();
    await refreshEngine(ctx);
    ctx.render();
    const pass = results.filter((r) => r.passed).length;
    toast(`${pass} of ${results.length} passed so far. Now the post-test check-in.`);
    setTimeout(() => openForm(ctx, "post_workout", { entry: { session_id: s.id, date: s.local_date } }), 260);
  };
}

async function openSkipTest(ctx, testId) {
  const t = ctx.docs.tests.tests.find((x) => x.id === testId);
  const root = openSheet(`<h2>Skip ${esc(t?.name || testId)}?</h2><p class="sheet-copy">Optional tests are skipped for good if the movement brings on symptoms. Say why so it's on record.</p>
    <form id="sk-form"><label class="ci-q"><span class="ci-label">Why</span><textarea name="why" rows="2" required placeholder="e.g. extension brought on my leg symptoms"></textarea></label>
    <div class="sheet-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Skip it</button></div></form>`);
  $("#sk-form", root).onsubmit = async (ev) => {
    ev.preventDefault();
    const why = String(new FormData(ev.target).get("why") || "").trim();
    if (!why) return;
    await manual(ctx.store, ctx.docs, ctx.profile, { type: "skip_optional_test", test_id: testId, note: why });
    ctx.state = await ctx.store.kvGet("state");
    await refreshEngine(ctx);
    closeSheet(); ctx.render(); toast("Skipped, and logged.");
  };
}

async function doAction(ctx, act) {
  const copy = {
    flare: ["I flared?", "This puts you in settle mode: strength work pauses and the plan eases off until you've had 2 green days in a row. Use it when your back clearly flared up.", "Yes, I flared"],
    pause: ["Pause the plan?", "Nothing advances, steps back, or counts toward a layoff while you're paused. On resume you'll need one clean session before anything advances.", "Pause"],
    resume: ["Resume the plan?", "You'll need one clean session before anything advances.", "Resume"],
  }[act];
  if (!(await confirmSheet({ title: copy[0], body: copy[1], confirmLabel: copy[2] }))) return;
  await manual(ctx.store, ctx.docs, ctx.profile, { type: act === "flare" ? "flare" : act });
  ctx.state = await ctx.store.kvGet("state");
  ctx.render();
}

// ---------------------------------------------------------------- announcement screens
let showing = false;
/** After a render: if the engine made a level-up / step-back / settle / gate decision David hasn't seen, explain it once. */
export async function maybeShowDecisions(ctx) {
  if (showing || !$("#sheet").hidden) return;
  const [log, ack] = await Promise.all([ctx.store.all("log"), ctx.store.kvGet("decisions_ack")]);
  if (!ack) { await ctx.store.kvSet("decisions_ack", { ts: isoLocal() }); return; } // first run: nothing earlier counts as new
  const fresh = unseenDecisions(log, ack.ts).filter((e) => e.outcome !== "red");
  const reds = unseenDecisions(log, ack.ts).filter((e) => e.outcome === "red");
  if (reds.length) await ctx.store.kvSet("decisions_ack", { ts: isoLocal() });
  if (!fresh.length) return;
  showing = true;
  const shown = fresh.slice(-3).reverse();
  await ctx.store.kvSet("decisions_ack", { ts: isoLocal() });
  const confirmed = await ctx.store.kvGet("equip_confirmed");
  const cards = shown.map((e) => {
    const c = decisionCopy(e, ctx.state, ctx.docs.levels);
    return `<div class="announce ${c.tone}"><div class="announce-icon" aria-hidden="true">${c.icon}</div><h2>${esc(c.title)}</h2><p>${esc(c.body || "")}</p>
      <ul>${c.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>${c.link ? `<a class="btn primary" href="${c.link}" data-close>Open</a>` : ""}${c.equip && needsEquipConfirm(ctx.state, confirmed) ? '<button class="btn primary" type="button" data-equip>Confirm my equipment first</button>' : ""}</div>`;
  }).join("");
  const root = openSheet(`${cards}<div class="sheet-actions"><button class="btn primary" type="button" data-close>Got it</button></div>`, { onClose: () => { showing = false; } });
  root.onclick = (ev) => { if (ev.target.closest("[data-equip]")) openEquip(ctx); };
}

// ---------------------------------------------------------------- L6 equipment reconfirm
export function equipCardHtml() {
  return `<section class="card note equip-card"><h2>Before barbell work</h2><p class="small">Level 6 adds barbell lifts. Confirm what you actually have so the plan flags anything you can't do and you can use the listed alternative or skip it.</p>
    <button class="btn primary" type="button" data-equip>Confirm my equipment</button></section>`;
}
export function openEquip(ctx) {
  const eq = ctx.profile.equipment || {};
  const root = openSheet(`<h2>Confirm equipment</h2><p class="muted small">Switch off anything you don't have. Exercises that need it will be flagged on Today.</p>
    <form id="eq-form">${REQUIRED_EQUIPMENT.map(([k, l]) => qToggle(`eq_${k}`, l, eq[k] !== false)).join("")}
    <div class="sheet-actions"><button class="btn" type="button" data-close>Later</button><button class="btn primary" type="submit">Confirm</button></div></form>`);
  $("#eq-form", root).onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const profile = { ...ctx.profile, equipment: { ...ctx.profile.equipment, ...Object.fromEntries(REQUIRED_EQUIPMENT.map(([k]) => [k, fd.has(`eq_${k}`)])) } };
    await ctx.store.kvSet("profile", profile);
    await ctx.store.kvSet("equip_confirmed", true);
    ctx.profile = profile;
    closeSheet(); ctx.render();
    toast(REQUIRED_EQUIPMENT.some(([k]) => !profile.equipment[k]) ? "Saved. Items needing missing gear are flagged." : "Equipment confirmed.");
  };
}

/** Delegated clicks for this module. Resolves true when handled (falls through to the check-in handlers otherwise). */
export async function onClick(ctx, e) {
  const t = e.target;
  let el;
  if (t.closest("[data-gate-start]")) { await openGateStart(ctx); return true; }
  if ((el = t.closest("[data-skip-test]"))) { await openSkipTest(ctx, el.dataset.skipTest); return true; }
  if ((el = t.closest("[data-act]"))) { await doAction(ctx, el.dataset.act); return true; }
  if (t.closest("[data-equip]")) { openEquip(ctx); return true; }
  return checkinClick(ctx, e);
}
