/* Import wizard: file -> parse -> (AI) -> review -> product + archived report. */
import * as Core from './core.js';
import { t } from './i18n.js';
import { buildImportDraft, draftToProduct } from './pdf-import.js';
import { mergeAiIntoDraft } from './ai-merge.js';
import { loadPdf, loadImage, renderPage, cropDataUrl, pageJpegBase64 } from './pdf-render.js';
import { aiExtract, uploadFile, syncConfigured } from './sync.js';
import { escapeHtml as esc } from './report-sheet.js';
import { LEVELS } from './sampling.js';

const attr = esc;
const option = (v, label, sel) => `<option value="${attr(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
const FIELD_ORDER = ['partNo', 'revision', 'partName', 'catalogNo', 'customer', 'generalTolerance', 'aql', 'reportNo', 'inspectionDate', 'inspector', 'purchaseOrder', 'productionOrder', 'quantity', 'sampleSize', 'totalInspected', 'accepted', 'rejected'];
const PRODUCT_KEYS = ['partNo', 'revision', 'partName', 'catalogNo', 'customer', 'generalTolerance', 'aql'];

export function newImportState() {
  return { step: 'pick', fileName: '', fileBlob: null, source: null, draft: null, canvases: [], scale: 2.2, crops: {}, aiStatus: '', aiMessage: '', busy: false, saveReport: true, uploadFile: true, error: '' };
}

function confBadge(c) {
  const cls = c >= 0.8 ? 'ok' : c >= 0.5 ? 'review' : 'fail';
  const key = c >= 0.8 ? 'conf_high' : c >= 0.5 ? 'conf_mid' : 'conf_low';
  return `<span class="pill pill-${cls}">${esc(t(key))}</span>`;
}
const reasonsText = reasons => (reasons || []).map(r => t('reason_' + r.replace(/-/g, '_'))).join(' · ');

export async function startImport(ctx, file) {
  const im = ctx.ui.import;
  Object.assign(im, newImportState(), { step: 'reading', fileName: file.name, fileBlob: file, busy: true });
  ctx.render();
  try {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    im.source = isPdf ? await loadPdf(await file.arrayBuffer()) : await loadImage(file);
    im.draft = buildImportDraft(im.source.pages);
    im.canvases = [];
    for (let i = 0; i < im.source.pages.length; i++) im.canvases.push(await renderPage(im.source, i, im.scale));
    buildCrops(im);
    im.step = 'review'; im.busy = false;
    ctx.render();
    const needsAi = !im.draft.hasText || im.draft.summary.reviewRows > 0;
    if (needsAi && syncConfigured(ctx.state.settings) && ctx.state.settings.autoAi !== false && ctx.aiAvailable()) await runAi(ctx);
  } catch (error) {
    im.step = 'pick'; im.busy = false; im.error = t('import_unreadable') + (error && error.message ? ' (' + error.message + ')' : '');
    ctx.render();
  }
}

function buildCrops(im) {
  im.crops = {};
  for (const f of im.draft.features) {
    if (!f.source || !im.canvases[f.source.page]) continue;
    const canvas = im.canvases[f.source.page];
    im.crops[f.no] = { required: cropDataUrl(canvas, f.source.requiredRect, im.scale, 2), row: cropDataUrl(canvas, f.source.rect, im.scale, 1) };
  }
  for (const [key, field] of Object.entries(im.draft.fields)) {
    if (field.source && field.source.rect && im.canvases[field.source.page]) im.crops['field:' + key] = cropDataUrl(im.canvases[field.source.page], field.source.rect, im.scale, 4);
  }
}

export async function runAi(ctx) {
  const im = ctx.ui.import;
  if (!im.draft || im.busy) return;
  im.aiStatus = 'running'; im.aiMessage = t('import_ai_running'); im.busy = true; ctx.render();
  try {
    const pages = [];
    for (let i = 0; i < im.source.pages.length && i < 8; i++) pages.push({ mime: 'image/jpeg', base64: await pageJpegBase64(im.source, i) });
    const hints = { fields: Object.fromEntries(Object.entries(im.draft.fields).map(([k, v]) => [k, v.value])), rows: im.draft.features.map(f => ({ no: f.no, required: f.raw && f.raw.required, method: f.feature.method, min: f.result.min, max: f.result.max, imageCell: f.reasons.includes('image-cell') })) };
    const ai = await aiExtract(ctx.state.settings, pages, hints);
    const summary = mergeAiIntoDraft(im.draft, ai);
    im.aiStatus = 'done'; im.aiMessage = t('import_ai_done', { n: summary.rowsFilled + summary.rowsAdded, f: summary.fieldsFilled });
    buildCrops(im);
  } catch (error) {
    im.aiStatus = 'failed'; im.aiMessage = t('import_ai_failed', { err: error && error.message || error });
  }
  im.busy = false; ctx.render();
}

function fieldRow(ctx, key, f) {
  const crop = ctx.ui.import.crops['field:' + key];
  const label = key === 'sampleSize' ? t('f_sampleSize') : t('f_' + key);
  let control;
  if (key === 'aql') {
    control = `<input name="imf:aql" value="${attr(f.value)}" dir="ltr" inputmode="decimal">`;
  } else if (key === 'inspectionDate') control = `<input name="imf:inspectionDate" type="date" value="${attr(f.value)}">`;
  else control = `<input name="imf:${attr(key)}" value="${attr(f.value)}" dir="auto">`;
  const alt = f.aiValue ? `<div class="im-alt">${esc(t('import_ai_suggest', { v: f.aiValue }))} <button type="button" class="btn btn-small" data-action="im-use-ai-field" data-key="${attr(key)}">${esc(t('import_use_ai'))}</button></div>` : '';
  return `<div class="field im-field${f.needsReview ? ' needs' : ''}"><label>${esc(label)} ${f.value ? confBadge(f.confidence) : ''}</label>${control}${crop ? `<img class="im-crop-small" src="${crop}" alt="">` : ''}${alt}</div>`;
}

function rowEditor(ctx, f, i) {
  const im = ctx.ui.import;
  const feat = f.feature;
  const numeric = feat.kind === 'numeric';
  const crops = im.crops[f.no] || {};
  const kindSel = `<select name="imr:kind" data-i="${i}">${option('numeric', t('kind_numeric'), numeric)}${option('gauge', t('kind_gauge'), feat.kind === 'gauge')}${option('visual', t('kind_visual'), feat.kind === 'visual')}</select>`;
  const tolSel = `<select name="imr:symmetric" data-i="${i}">${option('1', t('tol_type_sym'), feat.symmetric)}${option('0', t('tol_type_asym'), !feat.symmetric)}</select>`;
  const unitSel = `<select name="imr:unit" data-i="${i}">${['mm', 'in', 'deg', 'um', ''].map(u => option(u, t('unit_' + (u || 'none')), feat.unit === u)).join('')}</select>`;
  const inp = (name, value, extra = '') => `<input name="imr:${name}" data-i="${i}" value="${attr(value)}" ${extra}>`;
  const numericFields = numeric ? `
      <div class="fe-field"><label>${esc(t('feat_nominal'))}</label>${inp('nominal', feat.nominal, 'dir="ltr" inputmode="decimal"')}</div>
      <div class="fe-field fe-tol"><label>${esc(t('feat_tol'))}</label>${tolSel}</div>
      <div class="fe-field"><label>${esc(feat.symmetric ? '±' : t('feat_upper'))}</label>${inp('upper', feat.upper, 'dir="ltr" inputmode="decimal"')}</div>
      <div class="fe-field${feat.symmetric ? ' hidden' : ''}"><label>${esc(t('feat_lower'))}</label>${inp('lower', feat.lower, 'dir="ltr" inputmode="decimal"')}</div>
      <div class="fe-field"><label>${esc(t('feat_unit'))}</label>${unitSel}</div>
      <div class="fe-field"><label>${esc('סיומת')}</label>${inp('suffix', feat.suffix, 'dir="ltr"')}</div>` : '';
  const results = numeric
    ? `<div class="fe-field"><label>${esc(t('col_min'))}</label>${inp('min', f.result.min, 'dir="ltr" inputmode="decimal"')}</div><div class="fe-field"><label>${esc(t('col_max'))}</label>${inp('max', f.result.max, 'dir="ltr" inputmode="decimal"')}</div>`
    : `<div class="fe-field"><label>${esc(t('col_result'))}</label><select name="imr:outcome" data-i="${i}">${option('', '—', !f.result.outcome)}${option('pass', feat.kind === 'gauge' ? 'GO' : t('pass'), f.result.outcome === 'pass')}${option('fail', feat.kind === 'gauge' ? 'NO-GO' : t('fail'), f.result.outcome === 'fail')}</select></div>`;
  const alt = f.aiAlternative ? `<div class="im-alt">${esc(t('import_ai_suggest', { v: Core.requirementText(f.aiAlternative) }))} <button type="button" class="btn btn-small" data-action="im-use-ai-row" data-i="${i}">${esc(t('import_use_ai'))}</button></div>` : '';
  const problems = Core.featureProblems(feat);
  return `<div class="fe-row im-row${f.needsReview ? ' needs' : ''}${problems.length ? ' has-problem' : ''}" data-im-row="${i}">
    <div class="fe-index">${f.no}</div>
    <div class="fe-grid">
      <div class="fe-field fe-kind"><label>${esc(t('feat_kind'))}</label>${kindSel}</div>
      <div class="fe-field fe-label"><label>${esc(t('feat_label'))}</label>${inp('label', feat.label, 'dir="auto"')}</div>
      ${numericFields}
      <div class="fe-field fe-method"><label>${esc(t('feat_method'))}</label>${inp('method', feat.method, 'dir="auto"')}</div>
      ${results}
    </div>
    <div class="fe-preview" dir="ltr"><span class="fe-preview-label">${esc(t('feat_preview'))}:</span> <span class="fe-preview-text">${esc(Core.requirementText(feat) || '—')} ${esc(Core.unitLabel(feat.unit))} <span class="muted">(${esc(Core.limitsText(feat) || '—')})</span></span>
      ${confBadge(f.confidence)} <span class="im-reasons">${esc(reasonsText(f.reasons))}</span>${f.feature.note ? `<span class="im-reasons">· ${esc(f.feature.note)}</span>` : ''}${alt}</div>
    <div class="im-crop">${crops.required ? `<img src="${crops.required}" alt="${attr(t('import_row_image'))}" title="${attr(t('import_row_image'))}">` : ''}${crops.row ? `<details><summary>${esc(t('import_show_row'))}</summary><img class="im-crop-row" src="${crops.row}" alt=""></details>` : ''}</div>
    <div class="fe-tools"><button type="button" class="btn btn-icon btn-danger" data-action="im-delete-row" data-i="${i}" title="${attr(t('import_delete_row'))}" aria-label="${attr(t('import_delete_row'))}">&times;</button></div>
  </div>`;
}

export function renderImport(ctx) {
  const im = ctx.ui.import;
  const head = ctx.heading(t('import_kicker'), t('import_title'), t('import_intro'), `<button type="button" class="btn" data-action="go-products">${esc(t('back_to_report'))}</button>`);
  const keysHint = `<div class="hint-line">${esc(t('import_keys_hint'))}</div>`;
  if (im.step === 'pick' || im.step === 'reading') {
    return head + `${im.error ? `<div class="alert alert-fail">${esc(im.error)}</div>` : ''}
      <div class="drop-zone${im.busy ? ' busy' : ''}" id="dropZone"><p>${esc(im.busy ? t('import_reading') : t('import_drop'))}</p>
      <input type="file" id="importPdf" accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png" ${im.busy ? 'disabled' : ''}>
      <button type="button" class="btn btn-primary" data-action="im-choose" ${im.busy ? 'disabled' : ''}>${esc(t('import_choose'))}</button></div>`;
  }
  const d = im.draft;
  const fields = d.fields;
  const partNo = (fields.partNo && fields.partNo.value || '').trim(), rev = (fields.revision && fields.revision.value || '').trim();
  const key = Core.productKey(partNo, rev);
  const existing = partNo ? Core.findProduct(ctx.state.products, partNo, rev) : null;
  const productNote = !partNo || !rev ? `<div class="alert alert-warn">${esc(t('import_product_missing_key'))}</div>`
    : existing ? `<div class="alert alert-warn">${esc(t('import_product_update', { key }))}</div>` : `<div class="alert alert-ok">${esc(t('import_product_new', { key }))}</div>`;
  const notices = [];
  if (!d.hasText) notices.push(['warn', t('import_no_text')]);
  if (d.missingPages) notices.push(['warn', t('import_missing_pages', { expected: d.expectedPages, got: d.pageCount })]);
  if (im.aiMessage) notices.push([im.aiStatus === 'failed' ? 'fail' : 'ok', im.aiMessage]);
  if (d.features.some(f => Core.featureProblems(f.feature).length)) notices.push(['warn', t('import_rows_with_problems')]);
  const aiButton = ctx.aiAvailable()
    ? `<button type="button" class="btn" data-action="im-run-ai" ${im.busy ? 'disabled' : ''}>${esc(t('import_ai_button'))}</button>`
    : `<span class="hint">${esc(t('import_ai_unavailable'))}</span>`;
  return head + `<div class="alert alert-ok">${esc(t('import_summary', { rows: d.summary.rows, review: d.summary.reviewRows }))} ${esc(im.fileName)}</div>${keysHint}
    ${notices.map(([c, m]) => `<div class="alert alert-${c}">${esc(m)}</div>`).join('')}
    <section class="panel"><div class="panel-head"><div><h2>${esc(t('import_fields'))}</h2><p>${esc(t('import_review_intro'))}</p></div><div class="compact-actions">${aiButton}</div></div>
      <div class="panel-body field-grid">${FIELD_ORDER.map(k => fieldRow(ctx, k, fields[k] || { value: '', confidence: 0, needsReview: false })).join('')}
      <div class="field"><label>${esc(t('f_inspectionLevel'))}</label><select name="imf:inspectionLevel">${option('', '—', !im.inspectionLevel)}${LEVELS.map(l => option(l, t('level_label')[l] || l, im.inspectionLevel === l)).join('')}</select></div></div></section>
    <section class="panel"><div class="panel-head"><h2>${esc(t('import_rows'))}</h2><span class="pill pill-empty">${d.features.length} ${esc(t('rows'))}</span></div>
      <div class="fe-list">${d.features.map((f, i) => rowEditor(ctx, f, i)).join('')}</div>
      <div class="panel-foot"><button type="button" class="btn" data-action="im-add-row">+ ${esc(t('import_add_row'))}</button></div></section>
    <section class="panel"><div class="panel-body">${productNote}
      <label class="toggle"><input type="checkbox" name="im:saveReport" ${im.saveReport ? 'checked' : ''}> ${esc(t('import_save_report'))}</label>
      ${syncConfigured(ctx.state.settings) ? `<label class="toggle"><input type="checkbox" name="im:uploadFile" ${im.uploadFile ? 'checked' : ''}> ${esc(t('import_upload_file'))}</label>` : ''}
      <div class="page-actions" style="margin-top:14px">
        <button type="button" class="btn btn-primary" data-action="im-save" data-then="report" ${!partNo || !rev || im.busy ? 'disabled' : ''}>${esc(t('import_confirm_and_report'))}</button>
        <button type="button" class="btn" data-action="im-save" data-then="products" ${!partNo || !rev || im.busy ? 'disabled' : ''}>${esc(t('import_confirm'))}</button>
        <button type="button" class="btn" data-action="im-cancel">${esc(t('import_cancel'))}</button></div></div></section>`;
}

function refreshRowPreview(ctx, i) {
  const f = ctx.ui.import.draft.features[i];
  const row = document.querySelector(`[data-im-row="${i}"]`);
  if (!row || !f) return;
  const feat = f.feature;
  const problems = Core.featureProblems(feat);
  row.classList.toggle('has-problem', problems.length > 0);
  const prev = row.querySelector('.fe-preview-text');
  if (prev) prev.innerHTML = `${esc(Core.requirementText(feat) || '—')} ${esc(Core.unitLabel(feat.unit))} <span class="muted">(${esc(Core.limitsText(feat) || '—')})</span>`;
}

export function onImportInput(ctx, el) {
  const im = ctx.ui.import;
  const name = el.name || '';
  if (!im.draft) return false;
  if (name.startsWith('imf:')) {
    const key = name.slice(4);
    if (key === 'inspectionLevel') { im.inspectionLevel = el.value; return true; }
    const f = im.draft.fields[key] || (im.draft.fields[key] = { value: '', confidence: 0, needsReview: false });
    f.value = el.value; f.confidence = 1; f.needsReview = false; f.conflict = false;
    if (key === 'partNo' || key === 'revision') ctx.renderSoon();
    return true;
  }
  if (name.startsWith('imr:')) {
    const i = Number(el.dataset.i); const f = im.draft.features[i]; if (!f) return true;
    const k = name.slice(4);
    if (k === 'kind') { f.feature.kind = Core.FEATURE_KINDS.includes(el.value) ? el.value : 'numeric'; if (f.feature.kind !== 'numeric') { f.feature.nominal = ''; f.feature.upper = ''; f.feature.lower = ''; f.feature.unit = ''; f.result.min = ''; f.result.max = ''; } else { if (!f.feature.unit) f.feature.unit = 'mm'; f.result.outcome = ''; } ctx.render(); return true; }
    if (k === 'symmetric') { f.feature.symmetric = el.value === '1'; ctx.render(); return true; }
    if (['label', 'nominal', 'upper', 'lower', 'unit', 'suffix', 'method'].includes(k)) f.feature[k] = el.value;
    if (['min', 'max', 'outcome'].includes(k)) f.result[k] = el.value;
    f.confidence = 1; f.needsReview = false; f.reasons = [];
    refreshRowPreview(ctx, i);
    return true;
  }
  if (name === 'im:saveReport') { im.saveReport = el.checked; return true; }
  if (name === 'im:uploadFile') { im.uploadFile = el.checked; return true; }
  return false;
}

/** Enter moves to the next useful field: nominal -> next numeric row's nominal; other fields -> next field in the row. */
export function onImportKeydown(ctx, event) {
  if (event.key !== 'Enter') return false;
  const el = event.target;
  if (!(el instanceof HTMLInputElement) || !String(el.name || '').startsWith('imr:')) return false;
  event.preventDefault();
  const field = el.name.slice(4);
  const i = Number(el.dataset.i);
  const rows = ctx.ui.import.draft.features;
  let target = null;
  if (field === 'nominal' || field === 'label' && rows[i].feature.kind !== 'numeric') {
    for (let j = i + 1; j < rows.length && !target; j++) {
      // numeric rows: the nominal; attribute rows only when their description is still empty
      const numeric = rows[j].feature.kind === 'numeric';
      if (!numeric && String(rows[j].feature.label || '').trim()) continue;
      target = document.querySelector(`input[name="imr:${numeric ? 'nominal' : 'label'}"][data-i="${j}"]`);
    }
  } else {
    const inputs = Array.from(document.querySelectorAll(`[data-im-row="${i}"] input, [data-im-row="${i}"] select`)).filter(x => !x.disabled && !x.hidden);
    const k = inputs.indexOf(el);
    target = inputs[k + 1] || document.querySelector(`[data-im-row="${i + 1}"] input`);
  }
  if (target) { target.focus(); if (target.select) target.select(); }
  return true;
}

export function onImportChange(ctx, el) {
  if (el.id === 'importPdf') { const f = el.files && el.files[0]; el.value = ''; if (f) startImport(ctx, f); return true; }
  return false;
}

export async function onImportAction(ctx, action, el) {
  const im = ctx.ui.import;
  switch (action) {
    case 'im-choose': document.getElementById('importPdf').click(); return true;
    case 'im-run-ai': await runAi(ctx); return true;
    case 'im-cancel': ctx.ui.import = newImportState(); ctx.go('products'); return true;
    case 'im-add-row': {
      const no = im.draft.features.length ? Math.max(...im.draft.features.map(f => f.no)) + 1 : 1;
      im.draft.features.push({ no, feature: Core.blankFeature('numeric'), result: Core.blankResult(), confidence: 1, reasons: [], needsReview: false, source: null, raw: {} });
      ctx.render(); return true;
    }
    case 'im-delete-row': { const i = Number(el.dataset.i); if (im.draft.features[i] && ctx.confirm(t('confirm_remove_feature'))) { im.draft.features.splice(i, 1); ctx.render(); } return true; }
    case 'im-use-ai-field': { const f = im.draft.fields[el.dataset.key]; if (f && f.aiValue) { f.value = f.aiValue; f.aiValue = ''; f.conflict = false; f.needsReview = false; f.confidence = 1; ctx.render(); } return true; }
    case 'im-use-ai-row': { const f = im.draft.features[Number(el.dataset.i)]; if (f && f.aiAlternative) { f.feature = { ...f.aiAlternative, id: f.feature.id }; f.aiAlternative = null; f.reasons = f.reasons.filter(r => r !== 'ai-disagrees'); f.needsReview = true; ctx.render(); } return true; }
    case 'im-save': await saveImport(ctx, el.dataset.then); return true;
    default: return false;
  }
}

async function saveImport(ctx, then) {
  const im = ctx.ui.import;
  const d = im.draft;
  const state = ctx.state;
  const overrides = { inspectionLevel: im.inspectionLevel || '' };
  const product = draftToProduct(d, overrides);
  if (!product.partNo || !product.revision) return;
  const existing = Core.findProduct(state.products, product.partNo, product.revision);
  const now = new Date().toISOString();
  let saved;
  if (existing) {
    saved = { ...existing, ...Object.fromEntries(PRODUCT_KEYS.map(k => [k, product[k]])), inspectionLevel: product.inspectionLevel || existing.inspectionLevel, features: product.features, sourceReportNo: product.sourceReportNo || existing.sourceReportNo, updatedAt: now };
    state.products[state.products.indexOf(existing)] = saved;
  } else {
    saved = { ...product, createdAt: now, updatedAt: now };
    state.products.push(saved);
  }
  // Original file: upload when configured, keep the id on the product
  let fileId = '';
  if (im.fileBlob && im.uploadFile && syncConfigured(state.settings)) {
    fileId = `${Core.normalizePartNo(product.partNo)}_${Core.normalizeRevision(product.revision)}_${Date.now()}`.replace(/[^\w.-]/g, '_') + (im.fileBlob.type === 'application/pdf' ? '.pdf' : '.img');
    try { await uploadFile(state.settings, fileId, im.fileBlob); saved.sourceFileId = fileId; ctx.toast(t('import_file_uploaded')); }
    catch (_) { fileId = ''; ctx.toast(t('import_file_upload_failed')); }
  }
  ctx.markDirty('product', saved.id);
  // Historical report into the archive
  if (im.saveReport) {
    const tpl = ctx.activeTemplate();
    const report = Core.createReport(tpl, null, new Date(), saved);
    for (const key of ['reportNo', 'inspectionDate', 'inspector', 'purchaseOrder', 'productionOrder', 'quantity', 'totalInspected', 'accepted', 'rejected', 'customer']) {
      if (d.fields[key] && d.fields[key].value) report.header[key] = d.fields[key].value;
    }
    report.features = d.features.map(f => ({ ...f.feature }));
    report.results = {};
    d.features.forEach(f => { report.results[f.feature.id] = { ...Core.blankResult(), ...f.result }; });
    report.remarks = `Imported from ${im.fileName}` + (d.aiNotes ? ` · ${d.aiNotes}` : '');
    report.baseline = { ...report.header };
    report.sourceFileId = fileId;
    report.createdAt = (d.fields.inspectionDate && d.fields.inspectionDate.value ? d.fields.inspectionDate.value + 'T12:00:00.000Z' : now);
    report.updatedAt = now;
    state.archive = [report, ...state.archive].slice(0, 500);
    ctx.markDirty('report', report.id);
    ctx.toast(t('import_report_saved'));
  }
  ctx.persist();
  ctx.toast(t('import_saved', { key: Core.productKey(saved.partNo, saved.revision) }));
  ctx.ui.import = newImportState();
  if (then === 'report') { ctx.startNewReportForProduct(saved); ctx.go('report'); }
  else { ctx.ui.editProductId = saved.id; ctx.go('products'); }
}
