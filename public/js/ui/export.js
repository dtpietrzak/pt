// Weekly export and agent plan-patch review (phase 4).
import { gatherExport, applyPlanPatch, revertPlanPatch, rejectPlanPatch } from "../pipeline.js";
import { extractPatch, dueExportWeek, weekRange } from "../export.js";
import { addDays, localDate, localTime } from "../util.js";
import { $, esc, today, toast, download, confirmSheet } from "./dom.js";

const APP_VERSION = "pt.davidp.dev";
const SCHEMA_NAMES = ["plan-patch", "levels", "exercises", "tests"];
let schemaCache = null, briefCache = null;

async function loadSchemas() {
  if (schemaCache) return schemaCache;
  const [patch, levels, exercises, tests] = await Promise.all(SCHEMA_NAMES.map((n) => fetch(`data/schemas/${n}.schema.json`).then((r) => r.json())));
  schemaCache = { patch, levels, exercises, tests };
  return schemaCache;
}
async function loadBrief() {
  if (briefCache) return briefCache;
  briefCache = await fetch("data/agent-brief.json").then((r) => r.json());
  return briefCache;
}

export async function weekHasData(store, start) {
  const end = addDays(start, 6);
  const inWeek = (d) => d >= start && d <= end;
  const [checkins, sessions] = await Promise.all([store.all("checkins"), store.all("sessions")]);
  return checkins.some((c) => inWeek(c.local_date)) || sessions.some((s) => inWeek(s.local_date));
}

export async function exportDueInfo(ctx, now = new Date()) {
  const exported = await ctx.store.kvGet("export_done");
  const info = dueExportWeek({
    today: localDate(now), timeHM: localTime(now),
    evening: ctx.profile?.notify?.evening || "15:30",
    exported,
  });
  if (!info.due) return info;
  info.due = await weekHasData(ctx.store, info.start);
  return info;
}

/** Today / Settings card + a one-time local notification when a finished week hasn't been exported. */
export async function exportCardHtml(ctx, now = new Date()) {
  const info = await exportDueInfo(ctx, now);
  if (!info.due) return "";
  maybeNotifyExport(info);
  return `<section class="card export-due">
    <div class="card-head"><h3>Weekly export is ready</h3></div>
    <div class="card-body">
    <p class="muted small">${fmtWeek(info.start, info.end)} is complete. Download the summary for an agent, or paste a plan-change reply.</p>
    <a class="btn" href="#/export">Open export</a>
    </div>
  </section>`;
}

export function markSettingsDue(due) {
  const nav = document.querySelector('.nav a[data-page="settings"]');
  if (nav) nav.classList.toggle("has-due", !!due);
}

let exportNotified = null;
async function maybeNotifyExport(info) {
  if (!info?.due) return;
  const key = `pt:export-notified:${info.start}`;
  if (exportNotified === key) return;
  try { if (localStorage.getItem(key)) { exportNotified = key; return; } } catch { /* ignore */ }
  exportNotified = key;
  try { localStorage.setItem(key, "1"); } catch { /* ignore */ }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body: `Export ${fmtWeek(info.start, info.end)}.`, tag: "pt-export-week", icon: "icons/icon-192.png", badge: "icons/icon-192.png" };
    if (reg?.showNotification) await reg.showNotification("Weekly export is ready", opts);
    else new Notification("Weekly export is ready", opts);
  } catch { /* ignore */ }
}

