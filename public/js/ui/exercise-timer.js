// Countdown for timed-exercise doses, shown inside the exercise sheet (and a header chip if the sheet is closed).
import { currentDose } from "../engine.js";
import { formatDose, timedPlan } from "../dose.js";
import { unlockAudio, playAlarm, fmtClock, buzz, dingNotify } from "../audio.js";
import { $, esc, openSheet } from "./dom.js";

let sess = null; // { itemKey, name, plan, step, status, endsAt, remain, sound }
let sheetItem = null;
let clockStop = null;
let dingedFor = "";

const chip = () => document.getElementById("ex-timer-chip");
const stepOf = () => sess?.plan.steps[sess.step];
const remainMs = (now = Date.now()) => {
  if (!sess) return 0;
  if (sess.status === "running") return Math.max(0, sess.endsAt - now);
  return sess.remain ?? sess.plan.seconds * 1000;
};

function ensureClock() {
  if (clockStop) return;
  const tick = () => render();
  let worker = null;
  try {
    const url = URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),250)"], { type: "text/javascript" }));
    worker = new Worker(url); worker.onmessage = tick; URL.revokeObjectURL(url);
  } catch { worker = null; }
  const iv = worker ? null : setInterval(tick, 250);
  document.addEventListener("visibilitychange", tick);
  addEventListener("focus", tick);
  addEventListener("pageshow", tick);
  clockStop = () => { worker?.terminate(); if (iv) clearInterval(iv); clockStop = null; };
}

function stopClockIfIdle() {
  if (sess && (sess.status === "running" || sess.status === "paused")) return;
  if (!sess) { clockStop?.(); }
}

function fireDone() {
  const key = `${sess.itemKey}:${sess.step}:${sess.endsAt}`;
  if (dingedFor === key) return;
  dingedFor = key;
  const more = sess.step < sess.plan.steps.length - 1;
  sess.status = more ? "next" : "done";
  sess.remain = 0;
  sess.endsAt = null;
  if (sess.sound !== false) playAlarm("done") || playAlarm("end");
  buzz([300, 150, 300, 150, 300]);
  const st = stepOf();
  dingNotify(more ? `${st.label} done` : `${sess.name} done`, more ? "Start the next set when you're ready." : "All timed sets for this dose are done.", "pt-ex-timer");
}

