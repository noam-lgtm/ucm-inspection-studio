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
const pdfText = (file, extra = []) => execFileSync('pdftotext', [...extra, '-layout', file, '-']).toString();

/** Create a product by hand (two rows) and open a report for it. */
async function createProductAndReport(partNo = 'P-100') {
  await page.click('.side-nav [data-tab="products"]');
  await page.click('[data-action="product-new"]');
  await fill('input[name="pr:partNo"]', partNo);
  await fill('input[name="pr:revision"]', 'A');
  await fill('input[name="pr:partName"]', 'Bracket');
  await fill('input[name="pr:customer"]', 'Acme Ltd');
  await fill('input[name="pr:catalogNo"]', 'CAT-100');
  await page.waitForTimeout(450);
  const fid = await page.evaluate(() => window.UCM.state.products[0].features[0].id);
  await fill(`input[name="f:label"][data-fid="${fid}"]`, 'Length');
  await fill(`input[name="f:nominal"][data-fid="${fid}"]`, '25.00');
  await fill(`input[name="f:upper"][data-fid="${fid}"]`, '0.10');
  await fill(`input[name="f:method"][data-fid="${fid}"]`, 'Caliper');
  await page.click('[data-action="feature-add"][data-kind="gauge"]');
  const gid = await page.evaluate(() => window.UCM.state.products[0].features[1].id);
  await fill(`input[name="f:label"][data-fid="${gid}"]`, 'M8x1.25-6H');
  await fill(`input[name="f:method"][data-fid="${gid}"]`, 'Thread plug gage');
  await page.waitForTimeout(350);
  await page.click('[data-action="product-report"]');
  await page.waitForSelector('#h_reportNo');
}

test('loads without console errors; without products the report tab offers the PDF import', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  assert.deepEqual(page.__errors, []);
  assert.equal(await page.title(), 'UCM Inspection Studio');
  assert.ok(await page.$('.empty-start [data-action="go-import"]'));
  assert.equal((await page.$$('.side-nav [data-tab]')).length, 4, 'four tabs only: report, products, archive, settings');
  assert.equal(await page.$('[data-tab="templates"]'), null, 'templates are gone');
});

test('product editor: required text follows the drawing notation; a report opens from the product with locked product fields', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await createProductAndReport();
  const s = await uiState();
  assert.equal(s.products.length, 1);
  assert.equal(s.products[0].inspectionLevel, 'II');
  assert.equal(s.products[0].aql, '2.5');
  assert.equal(await page.inputValue('#h_partNo'), 'P-100');
  assert.ok(await page.$('#h_partNo:disabled') && await page.$('#h_revision:disabled') && await page.$('#h_aql:disabled'), 'product fields are locked on the report');
  assert.ok(await page.$('#h_quantity:not(:disabled)') && await page.$('#h_customer:not(:disabled)'));
  assert.equal(await page.inputValue('#h_customer'), 'Acme Ltd', 'customer comes from the product');
  assert.equal((await page.$$('tr[data-row]')).length, 2);
  assert.match(await page.textContent('tr[data-row] .req'), /Length 25\.00/);
  assert.match(await page.textContent('tr[data-row] .lim'), /±0\.10/);
  // Edit the product: the open draft follows
  await page.click('[data-action="product-open-current"]');
  const fid = await page.evaluate(() => window.UCM.state.products[0].features[0].id);
  await page.selectOption(`select[name="f:symmetric"][data-fid="${fid}"]`, '0');
  await fill(`input[name="f:upper"][data-fid="${fid}"]`, '0.10');
  await fill(`input[name="f:lower"][data-fid="${fid}"]`, '0.05');
  assert.match(await page.textContent(`.fe-row[data-feature="${fid}"] .fe-preview`), /Length 25\.00 \+0\.10 \/ \+0\.05 \(25\.05 – 25\.10\)/);
  await fill(`input[name="f:lower"][data-fid="${fid}"]`, '0.20');
  assert.match(await page.textContent(`.fe-row[data-feature="${fid}"] .fe-preview`), /התחתון גדול מהעליון/);
  await fill(`input[name="f:lower"][data-fid="${fid}"]`, '0.05');
  await page.click('[data-action="feature-add"][data-kind="numeric"]');
  await page.click('.side-nav [data-tab="report"]');
  assert.equal((await page.$$('tr[data-row]')).length, 3);
  await setMeasure(0, '25.06', '25.09');
  assert.match(await rowStatus(0), /בטווח/);
  await setMeasure(0, '25.00', '25.09');
  assert.match(await rowStatus(0), /חריגה/, 'a value equal to the nominal but below the shifted lower limit fails');
  await setMeasure(2, '1', '1');
  assert.match(await rowStatus(2), /לבדיקה/, 'a row without a definition never passes');
  assert.match(await page.textContent('#warnings'), /הגדרה חסרה/);
  assert.deepEqual(page.__errors, []);
});

