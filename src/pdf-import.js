/*
 * PDF import: turn positioned text items (from pdf.js) into a draft product
 * specification and a draft historical report, with per-field confidence and
 * source rectangles so the UI can show the matching PDF area for confirmation.
 *
 * Pure functions, no DOM. Page text items: { str, x, y, w, h } with y measured
 * from the top of the page in PDF points.
 */
import { blankFeature, blankProduct, blankResult, newId } from './core.js';

// Glyphs that the UCM Access template emits through non-Unicode fonts.
const GLYPH_FIXES = [[/¡\s*(?=\d)/g, 'Ø'], [/£/g, '✓']];
export function fixGlyphs(text) {
  let out = String(text || '');
  for (const [re, rep] of GLYPH_FIXES) out = out.replace(re, rep);
  return out.replace(/\s+/g, ' ').trim();
}

// Header labels and their synonyms (lower-cased, punctuation-insensitive).
const LABELS = {
  reportNo: ['report no', 'report number', 'מספר דוח', 'דוח מס'],
  productionOrder: ['prod order', 'production order', 'prod. order', 'work order', 'פקודת ייצור'],
  customer: ['customer', 'לקוח'],
  quantity: ['quantity', 'qty', 'lot size', 'lot qty', 'כמות'],
  purchaseOrder: ['purchase no', 'purchase order', 'po no', 'p o', 'הזמנת רכש', 'מספר הזמנה'],
  catalogNo: ['catalog no', 'catalogue no', 'catalog', 'מספר קטלוגי', 'מק"ט קטלוגי'],
  partNo: ['part no', 'part number', 'p/n', 'pn', 'מק"ט', 'מקט'],
  partName: ['part name', 'description', 'שם החלק', 'תיאור'],
  revision: ['rev', 'revision', 'rev.', 'מהדורה', 'גרסה'],
  aql: ['inspect methods', 'inspection method', 'aql'],
  sampleSize: ['sample size', 'גודל מדגם'],
  totalInspected: ['total inspected'],
  accepted: ['accepted', 'מאושר'],
  rejected: ['rejected', 'פסול'],
  generalTolerance: ['general tolerance', 'gen tolerance', 'טולרנס כללי'],
  inspector: ['name', 'inspector', 'inspected by', 'בודק', 'שם'],
  inspectionDate: ['date', 'תאריך'],
  // labels that must never be read as values
  _signature: ['signature', 'חתימה'],
  _remarks: ['remarks', 'הערות'],
  _planning: ['inspection planning'],
};
const TABLE_COLUMNS = {
  no: ['no', 'no.', '#', 'item', 'מס'],
  required: ['required', 'nominal', 'dimension', 'spec', 'דרישה', 'מידה'],
  method: ['test', 'equip', 'method', 'equip./method', 'instrument', 'אמצעי'],
  tolMinus: ['tol-', 'tol -', 'tol−', 'lower', 'min tol'],
  tolPlus: ['tol+', 'tol +', 'upper', 'max tol'],
  min: ['min-', 'min', 'actual min', 'min result'],
  max: ['max+', 'max', 'actual max', 'max result'],
};

const norm = s => String(s || '').toLowerCase().replace(/[.:_]/g, ' ').replace(/\s+/g, ' ').trim();

function labelKey(text, dict) {
  const t = norm(text);
  if (!t) return null;
  for (const [key, names] of Object.entries(dict)) {
    for (const n of names) {
      const nn = norm(n);
      if (t === nn || t === nn + ' ' || t.startsWith(nn + ' ') && t.length <= nn.length + 3) return key;
    }
  }
  return null;
}

