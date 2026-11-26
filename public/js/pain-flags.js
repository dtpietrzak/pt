// Unexpected-pain flags (pure): records, labels, and how they feed check-ins / progression.
// Stored on the daily log as `pain_flags` (extra field; weekly export strips it and lists flags in attention).
// Existing post-workout item fields (pain_peak, sharp_electrical) are reused when a session is checked in.

export const PAIN_LOCS = [
  ["low_back", "Low back"],
  ["leg", "Leg / radiating"],
  ["hip", "Hip"],
  ["other", "Other"],
];
export const PAIN_TYPES = [
  ["sharp", "Sharp"],
  ["ache", "Ache"],
  ["nerve", "Nerve / tingling"],
];
export const LOC_LABEL = Object.fromEntries(PAIN_LOCS);
export const TYPE_LABEL = Object.fromEntries(PAIN_TYPES);

/** Matches the post-workout orange threshold (pain_peak >= 5 or sharp/electrical). */
export function isSerious(flag) {
  if (!flag) return false;
  return (flag.pain ?? 0) >= 5 || flag.type === "sharp" || flag.type === "nerve" || flag.location === "leg";
}

/** Radiating/nerve, sharp, or high pain: show existing red-flag guidance (no auto-report). */
export function needsRedGuidance(flag) {
  if (!flag) return false;
  return flag.location === "leg" || flag.type === "nerve" || flag.type === "sharp" || (flag.pain ?? 0) >= 7;
}

export function newFlag({ item_key = null, session_key = null, pain, location, type, note = "", ts, id }) {
  const rec = {
    id: id || `pf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    pain: Math.max(0, Math.min(10, Math.round(Number(pain) || 0))),
    location,
    type,
    ts,
  };
  if (item_key) rec.item_key = item_key;
  if (session_key) rec.session_key = session_key;
  const n = String(note || "").trim();
  if (n) rec.note = n;
  return rec;
}

export function flagsOf(day) {
  return Array.isArray(day?.pain_flags) ? day.pain_flags : [];
}

export function flagsForItem(day, itemKey) {
  return flagsOf(day).filter((f) => f.item_key === itemKey);
}

export function flagsForSession(day, sessionKey) {
  return flagsOf(day).filter((f) => !f.item_key && f.session_key === sessionKey);
}

export function upsertFlag(day, flag) {
  const list = flagsOf(day).filter((f) => f.id !== flag.id);
  list.push(flag);
  list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return { ...day, pain_flags: list };
}

export function removeFlag(day, id) {
  return { ...day, pain_flags: flagsOf(day).filter((f) => f.id !== id) };
}

/** Map a flag onto the post-workout per-item fields the engine already reads. */
export function toItemFields(flag) {
  if (!flag) return { problem: false };
  return {
    problem: true,
    pain_peak: flag.pain,
    sharp: flag.type === "sharp" || flag.type === "nerve",
  };
}

/** Prefill post-workout item rows from today's flags (worst flag wins; doesn't clear a worse stored value). */
export function mergeFlagsIntoItems(items, flags) {
  const by = {};
  for (const f of flags || []) {
    if (!f.item_key) continue;
    const cur = by[f.item_key];
    if (!cur || (f.pain ?? 0) > (cur.pain ?? 0) || (isSerious(f) && !isSerious(cur))) by[f.item_key] = f;
  }
  return (items || []).map((i) => {
    const f = by[i.item_key];
    if (!f) return i;
    const add = toItemFields(f);
    return {
      ...i,
      problem: true,
      pain_peak: i.pain_peak != null ? Math.max(i.pain_peak, add.pain_peak) : add.pain_peak,
      sharp: !!(i.sharp || add.sharp),
    };
  });
}

/** Session-level (or any leftover) flags → session pain_peak / symptoms hints. */
export function sessionFlagHints(flags) {
  const list = flags || [];
  if (!list.length) return null;
  const pain = Math.max(0, ...list.map((f) => f.pain ?? 0));
  const sharp = list.some((f) => f.type === "sharp" || f.type === "nerve");
  const leg = list.some((f) => f.location === "leg") ? "new" : undefined;
  return { pain, sharp, leg };
}

export function holdsCoreDay(flags, coreKeys) {
  const keys = new Set(coreKeys || []);
  return (flags || []).some((f) => keys.has(f.item_key) && isSerious(f));
}

export function holdsWalkDay(flags, walkKey) {
  if (!walkKey) return false;
  return (flags || []).some((f) => f.item_key === walkKey && isSerious(f));
}

export function flagSummary(flag, itemName) {
  const who = itemName || (flag.session_key ? "This workout" : "This item");
  const bits = [`${flag.pain}/10`, TYPE_LABEL[flag.type] || flag.type, LOC_LABEL[flag.location] || flag.location];
  if (flag.note) bits.push(flag.note);
  return `${who}: ${bits.join(" · ")}`;
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
