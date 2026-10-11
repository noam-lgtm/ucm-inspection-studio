# UCM Inspection Studio

Browser-only **Final Inspection Report** generator for CNC manufacturing. Hosted on GitHub Pages, no server, no database, no accounts. Everything the user enters stays in their browser's local storage; backups are plain JSON files.

Live: https://noam-lgtm.github.io/ucm-inspection-studio/

## What it does

* **Templates** (per part family or customer): company identity and logo, report numbering, which header fields are fixed / prefilled / carried over from the previous report / blank, and the list of characteristics to inspect.
* **Reports**: fill the order details, enter the minimum and maximum measured value per characteristic (or GO / NO-GO, OK / NOT OK), get a verdict per row and for the report.
* **Sampling**: lot size + inspection level + AQL → code letter, sample size and Ac/Re from MIL-STD-105D/E Tables I and II-A (single sampling, normal inspection). Arrow cells and the "sample size ≥ lot → 100% inspection" rule are applied. Lot disposition is derived from the number of nonconforming units found in the sample.
* **PDF**: an English, A4, customer-ready report printed through the browser (Save as PDF). Running header and page numbers on every page, table header repeated across pages.
* **Archive**: every report is kept locally when a new one is started; reports can be reopened, duplicated, reprinted or deleted.
* **Backup**: export / import everything as one JSON file. Import merges and never deletes.
* **Offline**: a service worker caches the app so it works without a network connection once loaded.

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
npm ci
npm test            # unit tests (node:test)
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
src/app.js            UI
src/i18n.js           Hebrew UI strings
src/app.css, src/report.css
sw.js                 offline cache (bump VERSION on release)
tests/unit, tests/e2e
```

## Deployment

GitHub Pages serves the `main` branch root. Merging to `main` publishes. Bump `VERSION` in `sw.js` on every release so installed clients refresh their cache.

## Privacy note

Data is stored under the page origin (`noam-lgtm.github.io`). GitHub user/project pages under the same account share that origin, so any other site published under the same account could read this storage. Use a dedicated account or a custom domain if that matters.
