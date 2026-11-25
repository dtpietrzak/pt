// Small pure helpers shared by the app, the engine and the Node tests. No DOM, no I/O.
export const TZ = "America/Chicago";
export const RANK = { green: 0, yellow: 1, orange: 2, red: 3 };
export const COLORS = ["green", "yellow", "orange", "red"];
export const worst = (colors) =>
  colors.filter(Boolean).reduce((a, c) => (RANK[c] > RANK[a] ? c : a), "green");
export const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

// ---------- time (all America/Chicago) ----------
const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset",
});
function parts(date) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(date)) p[type] = value;
  return p;
}
/** ISO 8601 with the America/Chicago offset, e.g. 2026-12-01T08:10:00-06:00 */
export function isoLocal(date = new Date()) {
  const p = parts(date);
  let off = (p.timeZoneName || "GMT").replace("GMT", "");
  if (!off) off = "+00:00";
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
/** YYYY-MM-DD in America/Chicago for a Date or ISO string */
export function localDate(d = new Date()) {
  if (typeof d === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    // An ISO string with -06:00/-05:00 already carries the Chicago wall date.
    if (/[-+]0[56]:00$/.test(d)) return d.slice(0, 10);
    d = new Date(d);
  }
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}
export function localTime(d = new Date()) {
  const p = parts(typeof d === "string" ? new Date(d) : d);
  return `${p.hour}:${p.minute}`;
}
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
export function dayDiff(a, b) {
  // whole days a - b for YYYY-MM-DD strings
  const t = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((t(a) - t(b)) / 86400000);
}
export const hoursBetween = (a, b) => (new Date(a) - new Date(b)) / 3600000;
export const daysBetweenTs = (a, b) => (new Date(a) - new Date(b)) / 86400000;
/** Monday of the ISO week containing ymd */
export function weekStart(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(ymd, -((dow + 6) % 7));
}
export function isoWeek(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const year = t.getUTCFullYear();
  const week = 1 + Math.floor((t - Date.UTC(year, 0, 1)) / 86400000 / 7);
  return { year, week };
}

// ---------- ids ----------
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0, lastRand = null;
export function ulid(now = Date.now()) {
  let rand;
  if (now === lastTime && lastRand) {
    rand = lastRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) { if (rand[i] < 31) { rand[i]++; break; } rand[i] = 0; }
  } else {
    rand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
    if (globalThis.crypto?.getRandomValues) {
      const b = crypto.getRandomValues(new Uint8Array(16));
      rand = Array.from(b, (x) => x & 31);
    }
  }
  lastTime = now; lastRand = rand;
  let t = now, ts = "";
  for (let i = 0; i < 10; i++) { ts = B32[t % 32] + ts; t = Math.floor(t / 32); }
  return ts + rand.map((r) => B32[r]).join("");
}

// ---------- canonical JSON + SHA-256 (matches the Python generator) ----------
// Python's json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False).
// JSON.parse loses the difference between 1 and 1.0; load_bw is always a float in the
// plan documents, so integral load_bw values are written as "1.0" like Python does.
const FLOAT_KEYS = new Set(["load_bw"]);
export function canonicalJson(o, key) {
  if (Array.isArray(o)) return "[" + o.map((v) => canonicalJson(v, key)).join(",") + "]";
  if (o && typeof o === "object")
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k], k)).join(",") + "}";
  if (typeof o === "number" && FLOAT_KEYS.has(key) && Number.isInteger(o)) return o.toFixed(1);
  return JSON.stringify(o);
}
export async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
export const docHash = (doc) => sha256Hex(canonicalJson(doc));

export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const round5 = (x) => Math.round(x / 5) * 5;
