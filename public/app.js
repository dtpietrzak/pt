// PT — personal lumbar-disc rehab tracker. Phase 1: shell, settings, plan data, daily checklist.
import { openDb, createStore } from "./js/db.js";
import { boot, newState } from "./js/data.js";
import { isoLocal, localDate, clone, addDays } from "./js/util.js";
import { currentDose, levelById } from "./js/engine.js";
import { formatDose, missingEquipment } from "./js/dose.js";
import { DISCLAIMER } from "./js/defaults.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const BLOCKS = [
  ["daily_mobility", "Daily mobility"], ["daily_core", "Daily core"], ["walking", "Walking"], ["relief", "Relief"],
  ["strength_A", "Strength A"], ["strength_B", "Strength B"], ["conditioning", "Conditioning"],
];
const DAILY = ["daily_mobility", "daily_core", "walking", "relief"];
const PAGES = { today: "Today", plan: "Plan", settings: "Settings" };
const MORNING_WINDOW_MIN = 45;

let store, docs, profile, app, state, exById = {};
const main = $("#main");

async function start() {
  store = createStore(await openDb());
  const b = await boot(store, isoLocal());
  ({ docs, profile, app, state } = b);
  indexExercises();
  if (b.resynced) toast("Plan data updated from the latest seed.");
  window.addEventListener("hashchange", render);
  render();
}
function indexExercises() { exById = Object.fromEntries(docs.exercises.exercises.map((e) => [e.id, e])); }
const level = () => levelById(docs.levels, state.level_id);
const today = () => localDate(new Date());

