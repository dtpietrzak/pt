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
| 1.6 | Work posture timer (Work tab) + R16 dose progression | **live** |
| 2 | Four check-ins (morning, post-workout, evening, night), the green/yellow/orange/red rollup, due badges + reminders, a minimal workout log | **live** |
| 3 | Status page (advance/hold/regress), level-up/regress/settle announcements, gate tests, red-flag screen, L6 equipment reconfirm | **live** |
| 4 | Weekly export (JSON + markdown) and agent plan-patch import | **live** |

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

Work tab: **Start work mode** runs Stand 40 → Walk 2 → Sit 20 → Decompress 5, repeating (doses come from `public/data/posture-cycle.json` and `state.posture_cycle`). When a phase falls due the alarm rings (synth chime + notification) until you switch, snooze (5 min, max 2 per phase), tap **Sore early** (stand/sit only; logged and reorders the next phases), or skip. Quiet hours: work mode stops at work end (default 17:00 CT) with one decompress reminder; starting by hand outside work hours overrides that session.

- Time comes from stored wall-clock timestamps (`public/js/posture.js`, pure and tested), so reloads and background tabs don't drift. A worker drives a 1 Hz check so a hidden tab still alarms.
- Work-timer state is the synced `kv/timer` record, so other devices see it. Alarms ring only on the device that started work mode unless Settings > Work timer > "Ring on every signed-in device" is on (stored in the `app` setting).
- Blocks are logged to `kv/posture:log:<date>` and summarised in the daily log's `posture_cycle`; `postureCheckinData()` produces the evening check-in `posture_cycle` object (used by the evening check-in).
- R16 (`applyPosture` in `posture.js`, wired in `engine.js` `processDay`) runs on days whose evening check-in has `posture_cycle.work_mode_used`. Flare / settle exit apply the preset / restore.
- Browsers need a tap to allow audio: Start unlocks it; after a reload tap anywhere once.

## Check-ins (phase 2)

- Today has a Check-ins card (morning, evening, night, plus a post-workout row after a workout) with a color dot per check-in and the day's rolled-up status. History (`#/history`, linked from that card) lists each day with its check-ins, sessions, reasons and the plan's decisions.
- Forms are sliders, steppers and chips (`public/js/ui/checkins.js`); `public/js/checkins.js` builds schema-valid records and decides what is due (pure, tested). Evening pre-fills from the Work timer's log (`postureCheckinData()`), and the optional sitting block feeds R16.
- Due times come from the profile `notify` settings (morning also waits for wake + 45 min). While the app is open it shows a badge on the Today tab and fires a local `Notification` once when a check-in becomes due (allow it with "Turn on reminders" on the card). There is no push server, so nothing fires while the app is closed.
- Starting a workout (Today, Workout card) logs a session; finishing it opens the post-workout check-in. This is only the minimum needed to prompt that check-in. The full session runner and gate tests are phase 3.
- Every save runs the engine (`public/js/pipeline.js`) and persists plan state, decision-log entries and each session's evaluation. A red check-in freezes the plan and shows a notice with guidance (no contact details); the only way out is "Symptoms resolved, or a clinician cleared me", which enters settle mode.
- All of it goes through the synced store (`checkins`, `sessions`, `log`, `days`, `kv`), so it syncs like everything else. Those stores were already in the Firestore rules allow-list, so no rules change was needed.

## Status, gate tests and red flags (phase 3)

- **Status** (`#/status`, tap the level chip or the card on Today): current level and mode, a checklist of what it takes to move up (exercises at target, clean-session streak, confirmed gate tests), per-exercise rungs, the plan's recent decisions with the reason and rule id, and the day-by-day history. Pure logic is in `public/js/status.js` (tested); the screens are in `public/js/ui/status.js`.
- **Announcements**: when the engine promotes, steps back, enters or leaves settle mode, or a red happens, a sheet explains what changed and why. It shows once per decision (acknowledged timestamp in `kv`); the first run on a device is silent so old history doesn't pop up.
- **Gate tests**: unlocked when every required exercise is at target and the clean streak is met. You also need a green yesterday and a green morning. Pick one group per session, how-to text and thresholds are shown, and weight thresholds are recomputed from the profile body weight (rounded to 5 lb). Results go through `recordGate` (pipeline), a pass is provisional until the next morning is green, and the engine promotes when all required tests are confirmed.
- **Red flags** (`#/red`, also linked from the check-in card and every Today): a self-screen with guidance only (see a clinician; saddle numbness or bladder/bowel changes means emergency care). "Pause my plan" uses the `red_report` manual event. A red check-in routes here too. No contact details anywhere.
- **L6 entry**: before barbell work, Today asks you to reconfirm equipment (`kv.equip_confirmed`); workouts stay hidden until you do.

## Weekly export and plan patches (phase 4)

- **Export** (`#/export`, linked from Settings and from a Today card when a week is due): pick a Monday–Sunday week, add a note, and build a JSON file plus a markdown summary (`public/js/export.js`, tested). Downloads, copy to the clipboard, and (on mobile) the Web Share sheet are all available. The JSON includes posture-cycle hashes and sitting / stand / sit-block trends, and it validates against `weekly-export.schema.json`.
- A reminder appears Sunday at your evening check-in time once that week has any check-ins or sessions, and stays until you download, copy or share it. The Settings tab gets a due badge too. There is no push server, so it only fires while the app is open.
- **Plan changes**: paste or upload an agent's `pt-plan-patch` JSON (markdown after the JSON is fine). The app validates the schema, the plan hashes, that every op applies cleanly, document invariants, and the safety rules. You see a before/after preview, why a rejected item failed, and a second confirmation when a safety review is required. Apply writes a snapshot, increments `plan_version`, migrates your progress, and syncs the patched plan (`docs.patched = true`) between devices. Discard stores the patch with the reason. You can undo the most recent applied patch from its snapshot; check-ins and sessions are kept.
- **Restart at a level** (Settings) now stamps the new state and saves that level as `start_level`, and a stale write from another open device (for example the work timer) will not overwrite it.

## Layout

- `public/app.js`: UI (hash routes `#/today`, `#/plan`, `#/settings`)
- `public/js/engine.js`: the pure decision engine. It covers check-in colors, session evaluation, R1-R15, and manual events, and runs in both the browser and Node
- `public/js/util.js`: Chicago time, ULIDs, and canonical JSON + SHA-256 (matches PT Bot's Python hashes)
- `public/js/schema.js`: a small JSON Schema validator for the bundled schemas
- `public/js/checkins.js` (due logic, form -> record), `pipeline.js` (store -> engine -> store), `ui/checkins.js` (forms, Today card, history, reminders)
- Timed-exercise countdown: in the exercise sheet, for any current dose with `hold_s`, `time_s` or `time_min` (detected from the rung, not by exercise id). Multi-set and per-side counters, a start/pause/reset control, and a header chip if you close the sheet. Reuses the work timer's chime.
- `public/js/status.js` (level status, gate eligibility/results, announcements), `ui/status.js` (status page, gate flow, red screen, announcements, equipment)
- `public/js/export.js` (weekly JSON + markdown), `patch.js` (validation, safety review, state migration), `ui/export.js` (export page, patch preview/apply/undo)
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
