# UCM Inspection Studio

Browser-only **Final Inspection Report** generator for CNC manufacturing. Hosted on GitHub Pages, no server, no database, no accounts. Everything the user enters stays in their browser's local storage; backups are plain JSON files.

Live: https://noam-lgtm.github.io/ucm-inspection-studio/

## What it does

* **Templates** (per part family or customer): company identity and logo, report numbering, which header fields are fixed / prefilled / carried over from the previous report / blank, and the list of characteristics to inspect.
* **Reports**: fill the order details, enter the minimum and maximum measured value per characteristic (or GO / NO-GO, OK / NOT OK), get a verdict per row and for the report.
* **Sampling**: lot size + inspection level + AQL → code letter, sample size and Ac/Re from MIL-STD-105D/E Tables I and II-A (single sampling, normal inspection). Arrow cells and the "sample size ≥ lot → 100% inspection" rule are applied.
* **PDF**: an English, A4, customer-ready report printed through the browser (Save as PDF). Running header and page numbers on every page, table header repeated across pages.
* **Archive**: every report is kept locally when a new one is started; reports can be reopened, duplicated, reprinted or deleted.
* **Backup**: export / import everything as one JSON file. Import merges and never deletes.
* **Offline**: a service worker caches the app so it works without a network connection once loaded.
* **PDF import**: upload an existing inspection report (PDF or photo). The text layer is parsed deterministically; image-only cells and scans can be read by Claude through the sync server; everything uncertain is highlighted next to a crop of the PDF for confirmation. The result is a **product specification** stored by part number + revision, plus the historical report in the archive. See `docs/IMPORT-AND-SYNC.md`.
* **Products**: part number + revision → characteristics, tolerances, instruments, customer. A new report starts from a product in one click.
* **Sync (optional)**: a small Cloudflare Worker (free tier) keeps products, templates and reports identical on every computer, stores the original PDFs and writes a daily backup. The app remains local-first.

## Engineering rules the app enforces

* The printed *Required* text is generated from the structured nominal and deviations. A requirement can never contradict the limits used for the verdict.
* Deviations are signed: `+0.10 / −0.05`, `+0.10 / +0.05`, `−0.02 / −0.05` and `±0.10` are all representable.
* A characteristic with a missing or invalid definition never produces PASS; it is flagged for review in the UI and printed as REVIEW.
* Min > Max is a data-entry error (REVIEW), not an out-of-tolerance verdict.
* Table II-A columns shipped: AQL 0.65, 1.0, 1.5, 2.5, 4.0, 6.5 (cross-checked against two independent transcriptions, see `tests/unit/sampling.test.js`). Other AQL values are accepted as text; the sample size then comes from Table I only and Ac/Re is not calculated, which the report states explicitly.
* Tightened / reduced inspection and switching rules are **not** implemented. Nothing in the app invents acceptance criteria.

## Development

No build step. Plain ES modules.

```
npm ci && npm ci --prefix worker --omit=dev
npm test            # unit tests (node:test), including both real PDF fixtures
npm run test:worker # the Worker in workerd (Miniflare) with local D1/R2 and a mocked Anthropic API
npm run test:e2e    # Playwright end-to-end tests in headless Chromium (needs poppler-utils for PDF checks)
npm run serve       # local static server on http://127.0.0.1:8787/
```

Layout:

```
index.html            shell
src/sampling.js       Table I / Table II-A data and lookups
src/core.js           features, limits, verdicts, templates, reports
src/storage.js        localStorage persistence, v1 migration, backup files
src/report-sheet.js   printable report (HTML)
src/pdf-pages.js      pdf.js glue: positioned text + image placements
src/pdf-import.js     deterministic parser of inspection reports -> import draft
src/ai-merge.js       merges the vision model's answer into the draft
src/pdf-render.js     browser rendering / crops (uses vendor/pdfjs, legacy build)
src/sync.js           sync client (push/pull, tombstones, files, AI calls)
src/ui-import.js      import wizard; src/ui-products.js products; src/ui-settings.js settings
src/app.js            UI shell, report, archive, templates
worker/               Cloudflare Worker: sync API, file storage, AI proxy, daily backup
src/i18n.js           Hebrew UI strings
src/app.css, src/report.css
sw.js                 offline cache (bump VERSION on release)
tests/unit, tests/e2e
```

## Sync server setup (Hebrew, step by step)

ראו `docs/הקמת-סנכרון.md`: שלוש פקודות בתיקיית `worker` מקימות את השרת החינמי ב-Cloudflare.

## Deployment

GitHub Pages serves the `main` branch root. Merging to `main` publishes. Bump `VERSION` in `sw.js` on every release so installed clients refresh their cache.

## Privacy note

Data is stored under the page origin (`noam-lgtm.github.io`). GitHub user/project pages under the same account share that origin, so any other site published under the same account could read this storage. Use a dedicated account or a custom domain if that matters.
