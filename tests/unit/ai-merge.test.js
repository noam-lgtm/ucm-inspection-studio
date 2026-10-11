import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPdfPages } from '../helpers/pdf-pages.js';
import { buildImportDraft } from '../../src/pdf-import.js';
import { mergeAiIntoDraft, aiRowToFeature } from '../../src/ai-merge.js';
import { requirementText, evaluateFeature } from '../../src/core.js';

const FIX = path.join(process.cwd(), 'tests', 'fixtures');

// What a vision model is expected to return for the second real report (Required cells are pictures).
const AI_FOR_B = {
  header: { reportNo: '9195_2', partNo: '0112807-000', revision: 'AB', partName: 'SCREWLOCK , FEM 2-56,SS, 612S', catalogNo: '0112807-000', customer: 'ג.ט. גבעסול טכנולוגיות בע"מ', purchaseOrder: 'PO26001059', productionOrder: '0', quantity: '200', aql: '2.5', sampleSize: '32', accepted: '200', rejected: '0', generalTolerance: '±0.1', inspector: 'Yuri s.', inspectionDate: '20/4/26', drawingNo: '', material: '' },
  rows: [
    { no: 1, requiredText: '0.69', kind: 'numeric', label: '', nominal: '0.69', upper: '0.1', lower: '', symmetric: true, unit: 'mm', suffix: '', method: 'Pins', min: '0.66', max: '0.76', outcome: '', confidence: 0.9, note: '' },
    { no: 2, requiredText: '⊥0.508', kind: 'numeric', label: 'Depth', nominal: '0.508', upper: '0.1', lower: '', symmetric: true, unit: 'mm', suffix: '', method: 'Height Gauge', min: '0.47', max: '0.54', outcome: '', confidence: 0.7, note: 'symbol before the number is unclear' },
    { no: 6, requiredText: 'Ø3.05', kind: 'numeric', label: 'Ø', nominal: '3.05', upper: '0.1', lower: '', symmetric: true, unit: 'mm', suffix: '', method: 'Caliper', min: '3.01', max: '3.07', outcome: '', confidence: 0.95, note: '' },
    { no: 10, requiredText: '0.33 ∠45°', kind: 'gauge', label: '0.33 x 45° chamfer', nominal: '', upper: '', lower: '', symmetric: true, unit: '', suffix: '', method: 'Comperator', min: '✓', max: '✓', outcome: 'pass', confidence: 0.85, note: '' },
    { no: 11, requiredText: '-2-56UNC', kind: 'gauge', label: '2-56 UNC', nominal: '', upper: '', lower: '', symmetric: true, unit: '', suffix: '', method: 'Thread pluge gage', min: '✓', max: '✓', outcome: 'pass', confidence: 0.9, note: '' },
    { no: 15, requiredText: '2.29 MIN DEEP', kind: 'numeric', label: '', nominal: '2.29', upper: '', lower: '', symmetric: true, unit: 'mm', suffix: 'MIN DEEP', method: 'Thread pluge gage', min: '2.4', max: '2.6', outcome: '', confidence: 0.6, note: 'minimum depth, no upper limit printed' },
  ],
  notes: 'Required column is printed as images.',
};

test('AI rows fill image-only cells; text-layer results and methods are kept', async () => {
  const draft = buildImportDraft(await loadPdfPages(fs.readFileSync(path.join(FIX, 'report-0112807-000-AB.pdf'))));
  const before = draft.features[0].result;
  const summary = mergeAiIntoDraft(draft, AI_FOR_B);
  assert.equal(summary.rowsFilled, 6);
  assert.equal(summary.rowsAdded, 0);
  assert.equal(draft.features.length, 15);
  const r1 = draft.features[0];
  assert.equal(requirementText(r1.feature), '0.69 ±0.1');
  assert.deepEqual(r1.result, before, 'measured values from the text layer are preserved');
  assert.equal(evaluateFeature(r1.feature, r1.result).state, 'ok');
  assert.equal(r1.ai, true); assert.equal(r1.needsReview, true, 'AI-read cells still require a human confirmation');
  assert.equal(requirementText(draft.features[1].feature), 'Depth 0.508 ±0.1');
  assert.equal(requirementText(draft.features[5].feature), 'Ø3.05 ±0.1');
  assert.equal(draft.features[9].feature.kind, 'gauge'); assert.equal(draft.features[9].feature.label, '0.33 x 45° chamfer'); assert.equal(draft.features[9].result.outcome, 'pass');
  assert.equal(draft.features[10].feature.label, '2-56 UNC');
  // Row 15: numbers were measured; nominal came from the AI but the tolerance is missing -> flagged, cannot pass
  const r15 = draft.features[14];
  assert.equal(r15.feature.kind, 'numeric'); assert.equal(r15.feature.nominal, '2.29'); assert.equal(r15.feature.suffix, 'MIN DEEP');
  assert.ok(r15.reasons.includes('tolerance-missing'));
  assert.equal(evaluateFeature(r15.feature, r15.result).state, 'review');
  // Header: the text layer already had everything, AI agrees -> no conflicts
  assert.equal(summary.fieldsConflict, 0);
  assert.equal(draft.fields.inspectionDate.value, '2026-04-20');
  // Rows the AI did not mention remain flagged as image cells
  assert.ok(draft.features[2].needsReview && draft.features[2].reasons.includes('image-cell'));
});

