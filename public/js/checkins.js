// Check-ins (pure): which ones are due, and building schema-valid records from the quick forms.
// No DOM and no I/O, so Node tests drive it. The UI lives in js/ui/checkins.js.
import { isoLocal, localDate, localTime, addDays } from "./util.js";

export const TYPES = ["morning", "post_workout", "evening", "night"];
export const LABEL = { morning: "Morning", post_workout: "Post-workout", evening: "Evening", night: "Night" };
export const NIGHT_CUTOFF = "04:00";   // a night check-in done after midnight still counts for the evening before
export const MORNING_WINDOW_MIN = 45;
export const POST_WORKOUT_PROMPT_HOURS = 36;

export const RED_FLAGS = [
  ["saddle_numbness", "Numbness in the saddle area (groin, genitals, inner thighs, buttocks)", "emergency"],
  ["bladder_bowel_change", "New trouble urinating, or losing bladder or bowel control", "emergency"],
  ["new_leg_weakness", "New weakness in a leg or foot", "clinician"],
  ["new_numbness_tingling", "New numbness or tingling that isn't going away", "clinician"],
  ["fever_with_back_pain", "Fever or chills along with back pain", "clinician"],
  ["night_pain_unrelieved", "Pain at night that no position relieves", "clinician"],
  ["bilateral_leg_symptoms", "Symptoms in both legs", "clinician"],
  ["trauma_since_last_checkin", "A fall or injury since the last check-in", "clinician"],
  ["unexplained_weight_loss", "Unexplained weight loss", "clinician"],
];
export const noFlags = () => Object.fromEntries(RED_FLAGS.map(([k]) => [k, false]));

