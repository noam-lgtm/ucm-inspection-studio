# PDF import, product specifications and cross-device sync

## What was decided and why

Goal: upload an existing Final Inspection Report, get most of its data automatically, confirm the rest, store the specification per **part number + revision**, and reuse it from any computer.

### Reading the PDF (extraction)

The two real UCM reports were analysed first:

| | LotOrder96 (MM606207C rev C) | FINAL_INSPECTION_REPORT (0112807-000 rev AB) |
|---|---|---|
| Producer | Microsoft Access 2010 | Microsoft Access 2010 |
| Text layer | yes | yes, **except the Required column, which is 15 tiny pictures (40–120 px)** |
| Glyph quirks | `Ø` printed as `¡`, check mark printed as `£` | same fonts |
| Rows | 12 over 2 pages (9 + 3) | 15 over 2 pages (8 + 7) |

Decision: a **two-layer extractor**.

1. **Deterministic layer (free, offline, in the browser)**: pdf.js reads positioned text; `src/pdf-import.js` finds label/value pairs, the results table (column boundaries from the header row, rows from the `No.` column), parses drawing notation (`Ø30`, `R26`, `20 0 +0.03`, `4.33 x 60°`, `M16x2`, `7.50 (x3)`, `.1` tolerances, `£` check marks, `d/m/yy` dates) and records a source rectangle for every value so the review screen can show the matching crop. Image-only cells are detected from the PDF's image placements and flagged.
2. **Vision layer (optional, paid)**: when the text layer is missing or incomplete, page images are sent to the sync server, which calls Claude (`claude-opus-5-5` by default, configurable) with a strict JSON schema. Text-layer values with high confidence always win; the model fills image cells and scans; disagreements are shown side by side. Every AI-read value stays flagged until a person confirms it.

Rejected: Tesseract.js in the browser. It is free and offline, but the hard cases here are 40-pixel pictures of `Ø3.05` and `∠45°`; OCR of that quality would create more corrections than it saves. It can be added later as a last-resort fallback.

### Storing data across computers

| Option | Monthly cost | Pros | Cons |
|---|---|---|---|
| **Cloudflare Workers + D1 + R2 (chosen)** | $0 (free tier: 100k requests/day, 5 GB DB, 10 GB files) | No idle pausing, one small JS file to maintain, same place proxies the AI key, daily backup cron, no credit card needed | Login is a shared workspace key (fine for a small trusted team); DIY compared with Supabase Auth |
| Supabase (Postgres + Auth + Storage) | $0 but **pauses after 7 idle days**; $25 for Pro | Real user accounts, nice dashboard | Pausing is unacceptable for sporadic shop-floor use unless paying $25/month |
| Firebase (Firestore + Auth + Storage) | $0 within quotas, needs a credit card (Blaze) for Storage/Functions | Built-in offline cache and auth | Heavier SDK, Google lock-in, card required |
| Google Drive (appData) | $0 | No server | Multi-user sync is clumsy, OAuth setup, cannot hide an AI key |
| Local only (status quo) | $0 | Nothing to operate | No cross-device access, no automatic backup |

AI cost: a two-page report is ~6k input tokens and ~2k output tokens; with Claude Opus 5.5 that is about $0.07 per report, so 100 imports/month ≈ $7. Claude Haiku 5.5 would be ≈ $0.01 per report at lower reading quality; the model is a one-line setting on the Worker.

The app stays **local-first**: everything is saved in the browser immediately and works offline; the sync server is an add-on. Sync is last-write-wins by record (products, templates, archived reports). The Worker writes a full JSON snapshot to R2 every night and keeps 60 of them.

### Original PDFs

Kept. They are uploaded to R2 (25 MB limit per file, 10 GB free) and linked from the product and from the archived report. Reasons: audit trail (ISO 9001 traceability), the ability to re-read with better models later, and the review UI needs the file to show crops. The authoritative data is the confirmed structured specification.

### Part number vs report number vs revision

* `partNo + revision` is the product key (normalised: trimmed, upper-cased, `Rev.` prefix removed). The same part with a new revision is a new product; the previous one stays.
* The report number (`9515_2`) is stored on the archived report and as `sourceReportNo` on the product. It never identifies the product.
* Re-importing the same part/revision updates the product's characteristics (confirmed in the review screen) and adds another historical report.

## Setting up the sync server (one time, ~15 minutes)

```
cd worker
npm install
npx wrangler login                                   # Cloudflare account (free)
npx wrangler d1 create ucm-inspection                # copy the database_id into wrangler.toml
npx wrangler r2 bucket create ucm-inspection-files
npx wrangler d1 execute ucm-inspection --remote --file=./schema.sql
npx wrangler secret put WORKSPACE_KEY                 # a long random string, e.g. `openssl rand -hex 24`
npx wrangler secret put ANTHROPIC_API_KEY             # optional: enables the vision layer
npx wrangler deploy                                   # prints https://ucm-inspection-sync.<account>.workers.dev
```

Then in the app: הגדרות → סנכרון → paste the URL and the key → בדיקת חיבור. Repeat on every computer with the same key.

`ALLOWED_ORIGIN` in `wrangler.toml` must match the site that serves the app (the GitHub Pages origin). Change `AI_MODEL` there to pick a cheaper model.

## Security notes

* The API key for Claude lives only in the Worker secret; browsers never see it.
* The workspace key is compared in constant time; all other routes return 401. Rotate it with `wrangler secret put` and update the clients.
* The Worker validates every record (kind, id length, JSON size ≤ 600 KB, file types PDF/JPEG/PNG/WebP, file size).
* Data at rest is in Cloudflare's EU/US regions per the account setting; the inspection data (customer, PO, measurements) is business data, not personal data, but names of inspectors appear on reports.

## Verified in this change

* Unit tests: both real PDFs parse to the expected header fields and all rows (`tests/unit/pdf-import.test.js`).
* Worker tests run the real Worker code in workerd with local D1/R2 and a mocked Anthropic API (`tests/worker`).
* Browser tests: import both reports through the UI, correct a flagged row, save, open a report from the product, re-import updates instead of duplicating; **two separate browser profiles** sync through the Worker (A imports and uploads the PDF, B receives the product and the archived report, B edits, A receives the edit); the AI path end to end with a mocked model (`tests/e2e/import-sync.test.js`).

## Not verified

* A real call to the Claude API (no key in the build environment). The request shape follows the current SDK documentation; the first real import should be tried with the `ANTHROPIC_API_KEY` secret set and the result checked against the PDF.
* Deployment to Cloudflare itself (no account here). The Worker runs under the same runtime (`workerd`) locally.
* Low-quality photos of reports: the pipeline accepts JPEG/PNG and routes them to the vision layer, but no photo was attached to test with. The text layer cannot help there, so the quality depends entirely on the model.
