import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDecimal, parseMeasurement, decimalsOf, formatNumber, featureLimits, requirementText, limitsText,
  featureProblems, evaluateFeature, summarize, defaultTemplate, createReport, syncReportFeatures, isLocked,
  reportHasContent, headerWarnings, reportStatus, formatReportNo, blankFeature, formatDateForReport, HEADER_FIELDS,
} from '../../src/core.js';

const numeric = (over = {}) => ({ ...blankFeature('numeric'), nominal: '25.00', upper: '0.10', lower: '', symmetric: true, ...over });

test('parseDecimal / parseMeasurement', () => {
  assert.equal(parseDecimal('25'), 25);
  assert.equal(parseDecimal('-0.05'), -0.05);
  assert.equal(parseDecimal('+0.1'), 0.1);
  assert.equal(parseDecimal('0,05'), 0.05);
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
  // Shifted tolerance (both deviations positive), e.g. a shaft 20 +0.10/+0.05: the old model could not express this.
  const shifted = numeric({ nominal: '20', upper: '0.10', lower: '0.05', symmetric: false });
  const lim = featureLimits(shifted);
  assert.ok(lim.ok); assert.equal(lim.min, 20.05); assert.equal(lim.max, 20.1);
  // Both negative, e.g. hole 20 -0.02/-0.05
  const neg = numeric({ nominal: '20', upper: '-0.02', lower: '-0.05', symmetric: false });
  assert.ok(featureLimits(neg).ok); assert.equal(featureLimits(neg).min, 19.95); assert.equal(featureLimits(neg).max, 19.98);
  assert.equal(featureLimits(numeric({ nominal: '20', upper: '-0.05', lower: '-0.02', symmetric: false })).reason, 'inverted');
  assert.equal(featureLimits(numeric({ upper: '-0.1' })).reason, 'negative-symmetric');
  assert.equal(featureLimits(numeric({ nominal: '' })).reason, 'missing');
  assert.equal(featureLimits(numeric({ nominal: 'abc' })).reason, 'invalid');
  assert.equal(featureLimits(numeric({ upper: '' })).reason, 'missing');
  assert.equal(featureLimits({ ...blankFeature('gauge') }).reason, 'not-numeric');
});

test('requirementText is derived from the structured fields (cannot contradict the limits)', () => {
  assert.equal(requirementText(numeric()), '25.00 ±0.10');
  assert.equal(requirementText(numeric({ label: 'Ø' })), 'Ø 25.00 ±0.10');
  assert.equal(requirementText(numeric({ nominal: '10', upper: '0.05', lower: '0', symmetric: false })), '10.00 +0.05 / 0.00');
  assert.equal(requirementText(numeric({ nominal: '20', upper: '0.1', lower: '0.05', symmetric: false })), '20.00 +0.10 / +0.05');
  assert.equal(requirementText(numeric({ nominal: '20', upper: '-0.02', lower: '-0.05', symmetric: false })), '20.00 -0.02 / -0.05');
  assert.equal(requirementText(numeric({ nominal: '45', upper: '0', unit: 'deg' })), '45 ±0');
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
  assert.deepEqual(featureProblems({ ...blankFeature('visual'), label: 'Deburr' }), []);
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
  // min > max is a data-entry error, not an out-of-tolerance verdict
  const inverted = evaluateFeature(f, { min: '25.1', max: '24.9' });
  assert.equal(inverted.state, 'review'); assert.equal(inverted.reason, 'min-above-max');
  // A feature without valid limits never passes, even with numbers entered
  assert.equal(evaluateFeature(numeric({ upper: '' }), { min: '25', max: '25' }).state, 'review');
  assert.equal(evaluateFeature(numeric({ nominal: 'x' }), { min: '25', max: '25' }).state, 'review');
  // Floating point boundaries
  assert.equal(evaluateFeature(numeric({ nominal: '0.3', upper: '0.1' }), { min: '0.2', max: '0.4' }).state, 'ok');
  assert.equal(evaluateFeature(numeric({ nominal: '1.1', upper: '0.1' }), { min: '1.0', max: '1.2' }).state, 'ok');
  // Comma decimals and symbols in results
  assert.equal(evaluateFeature(f, { min: '24,95', max: 'Ø25.05' }).state, 'ok');
});

test('evaluateFeature: attribute kinds', () => {
  const g = { ...blankFeature('gauge'), label: 'M8' };
  assert.equal(evaluateFeature(g, { outcome: '' }).state, 'empty');
  assert.equal(evaluateFeature(g, { outcome: 'pass' }).state, 'manual-pass');
  assert.equal(evaluateFeature(g, { outcome: 'fail' }).state, 'fail');
  assert.equal(evaluateFeature(g, { outcome: 'maybe' }).state, 'review');
  // Numeric values entered against a gauge row are ignored, never a PASS
  assert.equal(evaluateFeature(g, { min: '8', max: '8', outcome: '' }).state, 'empty');
});

test('summarize and reportStatus', () => {
  const t = defaultTemplate();
  const r = createReport(t);
  assert.equal(summarize(r.features, r.results).status, 'incomplete');
  r.features.forEach(f => {
    if (f.kind === 'numeric') r.results[f.id] = { min: f.nominal, max: f.nominal, outcome: '' };
    else r.results[f.id] = { min: '', max: '', outcome: 'pass' };
  });
  assert.equal(summarize(r.features, r.results).status, 'pass');
  assert.equal(reportStatus(r), 'pass');
  r.results[r.features[0].id].max = '99';
  assert.equal(reportStatus(r), 'fail');
  // A lot rejected by Ac/Re is a failed report even if every measured row passed
  r.results[r.features[0].id].max = r.features[0].nominal;
  r.header.quantity = '400'; r.header.aql = '2.5'; r.header.inspectionLevel = 'II'; r.header.nonconforming = '4';
  assert.equal(reportStatus(r), 'fail');
  r.header.nonconforming = '3';
  assert.equal(reportStatus(r), 'pass');
});

