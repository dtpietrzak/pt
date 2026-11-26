// Flag-unexpected-pain form: used in the exercise sheet and on a workout card.
import { isoLocal } from "../util.js";
import { redGuidance } from "../checkins.js";
import {
  PAIN_LOCS, PAIN_TYPES, LOC_LABEL, TYPE_LABEL,
  newFlag, flagsOf, flagsForItem, flagsForSession, upsertFlag, removeFlag,
  needsRedGuidance, flagSummary,
} from "../pain-flags.js";
import { $, esc, toast, today } from "./dom.js";

export async function loadDay(ctx, date = today()) {
  return (await ctx.store.get("days", date)) || { local_date: date, level_id: ctx.state.level_id, checklist: [], pain_flags: [] };
}

export async function saveDay(ctx, day) {
  await ctx.store.put("days", day);
  return day;
}

export function flagsOnDay(day, { itemKey, sessionKey } = {}) {
  if (itemKey) return flagsForItem(day, itemKey);
  if (sessionKey) return flagsForSession(day, sessionKey);
  return flagsOf(day);
}

export function flagMarkHtml(flags, itemKey = "") {
  const slot = itemKey ? ` data-flag-slot="${esc(itemKey)}"` : "";
  if (!flags?.length) return itemKey ? `<span${slot}></span>` : "";
  const worst = flags.reduce((a, b) => ((b.pain ?? 0) > (a.pain ?? 0) ? b : a));
  const title = flags.map((f) => flagSummary(f)).join("; ");
  const cls = (worst.pain ?? 0) >= 7 || worst.type === "nerve" || worst.location === "leg" ? "pain-mark hot" : "pain-mark";
  return `<span class="${cls}"${slot} title="${esc(title)}" aria-label="Unexpected pain flagged">!</span>`;
}

function chips(name, options, value) {
  return `<div class="flag-chips">${options.map(([k, l]) => `<label class="chip-opt"><input type="radio" name="${esc(name)}" value="${esc(k)}"${value === k ? " checked" : ""} /><span>${esc(l)}</span></label>`).join("")}</div>`;
}

function scale(name, value) {
  const v = value == null ? "" : String(value);
  return `<div class="ci-scale pain flag-scale" style="--n:11">${[...Array(11).keys()].map((n) => `<label class="ci-cell"><input type="radio" name="${esc(name)}" value="${n}"${v === String(n) ? " checked" : ""} /><span>${n}</span></label>`).join("")}</div>`;
}

export function flagFormHtml(flag, { heading = "Flag unexpected pain" } = {}) {
  return `<div class="pain-flag-form" id="pain-flag-form">
    <h4>${esc(heading)}</h4>
    <p class="muted small">Only for unexpected pain during this movement, not normal muscle work. You can edit or clear this later.</p>
    <p class="flag-q">Pain 0–10</p>
    ${scale("flag_pain", flag?.pain)}
    <p class="flag-q">Where</p>
    ${chips("flag_loc", PAIN_LOCS, flag?.location)}
    <p class="flag-q">What kind</p>
    ${chips("flag_type", PAIN_TYPES, flag?.type)}
    <label class="field">Note (optional)<input name="flag_note" value="${esc(flag?.note || "")}" placeholder="What happened"></label>
    <div class="flag-actions">
      <button class="btn primary" type="button" data-flag-save>Save flag</button>
      ${flag ? `<button class="btn" type="button" data-flag-clear>Clear</button>` : ""}
      <button class="btn" type="button" data-flag-cancel>Cancel</button>
    </div>
    <div class="flag-guidance" id="flag-guidance" hidden></div>
  </div>`;
}

