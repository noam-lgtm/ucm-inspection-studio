/*
 * Local persistence: one JSON document in localStorage, strict normalisation
 * of anything read back (storage, backups, legacy v1 data), and backup files.
 */
import {
  HEADER_FIELDS, HEADER_KEYS, FEATURE_KINDS, UNITS, FIELD_MODES, MAX_FEATURES,
  newId, defaultTemplate, defaultFieldPolicy, blankFeature, blankResult, createReport,
} from './core.js';
import { LEVELS } from './sampling.js';

export const STORE_KEY = 'ucm.inspection.v2';
export const LEGACY_KEY = 'ucm.inspection.local.v1';
export const BACKUP_FORMAT = 'ucm-inspection-backup';
export const MAX_TEMPLATES = 50;
export const MAX_ARCHIVE = 500;
export const MAX_IMPORT_BYTES = 12 * 1024 * 1024;
const LOGO_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO_CHARS = 800000;

const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

export function emptyState() {
  const starter = defaultTemplate();
  return { version: 2, templates: [starter], activeTemplateId: starter.id, draft: null, archive: [], settings: { lastBackupAt: '' } };
}

export function normalizeFeature(raw) {
  if (!isObj(raw)) throw new Error('feature');
  const kind = FEATURE_KINDS.includes(raw.kind) ? raw.kind : 'numeric';
  const f = blankFeature(kind);
  f.id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 120) : newId();
  f.label = str(raw.label, 200);
  f.nominal = kind === 'numeric' ? str(raw.nominal, 40).trim() : '';
  f.upper = kind === 'numeric' ? str(raw.upper, 40).trim() : '';
  f.lower = kind === 'numeric' ? str(raw.lower, 40).trim() : '';
  f.symmetric = kind === 'numeric' ? raw.symmetric !== false : true;
  f.unit = kind === 'numeric' ? (UNITS.includes(raw.unit) ? raw.unit : 'mm') : '';
  f.method = str(raw.method, 200);
  f.note = str(raw.note, 300);
  return f;
}

export function normalizeTemplate(raw) {
  if (!isObj(raw) || !Array.isArray(raw.features)) throw new Error('template');
  const t = defaultTemplate();
  t.id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 120) : newId();
  t.name = str(raw.name, 120).trim() || t.name;
  t.updatedAt = str(raw.updatedAt, 40) || new Date().toISOString();
  const company = isObj(raw.company) ? raw.company : {};
  t.company = {
    name: str(company.name, 200), tagline: str(company.tagline, 300), footer: str(company.footer, 500),
    logo: typeof company.logo === 'string' && company.logo.length <= MAX_LOGO_CHARS && LOGO_RE.test(company.logo) ? company.logo : '',
    standardName: str(company.standardName, 80) || 'MIL-STD-105D',
  };
  const numbering = isObj(raw.numbering) ? raw.numbering : {};
  const next = Number(numbering.next);
  t.numbering = {
    mode: numbering.mode === 'manual' ? 'manual' : 'auto',
    prefix: str(numbering.prefix, 40),
    next: Number.isSafeInteger(next) && next >= 1 ? next : 1,
    width: Number.isSafeInteger(Number(numbering.width)) ? Math.max(0, Math.min(8, Number(numbering.width))) : 4,
  };
  const policy = defaultFieldPolicy();
  const fields = isObj(raw.fields) ? raw.fields : {};
  for (const key of HEADER_KEYS) {
    const p = isObj(fields[key]) ? fields[key] : null;
    if (p) {
      policy[key] = { mode: FIELD_MODES.includes(p.mode) ? p.mode : policy[key].mode, value: str(p.value, 240) };
    }
  }
  if (!LEVELS.includes(policy.inspectionLevel.value)) policy.inspectionLevel.value = 'II';
  for (const def of HEADER_FIELDS) if (!def.lockable) policy[def.key] = { mode: 'blank', value: '' };
  t.fields = policy;
  t.features = raw.features.slice(0, MAX_FEATURES).map(normalizeFeature);
  const seen = new Set();
  t.features.forEach(f => { if (seen.has(f.id)) f.id = newId(); seen.add(f.id); });
  if (!t.features.length) t.features = [blankFeature('numeric')];
  return t;
}

export function normalizeReport(raw) {
  if (!isObj(raw) || !isObj(raw.header) || !Array.isArray(raw.features)) throw new Error('report');
  const header = {}, baseline = {};
  const rawBaseline = isObj(raw.baseline) ? raw.baseline : {};
  for (const key of HEADER_KEYS) { header[key] = str(raw.header[key], 240); baseline[key] = str(rawBaseline[key], 240); }
  if (!LEVELS.includes(header.inspectionLevel)) header.inspectionLevel = header.inspectionLevel ? 'II' : '';
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
    templateId: str(raw.templateId, 120), templateName: str(raw.templateName, 120),
    createdAt: str(raw.createdAt, 40) || now, updatedAt: str(raw.updatedAt, 40) || now,
    header, baseline, features, results, remarks: str(raw.remarks, 4000),
  };
}