test('createReport honours field policies; non-lockable fields are always fresh', () => {
  const t = defaultTemplate();
  t.fields.customer = { mode: 'carry', value: 'Fallback Ltd' };
  t.fields.partNo = { mode: 'fixed', value: 'P-100' };
  t.fields.material = { mode: 'default', value: 'AL 6061' };
  t.fields.revision = { mode: 'blank', value: 'should-not-appear' };
  t.fields.quantity = { mode: 'fixed', value: '500' }; // not lockable: must be ignored
  t.fields.accepted = { mode: 'carry', value: '7' };    // not lockable: must be ignored
  const first = createReport(t, null, new Date(2026, 9, 11));
  assert.equal(first.header.customer, 'Fallback Ltd');
  assert.equal(first.header.partNo, 'P-100');
  assert.equal(first.header.material, 'AL 6061');
  assert.equal(first.header.revision, '');
  assert.equal(first.header.quantity, '');
  assert.equal(first.header.accepted, '');
  assert.equal(first.header.inspectionDate, '2026-10-11');
  assert.equal(first.header.reportNo, 'FIR-0001');
  assert.equal(isLocked(t, 'partNo'), true);
  assert.equal(isLocked(t, 'quantity'), false);
  assert.equal(isLocked(t, 'customer'), false);
  first.header.customer = 'Acme'; first.header.accepted = '9'; first.header.material = 'SS304';
  const second = createReport(t, first);
  assert.equal(second.header.customer, 'Acme', 'carry copies the previous value');
  assert.equal(second.header.material, 'AL 6061', 'default resets to the template value');
  assert.equal(second.header.accepted, '');
  assert.equal(second.header.reportNo, 'FIR-0001', 'the number is consumed by the caller, not by createReport');
  assert.equal(Object.keys(second.results).length, t.features.length);
  assert.notEqual(second.id, first.id);
  t.numbering.mode = 'manual';
  assert.equal(createReport(t).header.reportNo, '');
});

test('formatReportNo', () => {
  assert.equal(formatReportNo({ prefix: 'FIR-', next: 12, width: 4 }), 'FIR-0012');
  assert.equal(formatReportNo({ prefix: '', next: 7, width: 0 }), '7');
  assert.equal(formatReportNo({ prefix: 'Q', next: 7, width: 99 }), 'Q00000007');
});

test('syncReportFeatures keeps results by id, drops removed rows, adds new rows', () => {
  const t = defaultTemplate();
  const r = createReport(t);
  const keep = t.features[0].id;
  r.results[keep] = { min: '1', max: '2', outcome: '' };
  t.features = [t.features[0], { ...blankFeature('numeric'), nominal: '5', upper: '0.1' }];
  const synced = syncReportFeatures(r, t);
  assert.equal(synced.features.length, 2);
  assert.deepEqual(synced.results[keep], { min: '1', max: '2', outcome: '' });
  assert.deepEqual(synced.results[t.features[1].id], { min: '', max: '', outcome: '', note: '' });
  assert.equal(r.features.length, 4, 'original report not mutated');
  assert.equal(Object.keys(r.results).length, 4);
});

test('reportHasContent and headerWarnings', () => {
  const t = defaultTemplate();
  const r = createReport(t);
  // Values the template produced (fixed, default, carried) are not user content
  t.fields.partNo.value = 'P1';
  t.fields.customer = { mode: 'carry', value: '' };
  const r2 = createReport(t, { header: { customer: 'Carried Co' } });
  assert.equal(r2.header.customer, 'Carried Co');
  assert.equal(reportHasContent(r2), false, 'fixed + carried values alone are not content');
  r2.header.customer = 'Edited Co';
  assert.equal(reportHasContent(r2), true, 'an edited header value is content');
  const empty = createReport({ ...t, fields: Object.fromEntries(HEADER_FIELDS.map(f => [f.key, { mode: 'blank', value: '' }])) });
  assert.equal(reportHasContent(empty), false);
  empty.results[empty.features[0].id].min = '1';
  assert.equal(reportHasContent(empty), true);
  // Reports without a baseline (legacy) treat any header value as content
  assert.equal(reportHasContent({ header: { customer: 'x' }, results: {}, remarks: '' }), true);
  r.header.quantity = '100'; r.header.accepted = '90'; r.header.rejected = '20';
  assert.ok(headerWarnings(r).includes('counts-exceed-lot'));
  r.header.rejected = '5'; r.header.nonconforming = '50';
  assert.ok(headerWarnings(r).includes('nonconforming-exceeds-sample'));
  r.header.nonconforming = '1'; r.header.accepted = 'x';
  assert.ok(headerWarnings(r).includes('counts-invalid'));
  r.header.accepted = ''; r.header.quantity = '12.5';
  assert.ok(headerWarnings(r).includes('quantity-invalid'));
  r.header.quantity = '100'; r.header.inspectionDate = '11/10/2026';
  assert.ok(headerWarnings(r).includes('date-invalid'));
  r.header.inspectionDate = '2026-10-11';
  assert.deepEqual(headerWarnings(r), []);
});

test('formatDateForReport is unambiguous', () => {
  assert.equal(formatDateForReport('2026-10-11'), '11 Oct 2026');
  assert.equal(formatDateForReport('2026-01-05'), '5 Jan 2026');
  assert.equal(formatDateForReport(''), '');
  assert.equal(formatDateForReport('garbage'), 'garbage');
});
