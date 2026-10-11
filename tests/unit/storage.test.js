import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORE_KEY, LEGACY_KEY, loadState, saveState, normalizeTemplate, normalizeReport, migrateV1,
  buildBackup, parseBackup, mergeBackup, emptyState, MAX_TEMPLATES,
} from '../../src/storage.js';
import { createReport, defaultTemplate, requirementText, featureLimits } from '../../src/core.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
}

// A realistic document written by the v1 prototype (index.html at eb2ac08).
const V1_DOC = {
  version: 1,
  activeId: 'tpl-1',
  templates: [{
    id: 'tpl-1', name: 'Starter template',
    company: { name: 'UCM Technologies', tagline: 'Tag', footer: 'Footer', logo: 'data:image/png;base64,iVBORw0KGgo=' },
    defaults: { reportNo: '', productionOrder: '', customer: 'Acme', quantity: '', purchaseOrder: '', catalogNo: 'CAT-1', partNo: 'P-9', partName: 'Bracket', revision: 'B', inspector: 'Dana', inspectionDate: '', generalTolerance: '+/-0.1', aql: '2.5', inspectionLevel: 'II', accepted: '', rejected: '' },
    keep: { reportNo: false, productionOrder: false, customer: false, quantity: true, purchaseOrder: false, catalogNo: true, partNo: true, partName: true, revision: true, inspector: true, inspectionDate: false, generalTolerance: true, aql: true, inspectionLevel: true, accepted: false, rejected: false },
    features: [
      { id: 'f1', kind: 'numeric', required: '25.00', nominal: '25', minus: '0.1', plus: '0.1', method: 'Caliper', unit: 'mm' },
      { id: 'f2', kind: 'numeric', required: '10 +0.05/0', nominal: '10', minus: '0', plus: '0.05', method: 'Pins', unit: 'mm' },
      { id: 'f3', kind: 'gauge', required: 'M8x1.25', nominal: '', minus: '', plus: '', method: 'Thread plug gauge', unit: '' },
      { id: 'f4', kind: 'numeric', required: '30.00', nominal: '35', minus: '0.1', plus: '0.1', method: 'Caliper', unit: 'mm' },
    ],
  }],
  report: {
    header: { reportNo: 'R-1', productionOrder: 'PO-7', customer: 'Acme', quantity: '60', purchaseOrder: '', catalogNo: 'CAT-1', partNo: 'P-9', partName: 'Bracket', revision: 'B', inspector: 'Dana', inspectionDate: '2026-10-01', generalTolerance: '+/-0.1', aql: '2.5', inspectionLevel: 'II', accepted: '', rejected: '' },
    measurements: { f1: { min: '24.95', max: '25.05', outcome: '' }, f2: { min: '', max: '', outcome: '' }, f3: { min: '', max: '', outcome: 'pass' }, f4: { min: '35', max: '35', outcome: '' } },
    remarks: 'hello', createdAt: '2026-10-01T10:00:00.000Z',
  },
};

test('fresh storage yields the starter state', () => {
  const s = loadState(new MemoryStorage());
  assert.equal(s.version, 2);
  assert.equal(s.templates.length, 1);
  assert.equal(s.draft, null);
  assert.deepEqual(s.archive, []);
});

test('v1 prototype data is migrated without loss, and the Required/Nominal contradiction becomes visible', () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_KEY, JSON.stringify(V1_DOC));
  const s = loadState(storage);
  assert.equal(s.settings.migratedFromV1, true);
  const t = s.templates[0];
  assert.equal(t.id, 'tpl-1');
  assert.equal(t.company.logo, 'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(t.fields.customer.mode, 'default'); assert.equal(t.fields.customer.value, 'Acme');
  assert.equal(t.fields.partNo.mode, 'fixed'); assert.equal(t.fields.partNo.value, 'P-9');
  assert.equal(t.fields.quantity.mode, 'blank', 'v1 "keep quantity" (which locked the field empty forever) is dropped');
  assert.equal(t.fields.aql.value, '2.5');
  const [f1, f2, f3, f4] = t.features;
  assert.equal(f1.kind, 'numeric'); assert.equal(f1.nominal, '25'); assert.equal(f1.symmetric, true); assert.equal(f1.upper, '0.1'); assert.equal(f1.label, '');
  assert.equal(requirementText(f1), '25.0 ±0.1');
  assert.equal(f2.symmetric, false); assert.equal(f2.upper, '0.05'); assert.equal(f2.lower, '0');
  assert.deepEqual([featureLimits(f2).min, featureLimits(f2).max], [10, 10.05]);
  assert.equal(f3.kind, 'gauge'); assert.equal(f3.label, 'M8x1.25');
  // f4: the old "Required" said 30.00 but the nominal was 35. The migrated row keeps the old text as a
  // label and note so the author sees "30.00 35.0 ±0.1" and must fix it; the verdict follows the nominal.
  assert.equal(f4.label, '30.00');
  assert.match(f4.note, /Migrated/);
  assert.equal(requirementText(f4), '30.00 35.0 ±0.1');
  // draft
  assert.ok(s.draft);
  assert.equal(s.draft.header.reportNo, 'R-1');
  assert.equal(s.draft.header.quantity, '60');
  assert.equal(s.draft.results.f1.min, '24.95');
  assert.equal(s.draft.results.f3.outcome, 'pass');
  assert.equal(s.draft.remarks, 'hello');
  // v1 key is left untouched for rollback
  assert.ok(storage.getItem(LEGACY_KEY));
});

