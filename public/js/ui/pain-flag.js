// Simple unexpected-pain checkbox for an exercise sheet or Today row.
import { isoLocal } from "../util.js";
import { isItemFlagged, setItemFlagged } from "../pain-flags.js";
import { $, esc, toast, today } from "./dom.js";

export async function loadDay(ctx, date = today()) {
  return (await ctx.store.get("days", date)) || { local_date: date, level_id: ctx.state.level_id, checklist: [], pain_flags: [] };
}

export async function saveDay(ctx, day) {
  await ctx.store.put("days", day);
  return day;
}

export function flagMarkHtml(on, itemKey = "") {
  const slot = itemKey ? ` data-flag-slot="${esc(itemKey)}"` : "";
  if (!on) return itemKey ? `<span${slot}></span>` : "";
  return `<span class="pain-mark"${slot} title="Unexpected pain flagged" aria-label="Unexpected pain flagged">!</span>`;
}

export function flagToggleHtml(itemKey, on, { id = "flag-toggle" } = {}) {
  return `<label class="flag-check"${id ? ` id="${esc(id)}"` : ""}>
    <input type="checkbox" data-flag-item="${esc(itemKey)}" ${on ? "checked" : ""} />
    <span>Unexpected pain</span>
  </label>`;
}

export async function persistItemFlag(ctx, itemKey, on, date = today()) {
  const day = await loadDay(ctx, date);
  const next = await saveDay(ctx, setItemFlagged(day, itemKey, on, { ts: isoLocal() }));
  return { day: next, on: isItemFlagged(next, itemKey) };
}

export function paintFlagMark(itemKey, on) {
  const key = (window.CSS && CSS.escape) ? CSS.escape(itemKey) : itemKey;
  const html = flagMarkHtml(on, itemKey);
  for (const el of document.querySelectorAll(`[data-flag-slot="${key}"]`)) el.outerHTML = html || `<span data-flag-slot="${itemKey}"></span>`;
  const row = document.querySelector(`input[data-item="${key}"], input[data-wk-item="${key}"]`)?.closest(".item");
  if (row) row.classList.toggle("flagged", !!on);
  for (const box of document.querySelectorAll(`input[data-flag-item="${key}"]`)) box.checked = !!on;
}

export function wireFlagToggle(root, ctx, itemKey, onChange) {
  const box = root?.querySelector("[data-flag-item]") || root;
  if (!box) return;
  box.onchange = async (e) => {
    const on = e.target.checked;
    await persistItemFlag(ctx, itemKey, on);
    paintFlagMark(itemKey, on);
    toast(on ? "Unexpected pain flagged. This exercise will not advance." : "Pain flag cleared.");
    onChange?.(on);
  };
}
