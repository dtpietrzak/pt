// Remembered Google sign-in, account menu, and the optional Settings sign-in-to-sync card.
import { cloudState, signIn, signOutCloud } from "../cloud.js";
import { $, esc, toast } from "./dom.js";

const AUTH_KEY = "pt:auth";
const GOOGLE_G = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.54 5.54 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.54-5.17 3.54-8.87z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.95-2.86l-3.88-3c-1.07.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.09A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.27 14.33A7.2 7.2 0 0 1 4.9 12c0-.81.14-1.6.37-2.33V6.58H1.26a12 12 0 0 0 0 10.84l4.01-3.09z"/><path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.26 6.58l4.01 3.09c.95-2.85 3.6-4.92 6.73-4.92z"/></svg>`;

let cachedUser = null;
let renderedPhoto = null;

export function loadCachedUser() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    cachedUser = parsed && typeof parsed.email === "string" ? parsed : null;
  } catch {
    cachedUser = null;
  }
  return cachedUser;
}

export function saveCachedUser(u) {
  cachedUser = u ? { uid: u.uid, email: u.email, name: u.name || "", photoURL: u.photoURL || null } : null;
  try {
    if (cachedUser) localStorage.setItem(AUTH_KEY, JSON.stringify(cachedUser));
    else localStorage.removeItem(AUTH_KEY);
  } catch {}
}

export const activeUser = () => cloudState().user || cachedUser;

const HINT_KEY = "pt:sync-hint-dismissed";
export function syncHintDismissed() {
  try { return localStorage.getItem(HINT_KEY) === "1"; } catch { return false; }
}
export function dismissSyncHint() {
  try { localStorage.setItem(HINT_KEY, "1"); } catch {}
}

/** One-line first-run note on Today when the device is not signed in. */
export function syncHintHtml() {
  if (activeUser() || syncHintDismissed()) return "";
  return `<p class="sync-hint" id="sync-hint">Data stays on this device. <a class="link" href="#/settings">Sign in to sync</a> <button type="button" class="link" data-dismiss-sync-hint>Got it</button></p>`;
}

/** Settings card: sign in to turn on sync, or show status when already signed in. */
export function syncCardHtml() {
  const u = activeUser();
  if (!u) {
    const c = cloudState();
    return `<section class="card" id="sync-card"><div class="card-head"><h3>Sync</h3></div>
      <div class="card-body">
      <p class="muted small">Data stays on this device. Sign in to sync across devices.</p>
      <button class="btn google-btn" id="google-sign-in" type="button" ${c.available ? "" : "disabled"}>
        ${GOOGLE_G}<span>Sign in to sync</span>
      </button>
      <p class="muted small" id="login-msg"></p>
      </div>
    </section>`;
  }
  return `<section class="card" id="sync-card"><div class="card-head"><h3>Sync</h3></div>
    <div class="card-body">
    <p>Signed in as <b>${esc(u.email || u.name || "your account")}</b></p>
    <p class="muted small" id="settings-sync-line">${esc(syncLine())}</p>
    <button class="btn" id="settings-sign-out" type="button">Sign out</button>
    <p class="muted small">Signing out keeps your data on this device.</p>
    </div>
  </section>`;
}

export async function doSignOut(ctx) {
  closeAccountMenu();
  saveCachedUser(null);
  try { await signOutCloud(); } catch (e) { console.warn("Sign out:", e); }
  toast("Signed out. Your data stays on this device.");
  ctx.render();
}

export function wireSyncCard(ctx, root) {
  const btn = $("#google-sign-in", root);
  const msg = $("#login-msg", root);
  const out = $("#settings-sign-out", root);
  const line = $("#settings-sync-line", root);
  const paint = () => {
    const c = cloudState();
    if (btn) btn.disabled = !c.available;
    if (line) { line.textContent = syncLine(); line.classList.toggle("err", !!c.error); }
    if (!msg) return;
    if (c.error) msg.textContent = c.error;
    else if (!navigator.onLine) msg.textContent = "Connect to the internet to sign in.";
    else if (!c.available) msg.textContent = "Loading…";
    else msg.textContent = "";
  };
  paint();
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try { await signIn(); } catch (e) { if (e.message) toast(e.message); }
    finally { paint(); }
  };
  if (out) out.onclick = () => doSignOut(ctx);
}

export function syncLine() {
  const c = cloudState();
  if (c.error) return c.error;
  if (!navigator.onLine || !c.available) return "Offline · changes save locally and sync automatically.";
  if (!c.ready) return "Syncing…";
  if (c.pending) return `Syncing ${c.pending} change${c.pending === 1 ? "" : "s"}…`;
  return `Synced${c.lastSync ? " · " + c.lastSync.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}`;
}

function userInitial(u) {
  return ((u?.name || u?.email || "D").trim()[0] || "D").toUpperCase();
}

export function closeAccountMenu() {
  const menu = $("#account-menu");
  const btn = $("#account-btn");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

export function renderAccount(ctx) {
  const u = activeUser();
  const wrap = $("#account-wrap");
  if (!u) { wrap.hidden = true; closeAccountMenu(); return; }
  wrap.hidden = false;
  const btn = $("#account-btn");
  const photo = u.photoURL || "";
  if (renderedPhoto !== photo || !btn.childNodes.length) {
    renderedPhoto = photo;
    if (photo) {
      btn.innerHTML = `<img src="${esc(photo)}" alt="${esc(u.name || "Account")}" referrerpolicy="no-referrer" />`;
      btn.querySelector("img").onerror = () => { btn.textContent = userInitial(u); };
    } else {
      btn.textContent = userInitial(u);
    }
  }
  $("#account-name").textContent = u.name || (ctx.profile?.name || "Account");
  $("#account-email").textContent = u.email || "";
  const syncEl = $("#account-sync");
  syncEl.textContent = syncLine();
  syncEl.classList.toggle("err", !!cloudState().error);
}

export function wireAccountMenu(ctx) {
  const btn = $("#account-btn");
  const menu = $("#account-menu");
  const so = $("#sign-out");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) renderAccount(ctx);
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !e.target.closest("#account-wrap")) closeAccountMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAccountMenu();
  });
  so.addEventListener("click", () => doSignOut(ctx));
}
