/*
 * Local persistence: one JSON document in localStorage, strict normalisation
 * of anything read back (storage, backups, sync), and backup files.
 */
import {
  HEADER_KEYS, FEATURE_KINDS, UNITS, MAX_FEATURES,
  newId, blankFeature, blankResult, blankProduct, PRODUCT_FIELDS,
} from './core.js';
import { LEVELS } from './sampling.js';

export const STORE_KEY = 'ucm.inspection.v2';
export const BACKUP_FORMAT = 'ucm-inspection-backup';
export const MAX_ARCHIVE = 500;
export const MAX_PRODUCTS = 2000;
export const MAX_IMPORT_BYTES = 12 * 1024 * 1024;

const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

export function emptyState() {
  return { version: 2, draft: null, archive: [], products: [], settings: defaultSettings() };
}
export function defaultSettings() {
  return { lastBackupAt: '', sync: { url: '', key: '', cursor: '', lastSyncAt: '' }, dirty: {}, deleted: {}, autoAi: true };
}

export function normalizeFeature(raw) {
  if (!isObj(raw)) throw new Error('feature');
  // 'visual' rows from earlier versions are attribute checks too
  const kind = FEATURE_KINDS.includes(raw.kind) ? raw.kind : (raw.kind === 'visual' ? 'gauge' : 'numeric');
  const f = blankFeature(kind);
  f.id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 120) : newId();
  f.label = str(raw.label, 200);
  f.suffix = str(raw.suffix, 100);
  f.nominal = kind === 'numeric' ? str(raw.nominal, 40).trim() : '';
  f.upper = kind === 'numeric' ? str(raw.upper, 40).trim() : '';
  f.lower = kind === 'numeric' ? str(raw.lower, 40).trim() : '';
  f.symmetric = kind === 'numeric' ? raw.symmetric !== false : true;
  f.unit = kind === 'numeric' ? (UNITS.includes(raw.unit) ? raw.unit : 'mm') : '';
  f.method = str(raw.method, 200);
  f.note = str(raw.note, 300);
  return f;
}

export function normalizeProduct(raw) {
  if (!isObj(raw) || !Array.isArray(raw.features)) throw new Error('product');
  const p = blankProduct();
  p.id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 120) : newId();
  for (const key of PRODUCT_FIELDS) p[key] = str(raw[key], 240).trim();
  if (!LEVELS.includes(p.inspectionLevel)) p.inspectionLevel = 'II';
  p.features = raw.features.slice(0, MAX_FEATURES).map(normalizeFeature);
  const seen = new Set();
  p.features.forEach(f => { if (seen.has(f.id)) f.id = newId(); seen.add(f.id); });
  p.sourceFileId = str(raw.sourceFileId, 120); p.sourceReportNo = str(raw.sourceReportNo, 80); p.notes = str(raw.notes, 2000);
  p.createdAt = str(raw.createdAt, 40) || p.createdAt; p.updatedAt = str(raw.updatedAt, 40) || p.updatedAt;
  return p;
}

export function normalizeReport(raw) {
  if (!isObj(raw) || !isObj(raw.header) || !Array.isArray(raw.features)) throw new Error('report');
  const header = {}, baseline = {};
  const rawBaseline = isObj(raw.baseline) ? raw.baseline : {};
  for (const key of HEADER_KEYS) { header[key] = str(raw.header[key], 240); baseline[key] = str(rawBaseline[key], 240); }
  if (!LEVELS.includes(header.inspectionLevel)) header.inspectionLevel = 'II';
  const features = raw.features.slice(0, MAX_FEATURES).map(normalizeFeature);
  const results = {};
  const src = isObj(raw.results) ? raw.results : {};
  for (const f of features) {
    const r = isObj(src[f.id]) ? src[f.id] : {};
    results[f.id] = {
      ...blankResult(),
      min: str(r.min, 80), max: str(r.max, 80),
      outcome: ['pass', 'fail'].includes(r.outcome) ? r.outcome : '',
      note: str(r.note, 300),
    };
  }
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 120) : newId(),
    productId: str(raw.productId, 120), productKey: str(raw.productKey, 300), sourceFileId: str(raw.sourceFileId, 120),
    createdAt: str(raw.createdAt, 40) || now, updatedAt: str(raw.updatedAt, 40) || now,
    header, baseline, features, results, remarks: str(raw.remarks, 4000),
  };
}