test('sampling line: lot 60 / level II / AQL 2.5 follows the Table II-A arrow to code D (n=8, Ac 0 Re 1)', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await createProductAndReport();
  await fill('#h_quantity', '60');
  assert.match(await page.textContent('#samplingLine'), /גודל מדגם: 8 \(אות D, Ac 0 \/ Re 1\)/);
  await fill('#h_quantity', '400');
  assert.match(await page.textContent('#samplingLine'), /גודל מדגם: 50 \(אות H, Ac 3 \/ Re 4\)/);
  await fill('#h_quantity', '250');
  assert.match(await page.textContent('#samplingLine'), /גודל מדגם: 32/, 'lot 250 -> 32 as printed on the original UCM report');
  await fill('#h_quantity', '5');
  assert.match(await page.textContent('#samplingLine'), /100%/);
  await fill('#h_quantity', '1');
  assert.match(await page.textContent('#samplingLine'), /יחידה אחת/);
  await fill('#h_quantity', 'abc');
  assert.match(await page.textContent('#warnings'), /מספר שלם/);
});

test('measurement entry: verdicts, keyboard flow, copy-min, GO/NO-GO, persistence across reload', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await createProductAndReport();
  await setMeasure(0, '24.95', '25.05');
  assert.match(await rowStatus(0), /בטווח/);
  await setMeasure(0, '24.95', '25.11');
  assert.match(await rowStatus(0), /חריגה/);
  await setMeasure(0, '25.11', '24.95');
  assert.match(await rowStatus(0), /לבדיקה/);
  await setMeasure(0, '24,95', 'Ø25.05');
  assert.match(await rowStatus(0), /בטווח/);
  // Enter in an empty max copies min and moves on
  const id0 = await featureId(0);
  await fill(`input[data-measure="max"][data-id="${id0}"]`, '');
  await page.focus(`input[data-measure="max"][data-id="${id0}"]`);
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue(`input[data-measure="max"][data-id="${id0}"]`), '24,95');
  assert.match(await rowStatus(0), /בטווח/);
  const id1 = await featureId(1);
  await page.click(`[data-outcome="fail"][data-id="${id1}"]`);
  assert.match(await rowStatus(1), /חריגה/);
  assert.match(await page.textContent('#statusPill'), /חריגות/);
  await page.click(`[data-outcome="pass"][data-id="${id1}"]`);
  assert.match(await rowStatus(1), /עובר/);
  assert.match(await page.textContent('#statusPill'), /כל המידות בטווח/);
  await fill('#remarks', 'הערה בעברית');
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.inputValue(`input[data-measure="max"][data-id="${id0}"]`), '24,95');
  assert.match(await rowStatus(1), /עובר/);
  assert.equal(await page.inputValue('#remarks'), 'הערה בעברית');
  assert.deepEqual(page.__errors, []);
});

