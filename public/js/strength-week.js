// Today-only strength scheduling: rest the day after a logged session, and a Mon–Sun weekly count.
// Does not change engine rules (layoff, progression, A/B rotation).
import { addDays } from "./util.js";

export const STRENGTH_TEMPLATES = ["strength_A", "strength_B"];

export function isStrengthTemplate(template) {
  return template === "strength_A" || template === "strength_B";
}

/** Monday (YYYY-MM-DD) of the Monday–Sunday week containing `ymd`. */
export function weekStartMonday(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(ymd, -((dow + 6) % 7));
}

export function weekEndSunday(ymd) {
  return addDays(weekStartMonday(ymd), 6);
}

function sessionId(s) {
  return s.id || `${s.local_date || ""}:${s.template || ""}:${s.started_at || ""}`;
}

/** Strength sessions logged on a local date (not deduped). */
export function strengthSessionsOn(sessions, ymd) {
  return (sessions || []).filter((s) => isStrengthTemplate(s.template) && s.local_date === ymd);
}

export function hadStrengthYesterday(sessions, today) {
  return strengthSessionsOn(sessions, addDays(today, -1)).length > 0;
}

/** Count unique logged strength sessions in the Mon–Sun week of `today`. Dedupe by session id. */
export function strengthCountThisWeek(sessions, today) {
  const start = weekStartMonday(today);
  const end = weekEndSunday(today);
  const seen = new Set();
  let n = 0;
  for (const s of sessions || []) {
    if (!isStrengthTemplate(s.template) || !s.local_date) continue;
    if (s.local_date < start || s.local_date > end) continue;
    const id = sessionId(s);
    if (seen.has(id)) continue;
    seen.add(id);
    n++;
  }
  return n;
}

/** Weekly target from the level frequency. Hidden when missing or 0. May be a number or a range string like "2-3". */
export function weeklyStrengthTarget(level) {
  const n = level?.frequency?.strength_sessions_per_week;
  if (n == null || n === "" || n === 0 || n === "0") return null;
  return n;
}

export function weeklyStrengthLabel(count, target) {
  if (target == null) return "";
  return `Strength: ${count} of ${target} this week`;
}

/**
 * Whether Today should show a rest-day card instead of the next strength template.
 * Today's own logged strength session always wins. `startedAnyway` is a same-day override.
 */
export function shouldShowStrengthRest({ sessions, today, loggedToday, startedAnyway }) {
  if (loggedToday) return false;
  if (startedAnyway) return false;
  return hadStrengthYesterday(sessions, today);
}
