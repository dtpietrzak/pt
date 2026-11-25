# PT

Live at **https://pt.davidp.dev**

David's personal lower-back (lumbar disc) rehab tracker. It's built for one person, not as a general PT app. Progress is gated by check-ins and gate tests, never by the calendar. The plan (levels L0-L8, exercises, gate tests, and decision rules R1-R15) comes from PT Bot's spec in `/workspace/pt-rehab`.

> Self-management support only. Not medical advice, does not diagnose, and does not replace a clinician.

Data is saved on the device first (IndexedDB), so it works offline and before sign-in. Signing in with Google syncs it through Firebase (Firestore, project `pt-davidp`) so the phone and the laptop browser share one plan.

## Status: built in phases

| Phase | What | State |
| --- | --- | --- |
| 1 | App shell, nav, settings, IndexedDB, plan data and sync, pure engine with test vectors, daily checklist | **live** |
| 1.5 | Google sign-in + Firestore sync between devices | **live** |
| 1.6 | Work posture timer (Timer tab) + R16 dose progression | **live** |
| 2 | Four check-ins (morning, post-workout, evening, night) and the green/yellow/orange/red rollup | next |
| 3 | Advance/hold/regress UI, sessions, gate tests, red-flag screen | |
| 4 | Weekly export (JSON + markdown) and agent plan-patch import | |

`public/js/patch.js` and `public/js/export.js` are already written and tested, but no UI uses them yet (phase 4).

## Plan data

`public/data/` is a copy of PT Bot's `seed/` and `schemas/`. Re-sync with:

```bash
scripts/sync-seed.sh            # defaults to /workspace/pt-rehab
npm test                        # 71 test vectors + patch/export/flow tests
```

On the next load, the app picks up a changed seed by itself, as long as no agent patch has been applied on the device. When it does, it migrates rung state into the new plan.

## Sync (Firebase)

- **Project:** `pt-davidp` (Spark/free plan). Firestore `(default)` in `nam5`, Google sign-in enabled, authorized domains `pt.davidp.dev` + `localhost`. Console: https://console.firebase.google.com/project/pt-davidp
- **Sign-in:** Google only, from Settings (or the welcome screen on a new device). Popup in a browser tab; redirect in the installed PWA. Login persists per device (IndexedDB/local persistence) until "Sign out".
- **On pt.davidp.dev** the Firebase sign-in helper files are self-hosted under `public/__/auth/` (authDomain = pt.davidp.dev), so redirect sign-in stays first-party on Safari/Chrome. Re-sync them now and then with `npm run sync-auth-helpers`. On localhost the default `pt-davidp.firebaseapp.com` helpers are used.
- **Data:** every IndexedDB record is mirrored to `users/{uid}/{store}/{key}` as `{ k, d: JSON, u: updatedAt ms, del }`. Conflicts are last-write-wins per record (a transaction never overwrites a newer cloud copy). Data saved before sync existed uploads on first sign-in; a fresh device's boot defaults never overwrite real data. The unpatched plan (`kv/docs`) isn't synced, since every device rebuilds it from `public/data`.
- **Rules (`firestore.rules`):** only `dtpietrzak@gmail.com` (verified, Google provider) can read/write, only under their own `users/{uid}`, only known stores and the record shape above. Everything else is denied.
- **Code:** `public/js/sync.js` (pure merge engine, tested in `test/sync.test.mjs`), `public/js/cloud.js` (Firebase SDK from the gstatic ESM CDN, no bundler), `public/js/firebase-config.js` (public web config; not a secret).

## Work timer (posture cycle)

Timer tab: **Start work mode** runs Stand 40 → Walk 2 → Sit 20 → Decompress 5, repeating (doses come from `public/data/posture-cycle.json` and `state.posture_cycle`). When a phase falls due the alarm rings (synth chime + notification) until you switch, snooze (5 min, max 2 per phase), tap **Sore early** (stand/sit only; logged and reorders the next phases), or skip. Quiet hours: work mode stops at work end (default 17:00 CT) with one decompress reminder; starting by hand outside work hours overrides that session.

- Time comes from stored wall-clock timestamps (`public/js/posture.js`, pure and tested), so reloads and background tabs don't drift. A worker drives a 1 Hz check so a hidden tab still alarms.
- Timer state is the synced `kv/timer` record, so other devices see it. Alarms ring only on the device that started work mode unless Settings > Work timer > "Ring on every signed-in device" is on (stored in the `app` setting).
- Blocks are logged to `kv/posture:log:<date>` and summarised in the daily log's `posture_cycle`; `postureCheckinData()` produces the evening check-in `posture_cycle` object for Phase 2.
- R16 (`applyPosture` in `posture.js`, wired in `engine.js` `processDay`) runs on days whose evening check-in has `posture_cycle.work_mode_used`. Flare / settle exit apply the preset / restore.
- Browsers need a tap to allow audio: Start unlocks it; after a reload tap anywhere once.

## Layout

- `public/app.js`: UI (hash routes `#/today`, `#/plan`, `#/settings`)
- `public/js/engine.js`: the pure decision engine. It covers check-in colors, session evaluation, R1-R15, and manual events, and runs in both the browser and Node
- `public/js/util.js`: Chicago time, ULIDs, and canonical JSON + SHA-256 (matches PT Bot's Python hashes)
- `public/js/schema.js`: a small JSON Schema validator for the bundled schemas
- `public/js/db.js`, `data.js`, `dose.js`, `defaults.js`: storage, seed loading and migration, dose text, and fallback defaults
- `test/`: `node --test "test/*.test.mjs"`

## Dev + deploy from your own machine

One-time setup:

```bash
# Node 24+ (cf needs it). With nvm: `nvm install && nvm use` (reads .nvmrc)
git clone https://github.com/dtpietrzak/pt && cd pt
npm i                                   # installs the cf CLI
npx cf login                            # or: export CLOUDFLARE_API_TOKEN=... (+ CLOUDFLARE_ACCOUNT_ID=7efc0fd18c64d520333bcb1b1af30580)
npx --yes firebase-tools@latest login   # Google account dtpietrzak@gmail.com; .firebaserc already points at pt-davidp
```

Day to day:

```bash
npm run dev            # http://localhost:5182 (static server; sign-in works on localhost and syncs real data)
npm test               # engine vectors + patch/export/flow + sync merge tests
npm run deploy         # Cloudflare: cf deploy ./public -> pt.davidp.dev
npm run deploy:rules   # Firebase: firestore.rules + firestore.indexes.json
npm run deploy:all     # test, rules, then site
npm run deploy:auth    # only if you change the auth block in firebase.json
```

Notes:
- Bump `CACHE` in `public/sw.js` on every deploy so installed copies update. Don't precache `index.html`, because Cloudflare 307-redirects it to `/`.
- Use `localhost` (not 127.0.0.1) for dev; only `localhost` and `pt.davidp.dev` are authorized sign-in domains. Add more in Firebase console → Authentication → Settings → Authorized domains.
- Localhost dev uses the same production Firestore data. Be careful with test edits while signed in.
- Secrets never go in the repo: Cloudflare token lives in your shell env or `cf login`; Firebase login lives in `~/.config/configstore`. The Firebase web config in `public/js/firebase-config.js` is public by design.

## License

MIT
