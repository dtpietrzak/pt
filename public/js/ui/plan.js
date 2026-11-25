// Plan view: current level criteria, all blocks, and full L0-L8 overview.
import { currentDose } from "../engine.js";
import { formatDose } from "../dose.js";
import { esc, BLOCKS, showExercise } from "./dom.js";

const openPlanBlocks = new Set();
const CHEVRON = `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

export function renderPlan(ctx, main) {
  const lv = ctx.level();
  const testUnit = (id) => ctx.docs.tests.tests.find((t) => t.id === id)?.unit || "";
  const testName = (id) => ctx.docs.tests.tests.find((t) => t.id === id)?.name || id;

  let html = `<section class="card">
    <h2>${esc(lv.id)} · ${esc(lv.name)}</h2><p>${esc(lv.goal)}</p>
    <h4>Leave this level when</h4><ul>
      ${lv.exit?.clean_streak_sessions ? `<li>${lv.exit.clean_streak_sessions} clean strength sessions in a row</li>` : ""}
      ${lv.exit?.all_non_optional_items_at_target ? `<li>All non-optional items at target</li>` : ""}
      ${(lv.exit?.tests || []).map((t) => `<li>Gate test ${esc(testName(t.test_id))}: ${esc(t.threshold?.value)}${typeof t.threshold?.value === "number" ? " " + esc(testUnit(t.test_id)) : ""}${t.threshold?.note ? ` (${esc(t.threshold.note)})` : ""}${t.optional ? " · optional" : ""}</li>`).join("")}
      ${(lv.exit?.extra || []).map((x) => `<li>${esc(x)}</li>`).join("")}
    </ul>
    ${lv.avoid?.length ? `<h4>Avoid</h4><ul class="avoid">${lv.avoid.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}
  </section>`;

  for (const [block, label] of BLOCKS) {
    const its = lv.items.filter((i) => i.block === block);
    if (!its.length) continue;
    const atTarget = its.filter((it) => currentDose(ctx.state, it).rung >= it.target_rung).length;
    const optCount = its.filter((it) => it.optional).length;
    const allAtTarget = atTarget === its.length;
    const subParts = [`${its.length} ${its.length === 1 ? "exercise" : "exercises"}`];
    if (optCount) subParts.push(`${optCount} optional`);
    const isOpen = openPlanBlocks.has(block);
    html += `
      <section class="card section-card${allAtTarget ? " complete" : ""}${isOpen ? " open" : ""}" data-block="${block}">
        <button class="section-head" type="button" data-toggle-block="${block}" aria-expanded="${isOpen}">
          <div class="section-title">
            <span class="section-name">${esc(label)}</span>
            <span class="section-sub">${esc(subParts.join(" · "))}</span>
          </div>
          <div class="section-right">
            <span class="section-badge">${atTarget}/${its.length} target${allAtTarget ? " ✓" : ""}</span>
            ${CHEVRON}
          </div>
          <span class="section-bar" aria-hidden="true"><span style="width:${Math.round((atTarget / its.length) * 100)}%"></span></span>
        </button>
        <div class="section-body" data-block-body="${block}"${isOpen ? "" : " hidden"}>${its.map((it) => {
      const ex = ctx.exById[it.exercise_id] || { name: it.exercise_id };
      const { dose, rung } = currentDose(ctx.state, it);
      return `<button class="plan-item" type="button" data-info="${esc(it.item_key)}"><span class="name">${esc(ex.name)}${it.optional ? " <i class='muted'>(optional)</i>" : ""}</span>
        <span class="meta">Now: ${esc(formatDose(dose, it, ctx.profile))} · target ${esc(formatDose(it.rungs[it.target_rung], it, ctx.profile))} · rung ${rung + 1}/${it.rungs.length}</span></button>`;
    }).join("")}</div>
      </section>`;
  }

  html += `<section class="block"><h3>All levels</h3>${ctx.docs.levels.levels.map((l) => `
    <details class="lvl ${l.id === lv.id ? "cur" : ""}"><summary><b>${esc(l.id)}</b> ${esc(l.name)}</summary>
      <p class="small">${esc(l.goal)}</p>
      <p class="muted small">${l.items.length} items · ${(l.exit?.tests || []).length} gate tests${l.frequency?.strength_sessions_per_week ? ` · ${l.frequency.strength_sessions_per_week} strength sessions/week` : ""}</p>
    </details>`).join("")}</section>
    <p class="muted small center">Plan v${ctx.docs.levels.plan_version ?? 1} · ${ctx.docs.exercises.exercises.length} exercises · ${ctx.docs.tests.tests.length} tests</p>`;

  main.innerHTML = html;
  main.onclick = (e) => {
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
        if (nextOpen) openPlanBlocks.add(block);
        else openPlanBlocks.delete(block);
      }
      return;
    }
    const info = e.target.closest("[data-info]");
    if (info) showExercise(ctx, info.dataset.info);
  };
}