/** Convert the v1 prototype's localStorage document to v2. Returns null when not applicable. */
export function migrateV1(raw) {
  if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.templates) || !raw.templates.length) return null;
  const templates = [];
  for (const old of raw.templates) {
    if (!isObj(old) || !Array.isArray(old.features)) continue;
    const t = defaultTemplate();
    t.id = typeof old.id === 'string' && old.id ? old.id : newId();
    t.name = str(old.name, 120) || t.name;
    const c = isObj(old.company) ? old.company : {};
    t.company.name = str(c.name, 200); t.company.tagline = str(c.tagline, 300); t.company.footer = str(c.footer, 500);
    t.company.logo = typeof c.logo === 'string' && LOGO_RE.test(c.logo) && c.logo.length <= MAX_LOGO_CHARS ? c.logo : '';
    t.numbering = { mode: 'manual', prefix: '', next: 1, width: 4 };
    const defaults = isObj(old.defaults) ? old.defaults : {};
    const keep = isObj(old.keep) ? old.keep : {};
    for (const def of HEADER_FIELDS) {
      if (!def.lockable) continue;
      const value = str(defaults[def.key], 240);
      t.fields[def.key] = { mode: keep[def.key] ? 'fixed' : (value ? 'default' : t.fields[def.key].mode), value };
    }
    if (!LEVELS.includes(t.fields.inspectionLevel.value)) t.fields.inspectionLevel.value = 'II';
    t.features = old.features.slice(0, MAX_FEATURES).map(f => {
      if (!isObj(f)) return blankFeature('numeric');
      const kind = f.kind === 'gauge' ? 'gauge' : 'numeric';
      const nf = blankFeature(kind);
      nf.id = typeof f.id === 'string' && f.id ? f.id : newId();
      nf.method = str(f.method, 200);
      nf.unit = f.unit === 'deg' ? 'deg' : (kind === 'numeric' ? 'mm' : '');
      const required = str(f.required, 300).trim();
      if (kind === 'numeric') {
        const nominal = str(f.nominal, 40).trim(), minus = str(f.minus, 40).trim(), plus = str(f.plus, 40).trim();
        nf.nominal = nominal;
        nf.symmetric = Boolean(minus) && minus === plus;
        nf.upper = plus;
        nf.lower = minus ? (minus.startsWith('-') ? minus.slice(1) : '-' + minus) : '';
        if (nf.lower === '-0') nf.lower = '0';
        // The old free-text "required" is preserved as the label, unless it merely repeats the nominal.
        const bare = required.replace(/[^\d.,+-/± ]/g, '').trim();
        const repeatsNominal = required && nominal && (required === nominal || Number(required.replace(',', '.')) === Number(nominal.replace(',', '.')) || bare.startsWith(nominal));
        nf.label = repeatsNominal ? '' : required;
        if (!repeatsNominal && required) nf.note = 'Migrated: original requirement text "' + required + '"';
      } else {
        nf.label = required;
      }
      return nf;
    });
    if (!t.features.length) t.features = [blankFeature('numeric')];
    templates.push(t);
  }
  if (!templates.length) return null;
  const active = templates.find(t => t.id === raw.activeId) || templates[0];
  let draft = null;
  if (isObj(raw.report) && isObj(raw.report.header)) {
    draft = createReport(active);
    for (const key of HEADER_KEYS) if (raw.report.header[key] != null) draft.header[key] = str(raw.report.header[key], 240);
    if (!LEVELS.includes(draft.header.inspectionLevel)) draft.header.inspectionLevel = 'II';
    const m = isObj(raw.report.measurements) ? raw.report.measurements : {};
    for (const f of draft.features) {
      const r = isObj(m[f.id]) ? m[f.id] : {};
      draft.results[f.id] = { ...blankResult(), min: str(r.min, 80), max: str(r.max, 80), outcome: ['pass', 'fail'].includes(r.outcome) ? r.outcome : '' };
    }
    draft.remarks = str(raw.report.remarks, 4000);
    draft.createdAt = str(raw.report.createdAt, 40) || draft.createdAt;
  }
  return { version: 2, templates, activeTemplateId: active.id, draft, archive: [], settings: { lastBackupAt: '', migratedFromV1: true } };
}