export function showExercise(ctx, itemKey) {
  const it = ctx.docs.levels.levels.flatMap((l) => l.items).find((i) => i.item_key === itemKey);
  if (!it) return;
  const ex = ctx.exById[it.exercise_id] || {};
  const st = ctx.state.item_state[itemKey];
  const { dose, rung, easy } = currentDose(ctx.state, it);
  const plan = timedPlan(dose, it);
  const ladder = it.rungs
    .map((r, n) => `<li class="${st && st.rung === n ? "cur" : ""}">${esc(formatDose(r, it, ctx.profile))}${n === it.target_rung ? " (target)" : ""}</li>`)
    .join("");
  sheetItem = itemKey;
  openSheet(`
    <h2>${esc(ex.name || it.exercise_id)}</h2>
    <p class="muted small">${esc(it.item_key)} · ${esc(ex.category || "")} · rest ${it.rest_s ?? "-"} s${easy ? " · easy-dose sets" : ""}</p>
    ${ex.cues?.length ? `<h4>Cues</h4><ul>${ex.cues.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
    ${plan ? timerHtml(plan, formatDose(dose, it, ctx.profile), rung) : ""}
    <h4>Ladder</h4><ol class="ladder">${ladder}</ol>
    ${ex.stop_if ? `<h4>Stop if</h4><p>${esc(ex.stop_if)}</p>` : ""}
    ${ex.contraindications ? `<h4>Cautions</h4><p>${esc(ex.contraindications)}</p>` : ""}
    ${ex.equipment?.length ? `<h4>Equipment</h4><p>${esc(ex.equipment.join(", "))}</p>` : ""}
    ${it.requires?.length ? `<p class="muted small">Unlocks after: ${esc(it.requires.join(", "))}</p>` : ""}`, {
    onClose: () => { if (sheetItem === itemKey) sheetItem = null; render(); },
  });
  if (plan) {
    // Re-open keeps an in-progress timer; a different exercise keeps running in the chip until Start is pressed here.
    if (!sess || sess.itemKey !== itemKey || sess.plan.seconds !== plan.seconds || sess.plan.steps.length !== plan.steps.length) {
      if (!sess || sess.itemKey !== itemKey || sess.status === "idle" || sess.status === "done") {
        sess = { itemKey, name: ex.name || it.exercise_id, plan, step: 0, status: "idle", endsAt: null, remain: plan.seconds * 1000, sound: ctx.app?.timer_sound };
      } else if (sess.itemKey !== itemKey) {
        // Leave the other exercise running in the chip; this sheet shows a fresh idle plan until they press Start.
      }
    }
    wireSheet(ctx, it, ex, plan);
    render();
  }
}

function timerHtml(plan, doseText) {
  const dur = plan.seconds >= 60 && plan.seconds % 60 === 0 ? `${plan.seconds / 60} min` : `${plan.seconds} s`;
  const sets = plan.steps.length;
  return `<div class="ex-timer" id="ex-timer">
    <h4>Timer</h4>
    <p class="muted small">Current dose: ${esc(doseText)}. ${sets > 1 ? `${sets} timed bouts of ${dur}.` : `One ${dur} countdown.`} The clock uses wall time, so it stays honest if you switch apps.</p>
    <div class="ex-timer-step" id="ex-timer-step"></div>
    <div class="ex-timer-count" id="ex-timer-count" aria-live="polite">${fmtClock(plan.seconds * 1000)}</div>
    <div class="ex-timer-actions">
      <button class="btn primary" type="button" data-ex-act="start" id="ex-timer-start">Start</button>
      <button class="btn" type="button" data-ex-act="pause" id="ex-timer-pause" hidden>Pause</button>
      <button class="btn" type="button" data-ex-act="reset" id="ex-timer-reset">Reset</button>
    </div>
    <p class="muted small" id="ex-timer-hint"></p>
  </div>`;
}

function wireSheet(ctx, it, ex, plan) {
  const root = $("#ex-timer");
  if (!root) return;
  root.onclick = (e) => {
    const act = e.target.closest("[data-ex-act]")?.dataset.exAct;
    if (!act) return;
    if (act === "start") start(ctx, it, ex, plan);
    else if (act === "pause") pause();
    else if (act === "reset") reset(it, ex, plan);
  };
}

function adopt(ctx, it, ex, plan) {
  sess = { itemKey: it.item_key, name: ex.name || it.exercise_id, plan, step: 0, status: "idle", endsAt: null, remain: plan.seconds * 1000, sound: ctx.app?.timer_sound };
}

function start(ctx, it, ex, plan) {
  unlockAudio();
  if (!sess || sess.itemKey !== it.item_key) adopt(ctx, it, ex, plan);
  if (sess.status === "done") { sess.step = 0; sess.status = "idle"; sess.remain = sess.plan.seconds * 1000; }
  if (sess.status === "next") { sess.step += 1; sess.remain = sess.plan.seconds * 1000; }
  sess.status = "running";
  sess.endsAt = Date.now() + (sess.remain || sess.plan.seconds * 1000);
  dingedFor = "";
  ensureClock();
  render();
}

function pause() {
  if (!sess || sess.status !== "running") return;
  sess.remain = remainMs();
  sess.status = "paused";
  sess.endsAt = null;
  render();
}

function reset(it, ex, plan) {
  const name = ex?.name || sess?.name || it?.exercise_id;
  const key = it?.item_key || sess?.itemKey;
  const p = plan || sess?.plan;
  sess = { itemKey: key, name, plan: p, step: 0, status: "idle", endsAt: null, remain: p.seconds * 1000, sound: sess?.sound };
  dingedFor = "";
  render();
  stopClockIfIdle();
}

function render() {
  if (sess?.status === "running" && remainMs() <= 0) fireDone();
  const st = stepOf();
  const ms = remainMs();
  const running = sess?.status === "running";
  const paused = sess?.status === "paused";
  const next = sess?.status === "next";
  const done = sess?.status === "done";
  const inSheet = sheetItem && sess && sheetItem === sess.itemKey;
  const box = inSheet ? $("#ex-timer") : null;
  if (box) {
    const stepEl = $("#ex-timer-step", box);
    const countEl = $("#ex-timer-count", box);
    const startBtn = $("#ex-timer-start", box);
    const pauseBtn = $("#ex-timer-pause", box);
    const hint = $("#ex-timer-hint", box);
    if (stepEl) stepEl.textContent = st ? st.label : "";
    if (countEl) {
      countEl.textContent = done ? "Done" : next ? "Done" : fmtClock(ms);
      countEl.classList.toggle("done", done || next);
    }
    if (startBtn) {
      startBtn.hidden = running;
      startBtn.textContent = paused ? "Resume" : next ? (sess.step + 2 <= sess.plan.steps.length ? `Start ${sess.plan.steps[sess.step + 1].label}` : "Start next") : done ? "Start over" : "Start";
    }
    if (pauseBtn) pauseBtn.hidden = !running;
    if (hint) {
      hint.textContent = next && sess.plan.rest_s
        ? `Rest ${sess.plan.rest_s} s, then start the next one when you're ready.`
        : done ? "All timed sets for this dose are done."
        : paused ? "Paused."
        : running ? "" : "Starts a countdown for this dose. Pause or reset any time.";
    }
  }
  const c = chip();
  if (c) {
    const show = !!(sess && (running || paused || next) && !inSheet);
    c.hidden = !show;
    if (show) {
      const label = next ? "done — next" : fmtClock(ms);
      c.textContent = `⏱ ${label} · ${sess.name}`;
      c.classList.toggle("due", next);
    }
  }
  stopClockIfIdle();
}

export function wireExerciseTimerChip(ctx) {
  const c = chip();
  if (!c || c.dataset.wired) return;
  c.dataset.wired = "1";
  c.onclick = () => { if (sess) showExercise(ctx, sess.itemKey); };
}

export { timedPlan };
