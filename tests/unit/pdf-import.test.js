import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPdfPages } from '../helpers/pdf-pages.js';
import { buildImportDraft, interpretRequirement, interpretResult, parseDateText, fixGlyphs, draftToProduct } from '../../src/pdf-import.js';
import { requirementText, featureLimits, evaluateFeature, productKey } from '../../src/core.js';

const FIX = path.join(process.cwd(), 'tests', 'fixtures');
const load = name => loadPdfPages(fs.readFileSync(path.join(FIX, name)));

test('real report MM606207C rev C: header and all 12 rows are recovered from the text layer', async () => {
  const draft = buildImportDraft(await load('report-MM606207C-C.pdf'));
  const v = k => draft.fields[k].value;
  assert.equal(draft.pageCount, 2); assert.equal(draft.expectedPages, 2); assert.equal(draft.missingPages, false);
  assert.equal(v('reportNo'), '9515_2');
  assert.equal(v('partNo'), 'MM606207C');
  assert.equal(v('catalogNo'), 'MM606207C');
  assert.equal(v('revision'), 'C');
  assert.equal(v('partName'), 'Locker VG');
  assert.equal(v('customer'), 'Atena Ltd.');
  assert.equal(v('quantity'), '250');
  assert.equal(v('purchaseOrder'), 'PO23000834 PO24000075');
  assert.equal(v('productionOrder'), '0');
  assert.equal(v('aql'), '2.5');
  assert.equal(v('sampleSize'), '32');
  assert.equal(v('accepted'), '32');
  assert.equal(v('rejected'), '0');
  assert.equal(v('generalTolerance'), '±0.1');
  assert.equal(v('inspector'), 'YURI S.');
  assert.equal(v('inspectionDate'), '2023-09-06');
  assert.equal(draft.features.length, 12);
  assert.deepEqual(draft.features.map(f => f.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const rows = draft.features.map(f => [requirementText(f.feature), f.feature.kind, f.feature.method, f.result.min, f.result.max, f.result.outcome]);
  assert.deepEqual(rows, [
    ['4.33 ±0.10 x 60°', 'numeric', 'Comperator', '4.24', '4.38', ''],
    ['Ø 30.0 ±0.1', 'numeric', 'Caliper', '29.95', '30.04', ''],
    ['R 26.0 ±0.1', 'numeric', 'XYZ cmm', '25.97', '25.99', ''],
    ['34.0 ±0.1', 'numeric', 'Caliper', '33.94', '34.05', ''],
    ['M16x2', 'gauge', 'Thread pluge gage', '', '', 'pass'],
    ['5.1 ±0.1 x 30°', 'numeric', 'Comperator', '5.04', '5.13', ''],
    ['7.50 ±0.10 x 30°', 'numeric', 'Comperator', '7.45', '7.54', ''],
    ['20.00 +0.03 / 0.00', 'numeric', 'Pins', '20.01', '20.027', ''],
    ['90 ?', 'numeric', 'XYZ cmm', '89.95', '90.08', ''].map((x, i) => i === 0 ? '90' : x),
    ['3.60 ±0.10', 'numeric', 'Cutting Part + Comperator', '3.54', '3.67', ''],
    ['7.50 ±0.10 (x3)', 'numeric', 'Height Gauge', '7.48', '7.53', ''],
    ['M2 Thru (x3)', 'gauge', 'Thread pluge gage', '', '', 'pass'],
  ]);
  // The 90° row has no tolerance on the form: it must be flagged, never silently assumed
  const angle = draft.features[8];
  assert.equal(angle.feature.unit, 'deg'); assert.equal(angle.needsReview, true); assert.ok(angle.reasons.includes('tolerance-missing'));
  assert.equal(featureLimits(angle.feature).ok, false);
  // Rows that were fully understood are not flagged
  assert.equal(draft.features[1].needsReview, false);
  assert.equal(draft.features[7].needsReview, false);
  // Verdicts recomputed from the imported numbers agree with the original report (all within limits)
  for (const i of [1, 2, 3, 7, 9]) assert.equal(evaluateFeature(draft.features[i].feature, draft.features[i].result).state, 'ok', 'row ' + (i + 1));
  // Row 8: 20 +0.03/0 measured 20.01..20.027 -> ok; a value of 20.04 would fail
  assert.equal(evaluateFeature(draft.features[7].feature, { min: '20.01', max: '20.04' }).state, 'fail');
  // Every row carries a source rectangle on the right page for the review UI
  assert.ok(draft.features.every(f => f.source && f.source.rect && f.source.rect.h > 10));
  assert.equal(draft.features[9].source.page, 1, 'row 10 is on page 2');
  const product = draftToProduct(draft);
  assert.equal(productKey(product.partNo, product.revision), 'MM606207C@C');
  assert.equal(product.features.length, 12);
  assert.equal(product.sourceReportNo, '9515_2');
});

test('real report 0112807-000 rev AB: 15 rows across two pages; image-only Required cells are flagged for review', async () => {
  const draft = buildImportDraft(await load('report-0112807-000-AB.pdf'));
  const v = k => draft.fields[k].value;
  assert.equal(v('reportNo'), '9195_2');
  assert.equal(v('partNo'), '0112807-000');
  assert.equal(v('revision'), 'AB');
  assert.equal(v('partName'), 'SCREWLOCK , FEM 2-56,SS, 612S');
  assert.equal(v('customer'), 'ג.ט. גבעסול טכנולוגיות בע"מ');
  assert.equal(v('quantity'), '200');
  assert.equal(v('purchaseOrder'), 'PO26001059');
  assert.equal(v('accepted'), '200');
  assert.equal(v('inspector'), 'Yuri s.');
  assert.equal(v('inspectionDate'), '2026-04-20');
  assert.equal(draft.features.length, 15);
  assert.deepEqual(draft.features.map(f => f.no), Array.from({ length: 15 }, (_, i) => i + 1));
  // Every Required cell is a picture on this form: all rows need confirmation and say why
  assert.ok(draft.features.every(f => f.needsReview && f.reasons.includes('image-cell')));
  assert.equal(draft.summary.reviewRows, 15);
  // Measured values and methods still come through
  assert.deepEqual(draft.features.slice(0, 3).map(f => [f.feature.method, f.result.min, f.result.max]), [['Pins', '0.66', '0.76'], ['Height Gauge', '0.47', '0.54'], ['Comperator', '8.52', '8.57']]);
  assert.deepEqual(draft.features[12].source.page, 1);
  // Checkmark-only rows become GO/NO-GO rows reported as pass
  assert.equal(draft.features[10].feature.kind, 'gauge'); assert.equal(draft.features[10].result.outcome, 'pass');
  assert.equal(draft.features[9].feature.kind, 'gauge'); assert.equal(draft.features[9].result.outcome, 'pass');
  // Row 15 was measured numerically (2.4 / 2.6) on a thread-gauge line: stays numeric, awaiting the nominal
  assert.equal(draft.features[14].feature.kind, 'numeric'); assert.equal(draft.features[14].result.min, '2.4');
  // A numeric row without a nominal can never pass
  assert.equal(evaluateFeature(draft.features[0].feature, draft.features[0].result).state, 'review');
});

test('interpretRequirement handles drawing notations', () => {
  const t = (req, tm, tp, m) => { const r = interpretRequirement(req, tm, tp, m); return [requirementText(r.feature), r.feature.kind, r.feature.unit, r.confidence >= 0.8, r.reasons.join(',')]; };
  assert.deepEqual(t('25', '0.1', '0.1', 'Caliper'), ['25.0 ±0.1', 'numeric', 'mm', true, '']);
  assert.deepEqual(t('Ø12.5', '.05', '.05', 'Micrometer'), ['Ø 12.50 ±0.05', 'numeric', 'mm', true, '']);
  assert.deepEqual(t('¡30', '0.1', '0.1', 'Caliper'), ['Ø 30.0 ±0.1', 'numeric', 'mm', true, '']);
  assert.deepEqual(t('20 0 + 0.03', '', '', 'Pins'), ['20.00 +0.03 / 0.00', 'numeric', 'mm', true, '']);
  assert.deepEqual(t('20 +0.03/0', '', '', 'Pins'), ['20.00 +0.03 / 0.00', 'numeric', 'mm', true, '']);
  assert.deepEqual(t('15 ±0.05', '', '', 'CMM'), ['15.00 ±0.05', 'numeric', 'mm', true, '']);
  assert.deepEqual(t('15 +/-0.05', '', '', 'CMM'), ['15.00 ±0.05', 'numeric', 'mm', true, '']);
  assert.deepEqual(t('10 +0.1 -0.05', '', '', 'CMM'), ['10.00 +0.10 / -0.05', 'numeric', 'mm', true, '']);
  assert.deepEqual(t('12', '0', '0.05', 'Pins'), ['12.00 +0.05 / 0.00', 'numeric', 'mm', true, '']);
  assert.deepEqual(t('12', '0.05', '0.1', 'Pins'), ['12.00 +0.10 / -0.05', 'numeric', 'mm', true, '']);
  assert.deepEqual(t('M8x1.25-6H', '', '', 'Thread plug gauge'), ['M8x1.25-6H', 'gauge', '', true, '']);
  assert.deepEqual(t('1/4-20 UNC', '', '', 'Thread gage'), ['1/4-20 UNC', 'gauge', '', true, '']);
  assert.deepEqual(t('2-56 UNC', '', '', 'Thread pluge gage'), ['2-56 UNC', 'gauge', '', true, '']);
  assert.deepEqual(t('45°', '', '', 'Protractor'), ['45', 'numeric', 'deg', false, 'tolerance-missing']);
  assert.deepEqual(t('45° ±1°', '', '', 'Protractor')[0], '45 ±1');
  assert.deepEqual(t('', '0.1', '0.1', 'Caliper'), ['? ±0.1', 'numeric', 'mm', false, 'nominal-missing']);
  assert.deepEqual(t('7.50 (x3)', '0.1', '0.1', 'Height Gauge'), ['7.50 ±0.10 (x3)', 'numeric', 'mm', false, 'composite']);
  assert.deepEqual(t('R5', '0.1', '0.1', 'Comparator'), ['R 5.0 ±0.1', 'numeric', 'mm', true, '']);
  // explicit tolerance in the text wins over the columns
  assert.deepEqual(t('30 ±0.02', '0.1', '0.1', 'CMM')[0], '30.00 ±0.02');
});

test('interpretResult, parseDateText, fixGlyphs', () => {
  assert.deepEqual(interpretResult('R25.97'), { value: '25.97', outcome: '' });
  assert.deepEqual(interpretResult('£'), { value: '', outcome: 'pass' });
  assert.deepEqual(interpretResult('✓'), { value: '', outcome: 'pass' });
  assert.deepEqual(interpretResult('X'), { value: '', outcome: 'fail' });
  assert.deepEqual(interpretResult('OK'), { value: '', outcome: 'pass' });
  assert.deepEqual(interpretResult('.5'), { value: '0.5', outcome: '' });
  assert.deepEqual(interpretResult(''), { value: '', outcome: '' });
  assert.equal(parseDateText('06/09/23'), '2023-09-06');
  assert.equal(parseDateText('20/4/26'), '2026-04-20');
  assert.equal(parseDateText('5.11.2025'), '2025-11-05');
  assert.equal(parseDateText('2026-10-11'), '2026-10-11');
  assert.equal(parseDateText('31/13/26'), '');
  assert.equal(fixGlyphs('¡30'), 'Ø30');
  assert.equal(fixGlyphs(' £ '), '✓');
});
