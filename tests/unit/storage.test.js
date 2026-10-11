import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORE_KEY, loadState, saveState, normalizeProduct, normalizeReport, normalizeFeature,
  buildBackup, parseBackup, mergeBackup, emptyState, MAX_PRODUCTS,
} from '../../src/storage.js';
import { createReport, blankProduct, blankFeature } from '../../src/core.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
}
function product(over = {}) {
  const p = blankProduct();
  Object.assign(p, { partNo: 'P-1', revision: 'A', features: [{ ...blankFeature('numeric'), nominal: '10', upper: '0.1' }] }, over);
  return p;
}

test('fresh storage yields an empty state', () => {
  const s = loadState(new MemoryStorage());
  assert.equal(s.version, 2);
  assert.equal(s.draft, null);
  assert.deepEqual(s.archive, []);
  assert.deepEqual(s.products, []);
  assert.equal(s.settings.autoAi, true);
});

test('state round-trips and survives garbage; leftovers from the template era are ignored', () => {
  const storage = new MemoryStorage();
  const s = emptyState();
  s.products.push(product());
  s.draft = createReport(s.products[0]);
  s.draft.results[s.draft.features[0].id].min = '1';
  s.archive.push(createReport(s.products[0]));
  saveState(storage, s);
  assert.deepEqual(loadState(storage), s);
  storage.setItem(STORE_KEY, '{not json');
  assert.deepEqual(loadState(storage).products, []);
  storage.setItem(STORE_KEY, JSON.stringify({ version: 2, templates: [{ id: 't' }], activeTemplateId: 't', products: [{ bogus: true }, null, product()], archive: [{ header: {}, features: [] }, 5], settings: { dirty: { 'template:t': true, 'product:x': true }, deleted: { 'template:t': '2026-01-01' } } }));
  const recovered = loadState(storage);
  assert.equal(recovered.products.length, 1, 'broken products are skipped');
  assert.equal(recovered.archive.length, 1);
  assert.equal('templates' in recovered, false);
  assert.deepEqual(recovered.settings.dirty, { 'product:x': true });
  assert.deepEqual(recovered.settings.deleted, {});
});

test('normalizeProduct / normalizeFeature clamp and sanitise', () => {
  const p = normalizeProduct({
    id: 'x', partNo: ' p-9 ', revision: 'B', inspectionLevel: 'IV', aql: '2.5',
    features: [{ kind: 'gauge', label: 'G', nominal: '5', unit: 'mm' }, { kind: 'numeric', unit: 'furlong', symmetric: false, id: 'dup' }, { id: 'dup' }, { kind: 'visual', label: 'Deburr' }],
  });
  assert.equal(p.partNo, 'p-9');
  assert.equal(p.inspectionLevel, 'II', 'unknown level falls back to II');
  assert.equal(p.features[0].nominal, '', 'gauge rows carry no numeric limits');
  assert.equal(p.features[0].unit, '');
  assert.equal(p.features[1].unit, 'mm');
  assert.equal(p.features[1].symmetric, false);
  assert.notEqual(p.features[1].id, p.features[2].id, 'duplicate feature ids are repaired');
  assert.equal(p.features[3].kind, 'gauge', 'old visual rows become attribute rows');
  assert.throws(() => normalizeProduct({ features: 'nope' }));
  assert.throws(() => normalizeFeature(null));
  assert.throws(() => normalizeReport({ header: {} }));
  const r = normalizeReport({ header: { partNo: 'P', inspectionLevel: 'bogus' }, features: [{ id: 'f', kind: 'numeric', nominal: '1', upper: '0.1' }], results: { f: { min: '1', max: '2', outcome: 'weird' } }, templateId: 'old' });
  assert.equal(r.header.inspectionLevel, 'II');
  assert.equal(r.results.f.outcome, '');
  assert.equal('templateId' in r, false);
});

test('backup export, parse, merge (nothing is deleted on import)', () => {
  const s = emptyState();
  s.products.push(product({ id: 'p1', updatedAt: '2026-05-01T00:00:00.000Z' }));
  s.draft = createReport(s.products[0]);
  s.archive.push({ ...createReport(s.products[0]), id: 'r1', createdAt: '2026-01-01T00:00:00.000Z' });
  const text = JSON.stringify(buildBackup(s));
  const parsed = parseBackup(text);
  assert.equal(parsed.products.length, 1);
  assert.equal(parsed.archive.length, 1);
  assert.ok(parsed.draft);
  const other = emptyState();
  other.products.push(product({ id: 'p1', partName: 'newer', updatedAt: '2026-06-01T00:00:00.000Z' }));
  other.archive.push({ ...createReport(other.products[0]), id: 'local-1', createdAt: '2026-02-01T00:00:00.000Z' });
  const { state, counts } = mergeBackup(other, parsed);
  assert.deepEqual(counts, { addedReports: 1, updatedReports: 0, addedProducts: 0, updatedProducts: 0 });
  assert.equal(state.products[0].partName, 'newer', 'an older copy never overwrites a newer product');
  assert.equal(state.archive.length, 2);
  assert.equal(state.archive[0].id, 'local-1', 'newest first');
  assert.equal(state.draft, other.draft || parsed.draft);
  const again = mergeBackup(state, parsed);
  assert.deepEqual(again.counts, { addedReports: 0, updatedReports: 1, addedProducts: 0, updatedProducts: 0 });
  assert.throws(() => parseBackup('{"format":"x"}'));
  assert.throws(() => parseBackup('[]'));
  assert.throws(() => parseBackup('x'.repeat(13 * 1024 * 1024)));
});

test('product cap is enforced on merge', () => {
  const s = emptyState();
  const many = { products: Array.from({ length: MAX_PRODUCTS + 5 }, (_, i) => product({ id: 'm' + i })), archive: [], draft: null };
  const { state } = mergeBackup(s, many);
  assert.equal(state.products.length, MAX_PRODUCTS);
});
