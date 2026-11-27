// Countdown for timed-exercise doses (with Next, 15 s rest, and auto-continue)
// and a set counter for untimed (rep-based) doses. Also hosts the pain-flag panel.
import { currentDose } from "../engine.js";
import { formatDose, timedPlan, setPlan } from "../dose.js";
import { unlockAudio, playAlarm, playCue, fmtClock, buzz, dingNotify } from "../audio.js";
import { REST_SEC, needsRestAfter, restCuesToPlay, isItemFlagged, advanceTimerByNext } from "../pain-flags.js";
import { $, esc, openSheet, today, toast } from "./dom.js";
import { loadDay, saveDay, flagToggleHtml, wireFlagToggle } from "./pain-flag.js";
import { clearItemProgress, itemSheetTailHtml } from "../item-progress.js";

let sess = null; // { itemKey, name, plan, step, status, endsAt, remain, restEndsAt, restPrev, sound }
let sheetItem = null;
let clockStop = null;
let dingedFor = "";
let lastRestRemain = null;
let ctxRef = null;
let setCtl = null; // set-counter hooks while a details sheet is open

const chip = () => document.getElementById("ex-timer-chip");
const stepOf = () => sess?.plan.steps[sess.step];
const remainMs = (now = Date.now()) => {
  if (!sess) return 0;
  if (sess.status === "running") return Math.max(0, sess.endsAt - now);
  if (sess.status === "rest") return Math.max(0, sess.restEndsAt - now);
  return sess.remain ?? sess.plan.seconds * 1000;
};
const soundOn = () => sess?.sound !== false;
const autoOn = () => ctxRef?.app?.timer_auto_continue === true;

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
  if (sess && (sess.status === "running" || sess.status === "paused" || sess.status === "rest")) return;
  if (!sess) { clockStop?.(); }
}

function fireDone() {
  const key = `${sess.itemKey}:${sess.step}:${sess.endsAt || "next"}`;
  if (dingedFor === key) return;
  dingedFor = key;
  const more = needsRestAfter(sess.step, sess.plan.steps.length);
  if (soundOn()) void playAlarm("done");
  buzz([300, 150, 300, 150, 300]);
  const st = stepOf();
  if (more) {
    sess.status = "rest";
    sess.remain = 0;
    sess.endsAt = null;
    sess.restEndsAt = Date.now() + REST_SEC * 1000;
    lastRestRemain = REST_SEC * 1000 + 1;
    dingNotify(`${st?.label || "Set"} done`, `Rest ${REST_SEC} s, then the next one.`, "pt-ex-timer");
    ensureClock();
  } else {
    sess.status = "done";
    sess.remain = 0;
    sess.endsAt = null;
    dingNotify(`${sess.name} done`, "All timed sets for this dose are done.", "pt-ex-timer");
    finishReliefOrItem();
  }
}

function finishRest() {
  if (!sess || sess.status !== "rest") return;
  if (autoOn()) startNextSet();
  else {
    sess.status = "ready";
    sess.restEndsAt = null;
    sess.remain = sess.plan.seconds * 1000;
  }
}

function startNextSet() {
  if (!sess) return;
  sess.step += 1;
  sess.status = "running";
  sess.remain = sess.plan.seconds * 1000;
  sess.endsAt = Date.now() + sess.remain;
  sess.restEndsAt = null;
  dingedFor = "";
  lastRestRemain = null;
  ensureClock();
}

function skipRest() {
  if (!sess || (sess.status !== "rest" && sess.status !== "ready")) return;
  startNextSet();
}

async function saveAuto(on) {
  if (!ctxRef) return;
  ctxRef.app = { ...ctxRef.app, timer_auto_continue: !!on };
  await ctxRef.store.kvSet("app", ctxRef.app);
}

