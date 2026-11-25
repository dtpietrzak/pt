# PT

Live at **https://pt.davidp.dev**

A personal physical-therapy progress tracker. This is a private-use app, not a general PT product. Features are still being planned; the site is a placeholder for now.

No backend and no accounts. When the app is built, data will stay on the device, same as [simple-to-do](https://simple-to-do.davidp.dev) and [poop-tracker](https://poop.davidp.dev).

## Run locally

```bash
npm install
npm run dev     # http://localhost:5182
```

Service workers (so offline use and install) need `localhost` or HTTPS.

## Deploy

Hosted on Cloudflare as an assets-only Worker, configured in `cloudflare.config.ts` (Worker `pt`, custom domain `pt.davidp.dev`). Deploy with the [`cf` CLI](https://developers.cloudflare.com/cf/):

```bash
npm install
npm run deploy
```

When you change any file in `public/`, bump `CACHE` in `public/sw.js` so installed copies pick up the update.

## Files

- `public/index.html`, `styles.css`, `app.js`: placeholder page
- `public/sw.js`: precaches the shell; cache-first, refreshes in the background
- `public/manifest.webmanifest` + `public/icons/`: install metadata (`scripts/make-icons.py` renders the PNGs)

## License

MIT
