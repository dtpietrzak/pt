// Shared DOM, sheet, toast, formatting, and exercise-detail helpers.
import { isoLocal, localDate } from "../util.js";
import { formatDose } from "../dose.js";

export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const BLOCKS = [
  ["daily_mobility", "Daily mobility"],
  ["daily_core", "Daily core"],
  ["walking", "Walking"],
  ["strength_A", "Strength A"],
  ["strength_B", "Strength B"],
  ["conditioning", "Conditioning"],
];

let sheetDismiss = null;
let sheetWired = false;

function wireSheet() {
  if (sheetWired) return;
  sheetWired = true;
  $("#sheet").addEventListener("click", (e) => {
    if (e.target.id === "sheet" || e.target.closest("[data-close]")) closeSheet();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
  });
}

export function openSheet(html, { onClose } = {}) {
  wireSheet();
  if (sheetDismiss) { const prev = sheetDismiss; sheetDismiss = null; prev(); }
  sheetDismiss = onClose || null;
  const s = $("#sheet");
  $("#sheet-body").innerHTML = html;
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add("open"));
  return $("#sheet-body");
}

export function closeSheet() {
  const s = $("#sheet");
  if (sheetDismiss) { const cb = sheetDismiss; sheetDismiss = null; cb(); }
  s.classList.remove("open");
  setTimeout(() => { if (!s.classList.contains("open")) s.hidden = true; }, 200);
}

/** Bottom-sheet confirmation dialog (replaces window.confirm). */
export function confirmSheet({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const root = openSheet(`
      <h2>${esc(title)}</h2>
      <p class="sheet-copy">${esc(body)}</p>
      <div class="sheet-actions">
        <button class="btn" type="button" data-cancel>${esc(cancelLabel)}</button>
        <button class="btn ${danger ? "danger" : "primary"}" type="button" data-confirm>${esc(confirmLabel)}</button>
      </div>`, { onClose: () => finish(false) });
    $("[data-cancel]", root).onclick = () => { finish(false); closeSheet(); };
    $("[data-confirm]", root).onclick = () => { finish(true); closeSheet(); };
  });
}

let toastT;
export function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2600);
}

export function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const today = () => localDate(new Date());
export const nowHM = () => isoLocal().slice(11, 16);

export function addMin(hm, m) {
  const [h, mm] = hm.split(":").map(Number);
  const t = h * 60 + mm + m;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

export function minutesSince(d, hm) {
  if (d !== today()) return 9999;
  const [h, m] = hm.split(":").map(Number);
  const [nh, nm] = nowHM().split(":").map(Number);
  return nh * 60 + nm - (h * 60 + m);
}

export function fmtDate(d) {
  return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