const fmtWeek = (a, b) => {
  const f = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(a)} – ${f(b)}`;
};

async function markExported(store, start) {
  const prev = await store.kvGet("export_done");
  // Keep the most recently finished week; don't let exporting an older week clear a newer due flag incorrectly.
  if (!prev || prev <= start) await store.kvSet("export_done", start);
}

export async function renderExport(ctx, main) {
  const d = today();
  const current = weekRange(d);
  let start = (await ctx.store.kvGet("export_week")) || current.start;
  if (start > current.start) start = current.start;
  await draw(ctx, main, start);
}

async function draw(ctx, main, start) {
  const end = addDays(start, 6);
  const current = weekRange(today());
  const notes = (await ctx.store.kvGet(`export_notes:${start}`)) || "";
  const patches = (await ctx.store.all("patches").catch(() => [])).slice().sort((a, b) => String(b.applied_at || b.rejected_at || b.created_at || "").localeCompare(String(a.applied_at || a.rejected_at || a.created_at || "")));
  const due = await exportDueInfo(ctx);
  markSettingsDue(due.due);

  main.innerHTML = `
    <p class="back"><a href="#/settings">← Settings</a></p>
    <section class="card">
      <div class="card-head">
        <h2>Weekly export</h2>
        <p class="muted small">A JSON file and a markdown summary of one Monday–Sunday week, for you or an agent to review. Partial weeks are fine.</p>
      </div>
      <div class="card-body">
      <div class="week-nav">
        <button class="btn" type="button" data-week="-1" aria-label="Previous week">‹</button>
        <div class="week-label"><b>${esc(fmtWeek(start, end))}</b><span class="muted small">${start === current.start ? "This week" : start === addDays(current.start, -7) ? "Last week" : start}</span></div>
        <button class="btn" type="button" data-week="1" ${start >= current.start ? "disabled" : ""} aria-label="Next week">›</button>
      </div>
      <label class="field">Notes for this week<textarea id="ex-notes" rows="3" placeholder="Anything odd, lingering tightness, questions…">${esc(notes)}</textarea></label>
      <div class="row-actions">
        <button class="btn primary" type="button" data-build>Build export</button>
      </div>
      <div id="ex-out" hidden></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head">
        <h2>Plan change from an agent</h2>
        <p class="muted small">Paste the agent's JSON (markdown after it is fine) or upload a file. You'll see a preview of every change before anything is applied.</p>
      </div>
      <div class="card-body">
      <label class="field">Paste the reply<textarea id="patch-text" rows="8" placeholder='{ "kind": "pt-plan-patch", ... }'></textarea></label>
      <div class="row-actions">
        <label class="btn"><input type="file" id="patch-file" accept="application/json,.json,.md,.txt" hidden>Upload file</label>
        <button class="btn primary" type="button" data-review>Review</button>
      </div>
      <div id="patch-out"></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Applied and rejected patches</h2></div>
      <div class="card-body">
      ${patches.length ? patchLogHtml(patches) : `<p class="muted small">None yet. A patch you apply or discard is recorded here and syncs between your devices. You can undo the most recent applied patch.</p>`}
      </div>
    </section>`;

  await ctx.store.kvSet("export_week", start);

  const notesEl = $("#ex-notes", main);
  let notesT;
  notesEl.addEventListener("input", () => {
    clearTimeout(notesT);
    notesT = setTimeout(() => ctx.store.kvSet(`export_notes:${start}`, notesEl.value), 300);
  });

  main.onclick = async (e) => {
    const weekBtn = e.target.closest("[data-week]");
    if (weekBtn) {
      const next = addDays(start, 7 * +weekBtn.dataset.week);
      if (next > current.start) return;
      return draw(ctx, main, next);
    }
    if (e.target.closest("[data-build]")) return build(ctx, main, start, end, notesEl.value);
    if (e.target.closest("[data-review]")) return review(ctx, main, $("#patch-text", main).value);
    if (e.target.closest("[data-copy]")) { await copyText(e.target.dataset.copy, e.target.dataset.what); if (main._export) await markExported(ctx.store, start); return; }
    if (e.target.closest("[data-dl]")) {
      const kind = e.target.dataset.dl;
      const built = main._export;
      if (!built) return;
      if (kind === "json") download(`${built.stem}.json`, JSON.stringify(built.json, null, 2), "application/json");
      else download(`${built.stem}.md`, built.markdown, "text/markdown");
      await markExported(ctx.store, start);
      toast("Downloaded.");
      return;
    }
    if (e.target.closest("[data-share]")) return shareExport(ctx, start, main._export);
    if (e.target.closest("[data-apply]")) return apply(ctx, main, e.target.closest("[data-apply]").dataset.apply === "safety");
    if (e.target.closest("[data-discard]")) return discard(ctx, main);
    if (e.target.closest("[data-revert]")) return revert(ctx, main, e.target.closest("[data-revert]").dataset.revert);
  };

  $("#patch-file", main).onchange = async (ev) => {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (!f) return;
    $("#patch-text", main).value = await f.text();
    return review(ctx, main, $("#patch-text", main).value);
  };
}

async function build(ctx, main, start, end, notes) {
  const out = $("#ex-out", main);
  out.hidden = false;
  out.innerHTML = `<p class="muted">Building…</p>`;
  await ctx.store.kvSet(`export_notes:${start}`, notes || "");
  try {
    const built = await gatherExport(ctx.store, ctx.docs, ctx.profile, {
      start, end, userNotes: notes, appVersion: APP_VERSION, agentBrief: await loadBrief(),
    });
    main._export = built;
    const canShare = typeof navigator.share === "function";
    out.innerHTML = `
      <p class="muted small">Export id <code>${esc(built.json.meta.export_id)}</code> · plan v${built.json.meta.plan_version} · ${built.json.sessions.length} session${built.json.sessions.length === 1 ? "" : "s"} · ${built.json.checkins.length} check-in${built.json.checkins.length === 1 ? "" : "s"}.</p>
      <div class="row-actions wrap">
        <button class="btn" type="button" data-dl="json">Download JSON</button>
        <button class="btn" type="button" data-dl="md">Download markdown</button>
        <button class="btn" type="button" data-copy data-what="markdown">Copy markdown</button>
        <button class="btn" type="button" data-copy data-what="json">Copy JSON</button>
        ${canShare ? `<button class="btn" type="button" data-share>Share</button>` : ""}
      </div>
      <details class="ex-preview"><summary>Preview the markdown</summary><pre class="md-preview">${esc(built.markdown)}</pre></details>`;
    // Stash copy payloads on the buttons after paint.
    out.querySelectorAll("[data-copy]").forEach((b) => {
      b.dataset.copy = b.dataset.what === "json" ? JSON.stringify(built.json, null, 2) : built.markdown;
    });
  } catch (err) {
    out.innerHTML = `<p class="err">${esc(err.message || String(err))}</p>`;
  }
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what === "json" ? "JSON" : "markdown"}.`);
  } catch {
    toast("Couldn't copy — try download instead.");
  }
  const built = document.querySelector("#ex-out") && document.querySelector("#main")?._export;
  // mark exported when we have the week start on the page
}

