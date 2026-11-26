// Plan view: current level criteria, rehabilitation milestones (target dates), and full L0-L8 overview.
import { esc, fmtDate, today } from "./dom.js";
import { flagsOf } from "../pain-flags.js";
import { reliefWeekHtml } from "./relief.js";
import { morningTrend } from "../checkins.js";
import { morningTrendHtml } from "./checkins.js";
import { MILESTONES, milestoneOn } from "../milestones.js";
import { localDate, addDays, dayDiff } from "../util.js";

const openMilestones = new Set(); // expanded milestone rows; all start condensed
let calMonth = null; // "YYYY-MM" shown in the calendar; null = this month
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (ymd) => `${MONTHS[+ymd.slice(5, 7) - 1]} ${+ymd.slice(8, 10)}`;
const mdy = (ymd) => `${md(ymd)}, ${ymd.slice(0, 4)}`;
const monthAdd = (ym, n) => { const t = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)); return t.toISOString().slice(0, 7); };
const OPEN_TAIL_DAYS = 42; // how much of open-ended L8 the bar draws

function rangeText(m, today) {
  if (!m.end) return `${mdy(m.start)} onward`;
  const from = m.start <= today && today <= m.end ? "Now" : m.start.slice(0, 4) === m.end.slice(0, 4) ? md(m.start) : mdy(m.start);
  return `${from} – ${mdy(m.end)}`;
}

