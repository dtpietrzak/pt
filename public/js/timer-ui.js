// Work timer screen + alarm loop. The state machine is pure (posture.js); this file owns the clock loop,
// audio, notifications and persistence. Timer state lives in IndexedDB (kv "timer") and syncs through Firestore,
// so every device sees it; alarms ring only on the device that started work mode unless the app setting says otherwise.
import {
  TIMER_KEY, LAST_FALLBACK_KEY, SORENESS_LEVELS, postureLogKey, startTimer, switchPhase, soreEarly, snooze, stopTimer, tick, isDue, deadlineOf, remainingMs,
  snoozesLeft, followingPhase, phaseMinutes, phaseName, timerSettings, summarizeBlocks, postureDailyLog, inWorkHours, postureConfig, initPostureState,
  applyPosture, evaluateSorenessTrend, workDayPostureEvent,
} from "./posture.js";
import { manualEvent } from "./engine.js";
import { localDate, isoLocal } from "./util.js";
import { openSheet, closeSheet, confirmSheet } from "./ui/dom.js";
import { unlockAudio, audioReady, playAlarm, fmtClock } from "./audio.js";
export { unlockAudio, audioReady, playAlarm, fmtClock };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICON = { stand: "🧍", walk: "🚶", sit: "🪑", decompress: "🛏️" };
const SORENESS_BY_ID = Object.fromEntries(SORENESS_LEVELS.map((s) => [s.id, s]));
const REPEAT_MS = 60000, MAX_REPEATS = 15;

export function deviceId() {
  let id = localStorage.getItem("pt-device-id");
  if (!id) { id = "D" + Math.random().toString(36).slice(2, 10); localStorage.setItem("pt-device-id", id); }
  return id;
}
const fmtMin = (m) => `${Number.isInteger(m) ? m : m.toFixed(1)} min`;

