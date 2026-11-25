# PT

Live at **https://pt.davidp.dev**

David's personal lower-back (lumbar disc) rehab tracker. It's built for one person, not as a general PT app. Progress is gated by check-ins and gate tests, never by the calendar. The plan (levels L0-L8, exercises, gate tests, and decision rules R1-R15) comes from PT Bot's spec in `/workspace/pt-rehab`.

> Self-management support only. Not medical advice, does not diagnose, and does not replace a clinician.

No backend and no accounts. Everything stays on the device in IndexedDB, and it works offline.

## Status: built in phases

| Phase | What | State |
| --- | --- | --- |
| 1 | App shell, nav, settings, IndexedDB, plan data and sync, pure engine with test vectors, daily checklist | **live** |
| 2 | Four check-ins (morning, post-workout, evening, night) and the green/yellow/orange/red rollup | next |
| 3 | Advance/hold/regress UI, sessions, gate tests, red-flag screen | |
| 4 | Weekly export (JSON + markdown) and agent plan-patch import | |

`public/js/patch.js` and `public/js/export.js` are already written and tested, but no UI uses them yet (phase 4).

## Plan data

`public/data/` is a copy of PT Bot's `seed/` and `schemas/`. Re-sync with:

```bash
scripts/sync-seed.sh            # defaults to /workspace/pt-rehab
npm test                        # 51 test vectors + patch/export/flow tests
```

On the next load, the app picks up a changed seed by itself, as long as no agent patch has been applied on the device. When it does, it migrates rung state into the new plan.

## Layout

- `public/app.js`: UI (hash routes `#/today`, `#/plan`, `#/settings`)
- `public/js/engine.js`: the pure decision engine. It covers check-in colors, session evaluation, R1-R15, and manual events, and runs in both the browser and Node
- `public/js/util.js`: Chicago time, ULIDs, and canonical JSON + SHA-256 (matches PT Bot's Python hashes)
- `public/js/schema.js`: a small JSON Schema validator for the bundled schemas
- `public/js/db.js`, `data.js`, `dose.js`, `defaults.js`: storage, seed loading and migration, dose text, and fallback defaults
- `test/`: `node --test "test/*.test.mjs"`

## Run locally / deploy

```bash
npm run dev       # http://localhost:5182
npm run deploy    # cf deploy ./public  (assets-only Worker "pt", domain pt.davidp.dev)
```

Bump `CACHE` in `public/sw.js` on every deploy. Don't precache `index.html`, because Cloudflare 307-redirects it to `/`.

## License

MIT