function timelineHtml(ctx) {
  const today = localDate();
  const names = Object.fromEntries(ctx.docs.levels.levels.map((l) => [l.id, l.name]));
  const actual = ctx.state.level_id;
  const target = milestoneOn(today);
  const first = MILESTONES[0].start, lastM = MILESTONES[MILESTONES.length - 1];
  const barEnd = addDays(lastM.start, OPEN_TAIL_DAYS), span = dayDiff(barEnd, first);
  const firstYm = (today < first ? today : first).slice(0, 7), lastYm = monthAdd(lastM.start.slice(0, 7), 5);
  const ym = calMonth && calMonth >= firstYm && calMonth <= lastYm ? calMonth : today.slice(0, 7) < firstYm ? firstYm : today.slice(0, 7) > lastYm ? lastYm : today.slice(0, 7);

  const num = (id) => Number(id.replace("L", ""));
  let status = "";
  if (target && /^L[1-8]$/.test(actual)) {
    const diff = num(actual) - num(target.id);
    status = diff === 0 ? `On target: you're in ${esc(actual)}.` : diff > 0 ? `Ahead of target: you're in ${esc(actual)}, the target for today is ${esc(target.id)}.` : `You're in ${esc(actual)}; the target for today is ${esc(target.id)}. Progress still decides.`;
  }

  const bar = MILESTONES.map((m) => `<button type="button" class="tl-seg${m.end ? "" : " open"}" data-lv="${esc(m.id)}" data-cal-jump="${m.start.slice(0, 7)}" style="flex-grow:${dayDiff(m.end ? addDays(m.end, 1) : barEnd, m.start)}" title="${esc(m.id)} · ${esc(mdy(m.start))}"><span>${num(m.id)}</span></button>`).join("");
  const nowPct = Math.min(100, Math.max(0, (dayDiff(today, first) / span) * 100));
  const rows = MILESTONES.map((m) => {
    const open = openMilestones.has(m.id);
    return `<button type="button" class="ms-row${m.id === actual ? " cur" : ""}${open ? " open" : ""}" data-lv="${esc(m.id)}" data-ms-toggle="${esc(m.id)}" aria-expanded="${open}">
      <span class="ms-num" aria-hidden="true">${num(m.id)}</span>
      <span class="ms-title"><b>${esc(m.id)} · ${esc(names[m.id] || "")}</b>${m.id === actual ? `<span class="ms-here">You're here</span>` : ""}</span>
      <span class="ms-when">${esc(rangeText(m, today))}</span>
      <span class="ms-focus"${open ? "" : " hidden"}>${esc(m.length)} · ${esc(m.focus)}</span></button>`;
  }).join("");

  // month grid, Sunday first (weeks end on Saturday)
  const m1 = `${ym}-01`, lead = new Date(`${m1}T12:00:00Z`).getUTCDay();
  // always 6 full weeks so the calendar keeps one height; faded days from the adjacent months fill the gaps
  const total = 42, gridStart = addDays(m1, -lead);
  let cells = "";
  for (let i = 0; i < total; i++) {
    const d = addDays(gridStart, i), m = milestoneOn(d);
    const start = m && d === m.start, out = d.slice(0, 7) !== ym;
    const cls = [m ? "on" : "", out ? "out" : "", d === today ? "today" : "", d < today ? "past" : "", start ? "start" : ""].filter(Boolean).join(" ");
    cells += `<span class="${cls}"${m ? ` data-lv="${esc(m.id)}" title="${esc(m.id)}"` : ""}>${+d.slice(8, 10)}${start ? `<i>${esc(m.id)}</i>` : ""}</span>`;
  }

  return `<section class="card timeline">
    <div class="card-head">
      <h3>Rehabilitation milestones</h3>
      <p class="muted small">Dates are provisional targets, assuming symptoms and functional tests support progression.</p>
    </div>
    <div class="card-body">
    ${status ? `<p class="small ms-status">${status}</p>` : ""}
    <div class="tl-bar">${bar}<span class="tl-now" style="left:${nowPct}%" aria-hidden="true"></span></div>
    <div class="ms-rows">${rows}</div>
    <div class="cal">
      <div class="cal-head">
        <button type="button" class="btn icon" data-cal-step="-1" aria-label="Previous month"${ym > firstYm ? "" : " disabled"}>‹</button>
        <b>${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}</b>
        <button type="button" class="btn icon" data-cal-step="1" aria-label="Next month"${ym < lastYm ? "" : " disabled"}>›</button>
      </div>
      <div class="cal-grid cal-dow">${["S", "M", "T", "W", "T", "F", "S"].map((x) => `<span>${x}</span>`).join("")}</div>
      <div class="cal-grid" data-cal-month="${ym}">${cells}</div>
    </div>
    </div>
  </section>`;
}



async function fillMorningTrend(ctx, slot) {
  if (!slot || !ctx.store?.all) return;
  const checkins = await ctx.store.all("checkins");
  const html = morningTrendHtml(morningTrend(checkins));
  if (html) slot.outerHTML = html;
  else slot.remove();
}

async function fillReliefWeek(ctx, slot) {
  if (!slot || !ctx.store?.all) return;
  const recs = await ctx.store.all("days");
  const html = reliefWeekHtml(ctx, recs, today());
  if (html) slot.outerHTML = html;
  else slot.remove();
}

async function fillRecentFlags(ctx, slot) {
  if (!slot || !ctx.store?.all) return;
  const recs = await ctx.store.all("days");
  const rows = [];
  for (const rec of recs || []) {
    for (const f of flagsOf(rec)) rows.push({ date: rec.local_date, f });
  }
  rows.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : (a.f.ts < b.f.ts ? 1 : -1)));
  const latest = rows.slice(0, 8);
  if (!latest.length) return;
  const nameOf = (key) => ctx.exById?.[ctx.docs.levels.levels.flatMap((l) => l.items).find((it) => it.item_key === key)?.exercise_id]?.name || key;
  slot.outerHTML = `<section class="card"><div class="card-head"><h3>Recent pain flags</h3></div><div class="card-body">
    ${latest.map(({ date, f }) => `<p class="small">${esc(fmtDate(date))} · ${esc((f.item_key ? nameOf(f.item_key) : "Workout") + ": pain flagged")}</p>`).join("")}
  </div></section>`;
}

export function renderPlan(ctx, main) {
  const lv = ctx.level();
  const testUnit = (id) => ctx.docs.tests.tests.find((t) => t.id === id)?.unit || "";
  const testName = (id) => ctx.docs.tests.tests.find((t) => t.id === id)?.name || id;

  let html = `<section class="card">
    <div class="card-head">
      <h2>${esc(lv.id)} · ${esc(lv.name)}</h2>
      <p>${esc(lv.goal)}</p>
    </div>
    <div class="card-body">
    <h4>Leave this level when</h4><ul>
      ${lv.exit?.clean_streak_sessions ? `<li>${lv.exit.clean_streak_sessions} clean strength sessions in a row</li>` : ""}
      ${lv.exit?.all_non_optional_items_at_target ? `<li>All non-optional items at target</li>` : ""}
      ${(lv.exit?.tests || []).map((t) => `<li>Gate test ${esc(testName(t.test_id))}: ${esc(t.threshold?.value)}${typeof t.threshold?.value === "number" ? " " + esc(testUnit(t.test_id)) : ""}${t.threshold?.note ? ` (${esc(t.threshold.note)})` : ""}${t.optional ? " · optional" : ""}</li>`).join("")}
      ${(lv.exit?.extra || []).map((x) => `<li>${esc(x)}</li>`).join("")}
    </ul>
    ${lv.avoid?.length ? `<h4>Avoid</h4><ul class="avoid">${lv.avoid.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
    </div>
  </section>`;

  html += timelineHtml(ctx);

  html += `<section class="block"><h3>All levels</h3>${ctx.docs.levels.levels.map((l) => `
    <details class="lvl ${l.id === lv.id ? "cur" : ""}"><summary><b>${esc(l.id)}</b> ${esc(l.name)}</summary>
      <p class="small">${esc(l.goal)}</p>
      <p class="muted small">${l.items.length} items · ${(l.exit?.tests || []).length} gate tests${l.frequency?.strength_sessions_per_week ? ` · ${l.frequency.strength_sessions_per_week} strength sessions/week` : ""}</p>
    </details>`).join("")}</section>
    <p class="muted small center">Plan v${ctx.docs.levels.plan_version ?? 1} · ${ctx.docs.exercises.exercises.length} exercises · ${ctx.docs.tests.tests.length} tests</p>
    <div id="morning-trend"></div>
    <div id="relief-week"></div>
    <div id="recent-flags"></div>`;

  main.innerHTML = html;
  fillMorningTrend(ctx, main.querySelector("#morning-trend"));
  fillRecentFlags(ctx, main.querySelector("#recent-flags"));
  fillReliefWeek(ctx, main.querySelector("#relief-week"));
  main.onclick = (e) => {
    const row = e.target.closest("[data-ms-toggle]");
    if (row) {
      const id = row.dataset.msToggle, open = !openMilestones.has(id);
      if (open) openMilestones.add(id); else openMilestones.delete(id);
      row.classList.toggle("open", open);
      row.setAttribute("aria-expanded", String(open));
      row.querySelector(".ms-focus").hidden = !open;
      return;
    }
    const step = e.target.closest("[data-cal-step]");
    const jump = e.target.closest("[data-cal-jump]");
    if (step || jump) {
      const cur = main.querySelector("[data-cal-month]")?.dataset.calMonth || localDate().slice(0, 7);
      calMonth = jump ? jump.dataset.calJump : monthAdd(cur, Number(step.dataset.calStep));
      const y = window.scrollY;
      renderPlan(ctx, main);
      window.scrollTo(0, y);
      return;
    }
  };
}
