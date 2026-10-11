/*
 * Pure, deterministic model logic. No DOM, no storage.
 * Features (what the drawing requires), results (what was measured), and
 * the evaluation that joins them. The printed "Required" text is DERIVED
 * from the structured nominal/deviation fields, so a requirement can never
 * contradict the limits that produce the PASS/FAIL verdict.
 */
import { samplingPlan, LEVELS } from './sampling.js';

export const FEATURE_KINDS = Object.freeze(['numeric', 'gauge', 'visual']);
export const UNITS = Object.freeze(['mm', 'in', 'deg', 'um', '']);
export const FIELD_MODES = Object.freeze(['fixed', 'default', 'carry', 'blank']);
export const MAX_FEATURES = 200;

export const HEADER_FIELDS = Object.freeze([
  { key: 'reportNo', en: 'Report No.', lockable: false },
  { key: 'inspectionDate', en: 'Inspection date', lockable: false, type: 'date' },
  { key: 'customer', en: 'Customer', lockable: true },
  { key: 'purchaseOrder', en: 'Purchase order', lockable: true },
  { key: 'productionOrder', en: 'Production order', lockable: true },
  { key: 'quantity', en: 'Lot quantity', lockable: false, numeric: true },
  { key: 'catalogNo', en: 'Catalog No.', lockable: true },
  { key: 'partNo', en: 'Part No.', lockable: true },
  { key: 'partName', en: 'Part name', lockable: true },
  { key: 'revision', en: 'Revision', lockable: true },
  { key: 'inspector', en: 'Inspector', lockable: true },
  { key: 'generalTolerance', en: 'General tolerance', lockable: true },
  { key: 'aql', en: 'AQL', lockable: true },
  { key: 'inspectionLevel', en: 'Inspection level', lockable: true, type: 'level' },
  { key: 'totalInspected', en: 'Total inspected', lockable: false, numeric: true },
  { key: 'accepted', en: 'Accepted qty', lockable: false, numeric: true },
  { key: 'rejected', en: 'Rejected qty', lockable: false, numeric: true },
]);
export const HEADER_KEYS = HEADER_FIELDS.map(f => f.key);

