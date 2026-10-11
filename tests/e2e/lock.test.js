/* Lock screen: with syncUrl configured, nothing is shown until the company key is verified by the server. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { Miniflare } from 'miniflare';
import { startServer } from '../helpers/static-server.js';

const ROOT = process.cwd();
const BUNDLE = path.join(ROOT, 'test-output', 'worker.bundle.js');
const KEY = 'company-password-2026-ucm';
let server, url, browser, mf, workerUrl;

before(async () => {
  ({ server, url } = await startServer());
  browser = await chromium.launch();
  fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [path.join(ROOT, 'worker', 'src', 'index.js'), '--bundle', '--format=esm', '--platform=browser', '--target=es2022', '--outfile=' + BUNDLE], { stdio: 'ignore' });
  mf = new Miniflare({ modules: true, scriptPath: BUNDLE, compatibilityDate: '2026-07-01', port: 0, d1Databases: { DB: 'ucm-lock' }, r2Buckets: ['FILES'], bindings: { WORKSPACE_KEY: KEY, ALLOWED_ORIGIN: '*' } });
  workerUrl = (await mf.ready).toString().replace(/\/$/, '');
  const db = await mf.getD1Database('DB');
  const schema = fs.readFileSync(path.join(ROOT, 'worker', 'schema.sql'), 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of schema.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
});
after(async () => { await browser.close(); server.close(); if (mf) await mf.dispose(); });

async function lockedPage() {
  // The service worker is blocked here so the injected deployment config is used on every load.
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'he-IL', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('dialog', d => d.accept());
  // Deploy-time configuration: the sync server address is baked into src/config.js
  await page.route('**/src/config.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: `export const CONFIG = { syncUrl: '${workerUrl}' };` }));
  await page.goto(url, { waitUntil: 'networkidle' });
  return { context, page };
}

test('wrong key is rejected, right key opens the app, stays open after reload, logout locks again', async () => {
  const { context, page } = await lockedPage();
  assert.equal(await page.isVisible('#lockScreen'), true);
  assert.equal(await page.isVisible('.empty-start'), false, 'no app content behind the lock');
  assert.equal(await page.evaluate(() => document.getElementById('main').innerHTML.trim()), '', 'the app is not even rendered');
  await page.fill('#lockKey', 'wrong-password-123456');
  await page.click('#lockSubmit');
  await page.waitForFunction(() => document.getElementById('lockError').textContent.includes('שגוי'));
  assert.equal(await page.isVisible('#lockScreen'), true);
  await page.fill('#lockKey', KEY);
  await page.click('#lockSubmit');
  await page.waitForSelector('.empty-start');
  assert.equal(await page.isVisible('#lockScreen'), false);
  await page.waitForFunction(() => window.UCM.state.settings.sync.lastSyncAt, null, { timeout: 15000 });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.isVisible('#lockScreen'), false, 'the key is remembered on this computer');
  await page.click('.side-nav [data-tab="settings"]');
  await page.waitForSelector('#syncUrl');
  assert.ok(await page.$('#syncUrl[readonly]'), 'server address is fixed by the deployment');
  await page.click('[data-action="lock-logout"]');
  await page.waitForSelector('#lockScreen:not([hidden])');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.isVisible('#lockScreen'), true);
  await context.close();
});

test('without syncUrl in config.js the app opens directly (local mode)', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'he-IL' });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  assert.equal(await page.isVisible('#lockScreen'), false);
  assert.ok(await page.$('.empty-start'));
  await context.close();
});
