// Today Relief accordion and logging. Tracking only — not a checklist item.
import { isoLocal } from "../util.js";
import { RELIEF_OPTIONS, reliefById, reliefLogOf, newReliefEntry, addReliefEntry, removeLatestOfType, countByType, reliefWeekSummary } from "../relief.js";
import { esc, openSheet, today, fmtDate } from "./dom.js";
import { loadDay, saveDay } from "./pain-flag.js";

const nameOf = (ctx, id) => ctx.exById?.[id]?.name || reliefById[id]?.label || id;

function reliefSub(n) {
  return `${n} today`;
}

export function reliefCardHtml(ctx, day, { open = false } = {}) {
  const entries = reliefLogOf(day);
  const n = entries.length;
  const by = countByType(entries);
  const rows = RELIEF_OPTIONS.map((o) => {
    const ex = ctx.exById?.[o.exercise_id] || {};
    const count = by[o.exercise_id] || 0;
    const meta = o.range || (ex.cues && ex.cues[0]) || "";
    return `<div class="item${count ? " counted" : ""}" data-relief-row="${esc(o.exercise_id)}">
      <button class="text" type="button" data-relief-info="${esc(o.exercise_id)}">
        <span class="name">${esc(o.label)}</span>
        ${meta ? `<span class="meta">${esc(meta)}</span>` : ""}
      </button>
      <div class="stepper-ctrl">
        <button class="btn icon" type="button" data-relief-step="${esc(o.exercise_id)}" data-delta="-1" aria-label="Remove ${esc(o.label)}"${count ? "" : " disabled"}>−</button>
        <b data-relief-val="${esc(o.exercise_id)}">${count}</b>
        <button class="btn icon" type="button" data-relief-step="${esc(o.exercise_id)}" data-delta="1" aria-label="Add ${esc(o.label)}">+</button>
      </div>
    </div>`;
  }).join("");
  return `<section class="card section-card${open ? " open" : ""}" data-block="relief" id="relief-card">
    <button class="section-head" type="button" data-toggle-block="relief" aria-expanded="${open}">
      <span class="section-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 14c4-8 12-8 16 0"/><path d="M8 16c2-4 6-4 8 0"/></svg></span>
      <div class="section-title">
        <span class="section-name">Relief</span>
        <span class="section-sub" data-block-sub="relief">${esc(reliefSub(n))}</span>
      </div>
      <div class="section-right">
        <span class="section-badge" data-block-badge="relief">${n}</span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </div>
    </button>
    <div class="section-body" data-block-body="relief"${open ? "" : " hidden"}>${rows}</div>
  </section>`;
}

export function paintReliefCard(root, day) {
  const card = root?.querySelector?.("[data-block=relief]") || root;
  if (!card) return;
  const entries = reliefLogOf(day);
  const n = entries.length;
  const by = countByType(entries);
  const sub = card.querySelector("[data-block-sub=relief]");
  const badge = card.querySelector("[data-block-badge=relief]");
  if (sub) sub.textContent = reliefSub(n);
  if (badge) badge.textContent = String(n);
  for (const o of RELIEF_OPTIONS) {
    const count = by[o.exercise_id] || 0;
    const row = card.querySelector(`[data-relief-row="${o.exercise_id}"]`);
    const val = card.querySelector(`[data-relief-val="${o.exercise_id}"]`);
    const minus = card.querySelector(`[data-relief-step="${o.exercise_id}"][data-delta="-1"]`);
    if (val) val.textContent = String(count);
    if (minus) minus.disabled = count <= 0;
    row?.classList.toggle("counted", count > 0);
  }
}

export async function bumpRelief(ctx, exercise_id, date) {
  const day = await loadDay(ctx, date || today());
  const entry = newReliefEntry({ exercise_id, ts: isoLocal(), timed: false });
  const next = addReliefEntry(day, entry);
  await saveDay(ctx, next);
  return next;
}

export async function dropRelief(ctx, exercise_id, date) {
  const day = await loadDay(ctx, date || today());
  const next = removeLatestOfType(day, exercise_id);
  if (next === day) return day;
  await saveDay(ctx, next);
  return next;
}

export async function openReliefDetail(ctx, exercise_id) {
  const o = reliefById[exercise_id];
  const ex = ctx.exById?.[exercise_id] || {};
  const name = o?.label || ex.name || exercise_id;
  if (o?.timed) {
    const { showReliefTimer } = await import("./exercise-timer.js");
    showReliefTimer(ctx, o);
    return;
  }
  openSheet(`
    <h2>${esc(name)}</h2>
    ${ex.cues?.length ? `<h4>Cues</h4><ul>${ex.cues.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
    ${ex.stop_if && ex.stop_if !== "None." ? `<h4>Stop if</h4><p>${esc(ex.stop_if)}</p>` : ""}
    ${ex.contraindications && ex.contraindications !== "None." ? `<h4>Cautions</h4><p>${esc(ex.contraindications)}</p>` : ""}
    <p class="muted small">Use the stepper on Today to log this. It does not count toward the daily checklist.</p>`);
}

export function reliefHistoryHtml(ctx, dayRec) {
  const entries = reliefLogOf(dayRec);
  if (!entries.length) return "";
  const by = {};
  for (const e of entries) {
    const label = e.label || nameOf(ctx, e.exercise_id);
    by[label] = (by[label] || 0) + 1;
  }
  const bits = Object.entries(by).map(([k, n]) => `${n}× ${k}`);
  return `<div class="relief-hist"><small class="muted">Relief</small><p class="small">${entries.length} today · ${esc(bits.join(", "))}</p></div>`;
}

export function reliefWeekHtml(ctx, days, todayDate) {
  const map = {};
  for (const rec of days || []) if (rec?.local_date) map[rec.local_date] = rec;
  const w = reliefWeekSummary(map, todayDate || today());
  if (!w.total) return "";
  const typeBits = Object.entries(w.by_type).map(([id, n]) => `${n}× ${nameOf(ctx, id)}`);
  const dayBits = w.by_day.map((d) => `<p class="small">${esc(fmtDate(d.local_date))} · ${d.total}</p>`).join("");
  return `<section class="card" data-block="relief"><div class="card-head"><h3>Relief this week</h3></div><div class="card-body">
    <p>${w.total} logged · ${esc(typeBits.join(", "))}</p>
    ${dayBits}
  </div></section>`;
}

export { reliefWeekSummary, reliefLogOf };
