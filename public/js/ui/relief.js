// Today Relief card, picker, and logging. Tracking only — not a checklist item.
import { isoLocal, localTime } from "../util.js";
import { RELIEF_OPTIONS, reliefById, reliefLogOf, newReliefEntry, addReliefEntry, removeReliefEntry, reliefWeekSummary } from "../relief.js";
import { $, esc, openSheet, closeSheet, toast, today, fmtDate } from "./dom.js";
import { loadDay, saveDay } from "./pain-flag.js";

const nameOf = (ctx, id) => ctx.exById?.[id]?.name || reliefById[id]?.label || id;

export function reliefCardHtml(ctx, day) {
  const entries = reliefLogOf(day);
  const n = entries.length;
  const sub = n ? `${n} logged today` : "Log a reset any time. This is not part of today's checklist.";
  const rows = entries.slice().reverse().slice(0, 6).map((e) => {
    const t = (e.ts || "").slice(11, 16);
    const dur = e.duration_s ? ` · ${e.duration_s >= 60 ? `${Math.round(e.duration_s / 60)} min` : `${e.duration_s} s`}` : "";
    return `<li class="relief-row"><span>${esc(t)} · ${esc(e.label || nameOf(ctx, e.exercise_id))}${esc(dur)}</span><button class="link" type="button" data-relief-undo="${esc(e.id)}" aria-label="Remove this relief log">Undo</button></li>`;
  }).join("");
  return `<section class="card section-card open relief-card" data-block="relief" id="relief-card">
    <div class="section-head">
      <span class="section-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 14c4-8 12-8 16 0"/><path d="M8 16c2-4 6-4 8 0"/></svg></span>
      <div class="section-title">
        <span class="section-name">Relief</span>
        <span class="section-sub">${esc(sub)}</span>
      </div>
      <div class="section-right"><span class="section-badge">${n || "Log"}</span></div>
    </div>
    <div class="section-body" data-block-body="relief">
      <button class="btn primary wide" type="button" data-relief-open>Log relief</button>
      ${rows ? `<ul class="relief-log">${rows}</ul>` : ""}
    </div>
  </section>`;
}

export function pickerHtml(ctx) {
  const rows = RELIEF_OPTIONS.map((o) => {
    const ex = ctx.exById?.[o.exercise_id] || {};
    const cue = (ex.cues || [])[0] || "";
    const meta = o.range ? o.range : "Log without a timer, or open cues";
    return `<div class="relief-opt" data-relief-id="${esc(o.exercise_id)}">
      <button class="text" type="button" data-relief-info="${esc(o.exercise_id)}">
        <span class="name">${esc(o.label)}</span>
        <span class="meta">${esc(meta)}${cue ? ` · ${esc(cue)}` : ""}</span>
      </button>
      <div class="relief-opt-actions">
        <button class="btn" type="button" data-relief-log="${esc(o.exercise_id)}">Log now</button>
        ${o.timed ? `<button class="btn primary" type="button" data-relief-timer="${esc(o.exercise_id)}">Start timer</button>` : ""}
      </div>
    </div>`;
  }).join("");
  return `<h2>Log relief</h2>
    <p class="muted small">Pick one. Timed options can run a countdown, or you can log them without timing. This does not count toward today's checklist.</p>
    <div class="relief-picker">${rows}</div>`;
}

export async function logRelief(ctx, exercise_id, { duration_s, timed, ts, date } = {}) {
  const day = await loadDay(ctx, date || today());
  const entry = newReliefEntry({ exercise_id, ts: ts || isoLocal(), duration_s, timed: !!timed });
  await saveDay(ctx, addReliefEntry(day, entry));
  return entry;
}

export async function undoRelief(ctx, id, date) {
  const day = await loadDay(ctx, date || today());
  await saveDay(ctx, removeReliefEntry(day, id));
}

export function openReliefPicker(ctx, { onLogged } = {}) {
  const bind = (root) => {
    root.onclick = async (e) => {
      const info = e.target.closest("[data-relief-info]");
      const logBtn = e.target.closest("[data-relief-log]");
      const timerBtn = e.target.closest("[data-relief-timer]");
      if (logBtn) {
        e.preventDefault();
        await logRelief(ctx, logBtn.dataset.reliefLog, { timed: false });
        closeSheet();
        toast("Relief logged.");
        onLogged?.();
        return;
      }
      if (timerBtn) {
        e.preventDefault();
        const o = reliefById[timerBtn.dataset.reliefTimer];
        closeSheet();
        const { showReliefTimer } = await import("./exercise-timer.js");
        showReliefTimer(ctx, o, async ({ duration_s }) => {
          await logRelief(ctx, o.exercise_id, { duration_s, timed: true });
          toast("Relief logged.");
          onLogged?.();
        });
        return;
      }
      if (info) {
        const id = info.dataset.reliefInfo;
        const ex = ctx.exById?.[id] || {};
        const o = reliefById[id];
        const next = openSheet(`<h2>${esc(o?.label || ex.name || id)}</h2>
          ${ex.cues?.length ? `<h4>Cues</h4><ul>${ex.cues.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
          ${ex.stop_if && ex.stop_if !== "None." ? `<h4>Stop if</h4><p>${esc(ex.stop_if)}</p>` : ""}
          ${ex.contraindications && ex.contraindications !== "None." ? `<h4>Cautions</h4><p>${esc(ex.contraindications)}</p>` : ""}
          <div class="sheet-actions">
            <button class="btn" type="button" data-relief-log="${esc(id)}">Log now</button>
            ${o?.timed ? `<button class="btn primary" type="button" data-relief-timer="${esc(id)}">Start timer</button>` : ""}
            <button class="btn" type="button" data-close>Close</button>
          </div>`);
        bind(next);
      }
    };
  };
  bind(openSheet(pickerHtml(ctx)));
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
