import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDecimal, parseMeasurement, decimalsOf, formatNumber, featureLimits, requirementText, limitsText, printedRequired, printedTolerances,
  featureProblems, evaluateFeature, summarize, createReport, syncReportWithProduct, blankProduct, findProduct, productKey, productRevisions,
  reportHasContent, headerWarnings, reportStatus, reportSampling, blankFeature, formatDateForReport, HEADER_KEYS, PRODUCT_FIELDS,
} from '../../src/core.js';

const numeric = (over = {}) => ({ ...blankFeature('numeric'), nominal: '25.00', upper: '0.10', lower: '', symmetric: true, ...over });
function sampleProduct() {
  const p = blankProduct();
  Object.assign(p, { partNo: 'MM606207C', revision: 'C', partName: 'Locker VG', catalogNo: 'MM606207C', customer: 'Atena Ltd.', generalTolerance: '±0.1', aql: '2.5', inspectionLevel: 'II' });
  p.features = [
    numeric({ label: 'Ø', nominal: '30', upper: '0.1', method: 'Caliper' }),
    numeric({ nominal: '20', upper: '0.03', lower: '0', symmetric: false, method: 'Pins' }),
    { ...blankFeature('gauge'), label: 'M16x2', method: 'Thread plug gage' },
  ];
  return p;
}

test('parseDecimal / parseMeasurement', () => {
  assert.equal(parseDecimal('25'), 25);
  assert.equal(parseDecimal('-0.05'), -0.05);
  assert.equal(parseDecimal('+0.1'), 0.1);
  assert.equal(parseDecimal('0,05'), 0.05);
  assert.equal(parseDecimal('.1'), 0.1);
  assert.equal(parseDecimal(''), null);
  assert.ok(Number.isNaN(parseDecimal('abc')));
  assert.ok(Number.isNaN(parseDecimal('1e3')));
  assert.ok(Number.isNaN(parseDecimal('0x10')));
  assert.equal(parseMeasurement('25.03'), 25.03);
  assert.equal(parseMeasurement('25,03'), 25.03);
  assert.equal(parseMeasurement('Ø25.03'), 25.03);
  assert.equal(parseMeasurement('R5.1'), 5.1);
  assert.equal(parseMeasurement('30°'), 30);
  assert.equal(parseMeasurement('12.5 mm'), 12.5);
  assert.equal(parseMeasurement('.5'), 0.5);
  assert.equal(parseMeasurement(''), null);
  assert.equal(parseMeasurement('   '), null);
  assert.ok(Number.isNaN(parseMeasurement('25.0.1')));
  assert.ok(Number.isNaN(parseMeasurement('ok')));
  assert.equal(decimalsOf('25.00'), 2);
  assert.equal(decimalsOf('25'), 0);
  assert.equal(formatNumber(24.9, 2), '24.90');
  assert.equal(formatNumber(-0.0000001, 2), '0.00');
});

test('featureLimits: symmetric, asymmetric, unilateral, shifted', () => {
  assert.deepEqual(featureLimits(numeric()), { ok: true, nominal: 25, upper: 0.1, lower: -0.1, min: 24.9, max: 25.1, decimals: 2 });
  const uni = numeric({ nominal: '10', upper: '0.05', lower: '0', symmetric: false });
  assert.deepEqual(featureLimits(uni), { ok: true, nominal: 10, upper: 0.05, lower: 0, min: 10, max: 10.05, decimals: 2 });
  const shifted = numeric({ nominal: '20', upper: '0.10', lower: '0.05', symmetric: false });
  const lim = featureLimits(shifted);
  assert.ok(lim.ok); assert.equal(lim.min, 20.05); assert.equal(lim.max, 20.1);
  const neg = numeric({ nominal: '20', upper: '-0.02', lower: '-0.05', symmetric: false });
  assert.ok(featureLimits(neg).ok); assert.equal(featureLimits(neg).min, 19.95); assert.equal(featureLimits(neg).max, 19.98);
  assert.equal(featureLimits(numeric({ nominal: '20', upper: '-0.05', lower: '-0.02', symmetric: false })).reason, 'inverted');
  assert.equal(featureLimits(numeric({ upper: '-0.1' })).reason, 'negative-symmetric');
  assert.equal(featureLimits(numeric({ nominal: '' })).reason, 'missing');
  assert.equal(featureLimits(numeric({ nominal: 'abc' })).reason, 'invalid');
  assert.equal(featureLimits(numeric({ upper: '' })).reason, 'missing');
  assert.equal(featureLimits({ ...blankFeature('gauge') }).reason, 'not-numeric');
});