test('v2 state round-trips and survives garbage', () => {
  const storage = new MemoryStorage();
  const s = emptyState();
  s.draft = createReport(s.templates[0]);
  s.draft.results[s.draft.features[0].id].min = '1';
  s.archive.push(createReport(s.templates[0]));
  saveState(storage, s);
  const back = loadState(storage);
  assert.deepEqual(back, s);
  storage.setItem(STORE_KEY, '{not json');
  assert.equal(loadState(storage).templates.length, 1);
  storage.setItem(STORE_KEY, JSON.stringify({ version: 2, templates: [{ bogus: true }, null, 5] }));
  const recovered = loadState(storage);
  assert.equal(recovered.templates.length, 1, 'broken templates are skipped and a starter is provided');
});

test('normalizeTemplate clamps and sanitises', () => {
  const t = normalizeTemplate({
    id: 'x', name: 'N'.repeat(500), company: { logo: 'javascript:alert(1)', name: '<b>co</b>' },
    numbering: { mode: 'weird', next: -3, width: 99, prefix: 'P' },
    fields: { customer: { mode: 'nope', value: 'v' }, quantity: { mode: 'fixed', value: '5' }, inspectionLevel: { mode: 'fixed', value: 'IV' } },
    features: [{ kind: 'gauge', label: 'G', nominal: '5', unit: 'mm' }, { kind: 'numeric', unit: 'furlong', symmetric: false, id: 'dup' }, { id: 'dup' }],
  });
  assert.equal(t.name.length, 120);
  assert.equal(t.company.logo, '');
  assert.equal(t.company.name, '<b>co</b>', 'escaping happens at render time, not in storage');
  assert.deepEqual(t.numbering, { mode: 'auto', prefix: 'P', next: 1, width: 8 });
  assert.equal(t.fields.customer.mode, 'carry', 'unknown mode falls back to the default policy');
  assert.equal(t.fields.quantity.mode, 'blank', 'non-lockable fields cannot be fixed');
  assert.equal(t.fields.inspectionLevel.value, 'II');
  assert.equal(t.features[0].nominal, '', 'gauge rows carry no numeric limits');
  assert.equal(t.features[0].unit, '');
  assert.equal(t.features[1].unit, 'mm');
  assert.equal(t.features[1].symmetric, false);
  assert.notEqual(t.features[1].id, t.features[2].id, 'duplicate feature ids are repaired');
  assert.throws(() => normalizeTemplate({ features: 'nope' }));
  assert.throws(() => normalizeReport({ header: {} }));
});

test('backup export, parse, merge (nothing is deleted on import)', () => {
  const s = emptyState();
  const t2 = { ...defaultTemplate(), id: 't2', name: 'Second' };
  s.templates.push(t2);
  s.draft = createReport(s.templates[0]);
  s.archive.push({ ...createReport(s.templates[0]), id: 'r1', createdAt: '2026-01-01T00:00:00.000Z' });
  const text = JSON.stringify(buildBackup(s));
  const parsed = parseBackup(text);
  assert.equal(parsed.templates.length, 2);
  assert.equal(parsed.archive.length, 1);
  assert.ok(parsed.draft);
  const other = emptyState();
  other.archive.push({ ...createReport(other.templates[0]), id: 'local-1', createdAt: '2026-02-01T00:00:00.000Z' });
  const { state, counts } = mergeBackup(other, parsed);
  assert.deepEqual(counts, { addedTemplates: 2, updatedTemplates: 0, addedReports: 1, updatedReports: 0, addedProducts: 0, updatedProducts: 0 });
  assert.equal(state.templates.length, 3);
  assert.equal(state.archive.length, 2);
  assert.equal(state.archive[0].id, 'local-1', 'newest first');
  assert.equal(state.draft, parsed.draft, 'an imported draft fills an empty draft slot only');
  const again = mergeBackup(state, parsed);
  assert.deepEqual(again.counts, { addedTemplates: 0, updatedTemplates: 2, addedReports: 0, updatedReports: 1, addedProducts: 0, updatedProducts: 0 });
  const noReports = buildBackup(s, { includeReports: false });
  assert.deepEqual(noReports.archive, []); assert.equal(noReports.draft, null);
  assert.throws(() => parseBackup('{"format":"x"}'));
  assert.throws(() => parseBackup('[]'));
  assert.throws(() => parseBackup('x'.repeat(13 * 1024 * 1024)));
});

test('v1 template-only export file is accepted as a legacy backup', () => {
  const legacy = JSON.stringify({ format: 'ucm-inspection-templates', version: 1, templates: V1_DOC.templates, activeId: 'tpl-1' });
  const parsed = parseBackup(legacy);
  assert.equal(parsed.legacy, true);
  assert.equal(parsed.templates[0].features[1].lower, '0');
});

test('template cap is enforced on merge', () => {
  const s = emptyState();
  const many = { templates: Array.from({ length: MAX_TEMPLATES + 5 }, (_, i) => ({ ...defaultTemplate(), id: 'm' + i })), archive: [], draft: null };
  const { state } = mergeBackup(s, many);
  assert.equal(state.templates.length, MAX_TEMPLATES);
});