test('AI disagreement with a confident text-layer value is flagged, not applied', async () => {
  const draft = buildImportDraft(await loadPdfPages(fs.readFileSync(path.join(FIX, 'report-MM606207C-C.pdf'))));
  const summary = mergeAiIntoDraft(draft, {
    header: { partNo: 'MM606207C', revision: 'D', customer: 'Atena Ltd.' },
    rows: [{ no: 2, requiredText: 'Ø36', kind: 'numeric', label: 'Ø', nominal: '36', upper: '0.1', lower: '', symmetric: true, unit: 'mm', suffix: '', method: 'Caliper', min: '', max: '', outcome: '', confidence: 0.9, note: '' },
      { no: 9, requiredText: '90° ±0.5°', kind: 'numeric', label: '', nominal: '90', upper: '0.5', lower: '', symmetric: true, unit: 'deg', suffix: '', method: 'XYZ cmm', min: '89.95', max: '90.08', outcome: '', confidence: 0.9, note: '' },
      { no: 13, requiredText: 'Ra 1.6', kind: 'visual', label: 'Ra 1.6', nominal: '', upper: '', lower: '', symmetric: true, unit: '', suffix: '', method: 'Visual', min: '', max: '', outcome: '', confidence: 0.8, note: '' }],
    notes: '',
  });
  assert.equal(draft.fields.revision.value, 'C', 'text-layer revision kept');
  assert.equal(draft.fields.revision.aiValue, 'D'); assert.equal(draft.fields.revision.conflict, true);
  assert.equal(summary.fieldsConflict, 1);
  assert.equal(draft.features[1].feature.nominal, '30'); assert.ok(draft.features[1].reasons.includes('ai-disagrees')); assert.equal(draft.features[1].aiAlternative.nominal, '36');
  // The angle row had no tolerance; the AI supplied one with the same nominal -> accepted but still reviewed
  assert.equal(draft.features[8].feature.upper, '0.5'); assert.ok(!draft.features[8].reasons.includes('tolerance-missing'));
  // A row the text layer never saw is appended and flagged
  assert.equal(draft.features.length, 13);
  assert.equal(draft.features[12].feature.kind, 'gauge'); assert.ok(draft.features[12].reasons.includes('ai-only'));
});

test('aiRowToFeature normalises signs and falls back to text interpretation', () => {
  const a = aiRowToFeature({ no: 1, requiredText: '20 0 +0.03', kind: 'numeric', label: '', nominal: '20', upper: '0.03', lower: '0', symmetric: false, unit: 'mm', suffix: '', method: 'Pins', min: '20.01', max: '20.027', outcome: '', confidence: 0.9, note: '' });
  assert.equal(requirementText(a.feature), '20 +0.03 / 0');
  const b = aiRowToFeature({ no: 2, requiredText: '15 ±0.05', kind: 'numeric', label: '', nominal: '', upper: '', lower: '', symmetric: true, unit: 'mm', suffix: '', method: 'CMM', min: '', max: '', outcome: '', confidence: 0.9, note: '' });
  assert.equal(requirementText(b.feature), '15 ±0.05');
  const c = aiRowToFeature({ no: 3, requiredText: 'M6', kind: 'gauge', label: '', nominal: '', upper: '', lower: '', symmetric: true, unit: '', suffix: '', method: 'Plug', min: 'V', max: '', outcome: '', confidence: 0.9, note: '' });
  assert.equal(c.feature.label, 'M6'); assert.equal(c.result.outcome, 'pass');
});
