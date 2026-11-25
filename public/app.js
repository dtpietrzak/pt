// PT — personal lumbar-disc rehab tracker.
// App coordinator: boots IndexedDB + seed data, routes views, runs work timer & background cloud sync.
import { openDb, createStore } from "./js/db.js";
import { createSyncedStore } from "./js/sync.js";
import { createTimerUI } from "./js/timer-ui.js";
import { initCloud, cloudState } from "./js/cloud.js";
import { boot } from "./js/data.js";
import { isoLocal } from "./js/util.js";
import { levelById } from "./js/engine.js";
import { $, esc, toast } from "./js/ui/dom.js";
import { loadCachedUser, saveCachedUser, activeUser, renderAccount, closeAccountMenu, wireAccountMenu, renderLogin, updateLoginStatus } from "./js/ui/account.js";
import { renderToday } from "./js/ui/today.js";
import { renderPlan } from "./js/ui/plan.js";
import { renderSettings } from "./js/ui/settings.js";
import { renderHistory, refreshEngine, startReminders } from "./js/ui/checkins.js";

const PAGES = { today: "Today", work: "Work", plan: "Plan", settings: "Settings", history: "History" };
const main = $("#main");

let showingLogin = false;
const ctx = {
  store: null,
  docs: null,
  profile: null,
  app: null,
  state: null,
  exById: {},
  timerUI: null,
  indexExercises() {
    this.exById = Object.fromEntries(this.docs.exercises.exercises.map((e) => [e.id, e]));
  },
  level() {
    return levelById(this.docs.levels, this.state.level_id);
  },
  render,
};

function renderWork(c, root) {
  root.innerHTML = "";
  c.timerUI.show();
}

const VIEWS = { today: renderToday, work: renderWork, plan: renderPlan, settings: renderSettings, history: renderHistory };

function route() {
  let r = location.hash.replace(/^#\/?/, "") || "today";
  if (r === "timer") { location.replace("#/work"); r = "work"; }
  return PAGES[r] ? r : "today";
}

function render() {
  main.onclick = null;
  main.onchange = null;
  ctx.timerUI?.hide();
  if (!activeUser()) {
    showingLogin = true;
    renderLogin(main);
    return;
  }
  showingLogin = false;
  const r = route();
  $("#title").textContent = PAGES[r];
  $("#level-chip").textContent = `${ctx.state.level_id}${ctx.state.mode !== "active" ? " · " + ctx.state.mode : ""}`;
  $("#level-chip").hidden = false;
  renderAccount(ctx);
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("on", a.dataset.page === (r === "history" ? "today" : r)));
  $(".nav").hidden = false;
  VIEWS[r](ctx, main);
}

// Another device changed something: re-read IndexedDB and re-render (never while typing or in a sheet).
let reloadT;
let lastRemoteAt = 0;
let reloadPending = false;
function reloadFromStore() {
  clearTimeout(reloadT);
  reloadT = setTimeout(async () => {
    const editing = main.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (editing || !$("#sheet").hidden) { reloadPending = true; return; }
    reloadPending = false;
    lastRemoteAt = Date.now();
    const [d, p, a, st] = await Promise.all(["docs", "profile", "app", "state"].map((k) => ctx.store.kvGet(k)));
    if (d && d !== ctx.docs) { ctx.docs = d; ctx.indexExercises(); }
    if (p) ctx.profile = p;
    if (a) ctx.app = { ...ctx.app, ...a };
    if (st) ctx.state = st;
    await ctx.timerUI?.reload();
    if (activeUser()) render();
  }, 150);
}
main.addEventListener("focusout", () => { if (reloadPending) setTimeout(reloadFromStore, 300); });

function onCloudChange() {
  const c = cloudState();
  if (c.user) {
    saveCachedUser(c.user);
    if (showingLogin) {
      if (!location.hash || location.hash === "#") location.hash = "#/today";
      render();
      return;
    }
    renderAccount(ctx);
    return;
  }
  if (c.authResolved && !c.user) {
    saveCachedUser(null);
    closeAccountMenu();
    if (!showingLogin) render();
    else updateLoginStatus();
    return;
  }
  if (showingLogin) updateLoginStatus();
  else renderAccount(ctx);
}

function connectCloud() {
  if (cloudState().available) return;
  initCloud(ctx.store, { onChange: onCloudChange, onApplied: reloadFromStore })
    .catch((e) => { console.warn("Sync unavailable:", e); onCloudChange(); });
}

async function start() {
  loadCachedUser();
  ctx.store = createSyncedStore(createStore(await openDb()));
  const b = await boot(ctx.store, isoLocal());
  ctx.store.endBoot();
  ({ docs: ctx.docs, profile: ctx.profile, app: ctx.app, state: ctx.state } = b);
  ctx.indexExercises();
  ctx.timerUI = createTimerUI({
    store: ctx.store,
    root: main,
    chip: $("#timer-chip"),
    toast,
    ctx: () => ({ docs: ctx.docs, profile: ctx.profile, app: ctx.app, state: ctx.state, exById: ctx.exById }),
    setState: async (nextState, logEntries = []) => {
      ctx.state = nextState;
      await ctx.store.kvSet("state", nextState);
      for (const entry of logEntries) await ctx.store.put("log", entry);
      $("#level-chip").textContent = `${ctx.state.level_id}${ctx.state.mode !== "active" ? " · " + ctx.state.mode : ""}`;
    },
  });
  ctx.timerUI.init().catch((e) => console.warn("Timer unavailable:", e));
  if (b.resynced) toast("Plan data updated from the latest seed.");
  wireAccountMenu(ctx);
  window.addEventListener("hashchange", render);
  window.addEventListener("online", connectCloud);
  render();
  connectCloud();
  // Check-ins: re-run the engine over what's stored, then keep badges and reminders going while the app is open.
  const quiet = () => Date.now() - lastRemoteAt > 60000;
  refreshEngine(ctx).then((r) => { if (r.changed && activeUser()) render(); }).catch((e) => console.warn("Engine unavailable:", e));
  startReminders(ctx, { isActive: () => !!activeUser(), onRemoteQuiet: quiet });
}

document.addEventListener("visibilitychange", () => { if (!document.hidden && activeUser() && ctx.state) render(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
start().catch((e) => { main.innerHTML = `<section class="card"><h2>Couldn't start</h2><p>${esc(e.message)}</p></section>`; console.error(e); });
