// Settings view: profile, work timer, equipment, baselines (with drift guardrail), pacing, level restart, backup/wipe.
import { newState } from "../data.js";
import { DISCLAIMER } from "../defaults.js";
import { isoLocal, clone } from "../util.js";
import { activeUser } from "./account.js";
import { $, esc, today, toast, download, confirmSheet } from "./dom.js";
import { unlockAudio, playAlarm, dingNotify } from "../audio.js";
import { exportCardHtml } from "./export.js";

const EQUIP_BOOL = [
  ["bands", "Resistance bands"], ["barbell", "Barbell"], ["rack_with_safeties", "Rack with safeties"],
  ["bench", "Bench"], ["pull_up_bar", "Pull-up bar"], ["blocks", "Blocks"], ["cones", "Cones"], ["track_or_field", "Track or field"],
];
const EQUIP_LIST = [
  ["dumbbells_lb", "Dumbbell sizes (lb)"], ["kettlebells_lb", "Kettlebell sizes (lb)"],
  ["plates_lb", "Plates (lb)"], ["step_box_in", "Step / box heights (in)"],
];
const nums = (s) => String(s || "").split(/[,\s]+/).map(Number).filter((n) => n > 0);

export function renderSettings(ctx, main) {
  const p = ctx.profile;
  const eq = p.equipment || {};
  const B = p.baselines || {};
  const pc = p.settings?.posture_cycle || {};

  main.innerHTML = `
  <form id="settings" class="settings">
    <section class="card"><div class="card-head"><h3>You</h3></div>
      <div class="card-body">
      <label class="field">Body weight (lb)<input type="number" name="body_weight_lb" min="60" max="400" step="1" value="${p.body_weight_lb ?? 180}" inputmode="decimal"></label>
      <label class="field">Sports<input name="sports" value="${esc((p.sports || []).join(", "))}" placeholder="soccer, football"></label>
      </div>
    </section>
    <section class="card"><div class="card-head"><h3>Check-in reminders</h3></div>
      <div class="card-body">
      <div class="times">
        <label class="field">Morning<input type="time" name="n_morning" value="${esc(p.notify?.morning || "08:00")}"></label>
        <label class="field">Evening<input type="time" name="n_evening" value="${esc(p.notify?.evening || "15:30")}"></label>
        <label class="field">Night<input type="time" name="n_night" value="${esc(p.notify?.night || "21:00")}"></label>
      </div>
      <p class="muted small">Post-workout check-in opens when you finish a session. Times are America/Chicago. Reminders turn on with the check-ins phase.</p>
      </div>
    </section>
    <section class="card"><div class="card-head"><h3>Work timer</h3></div>
      <div class="card-body">
      <label class="toggle"><input type="checkbox" name="pc_enabled" ${pc.enabled !== false ? "checked" : ""}><span>Work timer enabled</span></label>
      <div class="times">
        <label class="field">Work starts<input type="time" name="pc_start" value="${esc(pc.work_start || "08:00")}"></label>
        <label class="field">Work ends<input type="time" name="pc_end" value="${esc(pc.work_end || "17:00")}"></label>
      </div>
      <label class="toggle"><input type="checkbox" name="pc_quiet" ${pc.quiet_outside_work_hours !== false ? "checked" : ""}><span>Quiet outside work hours (stops with one decompress reminder at work end)</span></label>
      <div class="times">
        <label class="field">Snooze (min)<input type="number" name="pc_snooze" min="1" max="15" step="1" value="${pc.snooze_min ?? 5}"></label>
        <label class="field">Max snoozes per phase<input type="number" name="pc_maxsnz" min="0" max="5" step="1" value="${pc.max_snoozes_per_phase ?? 2}"></label>
      </div>
      <div class="sound-row">
        <label class="toggle"><input type="checkbox" name="pc_sound" ${ctx.app.timer_sound !== false ? "checked" : ""}><span>Alarm sound</span></label>
        <button class="btn" id="test-sound" type="button">Test sound</button>
      </div>
      <label class="toggle"><input type="checkbox" name="pc_all" ${ctx.app.timer_alarm_all_devices ? "checked" : ""}><span>Ring on every signed-in device (off = only the device that started work mode)</span></label>
      <p class="muted small">Stand ${ctx.state.posture_cycle?.stand_min ?? 40} · walk ${ctx.state.posture_cycle?.walk_min ?? 2} · sit ${ctx.state.posture_cycle?.sit_min ?? 20} · decompress ${ctx.state.posture_cycle?.decomp_min ?? 5} min now. These doses change with your check-ins, not here.</p>
      </div>
    </section>
    <section class="card"><div class="card-head"><h3>Equipment</h3></div>
      <div class="card-body">
      ${EQUIP_BOOL.map(([k, l]) => `<label class="toggle"><input type="checkbox" name="eq_${k}" ${eq[k] ? "checked" : ""}><span>${l}</span></label>`).join("")}
      ${EQUIP_LIST.map(([k, l]) => `<label class="field">${l}<input name="eq_${k}" value="${esc((eq[k] || []).join(", "))}" placeholder="blank = any size"></label>`).join("")}
      <p class="muted small">Loads are shown snapped to 5 lb, or to the nearest size you list.</p>
      </div>
    </section>
    <section class="card"><div class="card-head"><h3>Baselines</h3></div>
      <div class="card-body">
      <div class="grid3">
        <label class="field">Stiffness (min)<input type="number" name="b_stiffness_min" min="0" step="1" value="${B.stiffness_min ?? 30}"></label>
        <label class="field">Standing (h)<input type="number" name="b_standing_h" min="0" step="0.25" value="${B.standing_h ?? 5}"></label>
        <label class="field">Rest pain (0-10)<input type="number" name="b_pain_rest" min="0" max="10" step="1" value="${B.pain_rest ?? 1}"></label>
        <label class="field">Sitting (min)<input type="number" name="b_sitting_min" min="5" step="1" value="${B.sitting_min ?? 20}"></label>
      </div>
      <p class="muted small">Changes in the unfavorable direction (more stiffness, less standing, more pain, less sitting) ask you to confirm, so slow drift can't hide a decline.</p>
      </div>
    </section>
    <section class="card"><div class="card-head"><h3>Pacing</h3></div>
      <div class="card-body">
      <label class="field">Max items advanced per session<input type="number" name="cap" min="1" max="6" value="${p.settings?.max_item_changes_per_finalized_session ?? 3}"></label>
      <label class="field">Clean sessions needed to advance<input type="number" name="clean_req" min="1" max="6" value="${p.settings?.clean_exposures_required ?? 2}"></label>
      <label class="toggle"><input type="checkbox" name="layoff" ${p.settings?.layoff_rule_enabled !== false ? "checked" : ""}><span>Layoff rule (step back after 10 days without a strength session)</span></label>
      </div>
    </section>
    <button class="btn primary wide" type="submit">Save settings</button>
  </form>
  <section class="card"><div class="card-head"><h3>Level</h3></div>
    <div class="card-body">
    <p>Current: <b>${esc(ctx.state.level_id)}</b> · ${esc(ctx.level().name)}</p>
    <label class="field">Restart at<select id="restart-level">${ctx.docs.levels.levels.map((l) => `<option value="${l.id}" ${l.id === ctx.state.level_id ? "selected" : ""}>${l.id} · ${esc(l.name)}</option>`).join("")}</select></label>
    <button class="btn" id="restart" type="button">Restart plan at this level</button>
    <p class="muted small">Resets rungs and progress. Your checklist history is kept.</p>
    </div>
  </section>
  <section class="card" id="export-slot"></section>
  <section class="card"><div class="card-head"><h3>Data</h3></div>
    <div class="card-body">
    <p class="small">Plan v${ctx.docs.levels.plan_version ?? 1} · ${ctx.docs.levels.levels.length} levels · ${ctx.docs.exercises.exercises.length} exercises · ${ctx.docs.tests.tests.length} gate tests</p>
    <p class="muted small">Saved on this device first so it works offline, and synced automatically to your private Firebase database.</p>
    <p><a class="btn" href="#/export">Weekly export &amp; plan changes</a></p>
    <button class="btn" id="backup" type="button">Download backup (JSON)</button>
    <button class="btn danger" id="wipe" type="button">Erase this device's data</button>
    </div>
  </section>
  <p class="disclaimer pad">${esc(DISCLAIMER)}</p>`;

  exportCardHtml(ctx).then((html) => { const slot = $("#export-slot", main); if (slot) slot.outerHTML = html || ""; }).catch(() => {});

  $("#settings", main).onsubmit = (ev) => saveSettings(ctx, ev);

  main.onclick = async (e) => {
    if (e.target.closest("#test-sound")) {
      e.preventDefault();
      await unlockAudio();
      const ok = await playAlarm("walk");
      if (!ok) toast("Couldn't play the sound. Tap Test sound again.");
      dingNotify("Test sound", "This is the timer ding.");
      return;
    }
    if (e.target.closest("#restart")) {
      const id = $("#restart-level", main).value;
      const ok = await confirmSheet({
        title: `Restart at ${id}?`,
        body: "Rungs and progress reset to the start of this level. Your checklist history is kept.",
        confirmLabel: `Restart at ${id}`,
      });
      if (!ok) return;
      const st = newState(ctx.docs, ctx.profile, id, isoLocal());
      st.x = { ...st.x, restarted_at: isoLocal() };
      ctx.state = st;
      ctx.app = { ...ctx.app, start_level: id };
      await ctx.store.kvSet("state", ctx.state);
      await ctx.store.kvSet("app", ctx.app);
      toast(`Plan restarted at ${id}.`);
      ctx.render();
      return;
    }
    if (e.target.closest("#backup")) {
      download(`pt-backup-${today()}.json`, JSON.stringify(await ctx.store.dump(), null, 2), "application/json");
      return;
    }
    if (e.target.closest("#wipe")) {
      const ok = await confirmSheet({
        title: "Erase this device's data?",
        body: activeUser()
          ? "Your synced cloud copy is kept and will download again while you're signed in."
          : "Everything on this device will be erased. This cannot be undone.",
        confirmLabel: "Erase data",
        danger: true,
      });
      if (!ok) return;
      await ctx.store.clearAll();
      location.hash = "";
      location.reload();
    }
  };
}

