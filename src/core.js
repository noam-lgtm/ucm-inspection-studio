/*
 * Pure, deterministic model logic. No DOM, no storage.
 * Products (what the drawing requires, per part number + revision), reports
 * (what was measured for one lot) and the evaluation that joins them.
 * The printed "Required" text and the TOL-/TOL+ cells are DERIVED from the
 * structured nominal/deviation fields, so a requirement can never contradict
 * the limits that produce the verdict.
 */
import { samplingPlan, LEVELS } from './sampling.js';

export const FEATURE_KINDS = Object.freeze(['numeric', 'gauge']);
export const UNITS = Object.freeze(['mm', 'in', 'deg', 'um', '']);
export const MAX_FEATURES = 200;

/** Company identity printed on every report (the original UCM form). */
export const COMPANY = Object.freeze({
  name: 'UCM Technologies',
  tagline: 'Professional Milling • Turning and Assembly Solutions',
  footerLine: '11 Hidekel St., Building 15, Gav-Yam Park, Yavne | Tel: 08-9421002 | www.ucm.co.il | info@ucm.co.il',
});

/** Header fields of a report, in the order of the original form. */
export const HEADER_FIELDS = Object.freeze([
  { key: 'reportNo', en: 'Report No.' },
  { key: 'inspectionDate', en: 'Date', type: 'date' },
  { key: 'productionOrder', en: 'Prod. order' },
  { key: 'customer', en: 'Customer' },
  { key: 'quantity', en: 'Quantity', numeric: true },
  { key: 'purchaseOrder', en: 'Purchase No.' },
  { key: 'catalogNo', en: 'Catalog No.', product: true },
  { key: 'partNo', en: 'Part No.', product: true },
  { key: 'partName', en: 'Part name', product: true },
  { key: 'revision', en: 'Rev.', product: true },
  { key: 'aql', en: 'AQL', product: true },
  { key: 'inspectionLevel', en: 'Inspection level', product: true, type: 'level' },
  { key: 'generalTolerance', en: 'General tolerance', product: true },
  { key: 'totalInspected', en: 'Total inspected', numeric: true },
  { key: 'accepted', en: 'Accepted', numeric: true },
  { key: 'rejected', en: 'Rejected', numeric: true },
  { key: 'inspector', en: 'Name' },
]);
export const HEADER_KEYS = HEADER_FIELDS.map(f => f.key);
/** Fields that come from the product specification (not typed per report). */
export const PRODUCT_FIELDS = Object.freeze(['partNo', 'revision', 'partName', 'catalogNo', 'customer', 'generalTolerance', 'aql', 'inspectionLevel']);
/** Fields typed for every lot. */
export const ORDER_FIELDS = Object.freeze(['reportNo', 'inspectionDate', 'productionOrder', 'purchaseOrder', 'quantity', 'inspector', 'totalInspected', 'accepted', 'rejected']);

