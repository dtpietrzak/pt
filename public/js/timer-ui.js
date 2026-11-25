// Work timer screen + alarm loop. The state machine is pure (posture.js); this file owns the clock loop,
// audio, notifications and persistence. Timer state lives in IndexedDB (kv "timer") and syncs through Firestore,
// so every device sees it; alarms ring only on the device that started work mode unless the app setting says otherwise.
import {
  TIMER_KEY, postureLogKey, startTimer, switchPhase, soreEarly, snooze, stopTimer, tick, isDue, deadlineOf, remainingMs,
  snoozesLeft, followingPhase, phaseMinutes, phaseName, timerSettings, summarizeBlocks, postureDailyLog, inWorkHours, postureConfig, initPostureState,
} from "./posture.js";
import { localDate } from "./util.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICON = { stand: "🧍", walk: "🚶", sit: "🪑", decompress: "🛏️" };
const REPEAT_MS = 60000, MAX_REPEATS = 15;

export function deviceId() {
  let id = localStorage.getItem("pt-device-id");
  if (!id) { id = "D" + Math.random().toString(36).slice(2, 10); localStorage.setItem("pt-device-id", id); }
  return id;
}
export const fmtClock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const fmtMin = (m) => `${Number.isInteger(m) ? m : m.toFixed(1)} min`;

// ---------------------------------------------------------------- audio + notifications
let actx = null;
export function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    const b = actx.createBuffer(1, 1, 22050), src = actx.createBufferSource(); // silent blip: marks the context as user-activated
    src.buffer = b; src.connect(actx.destination); src.start(0);
  } catch { /* no audio available */ }
}
export const audioReady = () => !!actx && actx.state === "running";
const TONES = { stand: [523, 659, 784], walk: [784, 659, 523], sit: [440, 554, 440], decompress: [392, 330, 262], end: [660, 520, 660] };
export function playAlarm(kind = "walk") {
  if (!audioReady()) return false;
  const notes = TONES[kind] || TONES.walk, t0 = actx.currentTime + 0.02;
  notes.forEach((f, i) => {
    for (let r = 0; r < 2; r++) {
      const o = actx.createOscillator(), g = actx.createGain(), t = t0 + i * 0.5 + r * 0.2;
      o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.18);
    }
  });
  return true;
}
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
export function createTimerUI({ store, ctx, toast, root, chip }) {
  let timer = null, loaded = false, ring = { key: null, count: 0, last: 0 };
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
    await store.kvSet(key, log);
    const day = (await store.get("days", date)) || { local_date: date, level_id: ctx().state.level_id, checklist: [] };
    day.posture_cycle = postureDailyLog(log.blocks, log.early_switches, doses());
    await store.put("days", day);
  }

  // ---- actions
  async function start() {
    unlockAudio(); askNotifications();
    const prev = timer;
    await save(startTimer(doses(), Date.now(), { cfg: cfg(), settings: settings(), deviceId: dev }), prev);
  }
  const withNow = (fn) => async () => { const prev = timer; const next = fn(prev, Date.now()); if (next !== prev) await save(next, prev); };
  const sw = (how) => withNow((t, now) => switchPhase(t, now, doses(), how, cfg()));
  const actions = {
    start,
    switch: async () => { unlockAudio(); await sw(isDue(timer, Date.now()) ? "alarm" : "manual")(); },
    skip: sw("manual"),
    sore: withNow((t, now) => soreEarly(t, now, doses(), cfg())),
    snooze: withNow((t, now) => snooze(t, now, settings())),
    stop: async () => { if (confirm("Stop work mode?")) await withNow((t, now) => stopTimer(t, now, "manual"))(); },
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
    let html = "";
    if (!timer?.active) {
      const inside = inWorkHours(now, st);
      html += `<section class="card timer-card">
        <h2>Work mode</h2>
        <p class="small">Repeats <b>Stand → Walk → Sit → Decompress</b> and sounds an alarm at each change, so you break before the soreness builds.</p>
        <p class="timer-doses">${esc(dosesLine())}</p>
        <button class="btn primary wide big" id="t-start" ${st.enabled === false ? "disabled" : ""}>Start work mode</button>
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
        ${due && timer.snoozes ? `<p class="muted small">Snoozed ${timer.snoozes}×.${left ? "" : " No snoozes left: switch, tap sore early, or skip."}</p>` : ""}
        <div class="t-actions">
          <button class="btn primary big" id="t-switch">${due ? `Start ${esc(phaseName(c, next))}` : `Skip to ${esc(phaseName(c, next))}`}</button>
          ${due && left ? `<button class="btn big" id="t-snooze">Snooze ${st.snooze_min} min (${left} left)</button>` : ""}
          ${timer.phase === "stand" || timer.phase === "sit" ? `<button class="btn warn big" id="t-sore">Sore early</button>` : ""}
        </div>
        <ul class="t-cues">${(ph.cues || []).map((q) => `<li>${esc(q)}</li>`).join("")}</ul>
        ${decompIds.length ? `<p class="muted small">Options: ${decompIds.map((id) => esc(ctx().exById[id]?.name || id)).join(" · ")}</p>` : ""}
        <button class="btn danger" id="t-stop">Stop work mode</button>
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
      html += `<section class="card"><h3>Today</h3>
        <p class="muted small">${sum.cycles_completed} full cycle${sum.cycles_completed === 1 ? "" : "s"} · ${sum.early_switch_count} early switch${sum.early_switch_count === 1 ? "" : "es"} (${sum.stand_early_switches} stand, ${sum.sit_early_switches} sit sore)</p>
        <ul class="t-log">${blocks.slice(-12).reverse().map((b) => `<li><span>${dlg.hhmm(b.started_at)} ${ICON[b.phase] || ""} ${esc(phaseName(c, b.phase))}</span><span>${b.actual_min} / ${b.prescribed_min} min${b.ended_how === "sore_early" ? " · sore early" : b.ended_how === "manual" ? " · early" : b.snoozes ? ` · snoozed ${b.snoozes}×` : ""}</span></li>`).join("")}</ul>
      </section>`;
    }
    root.innerHTML = html;
    const on = (id, fn) => { const el = root.querySelector(id); if (el) el.onclick = fn; };
    on("#t-start", actions.start); on("#t-switch", actions.switch); on("#t-snooze", actions.snooze); on("#t-sore", actions.sore); on("#t-stop", actions.stop);
    on("#t-perm", async () => { await askNotifications(); update(true); });
  }

  // tap anywhere re-arms audio after a reload
  document.addEventListener("pointerdown", () => { if (timer?.active && !audioReady()) { unlockAudio(); update(true); } }, { passive: true });

  return {
    async init() { await load(); startClock(onTick); onTick(); },
    async reload() { await load(); onTick(); update(true); },
    show() { root.dataset.timerPage = "1"; shape = ""; update(true); },
    hide() { delete root.dataset.timerPage; },
    testAlarm() { unlockAudio(); setTimeout(() => { if (!playAlarm("walk")) toast("Couldn't start audio. Tap again."); notify("Test alarm", "This is what a phase change looks like."); }, 50); },
    get active() { return !!timer?.active; },
  };
}