// ---------------------------------------------------------------- audio + notifications
export async function askNotifications() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  try { await Notification.requestPermission(); } catch { /* ignore */ }
}
async function notify(title, body, tag = "pt-timer") {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const opts = { body, tag, renotify: true, requireInteraction: true, icon: "icons/icon-192.png", badge: "icons/icon-192.png", vibrate: [200, 100, 200, 100, 200] };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) return await reg.showNotification(title, opts);
    new Notification(title, opts);
  } catch { try { new Notification(title, opts); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- 1 Hz clock that survives background throttling
// A dedicated worker's timers aren't throttled like a hidden tab's, and every tick recomputes from the wall clock anyway.
function startClock(fn) {
  let worker = null;
  try {
    const url = URL.createObjectURL(new Blob(["setInterval(()=>postMessage(0),1000)"], { type: "text/javascript" }));
    worker = new Worker(url); worker.onmessage = fn; URL.revokeObjectURL(url);
  } catch { worker = null; }
  const iv = worker ? null : setInterval(fn, 1000);
  document.addEventListener("visibilitychange", fn);
  addEventListener("focus", fn);
  addEventListener("pageshow", fn);
  return () => { worker?.terminate(); if (iv) clearInterval(iv); };
}

/** ctx() -> { docs, profile, app, state, exById }. */
export function createTimerUI({ store, ctx, setState, toast, root, chip }) {
  let timer = null, loaded = false, ring = { key: null, count: 0, last: 0 }, fallbackCheckedFor = null;
  const dev = deviceId();
  const cfg = () => postureConfig() || ctx().docs.posture;
  const settings = () => timerSettings(ctx().profile, cfg());
  const doses = () => ctx().state?.posture_cycle || initPostureState(cfg(), ctx().state?.level_id);
  const isAlarmDevice = () => !!timer && (ctx().app.timer_alarm_all_devices || !timer.device_id || timer.device_id === dev);

  async function load() { timer = (await store.kvGet(TIMER_KEY)) || null; loaded = true; }
  async function save(t, prev) {
    timer = t; await store.kvSet(TIMER_KEY, t);
    if (prev) await logClosed(prev, t);
    update(true);
  }
  async function logClosed(prev, t) {
    const nb = t.blocks.slice(prev.session_id === t.session_id ? prev.blocks.length : 0);
    if (!nb.length) return;
    const ne = t.early_switches.slice(prev.session_id === t.session_id ? prev.early_switches.length : 0);
    const date = t.local_date, key = postureLogKey(date);
    const log = (await store.kvGet(key)) || { local_date: date, blocks: [], early_switches: [] };
    log.blocks = [...log.blocks, ...nb.map((b) => ({ ...b, session_id: t.session_id }))];
    log.early_switches = [...log.early_switches, ...ne];
    const trend = evaluateSorenessTrend(log.blocks, log.early_switches);
    log.fallback = trend;
    await store.kvSet(key, log);
    const day = (await store.get("days", date)) || { local_date: date, level_id: ctx().state.level_id, checklist: [] };
    day.posture_cycle = postureDailyLog(log.blocks, log.early_switches, doses());
    if (trend.rated_count > 0 || log.early_switches.some((e) => e.reason === "sore_early")) {
      day.daily_status = trend.status;
      day.daily_status_reasons = trend.reasons;
    }
    await store.put("days", day);
  }

  /** Apply any unapplied previous workday's soreness trend to today's posture doses. */
  async function applyPendingFallback() {
    const todayStr = localDate(new Date());
    if (fallbackCheckedFor === todayStr || !ctx().state || !setState) return;
    fallbackCheckedFor = todayStr;
    const lastApplied = (await store.kvGet(LAST_FALLBACK_KEY)) || "";
    const allKv = await store.all("kv");
    const pending = allKv
      .filter((r) => typeof r.key === "string" && r.key.startsWith("posture:log:"))
      .map((r) => ({ date: r.key.slice("posture:log:".length), log: r.value }))
      .filter((x) => x.date < todayStr && x.date > lastApplied && x.log?.blocks?.length)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!pending.length) return;

    let st = ctx().state;
    let lastResult = null;
    for (const item of pending) {
      if (st.mode === "active" && st.level_id !== "L0") {
        const cur = st.posture_cycle || initPostureState(cfg(), st.level_id);
        const ev = workDayPostureEvent(item.log, cur);
        const r = applyPosture(cur, ev, cfg());
        st = { ...st, posture_cycle: r.state };
        lastResult = { date: item.date, ...r.result };
      }
      await store.kvSet(LAST_FALLBACK_KEY, item.date);
    }
    if (lastResult) {
      await setState(st);
      if (lastResult.outcome === "posture_regress") {
        toast(`Yesterday showed worsening soreness — stepped back to Stand ${st.posture_cycle.stand_min} / Sit ${st.posture_cycle.sit_min} min.`);
      } else if (lastResult.outcome === "posture_hold") {
        toast("Yesterday's soreness held today's posture doses steady.");
      } else if (lastResult.outcome === "posture_advance") {
        toast(`3 clean work days — advanced to Stand ${st.posture_cycle.stand_min} / Sit ${st.posture_cycle.sit_min} min.`);
      }
      update(true);
    }
  }

  async function triggerFlare({ confirmFirst = true } = {}) {
    const { state, docs } = ctx();
    if (!state || !setState) return false;
    if (state.mode === "red_stop") { toast("Plan is paused for a red flag."); return false; }
    if (state.level_id === "L0") { toast("Already in settle mode (L0)."); return false; }
    if (confirmFirst) {
      const ok = await confirmSheet({
        title: "Trigger flare mode (L0)?",
        body: "Switches to L0 settle mode with shorter blocks (Stand 25 · Sit 10 min) and decompression after every block until you have 2 green days.",
        confirmLabel: "Enter flare mode",
        danger: true,
      });
      if (!ok) return false;
    }
    const { state: nextState, log } = manualEvent(state, docs.levels, docs.config, { type: "flare" }, isoLocal());
    await setState(nextState, log);
    toast("Flare mode (L0) active — Stand 25 · Sit 10 min, decompress after each block.");
    update(true);
    return true;
  }

  function promptPhaseSoreness(phaseId, { subtitle = "" } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        resolve(val);
      };
      const label = phaseName(cfg(), phaseId);
      const rootEl = openSheet(`
        <h2>${ICON[phaseId] || ""} How did ${esc(label)} feel?</h2>
        <p class="sheet-copy">${esc(subtitle || "Check in so we can spot worsening soreness and adjust tomorrow's blocks.")}</p>
        <div class="sore-grid">
          ${SORENESS_LEVELS.map((s) => `
            <button class="sore-btn sore-${s.color}" type="button" data-sore="${s.id}">
              <span class="sore-dot" aria-hidden="true"></span>
              <span class="sore-text"><b>${esc(s.label)}</b><small>${esc(s.hint)}</small></span>
            </button>`).join("")}
        </div>
        <div class="sheet-actions">
          <button class="btn" type="button" data-skip-sore>Skip rating</button>
        </div>`, { onClose: () => finish(null) });

      rootEl.onclick = (e) => {
        const pick = e.target.closest("[data-sore]");
        if (pick) {
          finish({ soreness: pick.dataset.sore });
          closeSheet();
          return;
        }
        if (e.target.closest("[data-skip-sore]")) {
          finish({ soreness: null });
          closeSheet();
        }
      };
    });
  }

  // ---- actions
  async function start() {
    unlockAudio(); askNotifications();
    await applyPendingFallback();
    const prev = timer;
    await save(startTimer(doses(), Date.now(), { cfg: cfg(), settings: settings(), deviceId: dev }), prev);
  }
  const withNow = (fn) => async () => { const prev = timer; const next = fn(prev, Date.now()); if (next !== prev) await save(next, prev); };

  async function finishAndSwitch(how) {
    unlockAudio();
    if (!timer?.active) return;
    const picked = await promptPhaseSoreness(timer.phase, {
      subtitle: how === "sore_early"
        ? "Ending this block early — how sore are you right now?"
        : "Quick check before moving to the next phase.",
    });
    if (!picked) return; // dismissed without switching
    const prev = timer;
    const soreness = picked.soreness;
    const effectiveHow = soreness === "flare" && (prev.phase === "stand" || prev.phase === "sit") ? "sore_early" : how;
    if (soreness === "flare") {
      await triggerFlare({ confirmFirst: false });
    }
    const next = switchPhase(prev, Date.now(), doses(), effectiveHow, cfg(), soreness);
    if (next !== prev) await save(next, prev);
  }

  const actions = {
    start,
    switch: () => finishAndSwitch(isDue(timer, Date.now()) ? "alarm" : "manual"),
    skip: () => finishAndSwitch("manual"),
    sore: () => finishAndSwitch("sore_early"),
    snooze: withNow((t, now) => snooze(t, now, settings())),
    flare: () => triggerFlare({ confirmFirst: true }),
    stop: async () => {
      if (!timer?.active) return;
      const picked = await promptPhaseSoreness(timer.phase, {
        subtitle: "Stopping work mode — how did this last block feel?",
      });
      if (!picked) return;
      const prev = timer;
      if (picked.soreness === "flare") await triggerFlare({ confirmFirst: false });
      const next = stopTimer(prev, Date.now(), "manual", picked.soreness);
      if (next !== prev) await save(next, prev);
    },
  };

  // ---- the clock loop
  async function onTick() {
    if (!loaded || !ctx().docs?.posture) return;
    const now = Date.now();
    if (timer?.active) {
      const { timer: t2, events } = tick(timer, now, settings());
      if (events.length) {
        const mine = isAlarmDevice();
        // Only the alarm device applies the work-end stop (so it can remind); others only clean up a long-stale session.
        if (mine || events.includes("work_end_silent")) {
          await save(t2, timer);
          if (mine && events.includes("work_end_reminder")) {
            const msg = "Work hours are over. Take a 3-5 minute decompress now, then you're done for the day.";
            playAlarm("end"); notify("Work mode ended", msg, "pt-timer-end"); toast(msg);
          }
        }
      }
    }
    if (timer?.active && isDue(timer, now) && isAlarmDevice()) ringIfNeeded(now);
    else ring = { key: null, count: 0, last: 0 };
    update(false);
  }
  function ringIfNeeded(now) {
    const key = `${timer.session_id}|${timer.phase_started_at}|${timer.snoozes}`;
    if (ring.key !== key) ring = { key, count: 0, last: 0 };
    if (ring.count >= MAX_REPEATS || now - ring.last < (ring.count === 0 ? 0 : REPEAT_MS)) return;
    ring.count++; ring.last = now;
    const c = cfg(), { next } = followingPhase(c, timer, doses(), "alarm");
    const title = `${ICON[next] || ""} Time to ${next === "decompress" ? "decompress" : next} — ${fmtMin(phaseMinutes(doses(), next, c))}`;
    const body = `${phaseName(c, timer.phase)} block is done${timer.snoozes ? ` (snoozed ${timer.snoozes}×)` : ""}. Open PT to switch, snooze, or tap sore early.`;
    if (ctx().app.timer_sound !== false) playAlarm(next);
    notify(title, body);
    if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.([300, 150, 300]);
  }

  // ---- rendering
  function chipText() {
    if (!timer?.active) return null;
    const now = Date.now(), due = isDue(timer, now);
    return `${ICON[timer.phase]} ${due ? "switch!" : fmtClock(remainingMs(timer, now))}`;
  }
  let shape = "";
  function update(force) {
    const now = Date.now();
    const ct = chipText();
    if (chip) { chip.hidden = !ct; if (ct) { chip.textContent = ct; chip.classList.toggle("due", isDue(timer, now)); } }
    document.title = timer?.active && isDue(timer, now) ? `⏰ ${phaseName(cfg(), timer.phase)} done — PT` : "PT";
    if (!root.isConnected || !root.dataset.timerPage) return;
    const s = `${timer?.active}|${timer?.phase}|${timer?.phase_started_at}|${timer?.snoozes}|${timer?.stopped_at}|${timer?.device_id}|${timer?.active && isDue(timer, now)}|${audioReady()}|${window.Notification?.permission}`;
    if (force || s !== shape) { shape = s; draw(); }
    const cd = root.querySelector("#t-count");
    if (cd && timer?.active) {
      const due = isDue(timer, now);
      cd.textContent = due ? `+${fmtClock(now - deadlineOf(timer))}` : fmtClock(remainingMs(timer, now));
      const bar = root.querySelector("#t-bar");
      if (bar) bar.style.width = `${Math.min(100, Math.max(0, ((now - timer.phase_started_at) / (deadlineOf(timer) - timer.phase_started_at)) * 100))}%`;
    }
  }

  function dosesLine() {
    const d = doses();
    return `Stand ${d.stand_min} · Walk ${d.walk_min} · Sit ${d.sit_min} · Decompress ${d.decomp_min} min (${d.decomp_frequency === "after_each_block" ? "after each block" : "once per cycle"})`;
  }
  async function todayBlocks() { return (await store.kvGet(postureLogKey(localDate(new Date())))) || null; }
  const dlg = { hhmm: (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) };

  async function draw() {
    const c = cfg(), st = settings(), now = Date.now();
    const log = await todayBlocks();
    if (!root.isConnected) return;
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    const curState = ctx().state;
    const inFlare = curState?.level_id === "L0" || curState?.mode === "settle";
    const canFlare = !!curState && curState.level_id !== "L0" && curState.mode !== "red_stop";
    let html = "";
    if (!timer?.active) {
      const inside = inWorkHours(now, st);
      html += `<section class="card timer-card">
        <h2>Work mode</h2>
        <p class="small">Repeats <b>Stand → Walk → Sit → Decompress</b> and checks how you feel after each block to guard against flare-ups.</p>
        <p class="timer-doses">${esc(dosesLine())}</p>
        ${inFlare ? `<p class="flare-banner">Settle mode (L0) active — shorter blocks and decompression after each block.</p>` : ""}
        <button class="btn primary wide big" id="t-start" ${st.enabled === false ? "disabled" : ""}>Start work mode</button>
        ${canFlare ? `<button class="btn danger wide" id="t-flare" type="button">I flared — switch to L0 settle mode</button>` : ""}
        <p class="muted small">${st.enabled === false ? "The work timer is turned off in Settings. " : ""}Work hours ${esc(st.work_start)}–${esc(st.work_end)} CT${st.quiet_outside_work_hours ? ` (no alarms outside them). ${inside ? "You're inside them now." : "You're outside them now, so starting by hand overrides quiet hours for this session."}` : "."}</p>
        ${timer?.stopped_at ? `<p class="muted small">Last session ended ${new Date(timer.stopped_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${timer.stopped_how === "work_end" ? " at work end" : ""}.</p>` : ""}
      </section>`;
    } else {
      const due = isDue(timer, now), mine = isAlarmDevice();
      const { next } = followingPhase(c, timer, doses(), due ? "alarm" : "manual");
      const left = snoozesLeft(timer, st);
      const ph = c.phases.find((p) => p.id === timer.phase);
      const decompIds = timer.phase === "decompress" ? (ph.exercise_ids || []) : [];
      html += `<section class="card timer-card ${due ? "due" : ""}">
        <div class="t-phase">${ICON[timer.phase]} ${esc(phaseName(c, timer.phase))}</div>
        <div class="t-count" id="t-count" aria-live="off">${due ? "+" + fmtClock(now - deadlineOf(timer)) : fmtClock(remainingMs(timer, now))}</div>
        <div class="t-barwrap"><div class="t-bar" id="t-bar"></div></div>
        <p class="t-next">${due ? `<b>Time to switch.</b> ` : ""}Next: <b>${ICON[next] || ""} ${esc(phaseName(c, next))}</b> · ${fmtMin(phaseMinutes(doses(), next, c))}</p>
        ${inFlare ? `<p class="flare-banner">Settle mode (L0) active</p>` : ""}
        ${due && timer.snoozes ? `<p class="muted small">Snoozed ${timer.snoozes}×.${left ? "" : " No snoozes left: switch, tap sore early, or skip."}</p>` : ""}
        <div class="t-actions">
          <button class="btn primary big" id="t-switch">${due ? `Start ${esc(phaseName(c, next))}` : `Skip to ${esc(phaseName(c, next))}`}</button>
          ${due && left ? `<button class="btn big" id="t-snooze">Snooze ${st.snooze_min} min (${left} left)</button>` : ""}
          ${timer.phase === "stand" || timer.phase === "sit" ? `<button class="btn warn big" id="t-sore">Sore early</button>` : ""}
        </div>
        <ul class="t-cues">${(ph.cues || []).map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
        ${decompIds.length ? `<p class="muted small">Options: ${decompIds.map((id) => esc(ctx().exById[id]?.name || id)).join(" · ")}</p>` : ""}
        <div class="t-secondary">
          ${canFlare ? `<button class="btn warn" id="t-flare" type="button">I flared</button>` : ""}
          <button class="btn danger" id="t-stop" type="button">Stop work mode</button>
        </div>
      </section>
      <section class="card">
        <p class="muted small">${mine ? "Alarms ring on this device." : "Started on another device: it will ring there. You can still switch or stop from here."}
          ${mine && !audioReady() ? ` <b>Tap anywhere to enable alarm sound</b> (browsers need a tap after a reload).` : ""}
          ${perm === "default" ? ` <button class="btn" id="t-perm" type="button">Allow notifications</button>` : perm === "denied" ? " Notifications are blocked in the browser; the sound and this page still work." : ""}
          ${timer.override_quiet ? "Quiet hours are overridden for this session." : st.quiet_outside_work_hours ? `Work mode stops at ${esc(st.work_end)} CT with one decompress reminder.` : ""}
          Keep this tab open; avoid browser "memory saver" for pt.davidp.dev.</p>
      </section>`;
    }
    const blocks = log?.blocks || [];
    if (blocks.length || timer?.blocks?.length) {
      const sum = summarizeBlocks(blocks, log?.early_switches || []);
      const trend = evaluateSorenessTrend(blocks, log?.early_switches || []);
      html += `<section class="card"><h3>Today</h3>
        <div class="fallback-row fallback-${trend.status}">
          <span class="status-pill status-${trend.status}">${esc(trend.status)}</span>
          <span class="small">${esc(trend.next_day)}${trend.reasons.length ? ` · <span class="muted">${esc(trend.reasons[0])}</span>` : ""}</span>
        </div>
        <p class="muted small">${sum.cycles_completed} full cycle${sum.cycles_completed === 1 ? "" : "s"} · ${sum.early_switch_count} early switch${sum.early_switch_count === 1 ? "" : "es"} (${sum.stand_early_switches} stand, ${sum.sit_early_switches} sit sore)</p>
        <ul class="t-log">${blocks.slice(-12).reverse().map((b) => {
          const sr = b.soreness ? SORENESS_BY_ID[b.soreness] : null;
          const tag = sr ? ` <span class="sore-tag sore-${sr.color}">${esc(sr.label)}</span>` : "";
          return `<li><span>${dlg.hhmm(b.started_at)} ${ICON[b.phase] || ""} ${esc(phaseName(c, b.phase))}</span><span>${b.actual_min}/${b.prescribed_min} min${b.ended_how === "sore_early" ? " · sore early" : b.ended_how === "manual" ? " · early" : b.snoozes ? ` · snoozed ${b.snoozes}×` : ""}${tag}</span></li>`;
        }).join("")}</ul>
      </section>`;
    }
    root.innerHTML = html;
    const on = (id, fn) => { const el = root.querySelector(id); if (el) el.onclick = fn; };
    on("#t-start", actions.start); on("#t-switch", actions.switch); on("#t-snooze", actions.snooze); on("#t-sore", actions.sore); on("#t-flare", actions.flare); on("#t-stop", actions.stop);
    on("#t-perm", async () => { await askNotifications(); update(true); });
  }

  // tap anywhere re-arms audio after a reload
  document.addEventListener("pointerdown", () => { if (timer?.active && !audioReady()) { unlockAudio(); update(true); } }, { passive: true });

  return {
    async init() { await load(); await applyPendingFallback(); startClock(onTick); onTick(); },
    async reload() { await load(); onTick(); update(true); },
    show() { root.dataset.timerPage = "1"; shape = ""; applyPendingFallback().catch(() => {}); update(true); },
    hide() { delete root.dataset.timerPage; },
    testAlarm() { unlockAudio(); setTimeout(() => { if (!playAlarm("walk")) toast("Couldn't start audio. Tap again."); notify("Test alarm", "This is what a phase change looks like."); }, 50); },
    get active() { return !!timer?.active; },
  };
}
