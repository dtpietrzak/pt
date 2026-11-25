// Today view: daily checklist, morning protection window, and walk/break counters.
// Uses event delegation + in-place DOM updates so tapping checkboxes or steppers never flickers.
import { currentDose } from "../engine.js";
import { formatDose, missingEquipment } from "../dose.js";
import { $, esc, BLOCKS, today, nowHM, addMin, minutesSince, fmtDate, openSheet, closeSheet, showExercise } from "./dom.js";

const DAILY = ["daily_mobility", "daily_core", "walking"];
const MORNING_WINDOW_MIN = 45;
const openBlocks = new Set();

const CHEVRON = `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

async function dayLog(ctx, d) {
  return (await ctx.store.get("days", d)) || { local_date: d, level_id: ctx.state.level_id, checklist: [] };
}

function blockSummary(block, its, doneSet, log, walkTarget) {
  const total = its.length;
  const doneTotal = its.filter((i) => doneSet.has(i.item_key)).length;
  const reqItems = its.filter((i) => !i.optional);
  const reqDone = reqItems.filter((i) => doneSet.has(i.item_key)).length;
  const optCount = total - reqItems.length;

  if (block === "walking") {
    const walked = log.walk_min || 0;
    const complete = walkTarget > 0 ? walked >= walkTarget : doneTotal === total;
    const sub = walkTarget > 0
      ? (complete ? "Target reached, nice!" : `${walkTarget - walked} min to go`)
      : `${walked} min logged`;
    const badge = walkTarget > 0
      ? `${walked}/${walkTarget} min${complete ? " ✓" : ""}`
      : `${walked} min`;
    const pct = walkTarget > 0 ? Math.min(1, walked / walkTarget) : (total ? doneTotal / total : 0);
    return { sub, badge, complete, pct };
  }

  if (reqItems.length === 0) {
    const complete = total > 0 && doneTotal === total;
    return {
      sub: `Bonus · ${doneTotal} of ${total} done`,
      badge: `${doneTotal}/${total}${complete ? " ✓" : ""}`,
      complete,
      pct: total ? doneTotal / total : 0,
    };
  }

  const complete = reqDone === reqItems.length;
  let sub;
  if (optCount > 0) {
    sub = complete
      ? `All ${reqItems.length} required done · ${optCount} optional`
      : `${reqDone} of ${reqItems.length} required · ${optCount} optional`;
  } else {
    sub = complete ? "All done, nice!" : `${total - doneTotal} to go`;
  }
  return {
    sub,
    badge: `${doneTotal}/${total}${complete ? " ✓" : ""}`,
    complete,
    pct: reqDone / reqItems.length,
  };
}

export async function renderToday(ctx, main) {
  const d = today();
  const lv = ctx.level();
  const [log, wake] = await Promise.all([dayLog(ctx, d), ctx.store.kvGet(`wake:${d}`)]);
  const inWindow = wake && minutesSince(d, wake) < MORNING_WINDOW_MIN;
  const doneSet = new Set(log.checklist.filter((c) => c.done).map((c) => c.item_key));
  const items = lv.items.filter((i) => DAILY.includes(i.block));
  const itemsByBlock = new Map();
  for (const [block] of BLOCKS.filter(([b]) => DAILY.includes(b))) {
    const its = items.filter((i) => i.block === block);
    if (its.length) itemsByBlock.set(block, its);
  }
  const requiredKeys = new Set(items.filter((i) => !i.optional && i.block !== "walking").map((i) => i.item_key));
  const nDone = [...requiredKeys].filter((k) => doneSet.has(k)).length;
  const walkTarget = ctx.state.walk?.current_min || 0;

  const cheerFor = (n) => cheer(lv, n, requiredKeys.size, inWindow);

  // The day starts with "I'm up": until then, that button is the only thing on the page.
  let html = wake ? `
    <section class="hero" id="hero">
      <div class="hero-top">
        <div class="hero-copy">
          <div class="hero-date">${fmtDate(d)}</div>
          <h2 class="hero-greet">${esc(greeting())}</h2>
          <p class="hero-cheer" id="hero-cheer">${esc(cheerFor(nDone))}</p>
        </div>
        <div class="ring${requiredKeys.size && nDone === requiredKeys.size ? " full" : ""}" id="daily-ring" style="--p:${requiredKeys.size ? nDone / requiredKeys.size : 0}">
          <span><b id="daily-ring-label">${nDone}</b><small>of ${requiredKeys.size}</small></span>
        </div>
      </div>
      <div class="wake"><span>☀️ Up at <b>${esc(wake)}</b>${inWindow ? ` · easy morning until ${addMin(wake, MORNING_WINDOW_MIN)}` : ""}</span> <button class="link" id="wake-edit" type="button">change</button></div>
    </section>` : `
    <section class="hero start" id="hero">
      <div class="hero-date">${fmtDate(d)}</div>
      <h2 class="hero-greet">${esc(greeting())}</h2>
      <p class="hero-cheer">Tap when you're out of bed. It starts a ${MORNING_WINDOW_MIN}-minute easy morning, then today's list opens up.</p>
      <button class="btn primary big wide wake-btn" id="wake-now" type="button">☀️ I'm up</button>
      <button class="link" id="wake-edit" type="button">Got up earlier? Set the time</button>
    </section>`;
  if (inWindow) {
    html += `<section class="card note">Easy start: stroll around the house for now. Core and mobility open up after your morning window.</section>`;
  }
  for (const [block, label] of wake ? BLOCKS.filter(([b]) => DAILY.includes(b)) : []) {
    const its = itemsByBlock.get(block);
    if (!its) continue;
    const locked = inWindow && (block === "daily_core" || block === "daily_mobility");
    if (locked) {
      html += `
        <section class="card section-card locked" data-block="${block}">
          <div class="section-head">
            ${BLOCK_ICON[block] || ""}
            <div class="section-title">
              <span class="section-name">${esc(label)}</span>
              <span class="section-sub">Opens at ${esc(addMin(wake, MORNING_WINDOW_MIN))}, after your easy morning</span>
            </div>
            <span class="section-badge">Later</span>
          </div>
        </section>`;
      continue;
    }
    const sum = blockSummary(block, its, doneSet, log, walkTarget);
    const isOpen = openBlocks.has(block);
    html += `
      <section class="card section-card${sum.complete ? " complete" : ""}${isOpen ? " open" : ""}" data-block="${block}">
        <button class="section-head" type="button" data-toggle-block="${block}" aria-expanded="${isOpen}">
          ${BLOCK_ICON[block] || ""}
          <div class="section-title">
            <span class="section-name">${esc(label)}</span>
            <span class="section-sub" data-block-sub="${block}">${esc(sum.sub)}</span>
          </div>
          <div class="section-right">
            <span class="section-badge" data-block-badge="${block}">${esc(sum.badge)}</span>
            ${CHEVRON}
          </div>
          <span class="section-bar" aria-hidden="true"><span data-block-bar="${block}" style="width:${Math.round(sum.pct * 100)}%"></span></span>
        </button>
        <div class="section-body" data-block-body="${block}"${isOpen ? "" : " hidden"}>`;
    for (const it of its) html += itemRow(ctx, it, doneSet.has(it.item_key));
    if (block === "walking") {
      html += stepper("Walked today", walkHint(lv, walkTarget), "walk_min", log.walk_min || 0, "min", 5);
    }
    html += `</div></section>`;
  }
  main.innerHTML = html;

  const updateBlockCard = (block, l) => {
    const its = itemsByBlock.get(block);
    if (!its) return;
    const card = main.querySelector(`[data-block="${block}"]`);
    if (!card || card.classList.contains("locked")) return;
    const doneNow = new Set(l.checklist.filter((c) => c.done).map((c) => c.item_key));
    const sum = blockSummary(block, its, doneNow, l, walkTarget);
    card.classList.toggle("complete", sum.complete);
    const subEl = card.querySelector(`[data-block-sub="${block}"]`);
    const badgeEl = card.querySelector(`[data-block-badge="${block}"]`);
    const barEl = card.querySelector(`[data-block-bar="${block}"]`);
    if (subEl) subEl.textContent = sum.sub;
    if (badgeEl) badgeEl.textContent = sum.badge;
    if (barEl) barEl.style.width = `${Math.round(sum.pct * 100)}%`;
  };

  const setWake = async (t) => {
    await ctx.store.kvSet(`wake:${d}`, t);
    renderToday(ctx, main);
  };

  main.onchange = async (e) => {
    const cb = e.target.closest("input[data-item]");
    if (!cb) return;
    const k = cb.dataset.item;
    const row = cb.closest(".item");
    row?.classList.toggle("done", cb.checked);
    if (cb.checked) {
      row?.classList.remove("pop");
      void row?.offsetWidth;
      row?.classList.add("pop");
      navigator.vibrate?.(12);
    }
    const l = await dayLog(ctx, d);
    const before = l.checklist.filter((c) => c.done && requiredKeys.has(c.item_key)).length;
    const entry = l.checklist.find((c) => c.item_key === k);
    if (entry) entry.done = cb.checked;
    else l.checklist.push({ item_key: k, done: cb.checked });
    l.level_id = ctx.state.level_id;
    await ctx.store.put("days", l);
    const doneNow = l.checklist.filter((c) => c.done && requiredKeys.has(c.item_key)).length;
    const ring = $("#daily-ring", main);
    const ringLabel = $("#daily-ring-label", main);
    if (ring) ring.style.setProperty("--p", String(requiredKeys.size ? doneNow / requiredKeys.size : 0));
    if (ringLabel) ringLabel.textContent = String(doneNow);
    ring?.classList.toggle("full", requiredKeys.size > 0 && doneNow === requiredKeys.size);
    const cheerEl = $("#hero-cheer", main);
    if (cheerEl) cheerEl.textContent = cheerFor(doneNow);
    const block = cb.closest("[data-block]")?.dataset.block;
    if (block) updateBlockCard(block, l);
    if (requiredKeys.size && doneNow === requiredKeys.size && before < requiredKeys.size) celebrate(main);
  };

  main.onclick = async (e) => {
    const toggle = e.target.closest("[data-toggle-block]");
    if (toggle) {
      const block = toggle.dataset.toggleBlock;
      const card = toggle.closest(".section-card");
      const body = card?.querySelector(`[data-block-body="${block}"]`);
      if (card && body) {
        const nextOpen = !card.classList.contains("open");
        card.classList.toggle("open", nextOpen);
        toggle.setAttribute("aria-expanded", String(nextOpen));
        body.hidden = !nextOpen;
        if (nextOpen) openBlocks.add(block);
        else openBlocks.delete(block);
      }
      return;
    }

    const info = e.target.closest("[data-info]");
    if (info) { showExercise(ctx, info.dataset.info); return; }

    const stepBtn = e.target.closest("[data-step-key]");
    if (stepBtn) {
      const key = stepBtn.dataset.stepKey;
      const delta = Number(stepBtn.dataset.delta);
      const l = await dayLog(ctx, d);
      const next = Math.max(0, (l[key] || 0) + delta);
      l[key] = next;
      const valEl = main.querySelector(`[data-step-val="${key}"]`);
      if (valEl) valEl.textContent = String(next);
      await ctx.store.put("days", l);
      const block = stepBtn.closest("[data-block]")?.dataset.block;
      if (block) updateBlockCard(block, l);
      return;
    }

    if (e.target.closest("#wake-now")) {
      await setWake(nowHM());
      return;
    }
    if (e.target.closest("#wake-edit")) {
      openWakeSheet(wake || nowHM(), setWake);
    }
  };
}

function openWakeSheet(current, onSave) {
  const root = openSheet(`
    <h2>Wake time</h2>
    <p class="muted small">Sets the ${MORNING_WINDOW_MIN}-minute morning protection window.</p>
    <form id="wake-form">
      <label class="field">Time<input type="time" name="wake" value="${esc(current)}" required /></label>
      <div class="sheet-actions">
        <button class="btn" type="button" data-close>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>`);
  $("#wake-form", root).onsubmit = async (ev) => {
    ev.preventDefault();
    const val = new FormData(ev.target).get("wake");
    if (val) {
      closeSheet();
      await onSave(String(val));
    }
  };
}

function stepper(title, hint, key, value, unit, step) {
  const unitHtml = unit ? ` ${esc(unit)}` : "";
  return `<div class="stepper">
      <div class="stepper-copy"><span>${esc(title)}</span><small>${esc(hint)}</small></div>
      <div class="stepper-ctrl">
        <button class="btn icon" type="button" data-step-key="${key}" data-delta="-${step}" aria-label="minus ${step}">−</button>
        <b data-step-val="${key}">${esc(value)}</b>${unitHtml}
        <button class="btn icon" type="button" data-step-key="${key}" data-delta="${step}" aria-label="plus ${step}">+</button>
      </div></div>`;
}

function walkHint(lv, target) {
  const bouts = lv.walking?.bouts ? `, in ${lv.walking.bouts} walks` : "";
  return `Easy pace on flat ground${bouts}. Aim for ${target} min today.`;
}

function itemRow(ctx, it, done) {
  const ex = ctx.exById[it.exercise_id] || { name: it.exercise_id };
  const { dose, rung } = currentDose(ctx.state, it);
  const miss = missingEquipment(ex, ctx.profile.equipment);
  const ladder = it.rungs.length > 1 ? `rung ${rung + 1}/${it.rungs.length}` : "";
  return `<div class="item ${done ? "done" : ""}">
    <label class="check"><input type="checkbox" data-item="${esc(it.item_key)}" ${done ? "checked" : ""} aria-label="${esc(ex.name)}" /></label>
    <button class="text" type="button" data-info="${esc(it.item_key)}">
      <span class="name">${esc(ex.name)}</span>
      <span class="meta">${esc(formatDose(dose, it, ctx.profile))}${ladder ? ` · ${ladder}` : ""}${it.optional ? ` · <span class="bonus">bonus</span>` : ""}${miss.length ? ` · <span class="warn">needs ${esc(miss.join(", "))}</span>` : ""}</span>
      ${it.note ? `<span class="meta note-line">${esc(it.note)}</span>` : ""}
    </button></div>`;
}

// ---------------------------------------------------------------- hero and celebration

const ICON_PATHS = {
  daily_mobility: `<path d="M3 17c3 0 3-10 6-10s3 10 6 10 3-10 6-10"/>`,
  daily_core: `<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>`,
  walking: `<ellipse cx="8.5" cy="8" rx="2.6" ry="4"/><path d="M7.4 14.5h2.4"/><ellipse cx="15.5" cy="12" rx="2.6" ry="4"/><path d="M14.4 18.5h2.4"/>`,
};
const BLOCK_ICON = Object.fromEntries(Object.entries(ICON_PATHS).map(([b, p]) =>
  [b, `<span class="section-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${p}</svg></span>`]));

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Hey, night owl" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function cheer(lv, n, total, inWindow) {
  if (lv.number === 0) return "Settle mode. Rest, gentle walks and relief positions are the work today.";
  if (inWindow) return "Easy start. Let your back wake up before the stretches.";
  if (!total) return "Nothing required today. Move in whatever way feels good.";
  if (n === 0) return "A few gentle minutes is all today asks.";
  if (n >= total) return "All done for today. Nice work, your back says thanks.";
  if (n / total >= 0.5) return `More than halfway there. ${total - n} to go.`;
  return `Nice start. ${n} down, ${total - n} to go.`;
}

function celebrate(main) {
  navigator.vibrate?.([20, 60, 30]);
  const hero = $("#hero", main);
  if (!hero) return;
  hero.classList.remove("celebrate");
  void hero.offsetWidth;
  hero.classList.add("celebrate");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["var(--accent)", "var(--green)", "var(--yellow)", "var(--blk-mobility)", "var(--sun)"];
  const burst = document.createElement("div");
  burst.className = "confetti";
  burst.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 28; i++) {
    const s = document.createElement("span");
    const a = (Math.PI * 2 * i) / 28 + Math.random() * 0.3;
    const r = 70 + Math.random() * 90;
    s.style.setProperty("--x", `${Math.cos(a) * r}px`);
    s.style.setProperty("--y", `${Math.sin(a) * r - 40}px`);
    s.style.setProperty("--r", `${Math.random() * 540 - 270}deg`);
    s.style.background = colors[i % colors.length];
    burst.appendChild(s);
  }
  $("#daily-ring", main)?.appendChild(burst);
  setTimeout(() => burst.remove(), 1400);
}