test('printed Required / TOL cells follow the original form notation', () => {
  // Required holds the nominal as written on the drawing; the tolerance goes to TOL-/TOL+
  assert.equal(printedRequired(numeric({ label: 'Ø', nominal: '30', upper: '0.1' })), 'Ø30');
  assert.deepEqual(printedTolerances(numeric({ nominal: '30', upper: '0.1' })), { minus: '0.1', plus: '0.1' });
  assert.equal(printedRequired(numeric({ label: 'R', nominal: '26' })), 'R26');
  assert.equal(printedRequired(numeric({ nominal: '4.33', suffix: 'x 60°' })), '4.33 x 60°');
  assert.equal(printedRequired(numeric({ nominal: '7.50', suffix: '(x3)' })), '7.50 (x3)');
  assert.equal(printedRequired(numeric({ nominal: '90', unit: 'deg' })), '90°');
  assert.equal(printedRequired(numeric({ label: 'Depth', nominal: '5' })), 'Depth 5');
  assert.equal(printedRequired({ ...blankFeature('gauge'), label: 'M16x2' }), 'M16x2');
  assert.deepEqual(printedTolerances({ ...blankFeature('gauge'), label: 'M16x2' }), { minus: '', plus: '' });
  // "20 0 +0.03" on the form: TOL- 0, TOL+ 0.03
  assert.deepEqual(printedTolerances(numeric({ nominal: '20', upper: '0.03', lower: '0', symmetric: false })), { minus: '0', plus: '0.03' });
  assert.deepEqual(printedTolerances(numeric({ nominal: '20', upper: '.1', lower: '-.1', symmetric: false })), { minus: '0.1', plus: '0.1' });
  // Unusual signs stay visible so the cell can never be misread
  assert.deepEqual(printedTolerances(numeric({ nominal: '20', upper: '0.10', lower: '0.05', symmetric: false })), { minus: '+0.05', plus: '0.10' });
  assert.deepEqual(printedTolerances(numeric({ nominal: '20', upper: '-0.02', lower: '-0.05', symmetric: false })), { minus: '0.05', plus: '-0.02' });
});

test('requirementText is derived from the structured fields (cannot contradict the limits)', () => {
  assert.equal(requirementText(numeric()), '25.00 ±0.10');
  assert.equal(requirementText(numeric({ label: 'Ø' })), 'Ø25.00 ±0.10');
  assert.equal(requirementText(numeric({ nominal: '10', upper: '0.05', lower: '0', symmetric: false })), '10 +0.05 / 0');
  assert.equal(requirementText(numeric({ nominal: '20', upper: '0.1', lower: '0.05', symmetric: false })), '20 +0.1 / +0.05');
  assert.equal(requirementText(numeric({ nominal: '20', upper: '-0.02', lower: '-0.05', symmetric: false })), '20 -0.02 / -0.05');
  assert.equal(requirementText(numeric({ nominal: '45', upper: '0', unit: 'deg' })), '45° ±0');
  assert.equal(requirementText({ ...blankFeature('gauge'), label: 'M8x1.25-6H' }), 'M8x1.25-6H');
  assert.equal(limitsText(numeric()), '24.90 – 25.10');
  // Invalid configuration still prints what the author typed, never a fabricated limit
  assert.equal(requirementText(numeric({ label: 'Depth', nominal: '5', upper: '' })), 'Depth 5');
  assert.equal(limitsText(numeric({ upper: '' })), '');
});

