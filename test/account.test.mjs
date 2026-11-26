import "./ls-shim.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { syncCardHtml, syncHintHtml, syncHintDismissed, dismissSyncHint } from "../public/js/ui/account.js";

const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("Settings signed-out card offers Sign in to sync, not a sign-in wall", () => {
  const html = syncCardHtml();
  assert.match(html, /id="sync-card"/);
  assert.match(html, /Sign in to sync/);
  assert.match(html, /Data stays on this device/);
  assert.doesNotMatch(html, /Sign in with Google to access your plan/);
  assert.match(html, /id="google-sign-in"/);
});

test("the first-run Today hint is a one-liner and can be dismissed", () => {
  const html = syncHintHtml();
  if (!syncHintDismissed()) {
    assert.match(html, /Data stays on this device/);
    assert.match(html, /href="#\/settings"/);
    assert.match(html, /data-dismiss-sync-hint/);
  }
  dismissSyncHint();
  assert.equal(syncHintDismissed(), true);
  assert.equal(syncHintHtml(), "");
});

test("the app no longer gates the main UI on a signed-in user", () => {
  const app = src("../public/app.js");
  assert.doesNotMatch(app, /renderLogin/);
  assert.doesNotMatch(app, /if \(!activeUser\(\)\)/);
  assert.doesNotMatch(app, /showingLogin/);
  assert.match(app, /isActive: \(\) => true/);
  const settings = src("../public/js/ui/settings.js");
  assert.match(settings, /syncCardHtml/);
  assert.match(settings, /Sign in above to sync across devices/);
  assert.doesNotMatch(settings, /body_weight_lb/);
  assert.doesNotMatch(settings, /name="sports"/);
  assert.doesNotMatch(settings, />You</);
});
