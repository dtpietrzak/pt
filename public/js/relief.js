// Extra relief logging (pure): timestamped entries on the day record (`relief_log`).
// Tracking only — never part of the Today checklist or completion ring.
import { weekStartMonday, weekEndSunday } from "./strength-week.js";

export const RELIEF_OPTIONS = [
  { exercise_id: "EX_DECOMP_90_90", label: "90/90 rest", range: "3–5 min", seconds: 5 * 60, timed: true },
  { exercise_id: "EX_SIDELYING_REST", label: "Side-lying with pillow", range: "3–10 min", seconds: 5 * 60, timed: true },
  { exercise_id: "EX_DECOMP_PRONE_ELBOWS", label: "Prone on elbows", range: null, seconds: null, timed: false },
  { exercise_id: "EX_STAND_EXTENSION", label: "Standing extension", range: null, seconds: null, timed: false },
  { exercise_id: "EX_DOOR_HANG", label: "Door-frame hang (feet on the floor)", range: "3–5 min", seconds: 5 * 60, timed: true },
  { exercise_id: "EX_KNEE_TO_CHEST_RELIEF", label: "Single knee-to-chest (relief only)", range: null, seconds: null, timed: false },
  { exercise_id: "EX_INVERSION_TABLE", label: "Inversion table", range: "2–5 min", seconds: 3 * 60, timed: true },
];

export const reliefById = Object.fromEntries(RELIEF_OPTIONS.map((o) => [o.exercise_id, o]));

export function reliefLogOf(day) {
  return Array.isArray(day?.relief_log) ? day.relief_log : [];
}

export function newReliefEntry({ exercise_id, ts, duration_s, timed, id } = {}) {
  const opt = reliefById[exercise_id];
  return {
    id: id || `rl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    exercise_id,
    label: opt?.label || exercise_id,
    ts,
    timed: !!timed,
    ...(duration_s != null ? { duration_s } : {}),
  };
}

export function addReliefEntry(day, entry) {
  return { ...day, relief_log: [...reliefLogOf(day), entry] };
}

export function removeReliefEntry(day, id) {
  return { ...day, relief_log: reliefLogOf(day).filter((e) => e.id !== id) };
}

/** Remove the most recent log of this type today. No-op if the count is already 0. */
export function removeLatestOfType(day, exercise_id) {
  const log = reliefLogOf(day);
  let last = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].exercise_id === exercise_id) { last = i; break; }
  }
  if (last < 0) return day;
  return { ...day, relief_log: [...log.slice(0, last), ...log.slice(last + 1)] };
}

export function countByType(entries) {
  const out = {};
  for (const e of entries || []) {
    const k = e.exercise_id || "unknown";
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** Per-day counts for a map of day docs, inclusive of start/end. */
export function reliefByDay(daysMap, start, end) {
  const out = [];
  const keys = Object.keys(daysMap || {}).filter((d) => (!start || d >= start) && (!end || d <= end)).sort();
  for (const d of keys) {
    const entries = reliefLogOf(daysMap[d]);
    if (!entries.length) continue;
    out.push({ local_date: d, total: entries.length, by_type: countByType(entries), entries });
  }
  return out;
}

export function reliefWeekSummary(daysMap, today) {
  return reliefRangeSummary(daysMap, weekStartMonday(today), weekEndSunday(today));
}

/**
 * Unplanned relief count for the evening forced_rest field.
 * Returns null when no relief_log array is present so callers can fall back
 * to an explicit form/vector value. Scheduled work-timer breaks are never included.
 */
export function forcedRestFromReliefLogs(day) {
  if (!day || !Array.isArray(day.relief_log)) return null;
  return day.relief_log.length;
}

export function reliefRangeSummary(daysMap, start, end) {
  const days = reliefByDay(daysMap, start, end);
  const all = days.flatMap((d) => d.entries);
  return { start, end, total: all.length, by_type: countByType(all), by_day: days.map(({ entries, ...rest }) => rest) };
}