test('featureProblems', () => {
  assert.deepEqual(featureProblems(numeric()), []);
  assert.deepEqual(featureProblems(numeric({ upper: 'x' })), ['invalid']);
  assert.deepEqual(featureProblems({ ...blankFeature('gauge') }), ['label']);
  assert.deepEqual(featureProblems({ ...blankFeature('gauge'), label: 'M6' }), []);
});

test('evaluateFeature: numeric verdicts', () => {
  const f = numeric();
  assert.equal(evaluateFeature(f, { min: '24.90', max: '25.10' }).state, 'ok');
  assert.equal(evaluateFeature(f, { min: '24.89', max: '25.10' }).state, 'fail');
  assert.equal(evaluateFeature(f, { min: '24.89', max: '25.10' }).reason, 'below-min');
  assert.equal(evaluateFeature(f, { min: '24.90', max: '25.11' }).reason, 'above-max');
  assert.equal(evaluateFeature(f, { min: '25.5', max: '25.5' }).state, 'fail');
  assert.equal(evaluateFeature(f, { min: '', max: '' }).state, 'empty');
  assert.equal(evaluateFeature(f, undefined).state, 'empty');
  assert.equal(evaluateFeature(f, { min: '25', max: '' }).state, 'review');
  assert.equal(evaluateFeature(f, { min: '25', max: '' }).reason, 'min-max-required');
  assert.equal(evaluateFeature(f, { min: 'abc', max: '25' }).state, 'review');
  const inverted = evaluateFeature(f, { min: '25.1', max: '24.9' });
  assert.equal(inverted.state, 'review'); assert.equal(inverted.reason, 'min-above-max');
  assert.equal(evaluateFeature(numeric({ upper: '' }), { min: '25', max: '25' }).state, 'review');
  assert.equal(evaluateFeature(numeric({ nominal: 'x' }), { min: '25', max: '25' }).state, 'review');
  assert.equal(evaluateFeature(numeric({ nominal: '0.3', upper: '0.1' }), { min: '0.2', max: '0.4' }).state, 'ok');
  assert.equal(evaluateFeature(numeric({ nominal: '1.1', upper: '0.1' }), { min: '1.0', max: '1.2' }).state, 'ok');
  assert.equal(evaluateFeature(f, { min: '24,95', max: 'Ø25.05' }).state, 'ok');
});

test('evaluateFeature: gauge rows', () => {
  const g = { ...blankFeature('gauge'), label: 'M8' };
  assert.equal(evaluateFeature(g, { outcome: '' }).state, 'empty');
  assert.equal(evaluateFeature(g, { outcome: 'pass' }).state, 'manual-pass');
  assert.equal(evaluateFeature(g, { outcome: 'fail' }).state, 'fail');
  assert.equal(evaluateFeature(g, { outcome: 'maybe' }).state, 'review');
  assert.equal(evaluateFeature(g, { min: '8', max: '8', outcome: '' }).state, 'empty');
});

test('products: key, lookup, revisions', () => {
  const a = sampleProduct();
  const b = { ...sampleProduct(), revision: 'D' };
  assert.equal(productKey(' mm606207c ', 'Rev. c'), 'MM606207C@C');
  assert.equal(findProduct([a, b], 'mm606207c', 'c'), a);
  assert.equal(findProduct([a, b], 'MM606207C', 'B'), null);
  assert.deepEqual(productRevisions([a, b], 'MM606207C').map(p => p.revision), ['D', 'C']);
  assert.deepEqual(PRODUCT_FIELDS, ['partNo', 'revision', 'partName', 'catalogNo', 'customer', 'generalTolerance', 'aql', 'inspectionLevel']);
});

