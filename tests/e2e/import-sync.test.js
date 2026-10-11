/*
 * End-to-end: import the two real reports through the browser UI, save products,
 * open reports from them, and prove cross-device sync against the real Worker
 * (running in Miniflare/workerd on a local port with the Anthropic API mocked).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { Miniflare } from 'miniflare';
import { startServer } from '../helpers/static-server.js';

const ROOT = process.cwd();
const FIX = path.join(ROOT, 'tests', 'fixtures');
const BUNDLE = path.join(ROOT, 'test-output', 'worker.bundle.js');
const KEY = 'e2e-workspace-key-0123456789';
let server, url, browser, mf, workerUrl;

before(async () => {
  ({ server, url } = await startServer());
  browser = await chromium.launch();
  fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [path.join(ROOT, 'worker', 'src', 'index.js'), '--bundle', '--format=esm', '--platform=browser', '--target=es2022', '--outfile=' + BUNDLE], { stdio: 'ignore' });
  mf = new Miniflare({
    modules: true, scriptPath: BUNDLE, compatibilityDate: '2026-07-01', port: 0,
    d1Databases: { DB: 'ucm-e2e' }, r2Buckets: ['FILES'],
    bindings: { WORKSPACE_KEY: KEY, ALLOWED_ORIGIN: '*', ANTHROPIC_API_KEY: 'sk-test', AI_MODEL: 'claude-opus-5-5', MAX_FILE_MB: '25' },
    outboundService: async request => {
      if (new URL(request.url).hostname !== 'api.anthropic.com') return new Response('blocked', { status: 502 });
      const body = await request.json();
      // A plausible vision answer for the second report (Required cells are images)
      const answer = { header: { reportNo: '', partNo: '', revision: '', partName: '', catalogNo: '', customer: '', purchaseOrder: '', productionOrder: '', quantity: '', aql: '', sampleSize: '', accepted: '', rejected: '', generalTolerance: '', inspector: '', inspectionDate: '', drawingNo: '', material: '' },
        rows: [
          { no: 1, requiredText: '0.69', kind: 'numeric', label: '', nominal: '0.69', upper: '0.1', lower: '', symmetric: true, unit: 'mm', suffix: '', method: 'Pins', min: '0.66', max: '0.76', outcome: '', confidence: 0.9, note: '' },
          { no: 6, requiredText: 'Ø3.05', kind: 'numeric', label: 'Ø', nominal: '3.05', upper: '0.1', lower: '', symmetric: true, unit: 'mm', suffix: '', method: 'Caliper', min: '3.01', max: '3.07', outcome: '', confidence: 0.95, note: '' },
          { no: 11, requiredText: '-2-56UNC', kind: 'gauge', label: '2-56 UNC', nominal: '', upper: '', lower: '', symmetric: true, unit: '', suffix: '', method: 'Thread pluge gage', min: '✓', max: '✓', outcome: 'pass', confidence: 0.9, note: '' },
        ], notes: 'mock vision' };
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  workerUrl = (await mf.ready).toString().replace(/\/$/, '');
  const db = await mf.getD1Database('DB');
  const schema = fs.readFileSync(path.join(ROOT, 'worker', 'schema.sql'), 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of schema.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
});
after(async () => { await browser.close(); server.close(); if (mf) await mf.dispose(); });

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'he-IL' });
  const page = await context.newPage();
  page.on('dialog', d => d.accept());
  page.__errors = [];
  page.on('pageerror', e => page.__errors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle' });
  return { context, page };
}
async function configureSync(page) {
  await page.click('[data-tab="settings"]');
  await page.fill('#syncUrl', workerUrl);
  await page.fill('#syncKey', KEY);
  await page.click('[data-action="sync-test"]');
  await page.waitForFunction(() => /החיבור תקין|נכשל/.test(document.getElementById('syncDetail').textContent));
  assert.match(await page.textContent('#syncDetail'), /החיבור תקין/);
}
const uiState = page => page.evaluate(() => JSON.parse(JSON.stringify(window.UCM.state)));

test('import report A through the UI: 12 rows, product saved, report opened from the product', async () => {
  const { context, page } = await newPage();
  await page.click('[data-tab="products"]');
  await page.click('[data-action="go-import"]');
  await page.setInputFiles('#importPdf', path.join(FIX, 'report-MM606207C-C.pdf'));
  await page.waitForSelector('.im-row', { timeout: 60000 });
  assert.equal((await page.$$('.im-row')).length, 12);
  assert.equal((await page.$$('.im-row.needs')).length, 5, 'composite and angle rows wait for confirmation');
  assert.equal(await page.inputValue('input[name="imf:partNo"]'), 'MM606207C');
  assert.equal(await page.inputValue('input[name="imf:revision"]'), 'C');
  assert.equal(await page.inputValue('input[name="imf:inspectionDate"]'), '2023-09-06');
  assert.ok(await page.$('.im-row img'), 'crops from the PDF are shown');
  // Keyboard flow: Enter in a nominal field jumps to the next numeric row's nominal (gauge rows skipped)
  await page.focus('input[name="imr:nominal"][data-i="3"]');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.name + '/' + document.activeElement.dataset.i), 'imr:nominal/5', 'row 5 (thread gauge) is skipped');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.i), '6');
  // Fix the angle row (no tolerance on the form) before saving
  const angleIndex = await page.evaluate(() => window.UCM.ui.import.draft.features.findIndex(f => f.feature.unit === 'deg'));
  await page.fill(`input[name="imr:upper"][data-i="${angleIndex}"]`, '0.5');
  assert.match(await page.textContent('[data-im-row="8"] .fe-preview-text'), /90\.0 ±0\.5/);
  await page.click('[data-action="im-save"][data-then="report"]');
  await page.waitForSelector('#h_reportNo');
  assert.equal(await page.inputValue('#h_partNo'), 'MM606207C');
  assert.equal(await page.inputValue('#h_revision'), 'C');
  assert.ok(await page.$('#h_partNo:disabled') && await page.$('#h_revision:disabled'), 'product identity is locked on the report');
  assert.equal(await page.inputValue('#h_customer'), 'Atena Ltd.');
  assert.equal((await page.$$('tr[data-row]')).length, 12);
  assert.match(await page.textContent('tr[data-row] .req'), /4\.33 ±0\.10 x 60°/);
  const s = await uiState(page);
  assert.equal(s.products.length, 1);
  assert.equal(s.products[0].features.length, 12);
  assert.equal(s.archive.length, 1, 'the historical report was archived');
  assert.equal(s.archive[0].header.reportNo, '9515_2');
  assert.equal(s.archive[0].results[s.archive[0].features[0].id].min, '4.24');
  // Reload: the product-based draft survives
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.inputValue('#h_partNo'), 'MM606207C');
  assert.deepEqual(page.__errors, []);
  await context.close();
});

test('re-importing the same part/revision updates the existing product instead of duplicating it', async () => {
  const { context, page } = await newPage();
  for (let i = 0; i < 2; i++) {
    await page.click('[data-tab="products"]');
    await page.click('[data-action="go-import"]');
    await page.setInputFiles('#importPdf', path.join(FIX, 'report-MM606207C-C.pdf'));
    await page.waitForSelector('.im-row', { timeout: 60000 });
    if (i === 1) assert.match(await page.evaluate(() => Array.from(document.querySelectorAll('.alert')).map(a => a.textContent).join(' ')), /קיים ויעודכן/);
    await page.click('[data-action="im-save"][data-then="products"]');
    await page.waitForSelector('.tpl-editor');
  }
  const s = await uiState(page);
  assert.equal(s.products.length, 1);
  assert.equal(s.archive.length, 2, 'two historical reports, one product');
  await context.close();
});

test('cross-device: device A imports with sync on; device B sees the product and opens a report from it', async () => {
  const a = await newPage();
  await configureSync(a.page);
  await a.page.click('[data-tab="products"]');
  await a.page.click('[data-action="go-import"]');
  await a.page.setInputFiles('#importPdf', path.join(FIX, 'report-MM606207C-C.pdf'));
  await a.page.waitForSelector('.im-row', { timeout: 60000 });
  await a.page.click('[data-action="im-save"][data-then="products"]');
  await a.page.waitForSelector('.tpl-editor');
  // wait for the automatic push
  await a.page.waitForFunction(() => Object.keys(window.UCM.state.settings.dirty || {}).length === 0 && window.UCM.state.settings.sync.lastSyncAt, null, { timeout: 20000 });
  const sa = await uiState(a.page);
  assert.ok(sa.products[0].sourceFileId, 'original PDF uploaded and referenced');
  const fileRes = await mf.dispatchFetch(workerUrl + '/api/files/' + sa.products[0].sourceFileId, { headers: { Authorization: 'Bearer ' + KEY } });
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers.get('Content-Type'), 'application/pdf');

  const b = await newPage();
  assert.equal((await uiState(b.page)).products.length, 0, 'device B starts empty (separate browser profile)');
  await configureSync(b.page);
  await b.page.click('[data-action="sync-now"]');
  await b.page.waitForFunction(() => window.UCM.state.products.length > 0, null, { timeout: 20000 });
  const sb = await uiState(b.page);
  assert.equal(sb.products.length, 1);
  assert.equal(sb.products[0].partNo, 'MM606207C');
  assert.equal(sb.products[0].features.length, 12);
  assert.equal(sb.archive.length, 1, 'the archived historical report also arrived');
  // Open a report from the synced product via the picker on the report tab
  await b.page.click('[data-tab="report"]');
  await b.page.fill('#productSearch', 'MM606');
  await b.page.waitForSelector('#productResults button[data-action="product-use"]');
  await b.page.click('#productResults button[data-action="product-use"]');
  await b.page.waitForSelector('#h_partNo:disabled');
  assert.equal(await b.page.inputValue('#h_partNo'), 'MM606207C');
  assert.equal((await b.page.$$('tr[data-row]')).length, 12);
  // Device B edits the product; device A receives the change on its next sync
  await b.page.click('[data-tab="products"]');
  await b.page.click('[data-action="product-edit"]');
  await b.page.fill('input[name="pr:catalogNo"]', 'CAT-SYNC');
  await b.page.waitForFunction(() => Object.keys(window.UCM.state.settings.dirty || {}).length === 0, null, { timeout: 20000 });
  await a.page.click('[data-tab="settings"]');
  await a.page.click('[data-action="sync-now"]');
  await a.page.waitForFunction(() => window.UCM.state.products[0].catalogNo === 'CAT-SYNC', null, { timeout: 20000 });
  assert.deepEqual(a.page.__errors, []); assert.deepEqual(b.page.__errors, []);
  await a.context.close(); await b.context.close();
});

test('import report B with AI available: image cells are filled by the (mocked) vision model and still flagged for confirmation', async () => {
  const { context, page } = await newPage();
  await configureSync(page);
  await page.click('[data-tab="products"]');
  await page.click('[data-action="go-import"]');
  await page.setInputFiles('#importPdf', path.join(FIX, 'report-0112807-000-AB.pdf'));
  await page.waitForSelector('.im-row', { timeout: 60000 });
  await page.waitForFunction(() => window.UCM.ui.import.aiStatus === 'done' || window.UCM.ui.import.aiStatus === 'failed', null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.UCM.ui.import.aiStatus), 'done');
  assert.equal((await page.$$('.im-row')).length, 15);
  assert.equal(await page.inputValue('input[name="imr:nominal"][data-i="0"]'), '0.69');
  assert.equal(await page.inputValue('input[name="imr:nominal"][data-i="5"]'), '3.05');
  assert.equal(await page.inputValue('input[name="imr:label"][data-i="10"]'), '2-56 UNC');
  assert.match(await page.textContent('[data-im-row="0"] .fe-preview-text'), /0\.69 ±0\.10/);
  assert.ok(await page.$('[data-im-row="0"].needs'), 'AI-read rows still require confirmation');
  await page.click('[data-action="im-save"][data-then="products"]');
  await page.waitForSelector('.tpl-editor');
  const s = await uiState(page);
  assert.equal(s.products[0].partNo, '0112807-000');
  assert.equal(s.products[0].revision, 'AB');
  assert.equal(s.products[0].features.length, 15);
  assert.deepEqual(page.__errors, []);
  await context.close();
});