// ---------------------------------------------------------------- routing / chrome
function route() { const r = location.hash.replace(/^#\/?/, "") || "today"; return PAGES[r] ? r : "today"; }
function render() {
  if (!state) return renderWelcome();
  const r = route();
  $("#title").textContent = PAGES[r];
  $("#level-chip").textContent = `${state.level_id}${state.mode !== "active" ? " · " + state.mode : ""}`;
  $("#level-chip").hidden = false;
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("on", a.dataset.page === r));
  $(".nav").hidden = false;
  ({ today: renderToday, plan: renderPlan, settings: renderSettings })[r]();
}

function renderWelcome() {
  $("#title").textContent = "PT";
  $(".nav").hidden = true; $("#level-chip").hidden = true;
  const opts = docs.levels.levels.slice(0, 3).map((l) => `<option value="${l.id}" ${l.id === app.start_level ? "selected" : ""}>${l.id} · ${esc(l.name)}</option>`).join("");
  main.innerHTML = `
    <section class="card welcome">
      <h2>Welcome, ${esc((profile.name || "David").split(" ")[0])}</h2>
      <p>Your lower-back rehab plan, tracked on this phone only. Progress is driven by how your back responds, never by the calendar.</p>
      <p class="disclaimer">${esc(DISCLAIMER)}</p>
      <label class="field">Start at
        <select id="start-level">${opts}</select>
      </label>
      <p class="muted small">The plan says L1 is where you are today. Pick L0 (Settle) if you're in a flare right now.</p>
      <button class="btn primary" id="go">Start</button>
    </section>`;
  $("#go").onclick = async () => {
    app.start_level = $("#start-level").value;
    state = newState(docs, profile, app.start_level, isoLocal());
    await store.kvSet("app", app); await store.kvSet("state", state);
    location.hash = "#/today"; render();
  };
}

// ---------------------------------------------------------------- Today
async function dayLog(d) {
  return (await store.get("days", d)) || { local_date: d, level_id: state.level_id, checklist: [] };
}
async function renderToday() {
  const d = today(), lv = level();
  const log = await dayLog(d);
  const wake = await store.kvGet(`wake:${d}`);
  const inWindow = wake && minutesSince(d, wake) < MORNING_WINDOW_MIN;
  const doneSet = new Set(log.checklist.filter((c) => c.done).map((c) => c.item_key));
  const items = lv.items.filter((i) => DAILY.includes(i.block));
  const required = items.filter((i) => !i.optional && i.block !== "walking");
  const nDone = required.filter((i) => doneSet.has(i.item_key)).length;
  const walkTarget = state.walk?.current_min || 0;
  let html = `
    <section class="card hero-card">
      <div class="row between">
        <div><div class="muted small">${fmtDate(d)}</div><h2>${esc(lv.id)} · ${esc(lv.name)}</h2></div>
        <div class="ring" style="--p:${required.length ? nDone / required.length : 0}"><span>${nDone}/${required.length}</span></div>
      </div>
      <p class="muted small">${esc(lv.goal)}</p>
      <div class="wake">${wake ? `Up at <b>${esc(wake)}</b>${inWindow ? ` · morning window until ${addMin(wake, MORNING_WINDOW_MIN)}` : ""} <button class="link" id="wake-edit">change</button>`
        : `<button class="btn" id="wake-now">I'm up</button> <span class="muted small">starts the ${MORNING_WINDOW_MIN}-min morning window</span>`}</div>
    </section>`;
  if (inWindow) html += `<section class="card note">Walk around the house; core and mobility come after the morning window.</section>`;
  for (const [block, label] of BLOCKS.filter(([b]) => DAILY.includes(b))) {
    const its = items.filter((i) => i.block === block);
    if (!its.length) continue;
    const hidden = inWindow && (block === "daily_core" || block === "daily_mobility");
    html += `<section class="block"><h3>${label}${block === "walking" ? ` <span class="muted small">target ${walkTarget} min</span>` : ""}</h3>`;
    if (hidden) { html += `<p class="muted small pad">After the morning window.</p></section>`; continue; }
    for (const it of its) html += itemRow(it, doneSet.has(it.item_key));
    if (block === "walking") html += `
      <div class="stepper"><span>Walked today</span>
        <button class="btn icon" data-walk="-5" aria-label="minus 5">−</button>
        <b id="walk-min">${log.walk_min || 0}</b> min
        <button class="btn icon" data-walk="5" aria-label="plus 5">+</button></div>
      <div class="stepper"><span>Decompression breaks</span>
        <button class="btn icon" data-count="decomp_breaks_done" data-d="-1">−</button><b>${log.decomp_breaks_done || 0}</b>
        <button class="btn icon" data-count="decomp_breaks_done" data-d="1">+</button></div>
      <div class="stepper"><span>Standing breaks</span>
        <button class="btn icon" data-count="standing_breaks_done" data-d="-1">−</button><b>${log.standing_breaks_done || 0}</b>
        <button class="btn icon" data-count="standing_breaks_done" data-d="1">+</button></div>`;
    html += `</section>`;
  }
  const strength = lv.items.filter((i) => ["strength_A", "strength_B", "conditioning"].includes(i.block));
  if (strength.length) html += `<section class="card muted small">Strength sessions (${lv.frequency?.strength_sessions_per_week ?? "?"}/week, A and B alternating) and check-ins arrive in the next phases. You can see the session items on the Plan tab.</section>`;
  main.innerHTML = html;

  main.querySelectorAll("input[data-item]").forEach((cb) => cb.onchange = async () => {
    const l = await dayLog(d);
    const k = cb.dataset.item;
    const e = l.checklist.find((c) => c.item_key === k);
    if (e) e.done = cb.checked; else l.checklist.push({ item_key: k, done: cb.checked });
    l.level_id = state.level_id;
    await store.put("days", l);
    renderToday();
  });
  main.querySelectorAll("[data-walk]").forEach((b) => b.onclick = async () => {
    const l = await dayLog(d); l.walk_min = Math.max(0, (l.walk_min || 0) + +b.dataset.walk);
    await store.put("days", l); renderToday();
  });
  main.querySelectorAll("[data-count]").forEach((b) => b.onclick = async () => {
    const l = await dayLog(d); const k = b.dataset.count; l[k] = Math.max(0, (l[k] || 0) + +b.dataset.d);
    await store.put("days", l); renderToday();
  });
  main.querySelectorAll("[data-info]").forEach((b) => b.onclick = () => showExercise(b.dataset.info));
  const setWake = async (t) => { await store.kvSet(`wake:${d}`, t); renderToday(); };
  $("#wake-now")?.addEventListener("click", () => setWake(nowHM()));
  $("#wake-edit")?.addEventListener("click", () => { const t = prompt("Wake time (HH:MM)", wake || nowHM()); if (t && /^\d{1,2}:\d{2}$/.test(t)) setWake(t.padStart(5, "0")); });
}
function itemRow(it, done) {
  const ex = exById[it.exercise_id] || { name: it.exercise_id };
  const { dose, rung } = currentDose(state, it);
  const miss = missingEquipment(ex, profile.equipment);
  const ladder = it.rungs.length > 1 ? `rung ${rung + 1}/${it.rungs.length}` : "";
  return `<div class="item ${done ? "done" : ""}">
    <label class="check"><input type="checkbox" data-item="${esc(it.item_key)}" ${done ? "checked" : ""} aria-label="${esc(ex.name)}" /></label>
    <button class="text" data-info="${esc(it.item_key)}">
      <span class="name">${esc(ex.name)}</span>
      <span class="meta">${esc(formatDose(dose, it, profile))}${ladder ? ` · ${ladder}` : ""}${it.optional ? ` · <i>optional</i>` : ""}${miss.length ? ` · <span class="warn">needs ${esc(miss.join(", "))}</span>` : ""}</span>
      ${it.note ? `<span class="meta note-line">${esc(it.note)}</span>` : ""}
    </button></div>`;
}
function showExercise(itemKey) {
  const it = docs.levels.levels.flatMap((l) => l.items).find((i) => i.item_key === itemKey);
  const ex = exById[it.exercise_id] || {};
  const st = state.item_state[itemKey];
  const ladder = it.rungs.map((r, n) => `<li class="${st && st.rung === n ? "cur" : ""}">${esc(formatDose(r, it, profile))}${n === it.target_rung ? " (target)" : ""}</li>`).join("");
  openSheet(`
    <h2>${esc(ex.name || it.exercise_id)}</h2>
    <p class="muted small">${esc(it.item_key)} · ${esc(ex.category || "")} · rest ${it.rest_s ?? "-"} s</p>
    ${ex.cues?.length ? `<h4>Cues</h4><ul>${ex.cues.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
    <h4>Ladder</h4><ol class="ladder">${ladder}</ol>
    ${ex.stop_if ? `<h4>Stop if</h4><p>${esc(ex.stop_if)}</p>` : ""}
    ${ex.contraindications ? `<h4>Cautions</h4><p>${esc(ex.contraindications)}</p>` : ""}
    ${ex.equipment?.length ? `<h4>Equipment</h4><p>${esc(ex.equipment.join(", "))}</p>` : ""}
    ${it.requires?.length ? `<p class="muted small">Unlocks after: ${esc(it.requires.join(", "))}</p>` : ""}`);
}

// ---------------------------------------------------------------- Plan
function renderPlan() {
  const lv = level();
  let html = `<section class="card">
    <h2>${esc(lv.id)} · ${esc(lv.name)}</h2><p>${esc(lv.goal)}</p>
    <h4>Leave this level when</h4><ul>
      ${lv.exit?.clean_streak_sessions ? `<li>${lv.exit.clean_streak_sessions} clean strength sessions in a row</li>` : ""}
      ${lv.exit?.all_non_optional_items_at_target ? `<li>All non-optional items at target</li>` : ""}
      ${(lv.exit?.tests || []).map((t) => `<li>Gate test ${esc(testName(t.test_id))}: ${esc(t.threshold?.value)}${typeof t.threshold?.value === "number" ? " " + esc(testUnit(t.test_id)) : ""}${t.threshold?.note ? ` (${esc(t.threshold.note)})` : ""}${t.optional ? " · optional" : ""}</li>`).join("")}
      ${(lv.exit?.extra || []).map((x) => `<li>${esc(x)}</li>`).join("")}
    </ul>
    ${lv.avoid?.length ? `<h4>Avoid</h4><ul class="avoid">${lv.avoid.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
  </section>`;
  for (const [block, label] of BLOCKS) {
    const its = lv.items.filter((i) => i.block === block);
    if (!its.length) continue;
    html += `<section class="block"><h3>${label}</h3>${its.map((it) => {
      const ex = exById[it.exercise_id] || { name: it.exercise_id };
      const { dose, rung } = currentDose(state, it);
      return `<button class="plan-item" data-info="${esc(it.item_key)}"><span class="name">${esc(ex.name)}${it.optional ? " <i class='muted'>(optional)</i>" : ""}</span>
        <span class="meta">Now: ${esc(formatDose(dose, it, profile))} · target ${esc(formatDose(it.rungs[it.target_rung], it, profile))} · rung ${rung + 1}/${it.rungs.length}</span></button>`;
    }).join("")}</section>`;
  }
  html += `<section class="block"><h3>All levels</h3>${docs.levels.levels.map((l) => `
    <details class="lvl ${l.id === lv.id ? "cur" : ""}"><summary><b>${esc(l.id)}</b> ${esc(l.name)}</summary>
      <p class="small">${esc(l.goal)}</p>
      <p class="muted small">${l.items.length} items · ${(l.exit?.tests || []).length} gate tests${l.frequency?.strength_sessions_per_week ? ` · ${l.frequency.strength_sessions_per_week} strength sessions/week` : ""}</p>
    </details>`).join("")}</section>
    <p class="muted small center">Plan v${docs.levels.plan_version ?? 1} · ${docs.exercises.exercises.length} exercises · ${docs.tests.tests.length} tests</p>`;
  main.innerHTML = html;
  main.querySelectorAll("[data-info]").forEach((b) => b.onclick = () => showExercise(b.dataset.info));
}
const testUnit = (id) => docs.tests.tests.find((t) => t.id === id)?.unit || "";
const testName = (id) => docs.tests.tests.find((t) => t.id === id)?.name || id;

// ---------------------------------------------------------------- Settings
const EQUIP_BOOL = [["bands", "Resistance bands"], ["barbell", "Barbell"], ["rack_with_safeties", "Rack with safeties"], ["bench", "Bench"],
  ["pull_up_bar", "Pull-up bar"], ["blocks", "Blocks"], ["cones", "Cones"], ["track_or_field", "Track or field"]];
const EQUIP_LIST = [["dumbbells_lb", "Dumbbell sizes (lb)"], ["kettlebells_lb", "Kettlebell sizes (lb)"], ["plates_lb", "Plates (lb)"], ["step_box_in", "Step / box heights (in)"]];
function renderSettings() {
  const p = profile, eq = p.equipment || {}, B = p.baselines || {};
  main.innerHTML = `
  <form id="settings" class="settings">
    <section class="card"><h3>You</h3>
      <label class="field">Body weight (lb)<input type="number" name="body_weight_lb" min="60" max="400" step="1" value="${p.body_weight_lb ?? 180}" inputmode="decimal"></label>
      <label class="field">Sports<input name="sports" value="${esc((p.sports || []).join(", "))}" placeholder="soccer, football"></label>
    </section>
    <section class="card"><h3>Check-in reminders</h3>
      <div class="times">
        <label class="field">Morning<input type="time" name="n_morning" value="${esc(p.notify?.morning || "08:00")}"></label>
        <label class="field">Evening<input type="time" name="n_evening" value="${esc(p.notify?.evening || "15:30")}"></label>
        <label class="field">Night<input type="time" name="n_night" value="${esc(p.notify?.night || "21:00")}"></label>
      </div>
      <p class="muted small">Post-workout check-in opens when you finish a session. Times are America/Chicago. Reminders turn on with the check-ins phase.</p>
    </section>
    <section class="card"><h3>Equipment</h3>
      ${EQUIP_BOOL.map(([k, l]) => `<label class="toggle"><input type="checkbox" name="eq_${k}" ${eq[k] ? "checked" : ""}><span>${l}</span></label>`).join("")}
      ${EQUIP_LIST.map(([k, l]) => `<label class="field">${l}<input name="eq_${k}" value="${esc((eq[k] || []).join(", "))}" placeholder="blank = any size"></label>`).join("")}
      <p class="muted small">Loads are shown snapped to 5 lb, or to the nearest size you list.</p>
    </section>
    <section class="card"><h3>Baselines</h3>
      <div class="grid3">
        <label class="field">Stiffness (min)<input type="number" name="b_stiffness_min" min="0" step="1" value="${B.stiffness_min ?? 30}"></label>
        <label class="field">Standing (h)<input type="number" name="b_standing_h" min="0" step="0.25" value="${B.standing_h ?? 5}"></label>
        <label class="field">Rest pain (0-10)<input type="number" name="b_pain_rest" min="0" max="10" step="1" value="${B.pain_rest ?? 1}"></label>
      </div>
      <p class="muted small">Changes in the unfavorable direction (more stiffness, less standing, more pain) ask you to confirm, so slow drift can't hide a decline.</p>
    </section>
    <section class="card"><h3>Pacing</h3>
      <label class="field">Max items advanced per session<input type="number" name="cap" min="1" max="6" value="${p.settings?.max_item_changes_per_finalized_session ?? 3}"></label>
      <label class="field">Clean sessions needed to advance<input type="number" name="clean_req" min="1" max="6" value="${p.settings?.clean_exposures_required ?? 2}"></label>
      <label class="toggle"><input type="checkbox" name="layoff" ${p.settings?.layoff_rule_enabled !== false ? "checked" : ""}><span>Layoff rule (step back after 10 days without a strength session)</span></label>
    </section>
    <button class="btn primary wide" type="submit">Save settings</button>
  </form>
  <section class="card"><h3>Level</h3>
    <p>Current: <b>${esc(state.level_id)}</b> · ${esc(level().name)}</p>
    <label class="field">Restart at<select id="restart-level">${docs.levels.levels.map((l) => `<option value="${l.id}" ${l.id === state.level_id ? "selected" : ""}>${l.id} · ${esc(l.name)}</option>`).join("")}</select></label>
    <button class="btn" id="restart">Restart plan at this level</button>
    <p class="muted small">Resets rungs and progress. Your checklist history is kept.</p>
  </section>
  <section class="card"><h3>Data</h3>
    <p class="small">Plan v${docs.levels.plan_version ?? 1} · ${docs.levels.levels.length} levels · ${docs.exercises.exercises.length} exercises · ${docs.tests.tests.length} gate tests</p>
    <p class="muted small">Everything is stored on this device only. No accounts, no tracking.</p>
    <button class="btn" id="backup">Download backup (JSON)</button>
    <button class="btn danger" id="wipe">Erase all data</button>
  </section>
  <p class="disclaimer pad">${esc(DISCLAIMER)}</p>`;
  $("#settings").onsubmit = saveSettings;
  $("#restart").onclick = async () => {
    const id = $("#restart-level").value;
    if (!confirm(`Restart the plan at ${id}? Rungs and progress reset.`)) return;
    state = newState(docs, profile, id, isoLocal());
    await store.kvSet("state", state); toast(`Plan restarted at ${id}.`); render();
  };
  $("#backup").onclick = async () => download(`pt-backup-${today()}.json`, JSON.stringify(await store.dump(), null, 2), "application/json");
  $("#wipe").onclick = async () => {
    if (!confirm("Erase everything on this device? This cannot be undone.")) return;
    await store.clearAll(); location.hash = ""; location.reload();
  };
}
const nums = (s) => String(s || "").split(/[,\s]+/).map(Number).filter((n) => n > 0);
async function saveSettings(ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const p = clone(profile);
  p.body_weight_lb = +f.get("body_weight_lb") || p.body_weight_lb;
  p.sports = String(f.get("sports") || "").split(",").map((s) => s.trim()).filter(Boolean);
  delete p.clinician_contact;
  p.notify = { ...p.notify, morning: f.get("n_morning"), evening: f.get("n_evening"), night: f.get("n_night"), post_workout: "on_session_complete" };
  for (const [k] of EQUIP_BOOL) p.equipment[k] = f.get(`eq_${k}`) === "on";
  for (const [k] of EQUIP_LIST) p.equipment[k] = nums(f.get(`eq_${k}`));
  const nb = { stiffness_min: +f.get("b_stiffness_min"), standing_h: +f.get("b_standing_h"), pain_rest: Math.round(+f.get("b_pain_rest")) };
  const B = p.baselines;
  const worse = [];
  if (nb.stiffness_min > B.stiffness_min) worse.push(`stiffness ${B.stiffness_min} → ${nb.stiffness_min} min`);
  if (nb.standing_h < B.standing_h) worse.push(`standing ${B.standing_h} → ${nb.standing_h} h`);
  if (nb.pain_rest > (B.pain_rest ?? 1)) worse.push(`rest pain ${B.pain_rest} → ${nb.pain_rest}`);
  if (worse.length && !confirm(`These baseline changes are unfavorable:\n${worse.join("\n")}\n\nThey loosen the limits that flag a decline. Save them anyway?`)) return;
  p.baselines = nb;
  p.settings = { ...p.settings, max_item_changes_per_finalized_session: Math.min(6, Math.max(1, +f.get("cap") || 3)), clean_exposures_required: Math.max(1, +f.get("clean_req") || 2), layoff_rule_enabled: f.get("layoff") === "on" };
  profile = p;
  state = { ...state, baselines: clone(nb) };
  await store.kvSet("profile", profile); await store.kvSet("state", state);
  toast("Settings saved.");
  render();
}

// ---------------------------------------------------------------- helpers
function openSheet(html) {
  const s = $("#sheet");
  $("#sheet-body").innerHTML = html;
  s.hidden = false; requestAnimationFrame(() => s.classList.add("open"));
}
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet" || e.target.closest("[data-close]")) closeSheet(); });
function closeSheet() { const s = $("#sheet"); s.classList.remove("open"); setTimeout(() => (s.hidden = true), 200); }
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600); }
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const nowHM = () => isoLocal().slice(11, 16);
function addMin(hm, m) { const [h, mm] = hm.split(":").map(Number); const t = h * 60 + mm + m; return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; }
function minutesSince(d, hm) { if (d !== today()) return 9999; const [h, m] = hm.split(":").map(Number); const [nh, nm] = nowHM().split(":").map(Number); return nh * 60 + nm - (h * 60 + m); }
function fmtDate(d) { return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }); }
// Re-render at midnight / when returning to the app so "today" stays current.
document.addEventListener("visibilitychange", () => { if (!document.hidden && state) render(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start().catch((e) => { main.innerHTML = `<section class="card"><h2>Couldn't start</h2><p>${esc(e.message)}</p></section>`; console.error(e); });