export function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function localDate(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

// ---------- numbers ----------

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** Strict decimal parse of a configuration value ("25", "-0.05", "+0.1", "0,05"). null when blank, NaN when invalid. */
export function parseDecimal(value) {
  const text = String(value == null ? '' : value).trim().replace(',', '.');
  if (!text) return null;
  if (!NUMBER_RE.test(text)) return Number.NaN;
  return Number(text);
}

/** Number of decimals written in a decimal string ("25.00" -> 2). */
export function decimalsOf(value) {
  const text = String(value == null ? '' : value).trim().replace(',', '.');
  const m = text.match(/\.(\d+)$/);
  return m ? m[1].length : 0;
}

/**
 * Parse a measured value typed by an inspector. Tolerant of unit suffixes and
 * drawing symbols: "25.03", "25,03", "Ø25.03", "R5.1", "30°", "12.5 mm", "+0.02".
 * Returns null for blank, NaN when not a number.
 */
export function parseMeasurement(value) {
  let text = String(value == null ? '' : value).trim();
  if (!text) return null;
  text = text.replace(/^[RrØ⌀ø]\s*/, '').replace(/\s*(?:°|mm|in|"|um|µm|deg)$/i, '').replace(',', '.').trim();
  if (!NUMBER_RE.test(text)) return Number.NaN;
  return Number(text);
}

export function formatNumber(num, decimals) {
  if (!Number.isFinite(num)) return '';
  const d = Math.max(0, Math.min(6, decimals | 0));
  const fixed = num.toFixed(d);
  return fixed === '-0' || /^-0\.0+$/.test(fixed) ? fixed.slice(1) : fixed;
}

function signed(num, decimals) {
  const t = formatNumber(num, decimals);
  return num > 0 ? '+' + t : t;
}

export function unitLabel(unit) {
  return { mm: 'mm', in: 'in', deg: '°', um: 'µm', '': '' }[unit] ?? '';
}

// ---------- features ----------

export function blankFeature(kind = 'numeric') {
  return {
    id: newId(), kind: FEATURE_KINDS.includes(kind) ? kind : 'numeric',
    label: '', suffix: '', nominal: '', upper: '', lower: '', symmetric: true,
    unit: kind === 'numeric' ? 'mm' : '', method: '', note: '',
  };
}

/**
 * Resolve a numeric feature's limits.
 * @returns {{ok:boolean, reason?:string, nominal?:number, upper?:number, lower?:number, min?:number, max?:number, decimals?:number}}
 */
export function featureLimits(feature) {
  if (!feature || feature.kind !== 'numeric') return { ok: false, reason: 'not-numeric' };
  const nominal = parseDecimal(feature.nominal);
  const upper = parseDecimal(feature.upper);
  const lower = feature.symmetric ? (Number.isFinite(upper) ? -upper : upper) : parseDecimal(feature.lower);
  if (nominal === null || upper === null || lower === null) return { ok: false, reason: 'missing' };
  if (![nominal, upper, lower].every(Number.isFinite)) return { ok: false, reason: 'invalid' };
  if (feature.symmetric && upper < 0) return { ok: false, reason: 'negative-symmetric' };
  if (lower > upper) return { ok: false, reason: 'inverted' };
  const decimals = Math.max(decimalsOf(feature.nominal), decimalsOf(feature.upper), feature.symmetric ? 0 : decimalsOf(feature.lower));
  return { ok: true, nominal, upper, lower, min: nominal + lower, max: nominal + upper, decimals };
}

/** Human text of the requirement, derived from the structured fields: "25.00 ±0.10", "10 +0.05 / 0", "M8x1.25-6H". */
export function requirementText(feature) {
  if (!feature) return '';
  if (feature.kind !== 'numeric') return String(feature.label || '').trim();
  const lim = featureLimits(feature);
  const label = String(feature.label || '').trim();
  const suffix = String(feature.suffix || '').trim();
  if (!lim.ok) {
    const nom = String(feature.nominal ?? '').trim() || '?';
    const up = String(feature.upper ?? '').trim();
    const tol = up ? (feature.symmetric ? '±' + up : up + ' / ' + String(feature.lower ?? '').trim()) : '';
    return [label, nom, tol, suffix].filter(Boolean).join(' ');
  }
  const d = lim.decimals;
  const nominal = formatNumber(lim.nominal, d);
  let tol;
  if (lim.upper === -lim.lower) tol = lim.upper === 0 ? '±0' : '±' + formatNumber(lim.upper, d);
  else tol = `${signed(lim.upper, d)} / ${signed(lim.lower, d)}`;
  return [label, `${nominal} ${tol}`, suffix].filter(Boolean).join(' ');
}

/** "24.90 / 25.10" style limits text for the report. */
export function limitsText(feature) {
  const lim = featureLimits(feature);
  if (!lim.ok) return '';
  return `${formatNumber(lim.min, lim.decimals)} – ${formatNumber(lim.max, lim.decimals)}`;
}

/** Problems a template author must fix before a feature can produce verdicts. Empty array = fine. */
export function featureProblems(feature) {
  const problems = [];
  if (!feature) return ['missing'];
  if (feature.kind === 'numeric') {
    const lim = featureLimits(feature);
    if (!lim.ok) problems.push(lim.reason);
  } else if (!String(feature.label || '').trim()) {
    problems.push('label');
  }
  return problems;
}

// ---------- results and evaluation ----------

export function blankResult() { return { min: '', max: '', outcome: '', note: '' }; }

/**
 * Evaluate one feature against its recorded result.
 * state: 'empty' | 'review' | 'fail' | 'ok' | 'manual-pass'
 */
export function evaluateFeature(feature, result) {
  const r = result || blankResult();
  if (!feature) return { state: 'review', reason: 'feature-missing' };
  if (feature.kind !== 'numeric') {
    const outcome = String(r.outcome || '');
    if (!outcome) return { state: 'empty', reason: 'no-outcome' };
    if (outcome === 'pass') return { state: 'manual-pass', reason: 'reported-pass' };
    if (outcome === 'fail') return { state: 'fail', reason: 'reported-fail' };
    return { state: 'review', reason: 'unknown-outcome' };
  }
  const lim = featureLimits(feature);
  const a = parseMeasurement(r.min);
  const b = parseMeasurement(r.max);
  if (a === null && b === null) return { state: 'empty', reason: 'no-measurement', limits: lim.ok ? lim : null };
  if (a === null || b === null) return { state: 'review', reason: 'min-max-required', limits: lim.ok ? lim : null };
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { state: 'review', reason: 'not-a-number', limits: lim.ok ? lim : null };
  if (a > b) return { state: 'review', reason: 'min-above-max', limits: lim.ok ? lim : null };
  if (!lim.ok) return { state: 'review', reason: 'limits-' + lim.reason };
  const eps = 1e-9;
  const outLow = a < lim.min - eps;
  const outHigh = b > lim.max + eps;
  if (outLow || outHigh) return { state: 'fail', reason: outLow && outHigh ? 'both-out' : outLow ? 'below-min' : 'above-max', limits: lim };
  return { state: 'ok', reason: 'within', limits: lim };
}

export function summarize(features, results) {
  const counts = { total: 0, ok: 0, fail: 0, review: 0, empty: 0 };
  for (const f of features || []) {
    counts.total++;
    const s = evaluateFeature(f, results && results[f.id]).state;
    if (s === 'ok' || s === 'manual-pass') counts.ok++;
    else if (s === 'fail') counts.fail++;
    else if (s === 'review') counts.review++;
    else counts.empty++;
  }
  counts.status = counts.fail ? 'fail' : (counts.review || counts.empty || counts.total === 0) ? 'incomplete' : 'pass';
  return counts;
}

// ---------- templates ----------

export function defaultFieldPolicy() {
  const policy = {};
  for (const f of HEADER_FIELDS) policy[f.key] = { mode: 'blank', value: '' };
  Object.assign(policy, {
    customer: { mode: 'carry', value: '' },
    purchaseOrder: { mode: 'carry', value: '' },
    productionOrder: { mode: 'carry', value: '' },
    inspector: { mode: 'carry', value: '' },
    catalogNo: { mode: 'fixed', value: '' },
    partNo: { mode: 'fixed', value: '' },
    partName: { mode: 'fixed', value: '' },
    revision: { mode: 'fixed', value: '' },
    generalTolerance: { mode: 'fixed', value: '±0.1' },
    aql: { mode: 'fixed', value: '2.5' },
    inspectionLevel: { mode: 'fixed', value: 'II' },
  });
  return policy;
}

export function defaultTemplate() {
  return {
    id: newId(), name: 'תבנית לדוגמה', // "תבנית לדוגמה"
    updatedAt: new Date().toISOString(),
    company: {
      name: 'UCM Technologies',
      tagline: 'Professional Milling, Turning and Assembly Solutions',
      footer: '11 Hidekel St., Building 15, Gav-Yam Park, Yavne | Tel: 08-9421002 | www.ucm.co.il | info@ucm.co.il',
      logo: '',
      standardName: 'MIL-STD-105D',
    },
    numbering: { mode: 'auto', prefix: 'FIR-', next: 1, width: 4 },
    fields: defaultFieldPolicy(),
    features: [
      { ...blankFeature('numeric'), label: '', nominal: '25.00', upper: '0.10', lower: '', symmetric: true, unit: 'mm', method: 'Caliper' },
      { ...blankFeature('numeric'), label: 'Ø', nominal: '10', upper: '0.05', lower: '0', symmetric: false, unit: 'mm', method: 'Pin gauge' },
      { ...blankFeature('gauge'), label: 'M8x1.25-6H', method: 'Thread plug gauge', unit: '' },
      { ...blankFeature('visual'), label: 'Deburred, no visual defects', method: 'Visual', unit: '' },
    ],
  };
}

export function formatReportNo(numbering, n = numbering.next) {
  const width = Math.max(0, Math.min(8, Number(numbering.width) || 0));
  return `${numbering.prefix || ''}${String(n).padStart(width, '0')}`;
}

// ---------- products (specification per part number + revision) ----------

export const PRODUCT_FIELDS = Object.freeze(['partNo', 'revision', 'partName', 'catalogNo', 'customer', 'generalTolerance', 'aql', 'inspectionLevel']);

export function normalizePartNo(value) { return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toUpperCase(); }
export function normalizeRevision(value) { return String(value == null ? '' : value).trim().replace(/^rev\.?\s*/i, '').toUpperCase(); }
/** Stable key used to find "the same product": part number + revision. */
export function productKey(partNo, revision) { return normalizePartNo(partNo) + '@' + normalizeRevision(revision); }

export function blankProduct() {
  const now = new Date().toISOString();
  return {
    id: newId(), partNo: '', revision: '', partName: '', catalogNo: '', customer: '',
    generalTolerance: '', aql: '', inspectionLevel: '', features: [], sourceFileId: '', sourceReportNo: '',
    notes: '', createdAt: now, updatedAt: now,
  };
}

export function findProduct(products, partNo, revision) {
  const key = productKey(partNo, revision);
  return (products || []).find(p => productKey(p.partNo, p.revision) === key) || null;
}

/** All revisions of a part number, newest first by revision text then date. */
export function productRevisions(products, partNo) {
  const key = normalizePartNo(partNo);
  return (products || []).filter(p => normalizePartNo(p.partNo) === key)
    .sort((a, b) => String(b.revision).localeCompare(String(a.revision), undefined, { numeric: true }) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// ---------- reports ----------

/**
 * Create a fresh report from a template. `previous` (optional) supplies carry-over values.
 * Mutates nothing; returns { report, numberingNext } so the caller decides whether to consume the number.
 */
export function createReport(template, previous = null, now = new Date(), product = null) {
  const header = {};
  for (const f of HEADER_FIELDS) {
    const policy = template.fields[f.key] || { mode: 'blank', value: '' };
    const mode = f.lockable ? policy.mode : 'blank';
    if (mode === 'fixed' || mode === 'default') header[f.key] = String(policy.value ?? '');
    else if (mode === 'carry') header[f.key] = String(previous && previous.header && previous.header[f.key] || policy.value || '');
    else header[f.key] = '';
  }
  // A product specification overrides the product-related header fields and supplies the characteristics.
  if (product) {
    for (const key of PRODUCT_FIELDS) if (String(product[key] || '').trim()) header[key] = String(product[key]);
  }
  header.inspectionDate = localDate(now);
  if (template.numbering && template.numbering.mode === 'auto') header.reportNo = formatReportNo(template.numbering);
  const source = product ? product.features : template.features;
  const features = source.map(f => ({ ...f }));
  const results = {};
  features.forEach(f => { results[f.id] = blankResult(); });
  return {
    id: newId(), templateId: template.id, templateName: template.name,
    productId: product ? product.id : '', productKey: product ? productKey(product.partNo, product.revision) : '', sourceFileId: '',
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    header, baseline: { ...header }, features, results, remarks: '',
  };
}

/** Product-related header fields are locked when the report comes from a product specification. */
export function isProductLocked(report, key) {
  return Boolean(report && report.productId) && ['partNo', 'revision'].includes(key);
}

/** Keep a draft's feature rows in sync with its template, preserving entered results by feature id. */
export function syncReportFeatures(report, template, product = null) {
  const results = {};
  const source = product ? product.features : template.features;
  const features = source.map(f => ({ ...f }));
  features.forEach(f => { results[f.id] = report.results[f.id] || blankResult(); });
  return { ...report, templateId: template.id, templateName: template.name, features, results };
}

export function isLocked(template, key) {
  const def = HEADER_FIELDS.find(f => f.key === key);
  if (!def || !def.lockable) return false;
  const policy = template.fields[key];
  return Boolean(policy && policy.mode === 'fixed');
}

/**
 * True when the report holds anything the user entered: a measurement, a remark,
 * or a header value that differs from what the template produced at creation.
 */
export function reportHasContent(report) {
  if (!report) return false;
  if (String(report.remarks || '').trim()) return true;
  const baseline = report.baseline || {};
  for (const key of HEADER_KEYS) {
    if (key === 'inspectionDate' || key === 'reportNo') continue;
    if (String(report.header[key] || '').trim() !== String(baseline[key] || '').trim()) return true;
  }
  return Object.values(report.results || {}).some(r => r && (String(r.min || '').trim() || String(r.max || '').trim() || r.outcome));
}

export function reportSampling(report) {
  const h = report.header;
  const plan = samplingPlan(h.quantity, LEVELS.includes(h.inspectionLevel) ? h.inspectionLevel : 'II', h.aql);
  return { plan, disposition: null };
}

/** Header-level validation warnings (keys, translated by the UI). */
export function headerWarnings(report) {
  const h = report.header;
  const warnings = [];
  const lot = h.quantity ? Number(String(h.quantity).replace(/[\s,]/g, '')) : null;
  const intOrNull = v => (String(v || '').trim() === '' ? null : (/^\d+$/.test(String(v).trim()) ? Number(v) : Number.NaN));
  const acc = intOrNull(h.accepted), rej = intOrNull(h.rejected), tot = intOrNull(h.totalInspected);
  if (String(h.quantity || '').trim() && !(Number.isSafeInteger(lot) && lot >= 1)) warnings.push('quantity-invalid');
  if (Number.isNaN(acc) || Number.isNaN(rej) || Number.isNaN(tot)) warnings.push('counts-invalid');
  if (Number.isSafeInteger(lot) && acc !== null && rej !== null && !Number.isNaN(acc) && !Number.isNaN(rej) && acc + rej > lot) warnings.push('counts-exceed-lot');
  if (String(h.inspectionDate || '').trim() && !/^\d{4}-\d{2}-\d{2}$/.test(h.inspectionDate)) warnings.push('date-invalid');
  return warnings;
}

/** Overall report status: 'pass' | 'fail' | 'incomplete'. */
export function reportStatus(report) {
  const counts = summarize(report.features, report.results);
  const { disposition } = reportSampling(report);
  if (disposition === 'reject') return 'fail';
  return counts.status;
}

export function formatDateForReport(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}