async function saveSettings(ctx, ev) {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const p = clone(ctx.profile);
  p.body_weight_lb = +f.get("body_weight_lb") || p.body_weight_lb;
  p.sports = String(f.get("sports") || "").split(",").map((s) => s.trim()).filter(Boolean);
  delete p.clinician_contact;
  p.notify = { ...p.notify, morning: f.get("n_morning"), evening: f.get("n_evening"), night: f.get("n_night"), post_workout: "on_session_complete" };
  for (const [k] of EQUIP_BOOL) p.equipment[k] = f.get(`eq_${k}`) === "on";
  for (const [k] of EQUIP_LIST) p.equipment[k] = nums(f.get(`eq_${k}`));

  const B = p.baselines;
  const nb = {
    stiffness_min: +f.get("b_stiffness_min"),
    standing_h: +f.get("b_standing_h"),
    pain_rest: Math.round(+f.get("b_pain_rest")),
    sitting_min: Math.max(5, +f.get("b_sitting_min") || B.sitting_min || 20),
  };
  const worse = [];
  if (nb.stiffness_min > B.stiffness_min) worse.push(`stiffness ${B.stiffness_min} → ${nb.stiffness_min} min`);
  if (nb.standing_h < B.standing_h) worse.push(`standing ${B.standing_h} → ${nb.standing_h} h`);
  if (nb.pain_rest > (B.pain_rest ?? 1)) worse.push(`rest pain ${B.pain_rest} → ${nb.pain_rest}`);
  if (nb.sitting_min < (B.sitting_min ?? 20)) worse.push(`sitting ${B.sitting_min ?? 20} → ${nb.sitting_min} min`);
  if (worse.length) {
    const ok = await confirmSheet({
      title: "Unfavorable baseline change",
      body: `${worse.join(", ")}. These loosen the limits that flag a decline. Save anyway?`,
      confirmLabel: "Save anyway",
      danger: true,
    });
    if (!ok) return;
  }

  p.baselines = nb;
  p.settings = {
    ...p.settings,
    max_item_changes_per_finalized_session: Math.min(6, Math.max(1, +f.get("cap") || 3)),
    clean_exposures_required: Math.max(1, +f.get("clean_req") || 2),
    layoff_rule_enabled: f.get("layoff") === "on",
    posture_cycle: {
      enabled: f.get("pc_enabled") === "on",
      work_start: f.get("pc_start") || "08:00",
      work_end: f.get("pc_end") || "17:00",
      quiet_outside_work_hours: f.get("pc_quiet") === "on",
      snooze_min: Math.min(15, Math.max(1, Math.round(+f.get("pc_snooze")) || 5)),
      max_snoozes_per_phase: Math.min(5, Math.max(0, Math.round(+(f.get("pc_maxsnz") ?? 2)))),
    },
  };
  ctx.app = { ...ctx.app, timer_sound: f.get("pc_sound") === "on", timer_alarm_all_devices: f.get("pc_all") === "on" };
  ctx.profile = p;
  ctx.state = { ...ctx.state, baselines: clone(nb) };
  await ctx.store.kvSet("profile", ctx.profile);
  await ctx.store.kvSet("state", ctx.state);
  await ctx.store.kvSet("app", ctx.app);
  toast("Settings saved.");
  ctx.render();
}
