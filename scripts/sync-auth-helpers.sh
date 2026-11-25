#!/usr/bin/env bash
# Self-hosts Firebase Auth's sign-in helper files under public/__/ so Google sign-in runs on
# pt.davidp.dev itself (authDomain = pt.davidp.dev). That avoids the cross-site storage that
# Safari/Chrome block for signInWithRedirect. Google asks you to re-sync these now and then:
#   npm run sync-auth-helpers && npm run deploy
# Extensionless pages are saved as .html; Cloudflare serves /__/auth/handler from handler.html.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="https://pt-davidp.firebaseapp.com/__/auth"
mkdir -p public/__/auth public/__/firebase
for f in handler iframe links; do curl -fsSL "$SRC/$f" -o "public/__/auth/$f.html"; done
for f in handler.js iframe.js links.js experiments.js; do curl -fsSL "$SRC/$f" -o "public/__/auth/$f"; done
# Hosting normally serves this; we write it from the public web config.
node -e '
import("./public/js/firebase-config.js").then(({ FIREBASE_CONFIG: c }) => {
  const out = { apiKey: c.apiKey, appId: c.appId, authDomain: "pt.davidp.dev", messagingSenderId: c.messagingSenderId, projectId: c.projectId, storageBucket: c.storageBucket };
  require("fs").writeFileSync("public/__/firebase/init.json", JSON.stringify(out, null, 2) + "\n");
});'
echo "Auth helpers synced into public/__/"