test('createReport: product fields, features and the inspector carry over; order fields start empty', () => {
  const p = sampleProduct();
  const first = createReport(p, null, new Date(2026, 9, 11));
  assert.equal(first.header.partNo, 'MM606207C');
  assert.equal(first.header.revision, 'C');
  assert.equal(first.header.customer, 'Atena Ltd.');
  assert.equal(first.header.aql, '2.5');
  assert.equal(first.header.inspectionLevel, 'II');
  assert.equal(first.header.generalTolerance, '±0.1');
  assert.equal(first.header.inspectionDate, '2026-10-11');
  assert.equal(first.header.reportNo, '');
  assert.equal(first.header.quantity, '');
  assert.equal(first.productId, p.id);
  assert.equal(first.productKey, 'MM606207C@C');
  assert.equal(first.features.length, 3);
  assert.equal(Object.keys(first.results).length, 3);
  assert.equal(reportHasContent(first), false, 'a fresh report is not content');
  first.header.inspector = 'Yuri S.'; first.header.quantity = '250'; first.header.reportNo = '9515_2';
  assert.equal(reportHasContent(first), true);
  const second = createReport(p, first);
  assert.equal(second.header.inspector, 'Yuri S.', 'the inspector carries over');
  assert.equal(second.header.quantity, '', 'lot data never carries');
  assert.equal(second.header.reportNo, '');
  assert.notEqual(second.id, first.id);
  const none = createReport(null);
  assert.equal(none.features.length, 0);
  assert.equal(none.header.inspectionLevel, 'II');
  for (const key of HEADER_KEYS) assert.ok(key in none.header);
});

test('syncReportWithProduct keeps results by id, drops removed rows, adds new rows, refreshes product fields', () => {
  const p = sampleProduct();
  const r = createReport(p);
  const keep = p.features[0].id;
  r.results[keep] = { min: '1', max: '2', outcome: '', note: '' };
  p.features = [p.features[0], numeric({ nominal: '5', upper: '0.1' })];
  p.partName = 'Renamed';
  const synced = syncReportWithProduct(r, p);
  assert.equal(synced.features.length, 2);
  assert.deepEqual(synced.results[keep], { min: '1', max: '2', outcome: '', note: '' });
  assert.deepEqual(synced.results[p.features[1].id], { min: '', max: '', outcome: '', note: '' });
  assert.equal(synced.header.partName, 'Renamed');
  assert.equal(r.features.length, 3, 'original report not mutated');
});

test('summarize, reportStatus and sampling', () => {
  const p = sampleProduct();
  const r = createReport(p);
  assert.equal(summarize(r.features, r.results).status, 'incomplete');
  r.results[r.features[0].id] = { min: '29.95', max: '30.04', outcome: '' };
  r.results[r.features[1].id] = { min: '20.01', max: '20.027', outcome: '' };
  r.results[r.features[2].id] = { min: '', max: '', outcome: 'pass' };
  assert.equal(reportStatus(r), 'pass');
  r.results[r.features[0].id].max = '30.2';
  assert.equal(reportStatus(r), 'fail');
  // Lot 250, AQL 2.5, level II -> code G, n = 32 (as printed on the original report)
  r.header.quantity = '250';
  const { plan } = reportSampling(r);
  assert.equal(plan.sampleSize, 32);
  assert.equal(plan.plan.letter, 'G');
  r.header.quantity = '';
  assert.equal(reportSampling(r).plan, null);
});

test('headerWarnings', () => {
  const r = createReport(sampleProduct());
  r.header.quantity = '100'; r.header.accepted = '90'; r.header.rejected = '20';
  assert.ok(headerWarnings(r).includes('counts-exceed-lot'));
  r.header.rejected = '5'; r.header.accepted = 'x';
  assert.ok(headerWarnings(r).includes('counts-invalid'));
  r.header.accepted = ''; r.header.quantity = '12.5';
  assert.ok(headerWarnings(r).includes('quantity-invalid'));
  r.header.quantity = '100'; r.header.inspectionDate = '11/10/2026';
  assert.ok(headerWarnings(r).includes('date-invalid'));
  r.header.inspectionDate = '2026-10-11';
  assert.deepEqual(headerWarnings(r), []);
});

test('formatDateForReport prints dd/mm/yy like the original form', () => {
  assert.equal(formatDateForReport('2023-09-06'), '06/09/23');
  assert.equal(formatDateForReport('2026-04-20'), '20/04/26');
  assert.equal(formatDateForReport(''), '');
  assert.equal(formatDateForReport('garbage'), 'garbage');
});