export function normalizeState(raw) {
  if (!isObj(raw) || raw.version !== 2 || !Array.isArray(raw.templates)) throw new Error('state');
  const templates = [];
  for (const t of raw.templates.slice(0, MAX_TEMPLATES)) { try { templates.push(normalizeTemplate(t)); } catch (_) { /* skip broken template */ } }
  if (!templates.length) templates.push(defaultTemplate());
  const seen = new Set();
  templates.forEach(t => { if (seen.has(t.id)) t.id = newId(); seen.add(t.id); });
  const active = templates.find(t => t.id === raw.activeTemplateId) || templates[0];
  let draft = null;
  if (raw.draft) { try { draft = normalizeReport(raw.draft); } catch (_) { draft = null; } }
  const archive = [];
  if (Array.isArray(raw.archive)) {
    for (const r of raw.archive.slice(0, MAX_ARCHIVE)) { try { archive.push(normalizeReport(r)); } catch (_) { /* skip */ } }
  }
  const ids = new Set();
  archive.forEach(r => { if (ids.has(r.id)) r.id = newId(); ids.add(r.id); });
  const settings = isObj(raw.settings) ? raw.settings : {};
  return {
    version: 2, templates, activeTemplateId: active.id, draft, archive,
    settings: { lastBackupAt: str(settings.lastBackupAt, 40), migratedFromV1: Boolean(settings.migratedFromV1) },
  };
}

/** Read state from a Storage-like object (getItem/setItem). Never throws. */
export function loadState(storage) {
  let v2 = null;
  try { v2 = JSON.parse(storage.getItem(STORE_KEY) || 'null'); } catch (_) { v2 = null; }
  if (v2) { try { return normalizeState(v2); } catch (_) { /* fall through */ } }
  let v1 = null;
  try { v1 = JSON.parse(storage.getItem(LEGACY_KEY) || 'null'); } catch (_) { v1 = null; }
  const migrated = migrateV1(v1);
  if (migrated) { try { return normalizeState(migrated); } catch (_) { /* fall through */ } }
  return emptyState();
}

export function saveState(storage, state) {
  storage.setItem(STORE_KEY, JSON.stringify(state));
}

// ---------- backups ----------

export function buildBackup(state, { includeReports = true } = {}) {
  return {
    format: BACKUP_FORMAT, version: 2, exportedAt: new Date().toISOString(),
    templates: state.templates, activeTemplateId: state.activeTemplateId,
    archive: includeReports ? state.archive : [],
    draft: includeReports ? state.draft : null,
  };
}

/** Parse backup text (v2 backup, or the v1 "ucm-inspection-templates" export). Throws on invalid input. */
export function parseBackup(text) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) throw new Error('size');
  const data = JSON.parse(text);
  if (!isObj(data)) throw new Error('format');
  if (data.format === 'ucm-inspection-templates' && data.version === 1 && Array.isArray(data.templates)) {
    const migrated = migrateV1({ version: 1, templates: data.templates, activeId: data.activeId, report: null });
    if (!migrated) throw new Error('format');
    return { templates: migrated.templates, archive: [], draft: null, legacy: true };
  }
  if (data.format !== BACKUP_FORMAT || data.version !== 2 || !Array.isArray(data.templates)) throw new Error('format');
  const templates = data.templates.slice(0, MAX_TEMPLATES).map(normalizeTemplate);
  const archive = Array.isArray(data.archive) ? data.archive.slice(0, MAX_ARCHIVE).map(normalizeReport) : [];
  let draft = null;
  if (data.draft) { try { draft = normalizeReport(data.draft); } catch (_) { draft = null; } }
  if (!templates.length) throw new Error('empty');
  return { templates, archive, draft, legacy: false };
}

/**
 * Merge a parsed backup into state: templates and reports with the same id are
 * replaced, new ones are added, nothing is deleted. Returns a new state and counts.
 */
export function mergeBackup(state, backup) {
  const templates = state.templates.map(t => ({ ...t }));
  let addedTemplates = 0, updatedTemplates = 0;
  for (const t of backup.templates) {
    const i = templates.findIndex(x => x.id === t.id);
    if (i === -1) { if (templates.length < MAX_TEMPLATES) { templates.push(t); addedTemplates++; } }
    else { templates[i] = t; updatedTemplates++; }
  }
  const archive = state.archive.map(r => ({ ...r }));
  let addedReports = 0, updatedReports = 0;
  for (const r of backup.archive) {
    const i = archive.findIndex(x => x.id === r.id);
    if (i === -1) { archive.push(r); addedReports++; } else { archive[i] = r; updatedReports++; }
  }
  archive.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const trimmed = archive.slice(0, MAX_ARCHIVE);
  const draft = state.draft || backup.draft || null;
  const activeTemplateId = templates.some(t => t.id === state.activeTemplateId) ? state.activeTemplateId : templates[0].id;
  return {
    state: { ...state, templates, archive: trimmed, draft, activeTemplateId },
    counts: { addedTemplates, updatedTemplates, addedReports, updatedReports },
  };
}