test('new report: previous one is archived, the inspector carries over, lot data does not; archive reopen and delete', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await createProductAndReport();
  await fill('#h_reportNo', '9515_2');
  await fill('#h_inspector', 'Yuri S.');
  await fill('#h_purchaseOrder', 'PO-55');
  await fill('#h_quantity', '100');
  await setMeasure(0, '25', '25');
  await page.click('[data-action="new-report"]');
  await page.waitForSelector('#h_reportNo');
  assert.equal(await page.inputValue('#h_reportNo'), '');
  assert.equal(await page.inputValue('#h_inspector'), 'Yuri S.', 'the inspector carries over');
  assert.equal(await page.inputValue('#h_purchaseOrder'), '');
  assert.equal(await page.inputValue('#h_quantity'), '');
  assert.equal(await page.inputValue('#h_partNo'), 'P-100', 'same product');
  const s = await uiState();
  assert.equal(s.archive.length, 1);
  assert.equal(s.archive[0].header.reportNo, '9515_2');
  await page.click('.side-nav [data-tab="archive"]');
  assert.match(await page.textContent('table.list'), /9515_2/);
  assert.match(await page.textContent('table.list'), /Acme Ltd/);
  await page.click('[data-action="archive-open"]');
  await page.waitForSelector('#h_reportNo');
  assert.equal(await page.inputValue('#h_reportNo'), '9515_2');
  assert.equal((await uiState()).archive.length, 0, 'the empty draft was not archived');
  await page.click('[data-action="new-report"]');
  await page.waitForSelector('#h_reportNo');
  await page.click('.side-nav [data-tab="archive"]');
  await page.click('[data-action="archive-delete"]');
  await page.waitForTimeout(100);
  assert.equal((await uiState()).archive.length, 0);
  assert.deepEqual(page.__errors, []);
});

test('backup export and import round-trip (merge, nothing deleted)', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await createProductAndReport();
  await fill('#h_customer', 'Backup Co');
  await page.click('[data-action="new-report"]');
  await page.waitForSelector('#h_reportNo');
  await page.click('.side-nav [data-tab="settings"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export-backup"]')]);
  const file = path.join(os.tmpdir(), 'ucm-backup-test.json');
  await download.saveAs(file);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.format, 'ucm-inspection-backup');
  assert.equal(data.archive.length, 1);
  assert.equal(data.products.length, 1);
  await context.close();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'he-IL' });
  page = await context.newPage(); page.on('dialog', d => d.accept());
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('.side-nav [data-tab="settings"]');
  await page.setInputFiles('#importFile', file);
  await page.waitForTimeout(300);
  const s = await uiState();
  assert.equal(s.archive.length, 1);
  assert.equal(s.archive[0].header.customer, 'Backup Co');
  assert.equal(s.products.length, 1);
});