export function normalizeState(raw) {
  if (!isObj(raw) || raw.version !== 2) throw new Error('state');
  let draft = null;
  if (raw.draft) { try { draft = normalizeReport(raw.draft); } catch (_) { draft = null; } }
  const archive = [];
  if (Array.isArray(raw.archive)) {
    for (const r of raw.archive.slice(0, MAX_ARCHIVE)) { try { archive.push(normalizeReport(r)); } catch (_) { /* skip */ } }
  }
  const ids = new Set();
  archive.forEach(r => { if (ids.has(r.id)) r.id = newId(); ids.add(r.id); });
  const products = [];
  if (Array.isArray(raw.products)) {
    for (const p of raw.products.slice(0, MAX_PRODUCTS)) { try { products.push(normalizeProduct(p)); } catch (_) { /* skip */ } }
  }
  const pids = new Set();
  products.forEach(p => { if (pids.has(p.id)) p.id = newId(); pids.add(p.id); });
  const settings = isObj(raw.settings) ? raw.settings : {};
  return {
    version: 2, draft, archive, products,
    settings: {
      lastBackupAt: str(settings.lastBackupAt, 40),
      sync: isObj(settings.sync) ? { url: str(settings.sync.url, 300), key: str(settings.sync.key, 300), cursor: str(settings.sync.cursor, 40), lastSyncAt: str(settings.sync.lastSyncAt, 40) } : { url: '', key: '', cursor: '', lastSyncAt: '' },
      dirty: isObj(settings.dirty) ? Object.fromEntries(Object.entries(settings.dirty).filter(([k, v]) => v === true && !k.startsWith('template:')).slice(0, 5000)) : {},
      deleted: isObj(settings.deleted) ? Object.fromEntries(Object.entries(settings.deleted).filter(([k, v]) => typeof v === 'string' && !k.startsWith('template:')).slice(0, 5000)) : {},
      autoAi: settings.autoAi !== false,
    },
  };
}

/** Read state from a Storage-like object (getItem/setItem). Never throws. */
export function loadState(storage) {
  let raw = null;
  try { raw = JSON.parse(storage.getItem(STORE_KEY) || 'null'); } catch (_) { raw = null; }
  if (raw) { try { return normalizeState(raw); } catch (_) { /* fall through */ } }
  return emptyState();
}

export function saveState(storage, state) {
  storage.setItem(STORE_KEY, JSON.stringify(state));
}

// ---------- backups ----------

export function buildBackup(state) {
  return {
    format: BACKUP_FORMAT, version: 2, exportedAt: new Date().toISOString(),
    products: state.products || [], archive: state.archive, draft: state.draft,
  };
}

/** Parse backup text. Throws on invalid input. */
export function parseBackup(text) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) throw new Error('size');
  const data = JSON.parse(text);
  if (!isObj(data) || data.format !== BACKUP_FORMAT || data.version !== 2) throw new Error('format');
  const archive = Array.isArray(data.archive) ? data.archive.slice(0, MAX_ARCHIVE).map(normalizeReport) : [];
  let draft = null;
  if (data.draft) { try { draft = normalizeReport(data.draft); } catch (_) { draft = null; } }
  const products = Array.isArray(data.products) ? data.products.slice(0, MAX_PRODUCTS).map(normalizeProduct) : [];
  return { products, archive, draft };
}

/**
 * Merge a parsed backup into state: products and reports with the same id are
 * replaced (products only by a newer copy), new ones are added, nothing is deleted.
 */
export function mergeBackup(state, backup) {
  const archive = state.archive.map(r => ({ ...r }));
  let addedReports = 0, updatedReports = 0;
  for (const r of backup.archive) {
    const i = archive.findIndex(x => x.id === r.id);
    if (i === -1) { archive.push(r); addedReports++; } else { archive[i] = r; updatedReports++; }
  }
  archive.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const products = (state.products || []).map(p => ({ ...p }));
  let addedProducts = 0, updatedProducts = 0;
  for (const p of backup.products || []) {
    const i = products.findIndex(x => x.id === p.id);
    if (i === -1) { if (products.length < MAX_PRODUCTS) { products.push(p); addedProducts++; } }
    else if (String(p.updatedAt) >= String(products[i].updatedAt)) { products[i] = p; updatedProducts++; }
  }
  const draft = state.draft || backup.draft || null;
  return {
    state: { ...state, archive: archive.slice(0, MAX_ARCHIVE), draft, products },
    counts: { addedReports, updatedReports, addedProducts, updatedProducts },
  };
}