export function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function localDate(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

// ---------- numbers ----------

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** Strict decimal parse of a configuration value ("25", "-0.05", "+0.1", "0,05", ".1"). null when blank, NaN when invalid. */
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

export function unitLabel(unit) {
  return { mm: 'mm', in: 'in', deg: '°', um: 'µm', '': '' }[unit] ?? '';
}

/** Numeric text as the author typed it, tidied: ".1" -> "0.1", "0,05" -> "0.05", "+0.03" -> "0.03" when `unsigned`. */
function tidyNumber(value, unsigned = false) {
  let text = String(value == null ? '' : value).trim().replace(',', '.');
  if (!text) return '';
  if (unsigned) text = text.replace(/^[+-]/, '');
  return text.replace(/^([+-]?)\./, '$10.');
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

/**
 * The "Required" cell as printed on the form: label + nominal (as typed) + unit sign + suffix.
 * "Ø30", "R26", "4.33 x 60°", "90°", "7.50 (x3)", "M16x2".
 */
export function printedRequired(feature) {
  if (!feature) return '';
  const label = String(feature.label || '').trim();
  if (feature.kind !== 'numeric') return label;
  const nominal = tidyNumber(feature.nominal);
  const unit = feature.unit === 'deg' ? '°' : feature.unit === 'in' ? '"' : feature.unit === 'um' ? ' µm' : '';
  const suffix = String(feature.suffix || '').trim();
  // Drawing symbols (Ø, R, SR, ∠) hug the number; words get a space.
  const glue = label && (label.length <= 2 && !/\d/.test(label)) ? '' : ' ';
  const core = nominal ? (label ? label + glue + nominal : nominal) + unit : label;
  return [core, suffix].filter(Boolean).join(' ');
}

/**
 * TOL- / TOL+ cells as printed: magnitudes as typed ("0.1", "0", "0.03").
 * A deviation with the unexpected sign keeps its sign ("+0.05" in TOL- for 20 +0.10/+0.05).
 */
export function printedTolerances(feature) {
  if (!feature || feature.kind !== 'numeric') return { minus: '', plus: '' };
  const upper = tidyNumber(feature.upper);
  if (feature.symmetric) return { minus: tidyNumber(upper, true), plus: tidyNumber(upper, true) };
  const lower = tidyNumber(feature.lower);
  const lo = parseDecimal(lower), up = parseDecimal(upper);
  const minus = lower === '' ? '' : (Number.isFinite(lo) && lo > 0 ? '+' + tidyNumber(lower, true) : tidyNumber(lower, true));
  const plus = upper === '' ? '' : (Number.isFinite(up) && up < 0 ? '-' + tidyNumber(upper, true) : tidyNumber(upper, true));
  return { minus, plus };
}

/** Requirement with its tolerance, for the editor: "Ø30 ±0.1", "20 +0.03 / 0", "M16x2". */
export function requirementText(feature) {
  if (!feature) return '';
  const base = printedRequired(feature) || (feature.kind === 'numeric' ? '?' : '');
  if (feature.kind !== 'numeric') return base;
  const { minus, plus } = printedTolerances(feature);
  if (!plus && !minus) return base;
  const up = plus.startsWith('-') ? plus : '+' + plus;
  const lo = minus === '0' || minus === '' ? '0' : (minus.startsWith('+') ? minus : '-' + minus);
  const tol = feature.symmetric ? '±' + plus : `${up} / ${lo}`;
  return `${base} ${tol}`.trim();
}

/** "24.90 – 25.10" style limits text. */
export function limitsText(feature) {
  const lim = featureLimits(feature);
  if (!lim.ok) return '';
  return `${formatNumber(lim.min, lim.decimals)} – ${formatNumber(lim.max, lim.decimals)}`;
}

/** Problems the author must fix before a feature can produce verdicts. Empty array = fine. */
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

// ---------- products (specification per part number + revision) ----------

export function normalizePartNo(value) { return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toUpperCase(); }
export function normalizeRevision(value) { return String(value == null ? '' : value).trim().replace(/^rev\.?\s*/i, '').toUpperCase(); }
/** Stable key used to find "the same product": part number + revision. */
export function productKey(partNo, revision) { return normalizePartNo(partNo) + '@' + normalizeRevision(revision); }

export function blankProduct() {
  const now = new Date().toISOString();
  return {
    id: newId(), partNo: '', revision: '', partName: '', catalogNo: '', customer: '',
    generalTolerance: '±0.1', aql: '2.5', inspectionLevel: 'II', features: [], sourceFileId: '', sourceReportNo: '',
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
 * Create a fresh report for a product (or an empty one). `previous` supplies the
 * inspector's name, which is the only value that carries over between lots.
 */
export function createReport(product = null, previous = null, now = new Date()) {
  const header = {};
  for (const key of HEADER_KEYS) header[key] = '';
  if (product) for (const key of PRODUCT_FIELDS) header[key] = String(product[key] || '');
  if (!LEVELS.includes(header.inspectionLevel)) header.inspectionLevel = 'II';
  header.inspector = String(previous && previous.header && previous.header.inspector || '');
  header.inspectionDate = localDate(now);
  const features = (product ? product.features : []).map(f => ({ ...f }));
  const results = {};
  features.forEach(f => { results[f.id] = blankResult(); });
  return {
    id: newId(),
    productId: product ? product.id : '', productKey: product ? productKey(product.partNo, product.revision) : '', sourceFileId: '',
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    header, baseline: { ...header }, features, results, remarks: '',
  };
}

/** Refresh a draft from its product (features and product fields), keeping entered results by feature id. */
export function syncReportWithProduct(report, product) {
  if (!product) return report;
  const header = { ...report.header };
  for (const key of PRODUCT_FIELDS) if (String(product[key] || '').trim()) header[key] = String(product[key]);
  const results = {};
  const features = product.features.map(f => ({ ...f }));
  features.forEach(f => { results[f.id] = report.results[f.id] || blankResult(); });
  return { ...report, header, features, results };
}

/**
 * True when the report holds anything the user entered: a measurement, a remark,
 * or a header value that differs from what the product produced at creation.
 */
export function reportHasContent(report) {
  if (!report) return false;
  if (String(report.remarks || '').trim()) return true;
  const baseline = report.baseline || {};
  for (const key of HEADER_KEYS) {
    if (key === 'inspectionDate') continue;
    if (String(report.header[key] || '').trim() !== String(baseline[key] || '').trim()) return true;
  }
  return Object.values(report.results || {}).some(r => r && (String(r.min || '').trim() || String(r.max || '').trim() || r.outcome));
}

export function reportSampling(report) {
  const h = report.header;
  return { plan: samplingPlan(h.quantity, LEVELS.includes(h.inspectionLevel) ? h.inspectionLevel : 'II', h.aql) };
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
  return summarize(report.features, report.results).status;
}

/** Date as printed on the form: dd/mm/yy. */
export function formatDateForReport(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return `${m[3]}/${m[2]}/${m[1].slice(2)}`;
}