export async function showExercise(ctx, itemKey) {
  const it = ctx.docs.levels.levels.flatMap((l) => l.items).find((i) => i.item_key === itemKey);
  if (!it) return;
  const ex = ctx.exById[it.exercise_id] || {};
  const st = ctx.state.item_state[itemKey];
  const { dose, rung, easy } = currentDose(ctx.state, it);
  const plan = timedPlan(dose, it);
  const sets = plan ? null : setPlan(dose);
  const ladder = it.rungs
    .map((r, n) => `<li class="${st && st.rung === n ? "cur" : ""}">${esc(formatDose(r, it, ctx.profile))}${n === it.target_rung ? " (target)" : ""}</li>`)
    .join("");
  sheetItem = itemKey;
  ctxRef = ctx;
  setCtl = null;
  const flagged = isItemFlagged(await loadDay(ctx), itemKey);
  openSheet(`
    <h2>${esc(ex.name || it.exercise_id)}</h2>
    <p class="muted small">${esc(it.item_key)} · ${esc(ex.category || "")} · rest ${it.rest_s ?? "-"} s${easy ? " · easy-dose sets" : ""}</p>
    ${ex.cues?.length ? `<h4>Cues</h4><ul>${ex.cues.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
    ${plan ? timerHtml(plan, formatDose(dose, it, ctx.profile), ctx) : ""}
    ${sets ? setCounterHtml(sets, formatDose(dose, it, ctx.profile)) : ""}
    <h4>Ladder</h4><ol class="ladder">${ladder}</ol>
    ${ex.stop_if ? `<h4>Stop if</h4><p>${esc(ex.stop_if)}</p>` : ""}
    ${ex.contraindications ? `<h4>Cautions</h4><p>${esc(ex.contraindications)}</p>` : ""}
    ${ex.equipment?.length ? `<h4>Equipment</h4><p>${esc(ex.equipment.join(", "))}</p>` : ""}
    ${it.requires?.length ? `<p class="muted small">Unlocks after: ${esc(it.requires.join(", "))}</p>` : ""}
    ${itemSheetTailHtml(`<div class="pain-flag" id="pain-flag">${flagToggleHtml(itemKey, flagged)}</div>`)}`, {
    onClose: () => { if (sheetItem === itemKey) { sheetItem = null; setCtl = null; } render(); },
  });
  wireFlagToggle($("#pain-flag"), ctx, itemKey);
  wireFinish(ctx, it, ex);
  if (plan) {
    if (!sess || sess.itemKey !== itemKey || sess.plan.seconds !== plan.seconds || sess.plan.steps.length !== plan.steps.length) {
      if (!sess || sess.itemKey !== itemKey || sess.status === "idle" || sess.status === "done") {
        sess = { itemKey, name: ex.name || it.exercise_id, plan, step: 0, status: "idle", endsAt: null, remain: plan.seconds * 1000, sound: ctx.app?.timer_sound };
      }
    }
    wireTimer(ctx, it, ex, plan);
    render();
  }
  if (sets) wireSets(ctx, it, sets).catch((e) => console.warn(e));
}

function autoToggleHtml(ctx) {
  const on = ctx?.app?.timer_auto_continue === true;
  return `<label class="toggle auto-continue"><input type="checkbox" data-ex-act="auto" ${on ? "checked" : ""}><span>Auto-continue</span></label>`;
}

function timerHtml(plan, doseText, ctx) {
  const dur = plan.seconds >= 60 && plan.seconds % 60 === 0 ? `${plan.seconds / 60} min` : `${plan.seconds} s`;
  const sets = plan.steps.length;
  const restNote = sets > 1 ? ` A ${REST_SEC} s rest comes between bouts.` : "";
  return `<div class="ex-timer" id="ex-timer">
    <h4>Timer</h4>
    <p class="muted small">Current dose: ${esc(doseText)}. ${sets > 1 ? `${sets} timed bouts of ${dur}.` : `One ${dur} countdown.`} The clock uses wall time, so it stays honest if you switch apps.${restNote}</p>
    <div class="ex-timer-step" id="ex-timer-step"></div>
    <div class="ex-timer-count" id="ex-timer-count" aria-live="polite">${fmtClock(plan.seconds * 1000)}</div>
    <div class="ex-timer-actions">
      <button class="btn primary btn-lg" type="button" data-ex-act="start" id="ex-timer-start">Start</button>
      <button class="btn primary btn-lg" type="button" data-ex-act="next" id="ex-timer-next">Next</button>
      <button class="btn" type="button" data-ex-act="reset" id="ex-timer-reset">Reset</button>
    </div>
    ${sets > 1 ? autoToggleHtml(ctx) : ""}
    <p class="muted small" id="ex-timer-hint"></p>
  </div>`;
}

function setCounterHtml(plan, doseText) {
  return `<div class="ex-timer set-counter" id="ex-sets">
    <h4>Sets</h4>
    <p class="muted small">Current dose: ${esc(doseText)}. Tap Next after each set. Reset starts over.</p>
    <div class="ex-timer-step" id="ex-sets-step">Set 1 of ${plan.sets}</div>
    <div class="ex-timer-count" id="ex-sets-count" aria-live="polite">1<span class="ex-sets-of">/${plan.sets}</span></div>
    <div class="ex-timer-actions">
      <button class="btn primary btn-lg" type="button" data-set-act="next" id="ex-sets-next">Next</button>
      <button class="btn btn-lg" type="button" data-set-act="reset" id="ex-sets-reset">Reset</button>
    </div>
    <p class="muted small" id="ex-sets-hint"></p>
  </div>`;
}

function wireTimer(ctx, it, ex, plan) {
  const root = $("#ex-timer");
  if (!root) return;
  root.onclick = (e) => {
    const act = e.target.closest("[data-ex-act]")?.dataset.exAct;
    if (!act) return;
    if (act === "start") {
      if (sess?.itemKey === it.item_key && sess.status === "running") pause();
      else start(ctx, it, ex, plan);
    } else if (act === "reset") reset(it, ex, plan);
    else if (act === "next") next(ctx, it, ex, plan);
  };
  root.onchange = (e) => {
    if (e.target.closest("[data-ex-act=auto]")) {
      saveAuto(e.target.checked).catch(() => {});
      render();
    }
  };
}

function adopt(ctx, it, ex, plan) {
  sess = { itemKey: it.item_key, name: ex.name || it.exercise_id, plan, step: 0, status: "idle", endsAt: null, remain: plan.seconds * 1000, sound: ctx.app?.timer_sound };
}

function start(ctx, it, ex, plan) {
  unlockAudio();
  if (!sess || sess.itemKey !== it.item_key) adopt(ctx, it, ex, plan);
  if (sess.status === "done") { sess.step = 0; sess.status = "idle"; sess.remain = sess.plan.seconds * 1000; }
  if (sess.status === "ready" || sess.status === "next") return startNextSet(), render();
  if (sess.status === "rest") return skipRest(), render();
  sess.status = "running";
  sess.endsAt = Date.now() + (sess.remain || sess.plan.seconds * 1000);
  dingedFor = "";
  ensureClock();
  render();
}

function next(ctx, it, ex, plan) {
  unlockAudio();
  if (!sess || sess.itemKey !== it.item_key) adopt(ctx, it, ex, plan);
  if (sess.status === "done") return;
  const { sess: nextSess, ding, markDone } = advanceTimerByNext(sess, Date.now());
  sess = nextSess;
  if (ding) {
    const key = `${sess.itemKey}:${sess.step}:${sess.status}`;
    if (dingedFor !== key) {
      dingedFor = key;
      if (soundOn()) void playAlarm("done");
      buzz([300, 150, 300, 150, 300]);
    }
  }
  if (sess.status === "rest") {
    lastRestRemain = REST_SEC * 1000 + 1;
    const st = stepOf();
    dingNotify(`${st?.label || "Set"} done`, `Rest ${REST_SEC} s, then the next one.`, "pt-ex-timer");
    ensureClock();
  } else if (markDone) {
    dingNotify(`${sess.name} done`, "All timed sets for this dose are done.", "pt-ex-timer");
    finishReliefOrItem();
  }
  render();
  stopClockIfIdle();
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
  lastRestRemain = null;
  render();
  stopClockIfIdle();
}

function render() {
  if (sess?.status === "running" && remainMs() <= 0) fireDone();
  if (sess?.status === "rest") {
    const ms = remainMs();
    if (lastRestRemain != null && soundOn()) {
      for (const cue of restCuesToPlay(lastRestRemain, ms)) void playCue(cue);
    }
    lastRestRemain = ms;
    if (ms <= 0) finishRest();
  }
  const st = stepOf();
  const ms = remainMs();
  const running = sess?.status === "running";
  const paused = sess?.status === "paused";
  const rest = sess?.status === "rest";
  const ready = sess?.status === "ready" || sess?.status === "next";
  const done = sess?.status === "done";
  const inSheet = sheetItem && sess && sheetItem === sess.itemKey;
  const box = inSheet ? $("#ex-timer") : null;
  if (box) {
    const stepEl = $("#ex-timer-step", box);
    const countEl = $("#ex-timer-count", box);
    const startBtn = $("#ex-timer-start", box);
    const nextBtn = $("#ex-timer-next", box);
    const hint = $("#ex-timer-hint", box);
    const more = sess && needsRestAfter(sess.step, sess.plan.steps.length);
    if (stepEl) {
      stepEl.textContent = rest ? "Rest" : ready && sess.plan.steps[sess.step + 1] ? sess.plan.steps[sess.step + 1].label : (st ? st.label : "");
    }
    if (countEl) {
      countEl.textContent = done ? "Done" : ready ? "Ready" : fmtClock(ms);
      countEl.classList.toggle("done", done || ready);
      countEl.classList.toggle("rest", rest);
    }
    if (startBtn) {
      startBtn.hidden = false;
      startBtn.textContent = running ? "Pause" : paused ? "Resume" : (ready || rest) ? (sess.plan.steps[sess.step + 1]?.label ? `Start ${sess.plan.steps[sess.step + 1].label}` : "Start next") : "Start";
    }
    if (nextBtn) {
      nextBtn.hidden = !!done;
      nextBtn.textContent = rest ? "Skip rest" : ready ? "Next" : (more ? "Next" : "Finish");
    }
    const autoEl = box.querySelector("[data-ex-act=auto]");
    if (autoEl && autoEl.checked !== autoOn()) autoEl.checked = autoOn();
    if (hint) {
      hint.textContent = rest
        ? (autoOn() ? `Rest ${REST_SEC} s. The next set starts on its own after the go cue. Next skips the rest without starting the clock.` : `Rest ${REST_SEC} s. Start begins the next bout; Next skips the rest without starting the clock.`)
        : ready
          ? "Rest is over. Start begins the next bout; Next marks it done without running it."
          : done ? "All timed sets for this dose are done."
          : paused ? "Paused."
          : running ? (more ? "Next ends this bout and starts the rest." : "Next ends this bout and finishes the dose.")
          : "Start runs a countdown. Next marks this bout done and moves the count up, without starting the clock.";
    }
  }
  const c = chip();
  if (c) {
    const show = !!(sess && (running || paused || rest || ready) && !inSheet);
    c.hidden = !show;
    if (show) {
      const label = rest ? `rest ${fmtClock(ms)}` : ready ? "ready" : fmtClock(ms);
      c.textContent = `⏱ ${label} · ${sess.name}`;
      c.classList.toggle("due", ready || rest);
    }
  }
  stopClockIfIdle();
}

async function wireSets(ctx, it, plan) {
  const root = $("#ex-sets");
  if (!root) return;
  const day0 = await loadDay(ctx);
  const saved = day0.set_progress?.[it.item_key];
  let current = Math.min(Math.max(1, saved?.current || 1), plan.sets);
  let finished = !!saved?.done && current >= plan.sets;
  if (finished) current = plan.sets;

  const paint = () => {
    const step = $("#ex-sets-step", root);
    const count = $("#ex-sets-count", root);
    const nextBtn = $("#ex-sets-next", root);
    const hint = $("#ex-sets-hint", root);
    if (finished) {
      if (step) step.textContent = `All ${plan.sets} sets done`;
      if (count) { count.textContent = "Done"; count.classList.add("done"); }
      if (nextBtn) { nextBtn.textContent = "Finish"; nextBtn.hidden = true; }
      if (hint) hint.textContent = "This item is marked done for today. Uncheck it on Today if you need to recount.";
    } else {
      if (nextBtn) nextBtn.hidden = false;
      if (step) step.textContent = `Set ${current} of ${plan.sets}`;
      if (count) { count.innerHTML = `${current}<span class="ex-sets-of">/${plan.sets}</span>`; count.classList.remove("done"); }
      if (nextBtn) nextBtn.textContent = current >= plan.sets ? "Finish" : "Next";
      if (hint) hint.textContent = current >= plan.sets ? "Last set — Finish marks this item done." : "Tap Next when you finish this set.";
    }
  };

  const persist = async () => {
    const day = await loadDay(ctx);
    day.set_progress = { ...(day.set_progress || {}), [it.item_key]: { current, done: finished } };
    await saveDay(ctx, day);
  };

  root.onclick = async (e) => {
    const act = e.target.closest("[data-set-act]")?.dataset.setAct;
    if (!act) return;
    if (act === "reset") {
      current = 1;
      finished = false;
      await persist();
      unmarkItem(it.item_key);
      paint();
      return;
    }
    if (act === "next") {
      unlockAudio();
      if (finished) return;
      if (current >= plan.sets) {
        finished = true;
        await persist();
        markItemDone(it.item_key);
        if (ctx.app?.timer_sound !== false) void playAlarm("done");
        buzz([300, 150, 300, 150, 300]);
        paint();
        toast(`${(ctx.exById[it.exercise_id] || {}).name || "Item"} marked done.`);
        return;
      }
      current += 1;
      await persist();
      paint();
    }
  };
  paint();
  setCtl = {
    markFinished: async () => {
      if (finished) return;
      current = plan.sets;
      finished = true;
      await persist();
      paint();
    },
    resetFromUncheck: () => {
      current = 1;
      finished = false;
      paint();
    },
  };
}

function wireFinish(ctx, it, ex) {
  const btn = document.querySelector("[data-ex-finish]");
  if (!btn) return;
  btn.onclick = () => completeItem(ctx, it, ex);
}

async function completeItem(ctx, it, ex) {
  const name = (ex || ctx.exById[it.exercise_id] || {}).name || "Item";
  if (setCtl) await setCtl.markFinished();
  if (sess?.itemKey === it.item_key && sess.status !== "done") {
    sess.status = "done";
    sess.remain = 0;
    sess.endsAt = null;
    render();
    stopClockIfIdle();
  }
  markItemDone(it.item_key);
  if (ctx.app?.timer_sound !== false) void playAlarm("done");
  buzz([300, 150, 300, 150, 300]);
  toast(`${name} marked done.`);
}

/** Today-row uncheck is the reset path: clear an open timer or set counter for this item. */
export function onItemUnchecked(itemKey) {
  if (sess?.itemKey === itemKey) {
    sess = { ...sess, step: 0, status: "idle", endsAt: null, remain: sess.plan.seconds * 1000, restEndsAt: null };
    dingedFor = "";
    lastRestRemain = null;
    render();
    stopClockIfIdle();
  }
  setCtl?.resetFromUncheck?.();
}

export { clearItemProgress };

function markItemDone(itemKey) {
  syncCheckbox(itemKey, true);
}
function unmarkItem(itemKey) {
  syncCheckbox(itemKey, false);
}
function syncCheckbox(itemKey, done) {
  const key = (window.CSS && CSS.escape) ? CSS.escape(itemKey) : itemKey.replace(/"/g, '\\"');
  const cb = document.querySelector(`input[data-item="${key}"], input[data-wk-item="${key}"]`);
  if (!cb || cb.disabled || cb.checked === done) return;
  cb.checked = done;
  cb.dispatchEvent(new Event("change", { bubbles: true }));
}

function finishReliefOrItem() {
  if (sess?.onReliefDone) {
    const cb = sess.onReliefDone;
    sess.onReliefDone = null;
    Promise.resolve(cb({ duration_s: sess.plan.seconds })).catch(() => {});
    return;
  }
  if (sess?.itemKey && !String(sess.itemKey).startsWith("relief:")) markItemDone(sess.itemKey);
}

export function showReliefTimer(ctx, opt, onDone) {
  const catalog = ctx.exById?.[opt.exercise_id] || {};
  const ex = {
    ...catalog,
    name: opt.label || catalog.name || opt.exercise_id,
    ...(opt.cues ? { cues: opt.cues } : {}),
    ...(opt.stop_if ? { stop_if: opt.stop_if } : {}),
    ...(opt.contraindications ? { contraindications: opt.contraindications } : {}),
  };
  const name = ex.name;
  const seconds = opt.seconds || 180;
  const plan = { seconds, steps: [{ label: name, seconds }] };
  const it = { item_key: `relief:${opt.exercise_id}`, exercise_id: opt.exercise_id, rest_s: 0 };
  sheetItem = it.item_key;
  ctxRef = ctx;
  openSheet(`
    <h2>${esc(name)}</h2>
    <p class="muted small">${esc(opt.range || "Timed relief")}. Start runs the countdown. Logging a count is done with the stepper on Today, not by finishing the timer.</p>
    ${ex.cues?.length ? `<h4>Cues</h4><ul>${ex.cues.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
    ${timerHtml(plan, opt.range || name, ctx)}
    ${ex.stop_if && ex.stop_if !== "None." ? `<h4>Stop if</h4><p>${esc(ex.stop_if)}</p>` : ""}
    ${ex.contraindications && ex.contraindications !== "None." ? `<h4>Cautions</h4><p>${esc(ex.contraindications)}</p>` : ""}
  `, { onClose: () => { if (sheetItem === it.item_key) sheetItem = null; render(); } });
  if (!sess || sess.itemKey !== it.item_key || sess.status === "idle" || sess.status === "done") {
    sess = { itemKey: it.item_key, name, plan, step: 0, status: "idle", endsAt: null, remain: seconds * 1000, sound: ctx.app?.timer_sound, onReliefDone: onDone };
  }
  wireTimer(ctx, it, ex, plan);
  render();
}

export function wireExerciseTimerChip(ctx) {
  const c = chip();
  if (!c || c.dataset.wired) return;
  c.dataset.wired = "1";
  c.onclick = () => {
    if (!sess) return;
    if (String(sess.itemKey).startsWith("relief:")) {
      const id = String(sess.itemKey).slice("relief:".length);
      showReliefTimer(ctx, { exercise_id: id, label: sess.name, seconds: sess.plan?.seconds });
      return;
    }
    showExercise(ctx, sess.itemKey);
  };
}

export { timedPlan, REST_SEC, needsRestAfter, restCuesToPlay, advanceTimerByNext };