async function shareExport(ctx, start, built) {
  if (!built || typeof navigator.share !== "function") return toast("Sharing isn't available here.");
  try {
    const files = [
      new File([JSON.stringify(built.json, null, 2)], `${built.stem}.json`, { type: "application/json" }),
      new File([built.markdown], `${built.stem}.md`, { type: "text/markdown" }),
    ];
    const payload = { title: `PT ${built.stem}`, text: built.markdown };
    if (navigator.canShare?.({ files })) payload.files = files;
    await navigator.share(payload);
    await markExported(ctx.store, start);
  } catch (e) {
    if (e?.name !== "AbortError") toast("Couldn't share — try download instead.");
  }
}

async function review(ctx, main, text) {
  const box = $("#patch-out", main);
  const extracted = extractPatch(text);
  if (!extracted.ok) {
    box.innerHTML = `<p class="err">${esc(extracted.error)}</p>`;
    main._review = null;
    return;
  }
  box.innerHTML = `<p class="muted">Checking…</p>`;
  try {
    const schemas = await loadSchemas();
    const { validatePatch } = await import("../patch.js");
    const review = await validatePatch(extracted.patch, { levels: ctx.docs.levels, exercises: ctx.docs.exercises, tests: ctx.docs.tests }, schemas);
    main._review = { patch: extracted.patch, review, schemas };
    box.innerHTML = reviewHtml(extracted.patch, review);
  } catch (err) {
    box.innerHTML = `<p class="err">${esc(err.message || String(err))}</p>`;
    main._review = null;
  }
}