function rect(items) {
  const x1 = Math.min(...items.map(i => i.x)), y1 = Math.min(...items.map(i => i.y - i.h));
  const x2 = Math.max(...items.map(i => i.x + i.w)), y2 = Math.max(...items.map(i => i.y + i.h * 0.3));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
const overlapY = (a, b, tol = 4) => Math.abs(a.y - b.y) <= tol;

/** Group items into visual lines (same baseline), sorted left to right. */
function lines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const it of sorted) {
    const line = out.find(l => Math.abs(l.y - it.y) <= 5);
    if (line) { line.items.push(it); line.y = (line.y + it.y) / 2; } else out.push({ y: it.y, items: [it] });
  }
  out.forEach(l => l.items.sort((a, b) => a.x - b.x));
  return out;
}

/** Date text in Israeli/European style (d/m/yy, d.m.yyyy) -> ISO. */
export function parseDateText(text) {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(String(text || ''));
  if (iso) return iso[0];
  const m = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(String(text || ''));
  if (!m) return '';
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y;
  const day = Number(d), month = Number(mo);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const NUM = '[+-]?(?:\\d+(?:[.,]\\d+)?|[.,]\\d+)';
const numRe = new RegExp('^' + NUM + '$');
const toNum = s => String(s).replace(',', '.').replace(/^\+/, '').replace(/^(-?)\./, '$10.');

/**
 * Interpret a "Required" cell plus TOL-/TOL+ cells and the method text.
 * Returns a feature (core shape) plus confidence 0..1 and reasons.
 */
export function interpretRequirement(requiredText, tolMinus, tolPlus, methodText) {
  const text = fixGlyphs(requiredText);
  const method = fixGlyphs(methodText);
  const reasons = [];
  const threadLike = /^(?:M\s?\d|#?\d+-\d+\s*UN[CF]|UN[CF]|\d+\/\d+-\d+|G\d|NPT|BSP)/i.test(text) || /\b(M\d+)x/i.test(text);
  const gaugeMethod = /thread|plug|gage|gauge|\bgo\b|no-?go|ring gauge/i.test(method) && !/height|caliper|pin\b|pins|micro|protractor|cmm/i.test(method);
  if (threadLike || (gaugeMethod && !/^\s*[+-]?\d/.test(text))) {
    const f = blankFeature('gauge');
    f.label = text || '';
    f.method = method;
    if (!text) reasons.push('label-missing');
    return { feature: f, confidence: text ? 0.9 : 0.3, reasons };
  }
  const f = blankFeature('numeric');
  f.method = method;
  let rest = text;
  // Angles: "45°", "45° ±1°", "30 deg" -> unit deg, degree signs removed before tolerance parsing
  if (/\u00b0|\bdeg\b/i.test(rest) && !/x\s*\d/.test(rest)) { f.unit = 'deg'; rest = rest.replace(/\u00b0|\bdeg\b/gi, '').replace(/\s+/g, ' ').trim(); }
  // Explicit tolerance inside the text: "20 0 +0.03", "20 +0.03/0", "25 ±0.1", "10 +0.05 -0.02"
  const pm = new RegExp('(' + NUM + ')\\s*(?:\\u00b1|\\+/-|\\+-)\\s*(' + NUM + ')').exec(rest);
  const slash = new RegExp('(' + NUM + ')\\s*(?:\\+\\s*(' + NUM + ')\\s*/\\s*(' + NUM + ')|(' + NUM + ')\\s*\\+\\s*(' + NUM + ')|\\+\\s*(' + NUM + ')\\s*(-' + NUM + '))').exec(rest);
  let nominal = '', upper = '', lower = '', symmetric = true, explicitTol = false;
  let prefix = '', suffix = '';
  if (pm) {
    nominal = toNum(pm[1]); upper = toNum(pm[2]); symmetric = true; explicitTol = true;
    prefix = rest.slice(0, pm.index).trim(); suffix = rest.slice(pm.index + pm[0].length).trim();
  } else if (slash) {
    nominal = toNum(slash[1]); explicitTol = true; symmetric = false;
    if (slash[2] !== undefined) { upper = '+' + toNum(slash[2]); lower = toNum(slash[3]); }
    else if (slash[4] !== undefined) { lower = toNum(slash[4]); upper = '+' + toNum(slash[5]); }
    else { upper = '+' + toNum(slash[6]); lower = toNum(slash[7]); }
    if (lower && !/^[+-]/.test(lower) && Number(lower) !== 0) lower = '-' + lower;
    prefix = rest.slice(0, slash.index).trim(); suffix = rest.slice(slash.index + slash[0].length).trim();
  } else {
    const m = new RegExp('(' + NUM + ')').exec(rest);
    if (m) { nominal = toNum(m[1]); prefix = rest.slice(0, m.index).trim(); suffix = rest.slice(m.index + m[0].length).trim(); }
  }
  // Unit / symbol handling
  if (/°/.test(suffix) && suffix.replace(/°/g, '').trim() === '') { f.unit = 'deg'; suffix = ''; }
  else if (/^°/.test(suffix)) { f.unit = 'deg'; suffix = suffix.replace(/^°\s*/, ''); }
  prefix = prefix.replace(/^[Ø⌀ø]$/, 'Ø').replace(/^(?:dia|diam)\.?$/i, 'Ø');
  f.label = prefix; f.suffix = suffix; f.nominal = nominal;
  if (!nominal) reasons.push('nominal-missing');
  if (f.unit !== 'deg' && !explicitTol) {
    const tm = fixGlyphs(tolMinus), tp = fixGlyphs(tolPlus);
    const tmN = numRe.test(tm) ? Math.abs(Number(toNum(tm))) : null;
    const tpN = numRe.test(tp) ? Math.abs(Number(toNum(tp))) : null;
    if (tmN !== null && tpN !== null) {
      if (tmN === tpN) { symmetric = true; upper = String(tpN); }
      else { symmetric = false; upper = '+' + String(tpN); lower = tmN === 0 ? '0' : '-' + String(tmN); }
    } else if (tpN !== null && !tm) { symmetric = false; upper = '+' + String(tpN); lower = '0'; reasons.push('lower-assumed-zero'); }
    else reasons.push('tolerance-missing');
  } else if (f.unit === 'deg' && !explicitTol) {
    reasons.push('tolerance-missing');
  }
  f.symmetric = symmetric; f.upper = upper; f.lower = symmetric ? '' : lower;
  if (symmetric && upper.startsWith('+')) f.upper = upper.slice(1);
  if (/°/.test(suffix) || /x\s*\d/.test(suffix)) reasons.push('composite');
  let confidence = 0.95;
  if (reasons.includes('nominal-missing')) confidence = 0.2;
  else if (reasons.includes('tolerance-missing')) confidence = 0.5;
  else if (reasons.includes('lower-assumed-zero') || reasons.includes('composite')) confidence = 0.7;
  return { feature: f, confidence, reasons };
}

/** Interpret an actual-result cell: number, "R25.97", "Ø30.02", "✓" (pass), "X"/"NOK" (fail). */
export function interpretResult(text) {
  const t = fixGlyphs(text);
  if (!t) return { value: '', outcome: '' };
  if (/^[✓✔vV]$|^ok$|^pass$|^go$/i.test(t)) return { value: '', outcome: 'pass' };
  if (/^[xX✗✘]$|^nok$|^fail$|^no-?go$/i.test(t)) return { value: '', outcome: 'fail' };
  const m = new RegExp('(' + NUM + ')').exec(t);
  return { value: m ? toNum(m[1]) : t, outcome: '' };
}

/**
 * Parse one page's text items into header pairs and table rows.
 * @param {Array<{str,x,y,w,h}>} items
 * @param {{width:number,height:number,images?:Array<{x,y,w,h}>}} page
 */
export function parsePage(items, page, pageIndex) {
  const clean = items.filter(i => i.str && i.str.trim()).map(i => ({ ...i, str: i.str.trim() }));
  const header = {};
  const ls = lines(clean);
  // Header: label item followed on the same line by a value item to its right (within 260pt).
  for (const line of ls) {
    for (let k = 0; k < line.items.length; k++) {
      const key = labelKey(line.items[k].str, LABELS);
      if (!key || key.startsWith('_')) continue;
      const right = line.items.slice(k + 1).filter(v => v.x > line.items[k].x + line.items[k].w - 2 && v.x - (line.items[k].x + line.items[k].w) < 260 && !labelKey(v.str, LABELS));
      if (!right.length) continue;
      const valueItems = [right[0]];
      for (const v of right.slice(1)) { if (v.x - (valueItems[valueItems.length - 1].x + valueItems[valueItems.length - 1].w) < 40) valueItems.push(v); else break; }
      const text = fixGlyphs(valueItems.map(v => v.str).join(' '));
      if (!header[key]) header[key] = { text, rect: rect(valueItems), page: pageIndex, confidence: 0.9 };
    }
  }
  // Labels whose value sits on the next line (e.g. NAME / DATE above the signature row)
  for (const line of ls) {
    for (const it of line.items) {
      const key = labelKey(it.str, LABELS);
      if (!key || key.startsWith('_') || header[key]) continue;
      const below = clean.filter(v => v.y > it.y + 6 && v.y < it.y + 40 && v.x < it.x + it.w + 10 && v.x + v.w > it.x - 10 && !labelKey(v.str, LABELS))
        .sort((a, b) => a.y - b.y || a.x - b.x);
      if (!below.length) continue;
      const first = below[0];
      const group = below.filter(b => overlapY(b, first, 5));
      header[key] = { text: fixGlyphs(group.map(g => g.str).join(' ')), rect: rect(group), page: pageIndex, confidence: 0.75 };
    }
  }
  // Report number: a token like 9515_2 / 12345 / FIR-0001 near the title "FINAL INSPECTION REPORT"
  const title = clean.find(i => /final inspection report|inspection report/i.test(i.str));
  if (title) {
    const below = clean.filter(i => i.y > title.y && i.y < title.y + 70 && i.x > title.x - 40 && i.x < title.x + title.w + 40 && /^[\w\-_/]+$/.test(i.str) && /\d/.test(i.str)).sort((a, b) => a.y - b.y || a.x - b.x);
    if (below.length) {
      const first = below[0];
      const group = below.filter(b => overlapY(b, first, 6)).sort((a, b) => a.x - b.x);
      header.reportNo = { text: group.map(g => g.str).join(''), rect: rect(group), page: pageIndex, confidence: 0.8 };
    }
  }
  // Page "n from m"
  const pg = clean.map(i => /page\s*(\d+)\s*(?:from|of)\s*(\d+)/i.exec(i.str)).find(Boolean);
  const pageInfo = pg ? { index: Number(pg[1]), count: Number(pg[2]) } : null;

  // Table: locate column headers
  const cols = {};
  for (const it of clean) {
    const key = labelKey(it.str, TABLE_COLUMNS);
    if (key && !cols[key]) cols[key] = { x: it.x + it.w / 2, y: it.y, item: it };
  }
  // "ACTUAL RESULT" + "Min-" / "Max+" pairs: prefer the sub-labels
  const rows = [];
  if (cols.no && cols.required) {
    const headerY = Math.max(...Object.values(cols).map(c => c.y));
    const centers = Object.entries(cols).map(([k, c]) => [k, c.x]).sort((a, b) => a[1] - b[1]);
    const bounds = centers.map(([k, x], i) => {
      const left = i === 0 ? 0 : (centers[i - 1][1] + x) / 2;
      const right = i === centers.length - 1 ? page.width : (x + centers[i + 1][1]) / 2;
      return { key: k, left, right };
    });
    const colOf = it => { const cx = it.x + it.w / 2; const b = bounds.find(b => cx >= b.left && cx < b.right); return b ? b.key : null; };
    const noBound = bounds.find(b => b.key === 'no');
    const rowNos = clean.filter(it => it.y > headerY + 6 && /^\d{1,3}$/.test(it.str) && (it.x + it.w / 2) >= noBound.left && (it.x + it.w / 2) < noBound.right)
      .sort((a, b) => a.y - b.y);
    const body = clean.filter(it => it.y > headerY + 6);
    rowNos.forEach((rn, i) => {
      const top = i === 0 ? headerY + 6 : (rowNos[i - 1].y + rn.y) / 2;
      const bottom = i === rowNos.length - 1 ? rn.y + 18 : (rn.y + rowNos[i + 1].y) / 2;
      const cells = {};
      for (const it of body) {
        if (it === rn || it.y - 2 < top || it.y - 2 >= bottom) continue;
        const key = colOf(it);
        if (!key || key === 'no') continue;
        (cells[key] = cells[key] || []).push(it);
      }
      const cellText = k => cells[k] ? fixGlyphs(cells[k].sort((a, b) => a.y - b.y || a.x - b.x).map(x => x.str).join(' ')) : '';
      const reqBound = bounds.find(b => b.key === 'required');
      const rowRect = { x: 0, y: top - 2, w: page.width, h: bottom - top + 2 };
      const requiredRect = { x: reqBound.left, y: top - 2, w: reqBound.right - reqBound.left, h: bottom - top + 2 };
      // Cell-sized images only (not full-page backgrounds or logos)
      const hasImage = (page.images || []).some(im => im.w < page.width * 0.5 && im.h < 80 && im.y + im.h > top && im.y < bottom && im.x + im.w > reqBound.left && im.x < reqBound.right);
      rows.push({
        no: Number(rn.str), page: pageIndex, rowRect, requiredRect, hasImage,
        required: cellText('required'), method: cellText('method'), tolMinus: cellText('tolMinus'), tolPlus: cellText('tolPlus'),
        min: cellText('min'), max: cellText('max'),
      });
    });
  }
  return { header, rows, pageInfo, hasText: clean.length > 0 };
}

/**
 * Combine parsed pages into an import draft: product spec + historical report + review flags.
 * @param {Array<{items, width, height, images}>} pages
 */
export function buildImportDraft(pages) {
  const parsed = pages.map((p, i) => parsePage(p.items, p, i));
  const header = {};
  for (const p of parsed) for (const [k, v] of Object.entries(p.header)) if (!header[k]) header[k] = v;
  const rowsByNo = new Map();
  for (const p of parsed) for (const r of p.rows) if (!rowsByNo.has(r.no)) rowsByNo.set(r.no, r);
  const rows = [...rowsByNo.values()].sort((a, b) => a.no - b.no);
  const fields = {};
  const val = k => (header[k] ? header[k].text : '');
  const set = (key, text, conf, src) => { fields[key] = { value: text, confidence: conf, source: src || null, needsReview: conf < 0.8 || !text }; };
  set('partNo', val('partNo') || val('catalogNo'), header.partNo ? 0.9 : header.catalogNo ? 0.7 : 0, header.partNo || header.catalogNo);
  set('revision', val('revision'), header.revision ? 0.85 : 0, header.revision);
  set('partName', val('partName'), header.partName ? 0.85 : 0, header.partName);
  set('catalogNo', val('catalogNo'), header.catalogNo ? 0.9 : 0, header.catalogNo);
  set('customer', val('customer'), header.customer ? 0.85 : 0, header.customer);
  const tolText = val('generalTolerance').replace(/\+\/-|\+-/, '±');
  set('generalTolerance', tolText, header.generalTolerance ? 0.9 : 0, header.generalTolerance);
  const aqlM = /(\d+(?:[.,]\d+)?)/.exec(val('aql'));
  set('aql', aqlM ? aqlM[1].replace(',', '.') : '', aqlM ? 0.85 : 0, header.aql);
  set('reportNo', val('reportNo'), header.reportNo ? header.reportNo.confidence : 0, header.reportNo);
  set('productionOrder', val('productionOrder'), header.productionOrder ? 0.85 : 0, header.productionOrder);
  set('purchaseOrder', val('purchaseOrder'), header.purchaseOrder ? 0.85 : 0, header.purchaseOrder);
  const qty = /(\d[\d,]*)/.exec(val('quantity'));
  set('quantity', qty ? qty[1].replace(/,/g, '') : '', qty ? 0.9 : 0, header.quantity);
  set('inspector', val('inspector'), header.inspector ? 0.8 : 0, header.inspector);
  const date = parseDateText(val('inspectionDate'));
  set('inspectionDate', date, date ? 0.8 : 0, header.inspectionDate);
  set('accepted', (/(\d+)/.exec(val('accepted')) || [])[1] || '', header.accepted ? 0.85 : 0, header.accepted);
  set('rejected', (/(\d+)/.exec(val('rejected')) || [])[1] || '', header.rejected ? 0.85 : 0, header.rejected);
  set('sampleSize', (/(\d+)/.exec(val('sampleSize')) || [])[1] || '', header.sampleSize ? 0.85 : 0, header.sampleSize);

  const features = rows.map(r => {
    const { feature, confidence, reasons } = interpretRequirement(r.required, r.tolMinus, r.tolPlus, r.method);
    const min = interpretResult(r.min), max = interpretResult(r.max);
    const result = blankResult();
    if (feature.kind === 'numeric') { result.min = min.value; result.max = max.value; }
    else result.outcome = min.outcome || max.outcome || '';
    // A gauge-method row with numeric results (e.g. thread depth) is a numeric characteristic whose nominal is still unknown
    if (feature.kind === 'gauge' && !r.required && !min.outcome && !max.outcome && (min.value || max.value)) {
      const nf = blankFeature('numeric'); nf.method = feature.method; Object.assign(feature, nf, { id: feature.id });
      result.min = min.value; result.max = max.value; result.outcome = '';
      reasons.push('nominal-missing');
    }
    // Gauge rows detected only from checkmark results
    if (feature.kind === 'numeric' && !r.required && (min.outcome || max.outcome)) { feature.kind = 'gauge'; feature.nominal = ''; feature.upper = ''; feature.lower = ''; feature.unit = ''; result.min = ''; result.max = ''; result.outcome = min.outcome || max.outcome; }
    const needsReview = r.hasImage || !r.required || confidence < 0.8;
    const why = [...reasons];
    if (r.hasImage && !r.required) why.unshift('image-cell');
    return { no: r.no, feature, result, confidence: r.hasImage && !r.required ? 0.1 : confidence, reasons: why, needsReview, source: { page: r.page, rect: r.rowRect, requiredRect: r.requiredRect }, raw: { required: r.required, method: r.method, tolMinus: r.tolMinus, tolPlus: r.tolPlus, min: r.min, max: r.max } };
  });
  const pageCounts = parsed.map(p => p.pageInfo).filter(Boolean);
  const expectedPages = pageCounts.length ? Math.max(...pageCounts.map(p => p.count)) : pages.length;
  return {
    fields, features, rows,
    pageCount: pages.length, expectedPages, hasText: parsed.some(p => p.hasText),
    missingPages: expectedPages > pages.length,
    summary: { rows: features.length, reviewRows: features.filter(f => f.needsReview).length, reviewFields: Object.values(fields).filter(f => f.needsReview).length },
  };
}

/** Turn a confirmed import draft into a product record. */
export function draftToProduct(draft, overrides = {}) {
  const p = blankProduct();
  for (const key of ['partNo', 'revision', 'partName', 'catalogNo', 'customer', 'generalTolerance', 'aql']) {
    p[key] = String((overrides[key] ?? (draft.fields[key] && draft.fields[key].value)) || '').trim();
  }
  p.inspectionLevel = overrides.inspectionLevel || '';
  p.features = draft.features.map(f => ({ ...f.feature, id: f.feature.id || newId() }));
  p.sourceReportNo = String(draft.fields.reportNo ? draft.fields.reportNo.value : '');
  return p;
}