export function flagSummaryHtml(flag, { itemName } = {}) {
  if (!flag) return "";
  const when = flag.ts ? new Date(flag.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  return `<div class="pain-flag-saved">
    <p><b>Flagged${when ? ` at ${esc(when)}` : ""}</b> · ${esc(flag.pain)}/10 · ${esc(TYPE_LABEL[flag.type] || flag.type)} · ${esc(LOC_LABEL[flag.location] || flag.location)}${itemName ? ` · ${esc(itemName)}` : ""}</p>
    ${flag.note ? `<p class="muted small">${esc(flag.note)}</p>` : ""}
    <div class="flag-actions">
      <button class="btn" type="button" data-flag-edit>Edit</button>
      <button class="btn" type="button" data-flag-clear>Clear</button>
    </div>
  </div>`;
}

function readForm(root) {
  const painEl = root.querySelector("[name=flag_pain]:checked");
  const loc = root.querySelector("[name=flag_loc]:checked")?.value;
  const typ = root.querySelector("[name=flag_type]:checked")?.value;
  const note = root.querySelector("[name=flag_note]")?.value || "";
  if (!painEl || !loc || !typ) return { error: "Pick a pain number, where it was, and what kind." };
  return { pain: Number(painEl.value), location: loc, type: typ, note };
}

export function showGuidance(root, flag) {
  const box = root.querySelector("#flag-guidance") || root.querySelector(".flag-guidance");
  if (!box) return;
  if (!needsRedGuidance(flag)) { box.hidden = true; box.innerHTML = ""; return; }
  const g = redGuidance({ kind: "clinician" });
  box.hidden = false;
  box.innerHTML = `<p><b>${esc(g.title)}</b></p><p>${esc(g.body)}</p>
    <p class="muted small">Saddle-area numbness or a change in bladder or bowel control means emergency care. <a href="#/red">Open the red-flag screen</a>.</p>`;
}

export async function persistFlag(ctx, { date, existing, item_key, session_key, pain, location, type, note }) {
  const day = await loadDay(ctx, date || today());
  const flag = newFlag({
    id: existing?.id,
    item_key: item_key ?? existing?.item_key,
    session_key: session_key ?? existing?.session_key,
    pain, location, type, note,
    ts: existing?.ts || isoLocal(),
  });
  const next = await saveDay(ctx, upsertFlag(day, flag));
  return { day: next, flag };
}

export async function persistClear(ctx, date, id) {
  const day = await loadDay(ctx, date || today());
  return saveDay(ctx, removeFlag(day, id));
}

export function wireFlagPanel(root, ctx, { itemKey, sessionKey, itemName, heading, onChange }) {
  const box = root.querySelector("#pain-flag") || root;
  const date = today();

  const paint = async (mode) => {
    const day = await loadDay(ctx, date);
    const list = flagsOnDay(day, { itemKey, sessionKey });
    const flag = list[list.length - 1] || null;
    const showForm = mode === "form" || (!flag && mode === "form-if-empty");
    if (showForm) {
      box.innerHTML = flagFormHtml(flag, { heading });
    } else if (flag) {
      box.innerHTML = flagSummaryHtml(flag, { itemName }) + (needsRedGuidance(flag) ? `<div class="flag-guidance" id="flag-guidance"></div>` : "");
      if (needsRedGuidance(flag)) showGuidance(box, flag);
    } else {
      box.innerHTML = `<button class="btn flag-open" type="button" data-flag-open>Flag unexpected pain</button>
        <p class="muted small">Use this if something unexpected showed up during ${itemName ? esc(itemName) : "this workout"}.</p>`;
    }
    box.dataset.flagId = flag?.id || "";
  };

  box.onclick = async (e) => {
    const t = e.target.closest("[data-flag-open],[data-flag-edit],[data-flag-save],[data-flag-clear],[data-flag-cancel]");
    if (!t) return;
    e.preventDefault();
    if (t.dataset.flagOpen != null || t.dataset.flagEdit != null) { await paint("form"); return; }
    if (t.dataset.flagCancel != null) { await paint(); onChange?.(); return; }
    if (t.dataset.flagClear != null) {
      const id = box.dataset.flagId;
      if (id) await persistClear(ctx, date, id);
      toast("Pain flag cleared.");
      await paint();
      onChange?.();
      return;
    }
    if (t.dataset.flagSave != null) {
      const form = box.querySelector("#pain-flag-form") || box;
      const read = readForm(form);
      if (read.error) { toast(read.error); return; }
      const day = await loadDay(ctx, date);
      const existing = flagsOnDay(day, { itemKey, sessionKey }).find((f) => f.id === box.dataset.flagId);
      const { flag } = await persistFlag(ctx, { date, existing, item_key: itemKey, session_key: sessionKey, ...read });
      toast("Pain flag saved.");
      await paint();
      showGuidance(box, flag);
      onChange?.();
    }
  };

  return paint();
}
