/*
 * Worker tests: the real Worker code runs inside workerd (Miniflare) with local D1 and R2.
 * The Anthropic API is mocked through Miniflare's outbound service.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Miniflare } from 'miniflare';

const ROOT = process.cwd();
const BUNDLE = path.join(ROOT, 'test-output', 'worker.bundle.js');
let mf;
const KEY = 'test-workspace-key-0123456789';
const auth = { Authorization: 'Bearer ' + KEY };
let aiCalls = [];

before(async () => {
  fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'esbuild'), [path.join(ROOT, 'worker', 'src', 'index.js'), '--bundle', '--format=esm', '--platform=browser', '--target=es2022', '--outfile=' + BUNDLE], { stdio: 'inherit' });
  mf = new Miniflare({
    modules: true,
    scriptPath: BUNDLE,
    compatibilityDate: '2026-07-01',
    d1Databases: { DB: 'ucm-test' },
    r2Buckets: ['FILES'],
    bindings: { WORKSPACE_KEY: KEY, ALLOWED_ORIGIN: 'https://example.test', ANTHROPIC_API_KEY: 'sk-test', AI_MODEL: 'claude-opus-5-5', MAX_FILE_MB: '1' },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'api.anthropic.com') {
        const body = await request.json();
        aiCalls.push({ url: url.pathname, headers: Object.fromEntries(request.headers), body });
        const answer = { header: { reportNo: '9195_2', partNo: '0112807-000', revision: 'AB', partName: '', catalogNo: '', customer: '', purchaseOrder: '', productionOrder: '', quantity: '200', aql: '2.5', sampleSize: '32', accepted: '200', rejected: '0', generalTolerance: '±0.1', inspector: '', inspectionDate: '2026-04-20', drawingNo: '', material: '' },
          rows: [{ no: 1, requiredText: '0.69', kind: 'numeric', label: '', nominal: '0.69', upper: '0.1', lower: '', symmetric: true, unit: 'mm', suffix: '', method: 'Pins', min: '0.66', max: '0.76', outcome: '', confidence: 0.9, note: '' }], notes: 'mock' };
        return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 10, output_tokens: 5 } }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('blocked', { status: 502 });
    },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  const schema = fs.readFileSync(path.join(ROOT, 'worker', 'schema.sql'), 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const stmt of schema.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
});
after(async () => { if (mf) await mf.dispose(); });

const call = (p, init = {}) => mf.dispatchFetch('https://worker.test' + p, init);
const postJson = (p, body, headers = auth) => call(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('auth and CORS', async () => {
  assert.equal((await call('/api/health')).status, 401);
  assert.equal((await call('/api/health', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await call('/api/health', { headers: auth });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true); assert.equal(body.ai, true);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://example.test');
  const pre = await call('/api/sync', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  const root = await call('/');
  assert.equal(root.status, 200);
});

test('sync: push, pull from another device, last-write-wins, tombstones, cursor paging', async () => {
  const now = '2026-10-11T10:00:00.000Z';
  const r1 = await postJson('/api/sync', { cursor: '', changes: [
    { kind: 'product', id: 'p1', updatedAt: now, deleted: false, data: { id: 'p1', partNo: 'MM606207C', revision: 'C', features: [] } },
    { kind: 'template', id: 't1', updatedAt: now, deleted: false, data: { id: 't1', name: 'T' } },
  ] });
  assert.equal(r1.status, 200);
  const b1 = await r1.json();
  assert.equal(b1.written, 2);
  assert.deepEqual(b1.changes, [], 'a device does not get its own pushes back');
  assert.equal(b1.cursor, '2');
  // Device B, empty cursor -> receives both
  const r2 = await postJson('/api/sync', { cursor: '', changes: [] });
  const b2 = await r2.json();
  assert.equal(b2.changes.length, 2);
  assert.equal(b2.changes[0].data.partNo, 'MM606207C');
  assert.equal(b2.cursor, '2');
  // Older update is ignored, newer wins
  const older = await postJson('/api/sync', { cursor: '2', changes: [{ kind: 'product', id: 'p1', updatedAt: '2026-10-11T09:00:00.000Z', deleted: false, data: { id: 'p1', partNo: 'OLD', revision: 'C', features: [] } }] });
  assert.equal((await older.json()).written, 0);
  const newer = await postJson('/api/sync', { cursor: '2', changes: [{ kind: 'product', id: 'p1', updatedAt: '2026-10-11T11:00:00.000Z', deleted: false, data: { id: 'p1', partNo: 'NEW', revision: 'C', features: [] } }] });
  assert.equal((await newer.json()).written, 1);
  const r3 = await postJson('/api/sync', { cursor: '2', changes: [] });
  const b3 = await r3.json();
  assert.equal(b3.changes.length, 1); assert.equal(b3.changes[0].data.partNo, 'NEW');
  // Tombstone
  await postJson('/api/sync', { cursor: b3.cursor, changes: [{ kind: 'template', id: 't1', updatedAt: '2026-10-11T12:00:00.000Z', deleted: true, data: null }] });
  const r4 = await postJson('/api/sync', { cursor: b3.cursor, changes: [] });
  const b4 = await r4.json();
  assert.equal(b4.changes.length, 1); assert.equal(b4.changes[0].deleted, true); assert.equal(b4.changes[0].data, null);
  // Validation
  const bad = await postJson('/api/sync', { cursor: '', changes: [{ kind: 'bogus', id: 'x', updatedAt: now, deleted: false, data: {} }] });
  assert.equal(bad.status, 400);
  const bad2 = await postJson('/api/sync', { cursor: '', changes: [{ kind: 'product', id: 'x', updatedAt: now, deleted: false, data: 'no' }] });
  assert.equal(bad2.status, 400);
  // Paging: 600 reports -> first page 500 with more=true
  const many = Array.from({ length: 600 }, (_, i) => ({ kind: 'report', id: 'r' + i, updatedAt: now, deleted: false, data: { id: 'r' + i } }));
  await postJson('/api/sync', { cursor: '', changes: many });
  const page1 = await (await postJson('/api/sync', { cursor: b4.cursor, changes: [] })).json();
  assert.equal(page1.changes.length, 500); assert.equal(page1.more, true);
  const page2 = await (await postJson('/api/sync', { cursor: page1.cursor, changes: [] })).json();
  assert.equal(page2.changes.length, 100); assert.equal(page2.more, false);
});

test('files: upload and download, limits', async () => {
  const pdf = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'report-MM606207C-C.pdf'));
  const up = await call('/api/files/f1.pdf', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/pdf' }, body: pdf });
  assert.equal(up.status, 200);
  const meta = await up.json();
  assert.equal(meta.size, pdf.length);
  const down = await call('/api/files/f1.pdf', { headers: auth });
  assert.equal(down.status, 200);
  assert.equal(down.headers.get('Content-Type'), 'application/pdf');
  assert.equal((await down.arrayBuffer()).byteLength, pdf.length);
  assert.equal((await call('/api/files/missing', { headers: auth })).status, 404);
  assert.equal((await call('/api/files/x.txt', { method: 'PUT', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'hi' })).status, 415);
  const big = new Uint8Array(1024 * 1024 + 1);
  assert.equal((await call('/api/files/big.pdf', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/pdf' }, body: big })).status, 413);
  assert.equal((await call('/api/files/bad%20id', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/pdf' }, body: pdf })).status, 400);
});

test('extract: proxies page images to the model with a strict JSON schema and returns parsed rows', async () => {
  aiCalls = [];
  const res = await postJson('/api/extract', { pages: [{ mime: 'image/jpeg', base64: 'AAAA' }], hints: { fields: { partNo: '0112807-000' } } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.header.partNo, '0112807-000');
  assert.equal(body.rows.length, 1);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(aiCalls.length, 1);
  const req = aiCalls[0];
  assert.equal(req.url, '/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-test');
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.equal(req.body.messages[0].content[1].type, 'image');
  assert.match(req.body.messages[0].content[2].text, /0112807-000/, 'hints are passed');
  assert.match(req.body.system, /Never invent/);
  assert.equal((await postJson('/api/extract', { pages: [] })).status, 400);
  assert.equal((await postJson('/api/extract', { pages: [{ mime: 'text/plain', base64: 'x' }] })).status, 400);
});

test('backup writes a JSON snapshot to R2', async () => {
  const res = await call('/api/backup', { method: 'POST', headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.key, /^backups\/\d{4}-\d{2}-\d{2}\.json$/);
  assert.ok(body.records >= 602);
  const bucket = await mf.getR2Bucket('FILES');
  const obj = await bucket.get(body.key);
  assert.ok(obj);
  const snap = JSON.parse(await obj.text());
  assert.equal(snap.format, 'ucm-inspection-server-backup');
});
