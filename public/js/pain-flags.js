// Unexpected-pain flags (pure): a simple per-item checkbox on the day log (`pain_flags`).
// Older detailed flag records (pain/location/type/note) still count as checked.
// Also hosts the 15 s rest-cue helpers used by the exercise timer.

export const FLAG_STREAK_TO_REGRESS = 2;

export function flagsOf(day) {
  return Array.isArray(day?.pain_flags) ? day.pain_flags : [];
}

/** Any stored flag for this item counts as checked, including pre-simplification records. */
export function isItemFlagged(day, itemKey) {
  if (!itemKey) return false;
  return flagsOf(day).some((f) => f.item_key === itemKey);
}

export function flagsForItem(day, itemKey) {
  return flagsOf(day).filter((f) => f.item_key === itemKey);
}

export function flaggedItemKeys(day) {
  return [...new Set(flagsOf(day).filter((f) => f.item_key).map((f) => f.item_key))];
}

export function setItemFlagged(day, itemKey, on, { ts, id } = {}) {
  const rest = flagsOf(day).filter((f) => f.item_key !== itemKey);
  if (!on) return { ...day, pain_flags: rest };
  const existing = flagsOf(day).find((f) => f.item_key === itemKey);
  const rec = existing
    ? { ...existing, item_key: itemKey }
    : { id: id || `pf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, item_key: itemKey, ts: ts || new Date().toISOString() };
  return { ...day, pain_flags: [...rest, rec] };
}

/**
 * Trailing run of flagged, completed sessions/days.
 * `events` is chronological `{ done, flagged }` and should already be only the
 * times this item was done; unflagged done events break the run.
 */
export function consecutiveFlagStreak(events) {
  let n = 0;
  for (let i = (events || []).length - 1; i >= 0; i--) {
    if (!events[i].done) continue;
    if (events[i].flagged) n++;
    else break;
  }
  return n;
}

function itemWasDoneInSession(session, itemKey) {
  return (session.items || []).some((i) => i.item_key === itemKey && i.completed !== false && !i.skipped);
}

/** Completed sessions of this item up to and including `throughSession`, oldest first. */
export function sessionFlagEvents(itemKey, sessions, days, throughSession) {
  const list = (sessions || [])
    .filter((s) => itemWasDoneInSession(s, itemKey))
    .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
  const out = [];
  for (const s of list) {
    out.push({ id: s.id, date: s.local_date, done: true, flagged: isItemFlagged(days?.[s.local_date], itemKey) });
    if (throughSession && (s.id === throughSession.id || s === throughSession)) break;
  }
  return out;
}

function itemWasDoneOnDay(day, item) {
  if (!day || !item) return false;
  if ((day.checklist || []).some((c) => c.item_key === item.item_key && c.done)) return true;
  if (item.block === "walking" && (day.walk_min ?? 0) > 0) return true;
  return false;
}

/** Days this daily item was done, up to and including `throughDate`. */
export function dailyFlagEvents(item, daysMap, throughDate) {
  const dates = Object.keys(daysMap || {}).filter((d) => !throughDate || d <= throughDate).sort();
  const out = [];
  for (const d of dates) {
    const day = daysMap[d];
    if (!itemWasDoneOnDay(day, item)) continue;
    out.push({ date: d, done: true, flagged: isItemFlagged(day, item.item_key) });
  }
  return out;
}

export const REST_SEC = 15;

/** Cues to play when rest remaining crosses 3s, 2s, 1s (tick) and 0s (go). */
export function restCuesToPlay(prevRemainMs, remainMs) {
  const cues = [];
  for (const [sec, kind] of [[3, "tick"], [2, "tick"], [1, "tick"], [0, "go"]]) {
    const t = sec * 1000;
    if (prevRemainMs > t && remainMs <= t) cues.push(kind);
  }
  return cues;
}

export function needsRestAfter(step, stepCount) {
  return stepCount > 1 && step < stepCount - 1;
}

/**
 * Apply Next to a timed session without starting the next countdown.
 * Idle/ready: the current (or upcoming, if rest already ended) bout is marked
 * done and the count moves to the next hold, idle. Running/paused: the bout
 * finishes as if the clock hit zero (rest if more remain, else done).
 * During rest: skip rest and land on the next hold idle.
 */
export function advanceTimerByNext(sess, now = Date.now()) {
  if (!sess || sess.status === "done") return { sess, ding: false, markDone: false };
  const duration = sess.plan.seconds * 1000;
  const steps = sess.plan.steps.length;
  const base = { ...sess, endsAt: null, restEndsAt: null };

  if (sess.status === "rest") {
    return { sess: { ...base, step: sess.step + 1, status: "idle", remain: duration }, ding: false, markDone: false };
  }

  const step = (sess.status === "ready" || sess.status === "next") ? sess.step + 1 : sess.step;
  const more = needsRestAfter(step, steps);
  const runningLike = sess.status === "running" || sess.status === "paused";
  if (runningLike && more) {
    return { sess: { ...base, step, status: "rest", remain: 0, restEndsAt: now + REST_SEC * 1000 }, ding: true, markDone: false };
  }
  if (more) {
    return { sess: { ...base, step: step + 1, status: "idle", remain: duration }, ding: true, markDone: false };
  }
  return { sess: { ...base, step, status: "done", remain: 0 }, ding: true, markDone: true };
}