test('PDF: the original UCM form layout, A4, file name, "Page x from y" and repeated header on long reports', { skip: !hasPdfTools && 'pdftotext not installed' }, async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  await createProductAndReport();
  await fill('#h_reportNo', '9515_2');
  await fill('#h_productionOrder', '0');
  await fill('#h_purchaseOrder', 'PO23000834');
  await fill('#h_quantity', '250');
  await fill('#h_inspector', 'YURI S.');
  await fill('#h_inspectionDate', '2023-09-06');
  await fill('#h_totalInspected', '32'); await fill('#h_accepted', '32'); await fill('#h_rejected', '0');
  await fill('#remarks', 'שלום');
  await setMeasure(0, '24.95', '25.05');
  const id1 = await featureId(1); await page.click(`[data-outcome="pass"][data-id="${id1}"]`);
  await page.click('[data-action="go-preview"]');
  await page.waitForSelector('#previewPaper .rs-page');
  const fileName = await page.evaluate(() => { document.title = window.UCM.reportFileName(window.UCM.state.draft); return document.title; });
  assert.equal(fileName, '9515_2_P-100');
  assert.equal(await page.evaluate(() => { const i = document.querySelector('#previewPaper .rs-logo'); return i && i.complete && i.naturalWidth > 0; }), true, 'the UCM logo is on the sheet');
  await page.emulateMedia({ media: 'print' });
  const pdf1 = path.join(OUT, 'report-short.pdf');
  await page.pdf({ path: pdf1, format: 'A4', preferCSSPageSize: true, printBackground: true });
  const text = pdfText(pdf1);
  for (const expected of ['Page 1 of 1', 'FINAL INSPECTION REPORT', '9515_2', 'CUSTOMER', 'Acme Ltd', 'PURCHASE ORDER', 'PO23000834', 'PRODUCTION ORDER', 'LOT QUANTITY', '250',
    'CATALOG No.', 'PART No.', 'P-100', 'PART NAME', 'Bracket', 'REVISION', 'GENERAL TOLERANCE', '±0.1', 'INSPECTOR', 'YURI S.', 'DATE', '06/09/23', 'TOTAL INSPECTED',
    'SAMPLING PLAN', 'AQL', '2.5', 'CODE LETTER', 'SAMPLE SIZE', '32', 'Ac / Re', 'ACCEPTED QTY', 'REJECTED QTY',
    'Required', 'TOL', 'Actual min', 'Actual max', 'Result', 'Length 25.00', '0.10', 'Caliper', '24.95', '25.05', 'M8x1.25-6H', 'Thread plug gage', 'GO', 'PASS – all characteristics within limits',
    'REMARKS', 'NAME', 'SIGNATURE', 'MIL-STD-105D', 'Hidekel']) {
    assert.ok(text.includes(expected), `missing "${expected}"`);
  }
  assert.match(text, /שלום|םולש/, 'Hebrew remarks survive');
  assert.ok(!text.includes('—'), 'no empty cells: every value of the report is printed');
  const info1 = execFileSync('pdfinfo', [pdf1]).toString();
  assert.match(info1, /Pages:\s+1/);
  assert.match(info1, /Page size:\s+59[45]\.\d+ x 84[12]\.\d+ pts \(A4\)/);
  assert.match(info1, /Title:\s+9515_2_P-100/);
  // Long report: 40 more rows -> several pages, each with the title box and the table header, no lost rows
  await page.evaluate(() => {
    const p = window.UCM.state.products[0];
    for (let i = 0; i < 40; i++) p.features.push({ ...window.UCM.Core.blankFeature('numeric'), label: 'Dim', nominal: String(10 + i), upper: '0.1', method: 'CMM' });
    window.UCM.state.draft = window.UCM.Core.syncReportWithProduct(window.UCM.state.draft, p);
    window.UCM.render();
  });
  await page.waitForSelector('#previewPaper .rs-page[data-page="2"]', { state: 'attached' });
  const pdf2 = path.join(OUT, 'report-long.pdf');
  await page.pdf({ path: pdf2, format: 'A4', preferCSSPageSize: true, printBackground: true });
  const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf2]).toString())[1]);
  assert.ok(pages >= 2, 'long report spans pages');
  const all = pdfText(pdf2);
  assert.ok(all.includes(`Page 1 of ${pages}`) && all.includes(`Page ${pages} of ${pages}`), 'page numbering matches the real page count');
  assert.equal((all.match(/CMM/g) || []).length, 40, 'every row is printed exactly once');
  const page2 = pdfText(pdf2, ['-f', '2', '-l', '2']);
  assert.match(page2, /FINAL INSPECTION REPORT 9515_2/, 'running header repeats on page 2');
  assert.match(page2, /Required/, 'table header repeats on page 2');
  assert.ok(!page2.includes('SAMPLING PLAN'), 'the header blocks are printed on page 1 only');
  const last = pdfText(pdf2, ['-f', String(pages), '-l', String(pages)]);
  assert.match(last, /REMARKS/, 'the closing block is on the last page');
  assert.deepEqual(page.__errors, []);
});

test('mobile layout has no horizontal overflow and remains usable', async () => {
  await context.close();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL', isMobile: true, hasTouch: true });
  page = await context.newPage(); page.on('dialog', d => d.accept());
  await page.goto(url, { waitUntil: 'networkidle' });
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok((await overflow()) <= 1, `horizontal overflow ${await overflow()}px`);
  await createProductAndReport();
  assert.ok((await overflow()) <= 1, `report overflow ${await overflow()}px`);
  await fill('#h_quantity', '50');
  assert.match(await page.textContent('#samplingLine'), /גודל מדגם: 8/);
  await page.click('.side-nav [data-tab="products"]');
  assert.ok((await overflow()) <= 1, `products overflow ${await overflow()}px`);
});

test('service worker registers and serves the shell offline', async () => {
  await page.goto(url, { waitUntil: 'networkidle' });
  const registered = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return Boolean(r && r.active); });
  assert.equal(registered, true);
  await page.waitForTimeout(500);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  assert.equal(await page.title(), 'UCM Inspection Studio');
  assert.ok(await page.$('.empty-start'), 'app rendered from cache while offline');
  await context.setOffline(false);
});