function reviewHtml(patch, review) {
  const ev = (patch.evidence || []).map((e) => `<li><code>${esc(e.export_ref)}</code>${e.note ? ` — ${esc(e.note)}` : ""}</li>`).join("");
  const reqs = (patch.app_change_requests || []).map((r) => `<li><b>${esc(r.title)}</b> (${esc(r.priority || "")}): ${esc(r.description || "")}</li>`).join("");
  const errs = review.errors.map((e) => `<li>${esc(e)}</li>`).join("");
  const safety = review.safety.map((e) => `<li>${esc(e)}</li>`).join("");
  const diffs = (review.diff || []).filter((d) => d.op !== "test").map((d) => `
    <div class="diff-row">
      <div class="diff-label">${esc(d.label)} <span class="muted">${esc(d.op)}</span></div>
      ${d.op === "test" ? `<div class="muted small">${esc(d.text)}</div>` : `
        <div class="diff-before">${esc(d.before ?? "")}</div>
        <div class="diff-after">${esc(d.after ?? "")}</div>`}
    </div>`).join("");
  const onlySafety = !review.ok && review.safety.length && review.errors.length && review.errors.every((e) => /safety_review_required/.test(e));
  const ok = review.ok;
  return `
    <div class="patch-review ${ok || onlySafety ? "ok" : "bad"}">
      <p><b>${esc(patch.summary || "Untitled patch")}</b></p>
      <p class="muted small">By ${esc(patch.author?.name || patch.author?.kind || "an agent")} · risk ${esc(patch.risk || "unspecified")}${patch.safety_review_required || review.safety.length ? " · needs a safety review" : ""} · base plan v${esc(patch.base?.plan_version)}</p>
      ${patch.rationale ? `<p>${esc(patch.rationale)}</p>` : ""}
      ${patch.expected_effect ? `<p class="muted small">Expected: ${esc(patch.expected_effect)}</p>` : ""}
      ${ev ? `<p class="muted small">Evidence</p><ul class="compact">${ev}</ul>` : ""}
      ${diffs ? `<p class="muted small">What will change</p><div class="diff">${diffs}</div>` : `<p class="muted small">No document changes (test-only / no-op).</p>`}
      ${reqs ? `<p class="muted small">App change requests (not applied automatically)</p><ul class="compact">${reqs}</ul>` : ""}
      ${safety ? `<div class="safety"><b>Safety review</b><ul class="compact">${safety}</ul><p class="small">These are allowed only if you explicitly confirm them.</p></div>` : ""}
      ${errs && !onlySafety ? `<div class="err-box"><b>Can't apply</b><ul class="compact">${errs}</ul></div>` : ""}
      ${ok || onlySafety ? `<div class="row-actions">
          <button class="btn primary ${onlySafety ? "danger" : ""}" type="button" data-apply="${onlySafety ? "safety" : "ok"}">${onlySafety ? "I understand, apply anyway" : "Apply this patch"}</button>
          <button class="btn" type="button" data-discard>Discard</button>
        </div>` : `<div class="row-actions"><button class="btn" type="button" data-discard>Discard</button></div>`}
    </div>`;
}

async function apply(ctx, main, asSafety) {
  const packed = main._review;
  if (!packed) return;
  if (asSafety) {
    const ok = await confirmSheet({
      title: "Apply a change that needs a safety review?",
      body: packed.review.safety.join(" ") + " This will change the plan documents on every signed-in device.",
      confirmLabel: "Apply anyway",
      danger: true,
    });
    if (!ok) return;
  } else {
    const ok = await confirmSheet({
      title: "Apply this plan change?",
      body: packed.patch.summary || "The plan documents will update on every signed-in device.",
      confirmLabel: "Apply",
    });
    if (!ok) return;
  }
  const patch = asSafety ? { ...packed.patch, safety_review_required: true } : packed.patch;
  const r = await applyPlanPatch(ctx.store, ctx.docs, ctx.profile, patch, packed.schemas, { confirmSafety: !!asSafety || packed.review.safety.length === 0 });
  if (!r.ok) {
    if (r.needsSafetyConfirm) {
      packed.review = r.review;
      $("#patch-out", main).innerHTML = reviewHtml(packed.patch, r.review);
      toast("This change needs an explicit safety confirmation.");
      return;
    }
    $("#patch-out", main).innerHTML = reviewHtml(packed.patch, r.review);
    toast("The patch was not applied.");
    return;
  }
  ctx.docs = r.docs;
  if (r.state) ctx.state = r.state;
  ctx.indexExercises?.();
  toast("Plan change applied.");
  main._review = null;
  await draw(ctx, main, (await ctx.store.kvGet("export_week")) || weekRange(today()).start);
}

async function discard(ctx, main) {
  const packed = main._review;
  if (!packed) { $("#patch-out", main).innerHTML = ""; $("#patch-text", main).value = ""; return; }
  await rejectPlanPatch(ctx.store, packed.patch, "Discarded");
  toast("Discarded.");
  main._review = null;
  await draw(ctx, main, (await ctx.store.kvGet("export_week")) || weekRange(today()).start);
}

async function revert(ctx, main, patchId) {
  const ok = await confirmSheet({
    title: "Undo this plan change?",
    body: "The plan documents go back to the snapshot taken just before this patch. Your check-ins and sessions are kept; exercise progress is adjusted to fit the restored plan.",
    confirmLabel: "Undo patch",
    danger: true,
  });
  if (!ok) return;
  const r = await revertPlanPatch(ctx.store, ctx.docs, patchId);
  if (!r.ok) { toast(r.error); return; }
  ctx.docs = r.docs;
  if (r.state) ctx.state = r.state;
  ctx.indexExercises?.();
  toast("Patch undone.");
  await draw(ctx, main, (await ctx.store.kvGet("export_week")) || weekRange(today()).start);
}

function patchLogHtml(rows) {
  const latestApplied = rows.filter((p) => p.status === "applied").sort((a, b) => String(b.applied_at).localeCompare(String(a.applied_at)))[0];
  return `<ul class="patch-log">${rows.map((p) => {
    const when = (p.applied_at || p.reverted_at || p.rejected_at || p.created_at || "").slice(0, 10);
    const canRevert = p.status === "applied" && latestApplied?.patch_id === p.patch_id;
    return `<li>
      <div><b>${esc(p.summary || p.patch_id)}</b> <span class="pill ${esc(p.status)}">${esc(p.status)}</span></div>
      <div class="muted small">${esc(when)} · ${esc(p.author?.name || p.author?.kind || "")}${p.rejected_reason ? ` · ${esc(p.rejected_reason)}` : ""}</div>
      ${canRevert ? `<button class="btn" type="button" data-revert="${esc(p.patch_id)}">Undo</button>` : ""}
    </li>`;
  }).join("")}</ul>`;
}

export { fmtWeek };
