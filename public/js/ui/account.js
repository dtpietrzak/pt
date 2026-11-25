// Remembered Google sign-in, login screen, and top-right circular account menu.
import { cloudState, signIn, signOutCloud } from "../cloud.js";
import { DISCLAIMER } from "../defaults.js";
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
  so.addEventListener("click", async () => {
    closeAccountMenu();
    saveCachedUser(null);
    try { await signOutCloud(); } catch (e) { console.warn("Sign out:", e); }
    ctx.render();
  });
}

export function renderLogin(main) {
  $("#title").textContent = "PT";
  $(".nav").hidden = true;
  $("#level-chip").hidden = true;
  const tc = $("#timer-chip");
  if (tc) tc.hidden = true;
  $("#account-wrap").hidden = true;
  closeAccountMenu();
  main.innerHTML = `
    <section class="card login-card">
      <h2>PT</h2>
      <p class="muted small">Sign in with Google to access your plan.</p>
      <button class="btn google-btn" id="google-sign-in" type="button" ${cloudState().available ? "" : "disabled"}>
        ${GOOGLE_G}<span>Sign in with Google</span>
      </button>
      <p class="muted small" id="login-msg"></p>
    </section>
    <p class="disclaimer pad">${esc(DISCLAIMER)}</p>`;
  updateLoginStatus();
  $("#google-sign-in").onclick = async () => {
    const btn = $("#google-sign-in");
    btn.disabled = true;
    try { await signIn(); } catch (e) { toast(e.message); }
    finally { updateLoginStatus(); }
  };
}

export function updateLoginStatus() {
  const btn = $("#google-sign-in");
  const msg = $("#login-msg");
  if (!btn || !msg) return;
  const c = cloudState();
  btn.disabled = !c.available;
  if (c.error) msg.textContent = c.error;
  else if (!navigator.onLine) msg.textContent = "Connect to the internet to sign in on this device.";
  else if (!c.available) msg.textContent = "Loading…";
  else msg.textContent = "";
}
