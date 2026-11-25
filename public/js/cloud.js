// Firebase glue: Google sign-in (kept signed in per device) + Firestore remote for js/sync.js.
// The SDK loads from the official gstatic ESM CDN (no bundler); sw.js caches those files so a
// signed-in device still starts offline. If the SDK can't load, the app keeps working locally.
import { FIREBASE_CONFIG, FIREBASE_VERSION, SELF_HOSTED_AUTH_HOSTS, OWNER_EMAIL } from "./firebase-config.js";
import { createSyncEngine } from "./sync.js";

const CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
let A, F, auth, db, engine = null;
const cloud = { available: false, user: null, ready: false, pending: 0, lastSync: null, error: null };
let notify = () => {};
export const cloudState = () => cloud;

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const selfHosted = () => SELF_HOSTED_AUTH_HOSTS.includes(location.hostname);
export function describeError(e) {
  const code = e?.code || "";
  if (code === "permission-denied") return "This Google account isn't allowed to sync. Sign in as " + OWNER_EMAIL + ".";
  if (code === "auth/unauthorized-domain") return `${location.hostname} isn't an authorized sign-in domain in Firebase.`;
  if (code === "auth/network-request-failed" || code === "unavailable") return "Offline. Changes will sync when you're back online.";
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "";
  return e?.message || String(e);
}

/** Load Firebase and start watching sign-in. Resolves once the SDK is ready (or rejects if it can't load). */
export async function initCloud(store, { onChange = () => {}, onApplied = () => {} } = {}) {
  notify = onChange;
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${CDN}/firebase-app.js`), import(`${CDN}/firebase-auth.js`), import(`${CDN}/firebase-firestore.js`),
  ]);
  A = authMod; F = fsMod;
  const app = appMod.initializeApp({ ...FIREBASE_CONFIG, authDomain: selfHosted() ? location.hostname : FIREBASE_CONFIG.authDomain });
  // Local persistence: each device stays signed in until "Sign out".
  auth = A.initializeAuth(app, {
    persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence],
    popupRedirectResolver: A.browserPopupRedirectResolver,
  });
  db = F.getFirestore(app);
  cloud.available = true;
  A.getRedirectResult(auth).catch((e) => { cloud.error = describeError(e); notify(); });
  A.onAuthStateChanged(auth, async (user) => {
    if (engine) { engine.stop(); engine = null; }
    Object.assign(cloud, { user: user ? { email: user.email, name: user.displayName, uid: user.uid } : null, ready: false, pending: 0, error: null });
    notify();
    if (!user) return;
    if (user.email !== OWNER_EMAIL || !user.emailVerified) {
      cloud.error = `Signed in as ${user.email}, which can't sync. Sign out and use ${OWNER_EMAIL}.`;
      notify();
      return;
    }
    engine = createSyncEngine(store, firestoreRemote(user.uid), {
      onApplied,
      onStatus: (s) => { Object.assign(cloud, { ready: s.ready, pending: s.pending, lastSync: s.lastSync, error: s.error ? describeError(s.error) : null }); notify(); },
    });
    engine.start().catch((e) => { cloud.error = describeError(e); notify(); });
  });
  addEventListener("online", () => engine?.push());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) engine?.push(); });
}

function firestoreRemote(uid) {
  const ref = (s, id) => F.doc(db, "users", uid, s, id);
  return {
    subscribe(s, cb, onError) {
      return F.onSnapshot(F.collection(db, "users", uid, s), { includeMetadataChanges: true }, (snap) => {
        const recs = snap.docChanges().filter((c) => c.type !== "removed" && !c.doc.metadata.hasPendingWrites).map((c) => c.doc.data());
        cb(recs, snap.metadata.fromCache);
      }, onError);
    },
    // Atomic last-write-wins: never overwrite a newer cloud copy.
    pushIfNewer(s, id, rec) {
      return F.runTransaction(db, async (tx) => {
        const cur = await tx.get(ref(s, id));
        if (cur.exists()) {
          const r = cur.data();
          if (r.u > rec.u) return { applied: false, remote: r };
          if (r.u === rec.u) return { applied: true };
        }
        tx.set(ref(s, id), rec);
        return { applied: true };
      });
    },
  };
}

export async function signIn() {
  if (!auth) throw new Error("Sync isn't available right now (offline?).");
  const provider = new A.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account", login_hint: OWNER_EMAIL });
  // Installed PWA on the phone: popups are unreliable, and redirect is first-party here
  // because the auth helpers are self-hosted on pt.davidp.dev.
  if (isStandalone() && selfHosted()) return A.signInWithRedirect(auth, provider);
  try {
    await A.signInWithPopup(auth, provider);
  } catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/web-storage-unsupported"].includes(e.code)) {
      return A.signInWithRedirect(auth, provider);
    }
    const msg = describeError(e);
    if (msg) throw new Error(msg);
  }
}
export async function signOutCloud() {
  if (engine) { engine.stop(); engine = null; }
  if (auth) await A.signOut(auth);
}
export const syncNow = () => engine?.push();