const hm = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMin = (n) => `${String(Math.floor(n / 60) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** The local date a check-in of this type belongs to when filled in at `now`. */
export function effectiveDate(type, now = new Date()) {
  const d = localDate(now);
  return type === "night" && localTime(now) < NIGHT_CUTOFF ? addDays(d, -1) : d;
}

/**
 * What to show for today's check-ins.
 * Returns entries { key, type, label, date, state: "done" | "due" | "later", at, session_id?, checkin? }
 * ("later" = not due yet; "due" = past its notify time and not done). Post-workout entries only exist for a
 * session that has none, and are due immediately.
 */
export function checklist({ now = new Date(), profile, checkins = [], sessions = [], wake = null }) {
  const notify = profile?.notify || {};
  const t = localTime(now), date = localDate(now);
  const find = (type, d, sid) => checkins.filter((c) => c.type === type && c.local_date === d && (!sid || c.session_id === sid)).sort((a, b) => (a.ts < b.ts ? -1 : 1)).pop();
  const out = [];
  const entry = (type, d, at, extra = {}) => {
    const c = find(type, d, extra.session_id);
    out.push({ key: `${d}:${type}${extra.session_id ? ":" + extra.session_id : ""}`, type, label: LABEL[type], date: d, at, checkin: c, state: c ? "done" : t >= at || d < date ? "due" : "later", ...extra });
  };
  // Right after midnight the night check-in for last evening is still the open one.
  if (t < NIGHT_CUTOFF) entry("night", addDays(date, -1), notify.night || "21:00");
  let mAt = notify.morning || "08:00";
  if (wake && /^\d{2}:\d{2}$/.test(wake)) mAt = fromMin(Math.max(hm(mAt), hm(wake) + MORNING_WINDOW_MIN));
  entry("morning", date, mAt);
  entry("evening", date, notify.evening || "15:30");
  if (t >= NIGHT_CUTOFF) entry("night", date, notify.night || "21:00");
  // Post-workout check-ins already done today (so they show in the card), then any session still waiting for one.
  for (const c of checkins) {
    if (c.type === "post_workout" && c.local_date === date) out.push({ key: `${date}:post_workout:${c.session_id || c.id}`, type: "post_workout", label: LABEL.post_workout, date, at: localTime(c.ts), state: "done", checkin: c, session_id: c.session_id });
  }
  for (const s of sessions) {
    if (!s.ended_at) continue;
    const has = s.post_workout_checkin_id || checkins.some((c) => c.type === "post_workout" && c.session_id === s.id);
    if (has) continue;
    if ((now - new Date(s.ended_at)) / 3600000 > POST_WORKOUT_PROMPT_HOURS) continue;
    out.push({ key: `${s.local_date}:post_workout:${s.id}`, type: "post_workout", label: LABEL.post_workout, date: s.local_date, at: localTime(new Date(s.ended_at)), state: "due", session_id: s.id });
  }
  return out;
}
export const dueNow = (list) => list.filter((e) => e.state === "due");

// ---------------------------------------------------------------- building records
const int = (v, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pain = (v) => clamp(int(v), 0, 10);

/** Symptoms{} from the shared form fields. `painNow` is the check-in's main pain number. */
export function buildSymptoms(f, painNow, { sharpDefault = "accidental_bend_twist" } = {}) {
  const s = { pain_now: pain(painNow), sharp_electrical: !!f.sharp, leg_symptoms: f.leg || "none", numbness_tingling: !!f.numb };
  if (s.leg_symptoms !== "none" && f.leg_trend) s.leg_trend = f.leg_trend;
  if (s.sharp_electrical) {
    s.sharp_context = f.sharp_context || sharpDefault;
    if (f.sharp_settle_min !== undefined && f.sharp_settle_min !== null && f.sharp_settle_min !== "") s.sharp_settle_min = num(f.sharp_settle_min);
  }
  return s;
}

export function buildRedFlags(f) {
  const rf = noFlags();
  if (f.scary) for (const [k] of RED_FLAGS) rf[k] = !!f.flags?.[k];
  return rf;
}

/**
 * form -> a check-in record that validates against checkin.schema.json.
 * ctx: { now: Date, id, session_id?, wake_time?, posture?: posture_cycle object, existing? } (existing keeps id and ts when editing)
 */
export function buildCheckIn(type, f, ctx) {
  const now = ctx.now || new Date();
  let data;
  if (type === "morning") {
    data = {
      wake_time: ctx.wake_time || localTime(now),
      protection_window_respected: f.window_ok !== false,
      pain_on_waking: pain(f.pain),
      stiffness_min: f.stiffness_still ? num(f.stiffness_min, null) : num(f.stiffness_min, 0),
      stiffness_still_present: !!f.stiffness_still,
      sleep_hours: clamp(num(f.sleep_hours, 7), 0, 16),
      sleep_quality: clamp(int(f.sleep_quality, 3), 1, 5),
      woke_from_pain_count: Math.max(0, int(f.woke)),
      hip_shift: !!f.hip_shift,
      symptoms: buildSymptoms(f, f.pain),
    };
  } else if (type === "post_workout") {
    const items = (f.items || []).map((i) => {
      const o = { item_key: i.item_key, completed: i.completed !== false, rung_done: int(i.rung_done) };
      if (i.problem) {
        o.pain_peak = pain(i.pain_peak);
        if (i.sharp) o.sharp_electrical = true;
        if (i.form) o.form_breakdown = true;
      }
      return o;
    });
    data = { completed_items: items, pain_peak: pain(f.pain), symptoms: buildSymptoms(f, f.pain, { sharpDefault: "exercise" }) };
    if (f.pain15 !== undefined && f.pain15 !== null && f.pain15 !== "") data.pain_15min_after = pain(f.pain15);
    if (f.rpe !== undefined && f.rpe !== "") data.rpe = clamp(int(f.rpe, 5), 1, 10);
    if (f.settle) data.settle_bucket = f.settle;
    if (f.form_breakdown) data.form_breakdown = true;
  } else if (type === "evening") {
    const standing = { upright_h_total: Math.max(0, num(f.upright_h, 0)) };
    if (f.no_pressure) { standing.first_pressure_h = null; standing.censored = true; }
    else standing.first_pressure_h = Math.max(0, num(f.first_pressure_h, 0));
    if (f.breaks !== undefined) standing.breaks_taken = Math.max(0, int(f.breaks));
    if (f.decomp !== undefined) standing.decomp_breaks_done = Math.max(0, int(f.decomp));
    data = {
      standing,
      pain_peak_today: pain(f.pain),
      forced_rest_count: Math.max(0, int(f.forced_rest)),
      activity_limited: !!f.limited,
      hip_shift: !!f.hip_shift,
      symptoms: buildSymptoms(f, f.pain),
    };
    if (f.walk_min !== undefined && f.walk_min !== "") data.walk_min = Math.max(0, num(f.walk_min));
    if (f.sit_on) {
      const sit = { flared: !!f.sit_flared };
      if (f.sit_no_pressure) { sit.first_pressure_min = null; sit.censored = true; }
      else sit.first_pressure_min = Math.max(0, num(f.sit_first_min, 0));
      if (f.sit_total_min !== undefined && f.sit_total_min !== "") sit.seated_min_total = Math.max(0, num(f.sit_total_min));
      if (ctx.posture?.sit_prescribed_min) sit.prescribed_block_min = ctx.posture.sit_prescribed_min;
      if (ctx.posture?.cycles_completed !== undefined) sit.completed_blocks = ctx.posture.cycles_completed;
      data.sitting = sit;
    }
    if (ctx.posture) data.posture_cycle = ctx.posture;
  } else if (type === "night") {
    data = { bedtime_pain: pain(f.pain), symptoms: buildSymptoms(f, f.pain) };
    if (f.ready !== undefined) data.ready_for_tomorrow = !!f.ready;
  } else throw new Error(`Unknown check-in type: ${type}`);

  const rec = {
    type, id: ctx.existing?.id || ctx.id, ts: ctx.existing?.ts || isoLocal(now),
    local_date: ctx.existing?.local_date || effectiveDate(type, now),
    session_id: ctx.session_id ?? ctx.existing?.session_id ?? null,
    red_flags: buildRedFlags(f), anything_new_or_scary: !!f.scary, data,
  };
  const text = (f.oddities || "").trim();
  if (text) rec.oddities = text;
  if (f.tags?.length) rec.oddity_tags = [...f.tags];
  return rec;
}

/** The reverse: a stored check-in -> form values (for editing). */
export function formFromCheckIn(c) {
  const d = c.data || {}, sy = d.symptoms || {};
  const f = {
    leg: sy.leg_symptoms || "none", leg_trend: sy.leg_trend, numb: !!sy.numbness_tingling, sharp: !!sy.sharp_electrical,
    sharp_context: sy.sharp_context, sharp_settle_min: sy.sharp_settle_min,
    scary: !!c.anything_new_or_scary || Object.values(c.red_flags || {}).some(Boolean), flags: { ...(c.red_flags || {}) },
    oddities: c.oddities || "", tags: [...(c.oddity_tags || [])],
  };
  if (c.type === "morning") Object.assign(f, { pain: d.pain_on_waking, window_ok: d.protection_window_respected, stiffness_min: d.stiffness_min, stiffness_still: !!d.stiffness_still_present, sleep_hours: d.sleep_hours, sleep_quality: d.sleep_quality, woke: d.woke_from_pain_count, hip_shift: d.hip_shift });
  if (c.type === "post_workout") Object.assign(f, { pain: d.pain_peak, pain15: d.pain_15min_after, rpe: d.rpe, settle: d.settle_bucket, form_breakdown: d.form_breakdown, items: (d.completed_items || []).map((i) => ({ ...i, problem: i.pain_peak !== undefined || !!i.sharp_electrical || !!i.form_breakdown, sharp: i.sharp_electrical, form: i.form_breakdown })) });
  if (c.type === "evening") {
    const st = d.standing || {}, sit = d.sitting;
    Object.assign(f, { pain: d.pain_peak_today, upright_h: st.upright_h_total, no_pressure: st.first_pressure_h === null || st.first_pressure_h === undefined, first_pressure_h: st.first_pressure_h ?? "", breaks: st.breaks_taken, decomp: st.decomp_breaks_done, walk_min: d.walk_min, forced_rest: d.forced_rest_count, limited: d.activity_limited, hip_shift: d.hip_shift,
      sit_on: !!sit, sit_flared: sit?.flared, sit_no_pressure: sit ? sit.first_pressure_min === null || sit.first_pressure_min === undefined : true, sit_first_min: sit?.first_pressure_min ?? "", sit_total_min: sit?.seated_min_total });
  }
  if (c.type === "night") Object.assign(f, { pain: d.bedtime_pain, ready: d.ready_for_tomorrow });
  return f;
}

/** Primary pain number and one-line summary of a stored check-in, for lists. */
export function summaryLine(c) {
  const d = c.data || {};
  const p = { morning: d.pain_on_waking, post_workout: d.pain_peak, evening: d.pain_peak_today, night: d.bedtime_pain }[c.type];
  const bits = [`pain ${p}/10`];
  if (c.type === "morning" && d.stiffness_min != null) bits.push(`stiff ${d.stiffness_min}${d.stiffness_still_present ? "+" : ""} min`);
  if (c.type === "evening" && d.standing?.first_pressure_h != null) bits.push(`stood ${d.standing.first_pressure_h} h`);
  if (c.type === "post_workout" && d.rpe) bits.push(`effort ${d.rpe}/10`);
  return bits.join(" · ");
}

/** Plain-language banner for a red result. No contact details by design. */
export function redGuidance(red) {
  if (!red) return null;
  return red.kind === "emergency"
    ? { title: "Get emergency care now", body: "Saddle-area numbness or a change in bladder or bowel control can mean nerve compression. Go to an emergency department now, don't wait for the app." }
    : { title: "Stop the program and see a clinician", body: "Something on a check-in needs to be looked at by a clinician before more training. Rest in a comfortable position and book a visit soon; if it gets worse, or you get saddle numbness or bladder or bowel changes, go to emergency care." };
}

const RANKS = { Red: 0, Orange: 1, Yellow: 2 };
/** Reasons worst-first, without the "pain now N/10" echo of a pain number that's already listed. */
export function tidyReasons(reasons = []) {
  const main = new Set(reasons.map((r) => /: (?:pain on waking|peak pain|pain peak today|bedtime pain|pain 15 min after) (\d+)\/10$/.exec(r)?.[1]).filter(Boolean));
  return reasons
    .filter((r) => { const m = /: pain now (\d+)\/10$/.exec(r); return !(m && main.has(m[1])); })
    .map((r, i) => [r, i]).sort((a, b) => (RANKS[a[0].split(":")[0]] ?? 3) - (RANKS[b[0].split(":")[0]] ?? 3) || a[1] - b[1]).map(([r]) => r);
}
