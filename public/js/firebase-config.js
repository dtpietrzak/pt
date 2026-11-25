// Firebase web config for project pt-davidp. These values are public identifiers, not secrets;
// access is enforced by firestore.rules (only David's verified Google account).
export const FIREBASE_VERSION = "13.4.0";
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA6Mvb3nqWWtSzfGuCqqeJ-4NO-BRDUlyA",
  authDomain: "pt-davidp.firebaseapp.com",
  projectId: "pt-davidp",
  storageBucket: "pt-davidp.firebasestorage.app",
  messagingSenderId: "897420067839",
  appId: "1:897420067839:web:a84d6982e340efd24d9dca",
};
// On the live site the sign-in helpers are self-hosted under /__/auth (scripts/sync-auth-helpers.sh),
// so auth runs first-party. Everywhere else (localhost) the default firebaseapp.com helpers are used.
export const SELF_HOSTED_AUTH_HOSTS = ["pt.davidp.dev"];
export const OWNER_EMAIL = "dtpietrzak@gmail.com";
