// Today view: daily checklist, morning protection window, and walk/break counters.
// Uses event delegation + in-place DOM updates so tapping checkboxes or steppers never flickers.
import { currentDose } from "../engine.js";
import { formatDose, missingEquipment } from "../dose.js";
import { $, esc, BLOCKS, today, nowHM, addMin, minutesSince, fmtDate, openSheet, closeSheet, showExercise } from "./dom.js";

const DAILY = ["daily_mobility", "daily_core", "walking", "relief"];
const MORNING_WINDOW_MIN = 45;

async function dayLog(ctx, d) {
  return (await ctx.store.get("days", d)) || { local_date: d, level_id: ctx.state.level_id, checklist: [] };
}

export async function renderToday(ctx, main) {
  const d = today();
  const lv = ctx.level();
  const [log, wake] = await Promise.all([dayLog(ctx, d), ctx.store.kvGet(`wake:${d}`)]);
  const inWindow = wake && minutesSince(d, wake) < MORNING_WINDOW_MIN;
  const doneSet = new Set(log.checklist.filter((c) => c.done).map((c) => c.item_key));
  const items = lv.items.filter((i) => DAILY.includes(i.block));
  const requiredKeys = new Set(items.filter((i) => !i.optional && i.block !== "walking").map((i) => i.item_key));
  const nDone = [...requiredKeys].filter((k) => doneSet.has(k)).length;
  const walkTarget = ctx.state.walk?.current_min || 0;

  let html = `
    <section class="card hero-card">
      <div class="row between">
        <div><div class="muted small">${fmtDate(d)}</div><h2>${esc(lv.id)} · ${esc(lv.name)}</h2></div>
        <div class="ring" id="daily-ring" style="--p:${requiredKeys.size ? nDone / requiredKeys.size : 0}"><span id="daily-ring-label">${nDone}/${requiredKeys.size}</span></div>
      </div>
      <p class="muted small">${esc(lv.goal)}</p>
      <div class="wake">${wake
        ? `Up at <b>${esc(wake)}</b>${inWindow ? ` · morning window until ${addMin(wake, MORNING_WINDOW_MIN)}` : ""} <button class="link" id="wake-edit" type="button">change</button>`
        : `<button class="btn" id="wake-now" type="button">I'm up</button> <span class="muted small">starts the ${MORNING_WINDOW_MIN}-min morning window</span>`}</div>
    </section>`;
  if (inWindow) {
    html += `<section class="card note">Walk around the house; core and mobility come after the morning window.</section>`;
  }
  for (const [block, label] of BLOCKS.filter(([b]) => DAILY.includes(b))) {
    const its = items.filter((i) => i.block === block);
    if (!its.length) continue;
    const hidden = inWindow && (block === "daily_core" || block === "daily_mobility");
    html += `<section class="block"><h3>${label}${block === "walking" ? ` <span class="muted small">target ${walkTarget} min</span>` : ""}</h3>`;
    if (hidden) { html += `<p class="muted small pad">After the morning window.</p></section>`; continue; }
    for (const it of its) html += itemRow(ctx, it, doneSet.has(it.item_key));
    if (block === "walking") {
      html += `
        ${stepper("Walked today", walkHint(lv, walkTarget), "walk_min", log.walk_min || 0, "min", 5)}
        ${stepper("Decompression breaks", decompHint(lv), "decomp_breaks_done", log.decomp_breaks_done || 0, "", 1)}
        ${stepper("Standing breaks", standingHint(lv), "standing_breaks_done", log.standing_breaks_done || 0, "", 1)}`;
    }
    html += `</section>`;
  }
  main.innerHTML = html;

  const setWake = async (t) => {
    await ctx.store.kvSet(`wake:${d}`, t);
    renderToday(ctx, main);
  };

  main.onchange = async (e) => {
    const cb = e.target.closest("input[data-item]");
    if (!cb) return;
    const k = cb.dataset.item;
    cb.closest(".item")?.classList.toggle("done", cb.checked);
    const l = await dayLog(ctx, d);
    const entry = l.checklist.find((c) => c.item_key === k);
    if (entry) entry.done = cb.checked;
    else l.checklist.push({ item_key: k, done: cb.checked });
    l.level_id = ctx.state.level_id;
    await ctx.store.put("days", l);
    const doneNow = l.checklist.filter((c) => c.done && requiredKeys.has(c.item_key)).length;
    const ring = $("#daily-ring", main);
    const ringLabel = $("#daily-ring-label", main);
    if (ring) ring.style.setProperty("--p", String(requiredKeys.size ? doneNow / requiredKeys.size : 0));
    if (ringLabel) ringLabel.textContent = `${doneNow}/${requiredKeys.size}`;
  };

  main.onclick = async (e) => {
    const info = e.target.closest("[data-info]");
    if (info) { showExercise(ctx, info.dataset.info); return; }

    const stepBtn = e.target.closest("[data-step-key]");
    if (stepBtn) {
      const key = stepBtn.dataset.stepKey;
      const delta = Number(stepBtn.dataset.delta);
      const l = await dayLog(ctx, d);
      const next = Math.max(0, (l[key] || 0) + delta);
      l[key] = next;
      const valEl = main.querySelector(`[data-step-val="${key}"]`);
      if (valEl) valEl.textContent = String(next);
      await ctx.store.put("days", l);
      return;
    }

    if (e.target.closest("#wake-now")) {
      await setWake(nowHM());
      return;
    }
    if (e.target.closest("#wake-edit")) {
      openWakeSheet(wake || nowHM(), setWake);
    }
  };
}

function openWakeSheet(current, onSave) {
  const root = openSheet(`
    <h2>Wake time</h2>
    <p class="muted small">Sets the ${MORNING_WINDOW_MIN}-minute morning protection window.</p>
    <form id="wake-form">
      <label class="field">Time<input type="time" name="wake" value="${esc(current)}" required /></label>
      <div class="sheet-actions">
        <button class="btn" type="button" data-close>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>`);
  $("#wake-form", root).onsubmit = async (ev) => {
    ev.preventDefault();
    const val = new FormData(ev.target).get("wake");
    if (val) {
      closeSheet();
      await onSave(String(val));
    }
  };
}

function stepper(title, hint, key, value, unit, step) {
  const unitHtml = unit ? ` ${esc(unit)}` : "";
  return `<div class="stepper">
      <div class="stepper-copy"><span>${esc(title)}</span><small>${esc(hint)}</small></div>
      <div class="stepper-ctrl">
        <button class="btn icon" type="button" data-step-key="${key}" data-delta="-${step}" aria-label="minus ${step}">−</button>
        <b data-step-val="${key}">${esc(value)}</b>${unitHtml}
        <button class="btn icon" type="button" data-step-key="${key}" data-delta="${step}" aria-label="plus ${step}">+</button>
      </div></div>`;
}

function rangeMin(pair, fallback) {
  const [a, b] = pair || [];
  if (a && b && a !== b) return `${a}–${b} min`;
  if (a) return `${a} min`;
  return fallback;
}

function standingHint(lv) {
  const every = rangeMin(lv.standing?.break_every_min, "45–60 min");
  return `Pause standing every ${every}. Sit or change position; don’t try to stand through it.`;
}

function decompHint(lv) {
  const it = lv.items.find((i) => i.exercise_id === "EX_DECOMP_90_90");
  const start = it?.rungs?.[it.start_rung]?.time_min;
  const target = it?.rungs?.[it.target_rung]?.time_min;
  const dur = start && target && start !== target ? `${start}–${target} min` : `${target || start || 5} min`;
  const kind = String(lv.standing?.decomp || "");
  let when;
  if (/as often as needed/i.test(kind)) when = "Use as often as you need.";
  else if (/optional/i.test(kind) || !it) when = "Optional now; use any time.";
  else if (/recommend/i.test(kind)) when = "Recommended around 2½–3 hours of being up, before symptoms start.";
  else when = "Plan one around 2½–3 hours of being up, before symptoms start.";
  return `Lie on your back, calves on a chair (hips and knees at 90°), ${dur}. ${when}`;
}

function walkHint(lv, target) {
  const bouts = lv.walking?.bouts ? `, in ${lv.walking.bouts} walks` : "";
  return `Comfortable pace on flat ground${bouts}. Target is ${target} min today.`;
}

function itemRow(ctx, it, done) {
  const ex = ctx.exById[it.exercise_id] || { name: it.exercise_id };
  const { dose, rung } = currentDose(ctx.state, it);
  const miss = missingEquipment(ex, ctx.profile.equipment);
  const ladder = it.rungs.length > 1 ? `rung ${rung + 1}/${it.rungs.length}` : "";
  return `<div class="item ${done ? "done" : ""}">
    <label class="check"><input type="checkbox" data-item="${esc(it.item_key)}" ${done ? "checked" : ""} aria-label="${esc(ex.name)}" /></label>
    <button class="text" type="button" data-info="${esc(it.item_key)}">
      <span class="name">${esc(ex.name)}</span>
      <span class="meta">${esc(formatDose(dose, it, ctx.profile))}${ladder ? ` · ${ladder}` : ""}${it.optional ? ` · <i>optional</i>` : ""}${miss.length ? ` · <span class="warn">needs ${esc(miss.join(", "))}</span>` : ""}</span>
      ${it.note ? `<span class="meta note-line">${esc(it.note)}</span>` : ""}
    </button></div>`;
}
