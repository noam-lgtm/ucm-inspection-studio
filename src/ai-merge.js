/*
 * Merge the AI extractor's answer into a deterministic import draft.
 * Text-layer values with high confidence win; the AI fills gaps (image-only
 * cells, scans, photos); disagreements are flagged for the reviewer.
 */
import { blankFeature, blankResult, FEATURE_KINDS, UNITS } from './core.js';
import { interpretRequirement, interpretResult, parseDateText } from './pdf-import.js';

const HEADER_KEYS = ['reportNo', 'partNo', 'revision', 'partName', 'catalogNo', 'customer', 'purchaseOrder', 'productionOrder', 'quantity', 'aql', 'sampleSize', 'accepted', 'rejected', 'generalTolerance', 'inspector', 'inspectionDate', 'drawingNo', 'material'];
const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** Convert one AI row into a core feature + result. */
export function aiRowToFeature(row) {
  const kind = FEATURE_KINDS.includes(row.kind) ? row.kind : 'numeric';
  let feature, confidence = Math.max(0, Math.min(1, Number(row.confidence) || 0)), reasons = [];
  if (kind === 'numeric' && clean(row.nominal)) {
    feature = blankFeature('numeric');
    feature.label = clean(row.label); feature.suffix = clean(row.suffix); feature.nominal = clean(row.nominal).replace(',', '.');
    feature.symmetric = row.symmetric !== false && !clean(row.lower);
    feature.upper = clean(row.upper).replace(',', '.');
    feature.lower = feature.symmetric ? '' : clean(row.lower).replace(',', '.');
    if (feature.symmetric && feature.upper.startsWith('+')) feature.upper = feature.upper.slice(1);
    if (!feature.symmetric && feature.upper && !/^[+-]/.test(feature.upper)) feature.upper = '+' + feature.upper;
    feature.unit = UNITS.includes(row.unit) ? row.unit : 'mm';
    feature.method = clean(row.method);
    if (!feature.upper) { reasons.push('tolerance-missing'); confidence = Math.min(confidence, 0.5); }
  } else if (kind === 'numeric') {
    // No structured nominal: fall back to interpreting the printed text
    const r = interpretRequirement(clean(row.requiredText), '', '', clean(row.method));
    feature = r.feature; reasons = r.reasons; confidence = Math.min(confidence, r.confidence);
  } else {
    feature = blankFeature(kind);
    feature.label = clean(row.label) || clean(row.requiredText); feature.method = clean(row.method);
    if (!feature.label) { reasons.push('label-missing'); confidence = Math.min(confidence, 0.3); }
  }
  const result = blankResult();
  if (feature.kind === 'numeric') {
    result.min = interpretResult(clean(row.min)).value; result.max = interpretResult(clean(row.max)).value;
  } else {
    result.outcome = ['pass', 'fail'].includes(row.outcome) ? row.outcome : (interpretResult(clean(row.min)).outcome || interpretResult(clean(row.max)).outcome);
  }
  if (clean(row.note)) feature.note = clean(row.note).slice(0, 300);
  return { feature, result, confidence, reasons, requiredText: clean(row.requiredText) };
}

/**
 * Merge AI output into the draft (in place). Returns a summary of what changed.
 */
export function mergeAiIntoDraft(draft, ai) {
  const summary = { fieldsFilled: 0, fieldsConflict: 0, rowsFilled: 0, rowsAdded: 0, rowsConflict: 0 };
  const header = ai && ai.header && typeof ai.header === 'object' ? ai.header : {};
  for (const key of HEADER_KEYS) {
    const aiValue = key === 'inspectionDate' ? (parseDateText(clean(header[key])) || clean(header[key])) : clean(header[key]);
    if (!aiValue) continue;
    const f = draft.fields[key] || (draft.fields[key] = { value: '', confidence: 0, source: null, needsReview: true });
    if (!f.value || f.confidence < 0.8) {
      if (!f.value) summary.fieldsFilled++;
      f.value = aiValue; f.confidence = Math.max(f.confidence, 0.7); f.needsReview = true; f.ai = true;
    } else if (f.value.toLowerCase() !== aiValue.toLowerCase()) {
      f.aiValue = aiValue; f.needsReview = true; f.conflict = true; summary.fieldsConflict++;
    }
  }
  const rows = Array.isArray(ai && ai.rows) ? ai.rows : [];
  for (const row of rows) {
    const no = Number(row.no);
    if (!Number.isInteger(no) || no < 1 || no > 500) continue;
    const converted = aiRowToFeature(row);
    const existing = draft.features.find(f => f.no === no);
    if (!existing) {
      draft.features.push({ no, feature: converted.feature, result: converted.result, confidence: converted.confidence, reasons: ['ai-only', ...converted.reasons], needsReview: true, source: null, raw: { required: converted.requiredText }, ai: true });
      summary.rowsAdded++;
      continue;
    }
    const textCellMissing = !existing.raw || !existing.raw.required;
    if (textCellMissing) {
      // Image-only or empty cell: take the AI reading, keep the text-layer method/results when present
      const keepMethod = existing.feature.method;
      const keepResult = existing.result;
      existing.feature = { ...converted.feature, id: existing.feature.id, method: keepMethod || converted.feature.method };
      existing.result = (keepResult && (keepResult.min || keepResult.max || keepResult.outcome)) ? keepResult : converted.result;
      if (existing.feature.kind !== 'numeric' && existing.result.min && !existing.result.outcome) {
        // text layer had numbers but the AI says it is a gauge row: trust the numbers, keep numeric
        existing.feature = { ...existing.feature, kind: 'numeric', nominal: converted.feature.nominal || '', unit: 'mm' };
      }
      existing.confidence = converted.confidence; existing.reasons = converted.reasons; existing.ai = true;
      existing.needsReview = true;
      summary.rowsFilled++;
    } else if (existing.confidence < 0.8 && converted.confidence >= 0.8 && converted.feature.kind === existing.feature.kind) {
      // Text existed but was ambiguous (e.g. missing tolerance): accept the AI tolerance when it supplied one
      if (existing.feature.kind === 'numeric' && converted.feature.nominal === existing.feature.nominal && converted.feature.upper && !existing.feature.upper) {
        existing.feature.upper = converted.feature.upper; existing.feature.lower = converted.feature.lower; existing.feature.symmetric = converted.feature.symmetric;
        existing.reasons = existing.reasons.filter(r => r !== 'tolerance-missing'); existing.ai = true; summary.rowsFilled++;
      }
    } else if (existing.feature.kind === 'numeric' && converted.feature.kind === 'numeric' && converted.feature.nominal && Number(converted.feature.nominal) !== Number(existing.feature.nominal)) {
      existing.aiAlternative = converted.feature; existing.needsReview = true; existing.reasons = [...existing.reasons, 'ai-disagrees']; summary.rowsConflict++;
    }
  }
  draft.features.sort((a, b) => a.no - b.no);
  draft.summary = { rows: draft.features.length, reviewRows: draft.features.filter(f => f.needsReview).length, reviewFields: Object.values(draft.fields).filter(f => f.needsReview).length };
  draft.aiNotes = clean(ai && ai.notes).slice(0, 1000);
  return summary;
}
