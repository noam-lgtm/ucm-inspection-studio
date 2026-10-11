/*
 * End-to-end tests against the real page in headless Chromium (Playwright).
 * Run: npm run test:e2e   (needs `npx playwright install chromium` once, or PLAYWRIGHT_BROWSERS_PATH)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startServer } from '../helpers/static-server.js';

let server, url, browser, context, page;
const OUT = path.join(process.cwd(), 'test-output');
fs.mkdirSync(OUT, { recursive: true });

before(async () => {
  ({ server, url } = await startServer());
  browser = await chromium.launch();
});
after(async () => { await browser.close(); server.close(); });
beforeEach(async () => {
  if (context) await context.close();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'he-IL', acceptDownloads: true });
  page = await context.newPage();
  page.on('dialog', d => d.accept());
  page.__errors = [];
  page.on('pageerror', e => page.__errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.__errors.push(m.text()); });
});

const uiState = () => page.evaluate(() => JSON.parse(JSON.stringify(window.UCM.state)));
const featureId = i => page.evaluate(i => window.UCM.state.draft.features[i].id, i);
async function fill(selector, value) { await page.fill(selector, ''); await page.fill(selector, value); }
async function setMeasure(i, min, max) {
  const id = await featureId(i);
  await fill(`input[data-measure="min"][data-id="${id}"]`, min);
  await fill(`input[data-measure="max"][data-id="${id}"]`, max);
}
const rowStatus = async i => { const id = await featureId(i); return page.textContent(`tr[data-row="${id}"] .row-status`); };
const hasPdfTools = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();

test('loads without console errors and shows the starter template', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  assert.deepEqual(page.__errors, []);
  assert.equal(await page.title(), 'UCM Inspection Studio');
  assert.equal(await page.inputValue('#h_reportNo'), 'FIR-0001');
  assert.equal((await page.$$('tr[data-row]')).length, 4);
  assert.ok(await page.$('#h_partNo:disabled'), 'fixed field is locked');
  assert.ok(await page.$('#h_quantity:not(:disabled)'), 'quantity is never locked');
});

test('sampling: lot 60 / level II / AQL 2.5 follows the Table II-A arrow to code D (n=8, Ac 0 Re 1)', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await fill('#h_quantity', '60');
  assert.equal((await page.textContent('.sample-big')).trim(), '8');
  const foot = await page.textContent('.sample-foot');
  assert.match(foot, /E/); assert.match(foot, /n=13/); assert.match(foot, /Ac 0 \/ Re 1/);
  assert.ok((await page.textContent('#samplingPanel')).includes('(D)'), 'arrow note names the plan letter');
  await fill('#h_quantity', '400');
  assert.equal((await page.textContent('.sample-big')).trim(), '50');
  assert.match(await page.textContent('.sample-foot'), /Ac 3 \/ Re 4/);
  await fill('#h_nonconforming', '4');
  assert.match(await page.textContent('.dispo'), /נדחית/);
  await fill('#h_nonconforming', '3');
  assert.match(await page.textContent('.dispo'), /מתקבלת/);
  await fill('#h_quantity', '5');
  assert.equal((await page.textContent('.sample-big')).trim(), '5');
  assert.match(await page.textContent('#samplingPanel'), /100%/);
  await fill('#h_quantity', '1');
  assert.equal((await page.textContent('.sample-big')).trim(), '1');
  await fill('#h_quantity', 'abc');
  assert.match(await page.textContent('#warnings'), /מספר שלם/);
});

test('measurement entry: verdicts, keyboard flow, copy-min, GO/NO-GO, persistence across reload', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await setMeasure(0, '24.95', '25.05');
  assert.match(await rowStatus(0), /בטווח/);
  await setMeasure(0, '24.95', '25.11');
  assert.match(await rowStatus(0), /חריגה/);
  await setMeasure(0, '25.11', '24.95');
  assert.match(await rowStatus(0), /לבדיקה/);
  await setMeasure(0, '24,95', 'Ø25.05');
  assert.match(await rowStatus(0), /בטווח/);
  // Enter in an empty max copies min and moves on
  const id1 = await featureId(1);
  await fill(`input[data-measure="min"][data-id="${id1}"]`, '10.02');
  await page.focus(`input[data-measure="max"][data-id="${id1}"]`);
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue(`input[data-measure="max"][data-id="${id1}"]`), '10.02');
  assert.match(await rowStatus(1), /בטווח/);
  // GO/NO-GO buttons
  const id2 = await featureId(2);
  await page.click(`[data-outcome="fail"][data-id="${id2}"]`);
  assert.match(await rowStatus(2), /חריגה/);
  await page.click(`[data-outcome="pass"][data-id="${id2}"]`);
  assert.match(await rowStatus(2), /עובר/);
  const id3 = await featureId(3);
  await page.click(`[data-outcome="pass"][data-id="${id3}"]`);
  assert.match(await page.textContent('#summaryPanel'), /הדוח תקין/);
  await fill('#remarks', 'הערה בעברית');
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.inputValue(`input[data-measure="max"][data-id="${id1}"]`), '10.02');
  assert.match(await rowStatus(2), /עובר/);
  assert.equal(await page.inputValue('#remarks'), 'הערה בעברית');
  assert.deepEqual(page.__errors, []);
});

test('new report: archive, numbering, carry-over and fixed fields', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await fill('#h_customer', 'Acme Ltd');
  await fill('#h_purchaseOrder', 'PO-55');
  await fill('#h_quantity', '100');
  await setMeasure(0, '25', '25');
  await page.click('[data-action="new-report"]');
  await page.waitForSelector('#h_reportNo');
  assert.equal(await page.inputValue('#h_reportNo'), 'FIR-0002');
  assert.equal(await page.inputValue('#h_customer'), 'Acme Ltd', 'carry-over field');
  assert.equal(await page.inputValue('#h_purchaseOrder'), 'PO-55');
  assert.equal(await page.inputValue('#h_quantity'), '', 'quantity never carries');
  const s = await uiState();
  assert.equal(s.archive.length, 1);
  assert.equal(s.archive[0].header.reportNo, 'FIR-0001');
  assert.equal(s.templates[0].numbering.next, 2);
  // Archive tab lists it and can reopen it
  await page.click('[data-tab="archive"]');
  assert.match(await page.textContent('table.list'), /FIR-0001/);
  assert.match(await page.textContent('table.list'), /Acme Ltd/);
  await page.click('[data-action="archive-open"]');
  await page.waitForSelector('#h_reportNo');
  assert.equal(await page.inputValue('#h_reportNo'), 'FIR-0001');
  const s2 = await uiState();
  assert.equal(s2.archive.length, 0, 'the empty FIR-0002 draft was not archived');
});

test('template editor: edits flow into the draft; required text follows nominal; fixed field value locks the report', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('[data-tab="templates"]');
  const fid = await page.evaluate(() => window.UCM.state.templates[0].features[0].id);
  await fill(`input[name="f:nominal"][data-fid="${fid}"]`, '30.00');
  await fill(`input[name="f:upper"][data-fid="${fid}"]`, '0.05');
  await fill(`input[name="f:label"][data-fid="${fid}"]`, 'Length');
  assert.match(await page.textContent(`.fe-row[data-feature="${fid}"] .fe-preview`), /Length 30\.00 ±0\.05 mm \(29\.95 – 30\.05\)/);
  // asymmetric
  await page.selectOption(`select[name="f:symmetric"][data-fid="${fid}"]`, '0');
  await fill(`input[name="f:upper"][data-fid="${fid}"]`, '0.10');
  await fill(`input[name="f:lower"][data-fid="${fid}"]`, '0.05');
  assert.match(await page.textContent(`.fe-row[data-feature="${fid}"] .fe-preview`), /30\.00 \+0\.10 \/ \+0\.05 mm \(30\.05 – 30\.10\)/);
  // invalid: inverted
  await fill(`input[name="f:lower"][data-fid="${fid}"]`, '0.20');
  assert.match(await page.textContent(`.fe-row[data-feature="${fid}"] .fe-preview`), /התחתון גדול מהעליון/);
  await fill(`input[name="f:lower"][data-fid="${fid}"]`, '0.05');
  // fixed part number
  await fill('input[name="p:value"][data-key="partNo"]', 'P-777');
  await page.click('[data-action="feature-add"][data-kind="numeric"]');
  await page.click('[data-tab="report"]');
  assert.equal(await page.inputValue('#h_partNo'), 'P-777');
  assert.ok(await page.$('#h_partNo:disabled'));
  assert.equal((await page.$$('tr[data-row]')).length, 5);
  assert.match(await page.textContent('tr[data-row] .req'), /Length 30\.00 \+0\.10 \/ \+0\.05/);
  await setMeasure(0, '30.06', '30.09');
  assert.match(await rowStatus(0), /בטווח/);
  await setMeasure(0, '30.00', '30.09');
  assert.match(await rowStatus(0), /חריגה/, 'a value equal to the nominal but below the shifted lower limit fails');
  // new blank row cannot pass
  await setMeasure(4, '1', '1');
  assert.match(await rowStatus(4), /לבדיקה/);
  assert.match(await page.textContent('#warnings'), /הגדרה חסרה/);
  assert.deepEqual(page.__errors, []);
});

test('backup export and import round-trip (merge, nothing deleted)', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await fill('#h_customer', 'Backup Co');
  await page.click('[data-action="new-report"]');
  await page.waitForSelector('#h_reportNo');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export-backup"]')]);
  const file = path.join(os.tmpdir(), 'ucm-backup-test.json');
  await download.saveAs(file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.format, 'ucm-inspection-backup');
  assert.equal(data.archive.length, 1);
  assert.match(await page.textContent('#backupStatus'), /גיבוי אחרון/);
  // fresh browser profile, import
  await context.close();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'he-IL' });
  page = await context.newPage(); page.on('dialog', d => d.accept());
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.setInputFiles('#importFile', file);
  await page.waitForTimeout(300);
  const s = await uiState();
  assert.equal(s.archive.length, 1);
  assert.equal(s.archive[0].header.customer, 'Backup Co');
  assert.equal(s.templates.length, 2, 'starter template kept, imported template added');
});

test('v1 prototype localStorage is migrated on first load', async () => {
  const v1 = {
    version: 1, activeId: 't1',
    templates: [{ id: 't1', name: 'Old', company: { name: 'Old Co', tagline: '', footer: '', logo: '' },
      defaults: { reportNo: '', productionOrder: '', customer: '', quantity: '', purchaseOrder: '', catalogNo: '', partNo: 'OLD-1', partName: 'Old part', revision: '', inspector: '', inspectionDate: '', generalTolerance: '+/-0.1', aql: '2.5', inspectionLevel: 'II', accepted: '', rejected: '' },
      keep: { partNo: true, partName: true, quantity: true, aql: true, inspectionLevel: true },
      features: [{ id: 'a', kind: 'numeric', required: '12.00', nominal: '12', minus: '0.1', plus: '0.1', method: 'Caliper', unit: 'mm' }, { id: 'b', kind: 'gauge', required: 'M6', nominal: '', minus: '', plus: '', method: 'Plug', unit: '' }] }],
    report: { header: { quantity: '30', customer: 'Legacy' }, measurements: { a: { min: '12.01', max: '12.02', outcome: '' }, b: { min: '', max: '', outcome: 'pass' } }, remarks: 'old remark', createdAt: '2026-09-01T00:00:00.000Z' },
  };
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(v1 => { localStorage.clear(); localStorage.setItem('ucm.inspection.local.v1', JSON.stringify(v1)); }, v1);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.inputValue('#h_partNo'), 'OLD-1');
  assert.equal(await page.inputValue('#h_customer'), 'Legacy');
  assert.equal(await page.inputValue('#h_quantity'), '30');
  assert.ok(await page.$('#h_quantity:not(:disabled)'), 'v1 locked-empty quantity bug does not survive migration');
  assert.match(await rowStatus(0), /בטווח/);
  assert.match(await rowStatus(1), /עובר/);
  assert.equal(await page.inputValue('#remarks'), 'old remark');
  assert.deepEqual(page.__errors, []);
});

test('PDF: A4 output, file name, page numbering and repeated header on long reports', { skip: !hasPdfTools && 'pdftotext not installed' }, async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await fill('#h_customer', 'PDF Customer');
  await fill('#h_quantity', '120');
  await fill('#h_nonconforming', '0');
  await fill('#remarks', 'שלום');
  await setMeasure(0, '24.95', '25.05');
  const id2 = await featureId(2); await page.click(`[data-outcome="pass"][data-id="${id2}"]`);
  const id3 = await featureId(3); await page.click(`[data-outcome="pass"][data-id="${id3}"]`);
  await page.click('[data-tab="preview"]');
  // The print button sets document.title to the suggested file name; do the same here so the PDF metadata carries it.
  const fileName = await page.evaluate(() => { document.title = window.UCM.reportFileName(window.UCM.state.draft); return document.title; });
  assert.equal(fileName, 'FIR-0001');
  await page.emulateMedia({ media: 'print' });
  const pdf1 = path.join(OUT, 'report-short.pdf');
  await page.pdf({ path: pdf1, format: 'A4', preferCSSPageSize: true, printBackground: true });
  let text = execFileSync('pdftotext', ['-layout', pdf1, '-']).toString();
  assert.match(text, /FINAL INSPECTION REPORT/);
  assert.match(text, /PDF Customer/);
  assert.match(text, /SAMPLE SIZE/);
  assert.match(text, /CODE LETTER/);
  assert.match(text, /\b20\b/, 'sample size 20 for lot 120 level II');
  assert.match(text, /LOT ACCEPTED/);
  assert.match(text, /INCOMPLETE/);
  assert.match(text, /Page 1 of 1/);
  assert.match(text, /שלום|םולש/, 'Hebrew remarks survive');
  const info1 = execFileSync('pdfinfo', [pdf1]).toString();
  assert.match(info1, /Pages:\s+1/);
  assert.match(info1, /Page size:\s+59[45]\.\d+ x 84[12]\.\d+ pts \(A4\)/);
  assert.match(info1, /Title:\s+FIR-0001/);
  // Long report: 40 rows -> multiple pages, header repeated, no row split
  await page.evaluate(() => {
    const t = window.UCM.state.templates[0];
    for (let i = 0; i < 40; i++) t.features.push({ ...window.UCM.Core.blankFeature('numeric'), label: 'Dim ' + (i + 5), nominal: String(10 + i), upper: '0.1', method: 'CMM' });
    window.UCM.state.draft = window.UCM.Core.syncReportFeatures(window.UCM.state.draft, t);
    window.UCM.render();
  });
  const pdf2 = path.join(OUT, 'report-long.pdf');
  await page.pdf({ path: pdf2, format: 'A4', preferCSSPageSize: true, printBackground: true });
  const info2 = execFileSync('pdfinfo', [pdf2]).toString();
  const pages = Number(/Pages:\s+(\d+)/.exec(info2)[1]);
  assert.ok(pages >= 2, 'long report spans pages');
  text = execFileSync('pdftotext', ['-layout', pdf2, '-']).toString();
  assert.match(text, new RegExp(`Page ${pages} of ${pages}`));
  const page2 = execFileSync('pdftotext', ['-f', '2', '-l', '2', '-layout', pdf2, '-']).toString();
  assert.match(page2, /FINAL INSPECTION REPORT FIR-0001/, 'running header repeats on page 2');
  assert.match(page2, /Required/, 'table header repeats on page 2');
});

test('templates: switch, duplicate, delete, logo upload, AQL "other"', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await fill('#h_customer', 'Switch Co');
  await page.click('[data-tab="templates"]');
  await page.click('[data-action="template-duplicate"]');
  await fill('#tplName', 'Second template');
  await page.waitForTimeout(450);
  assert.match(await page.textContent('#quickTemplate'), /Second template/);
  // logo upload: 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await page.setInputFiles('#logoUpload', { name: 'logo.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('.logo-preview');
  const logo = await page.evaluate(() => window.UCM.state.templates[1].company.logo);
  assert.match(logo, /^data:image\/png;base64,/);
  // AQL "other" on the template policy
  await page.selectOption('select[name="p:aql"]', '__other');
  await fill('input[name="p:aql__other"]', '0.4');
  // use this template -> new report, previous archived
  await page.click('[data-action="template-use"]');
  await page.waitForSelector('#h_reportNo');
  assert.equal(await page.inputValue('#h_aql__other'), '0.4');
  await fill('#h_quantity', '100');
  assert.equal((await page.textContent('.sample-big')).trim(), '20', 'Table I size shown for an unsupported AQL');
  assert.match(await page.textContent('#samplingPanel'), /Ac\/Re יש לקרוא מהתקן/);
  assert.ok(await page.$('.report-sheet .rs-logo'), 'logo appears on the printed sheet');
  const s = await uiState();
  assert.equal(s.archive.length, 1); assert.equal(s.archive[0].header.customer, 'Switch Co');
  assert.equal(s.activeTemplateId, s.templates[1].id);
  // archive duplicate and delete
  await page.click('[data-tab="archive"]');
  await page.click('[data-action="archive-duplicate"]');
  await page.waitForSelector('#h_reportNo');
  assert.equal(await page.inputValue('#h_customer'), 'Switch Co');
  assert.equal((await uiState()).archive.length, 2, 'the quantity-filled report was archived before duplicating');
  await page.click('[data-tab="archive"]');
  await page.click('[data-action="archive-delete"]');
  await page.waitForTimeout(100);
  assert.equal((await uiState()).archive.length, 1);
  // delete the second template -> falls back to the first
  await page.click('[data-tab="templates"]');
  await page.click('[data-action="template-delete"]');
  await page.waitForTimeout(100);
  const s2 = await uiState();
  assert.equal(s2.templates.length, 1);
  assert.equal(s2.activeTemplateId, s2.templates[0].id);
  assert.deepEqual(page.__errors, []);
});

test('mobile layout has no horizontal overflow and remains usable', async () => {
  await context.close();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL', isMobile: true, hasTouch: true });
  page = await context.newPage(); page.on('dialog', d => d.accept());
  await page.goto(url, { waitUntil: 'networkidle' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
  await fill('#h_quantity', '50');
  assert.equal((await page.textContent('.sample-big')).trim(), '8');
  await page.click('[data-tab="templates"]');
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow2 <= 1, `templates overflow ${overflow2}px`);
});

test('service worker registers and serves the shell offline', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  const registered = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return Boolean(r && r.active); });
  assert.equal(registered, true);
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.title(), 'UCM Inspection Studio');
  assert.ok(await page.$('#h_reportNo'), 'app rendered from cache while offline');
  await context.setOffline(false);
});
