/* UI layer: state, rendering and events. All model logic lives in core.js / sampling.js / storage.js. */
import * as Core from './core.js';
import { LEVELS, SUPPORTED_AQLS } from './sampling.js';
import { t } from './i18n.js';
import * as Store from './storage.js';
import { renderReportSheet, escapeHtml, reportFileName } from './report-sheet.js';
import * as Sync from './sync.js';
import { renderImport, onImportInput, onImportChange, onImportAction, startImport, newImportState } from './ui-import.js';
import { renderProducts, onProductsInput, onProductsAction, filterProducts, productLabel } from './ui-products.js';
import { renderSettings, onSettingsInput, onSettingsAction, syncStatusText } from './ui-settings.js';

const APP_VERSION = '2.1.0';

const esc = escapeHtml;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const storage = window.localStorage;

let state;
const ui = { tab: 'report', editTemplateId: null, editProductId: null, archiveQuery: '', productQuery: '', productSearch: '', saveTimer: null, toastTimer: null, import: newImportState() };
const syncState = { running: false, error: '', health: null, testMessage: '', timer: null };

// ---------- persistence ----------
function persist() {
  clearTimeout(ui.saveTimer); ui.saveTimer = null;
  try { Store.saveState(storage, state); return true; }
  catch (_) { toast(t('toast_storage_error')); return false; }
}
function persistSoon() { clearTimeout(ui.saveTimer); ui.saveTimer = setTimeout(() => { persist(); scheduleSync(); }, 300); }

function activeTemplate() { return state.templates.find(x => x.id === state.activeTemplateId) || state.templates[0]; }
function editTemplate() { return state.templates.find(x => x.id === ui.editTemplateId) || activeTemplate(); }
function touch(template) { template.updatedAt = new Date().toISOString(); Sync.markDirty(state, 'template', template.id); }
function draftProduct() { return state.draft && state.draft.productId ? state.products.find(p => p.id === state.draft.productId) || null : null; }

/** Which list of characteristics the feature editor is operating on (template or product). */
function featureHost() {
  if (ui.tab === 'products') {
    const p = state.products.find(x => x.id === ui.editProductId);
    if (p) return { kind: 'product', record: p, features: p.features, touch: () => { p.updatedAt = new Date().toISOString(); Sync.markDirty(state, 'product', p.id); if (state.draft && state.draft.productId === p.id) state.draft = Core.syncReportFeatures(state.draft, activeTemplate(), p); }, rerender: () => render() };
  }
  const tpl = editTemplate();
  return { kind: 'template', record: tpl, features: tpl.features, touch: () => { touch(tpl); applyTemplateChangeToDraft(tpl); }, rerender: () => renderTemplates() };
}

function ensureDraft() {
  if (!state.draft) state.draft = Core.createReport(activeTemplate());
  const tpl = state.templates.find(x => x.id === state.draft.templateId);
  const product = draftProduct();
  if (tpl) state.draft = Core.syncReportFeatures(state.draft, tpl, product);
}

/** Move the current draft to the archive (if it has content) and open a new one from `template`. */
function startNewReport(template, { carryFrom = state.draft, confirmed = true, product = null } = {}) {
  if (!confirmed) return false;
  const old = state.draft;
  let archived = false;
  if (old && Core.reportHasContent(old)) {
    old.updatedAt = new Date().toISOString();
    state.archive = [old, ...state.archive.filter(r => r.id !== old.id)].slice(0, Store.MAX_ARCHIVE);
    Sync.markDirty(state, 'report', old.id);
    archived = true;
    const oldTpl = state.templates.find(x => x.id === old.templateId);
    if (oldTpl && oldTpl.numbering.mode === 'auto') {
      oldTpl.numbering.next = Math.max(oldTpl.numbering.next, nextNumberAfter(old.header.reportNo, oldTpl.numbering));
    }
  }
  state.activeTemplateId = template.id;
  state.draft = Core.createReport(template, carryFrom, new Date(), product);
  persist(); scheduleSync();
  return archived;
}
function startNewReportForProduct(product) {
  const archived = startNewReport(activeTemplate(), { product });
  toast(archived ? t('toast_archived') : t('toast_new_report'));
}

/** If the archived report's number follows the template pattern, continue after it. */
function nextNumberAfter(reportNo, numbering) {
  const prefix = numbering.prefix || '';
  const text = String(reportNo || '');
  if (!text.startsWith(prefix)) return numbering.next;
  const digits = text.slice(prefix.length);
  if (!/^\d+$/.test(digits)) return numbering.next;
  return Number(digits) + 1;
}

// ---------- helpers ----------
function toast(message) {
  const el = $('#toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function confirmAction(message) { return window.confirm(message); }
function attr(v) { return esc(v); }
function option(value, label, selected) { return `<option value="${attr(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`; }
function fieldLabel(key) { return t('f_' + key); }
function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('he-IL', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function statusPill(state) {
  const map = { ok: ['ok', 'st_ok'], 'manual-pass': ['ok', 'st_manual_pass'], fail: ['fail', 'st_fail'], review: ['review', 'st_review'], empty: ['empty', 'st_empty'] };
  const [cls, key] = map[state] || map.review;
  return `<span class="pill pill-${cls}">${esc(t(key))}</span>`;
}
function reasonText(reason) { return t('reason_' + String(reason || '').replace(/-/g, '_')); }
function reportStatusPill(report) {
  const s = Core.reportStatus(report);
  const cls = s === 'pass' ? 'ok' : s === 'fail' ? 'fail' : 'review';
  return `<span class="pill pill-${cls}">${esc(t('report_status_' + s))}</span>`;
}

function aqlControl(name, value, { disabled = false, id = '' } = {}) {
  const known = SUPPORTED_AQLS.includes(value);
  const other = !known && String(value || '').trim() !== '';
  const sel = `<select name="${attr(name)}" ${id ? `id="${attr(id)}"` : ''} class="aql-select" ${disabled ? 'disabled' : ''}>` +
    SUPPORTED_AQLS.map(a => option(a, a, a === value)).join('') +
    option('__other', t('aql_other'), other) + '</select>';
  const text = `<input type="text" name="${attr(name)}__other" ${id ? `id="${attr(id)}__other"` : ''} class="aql-other" value="${attr(other ? value : '')}" ${other ? '' : 'hidden'} ${disabled ? 'disabled' : ''} inputmode="decimal" placeholder="AQL" aria-label="AQL">`;
  return `<div class="aql-control">${sel}${text}</div>`;
}
function levelControl(name, value, { disabled = false, id = '' } = {}) {
  const labels = t('level_label');
  return `<select name="${attr(name)}" ${id ? `id="${attr(id)}"` : ''} ${disabled ? 'disabled' : ''}>` + LEVELS.map(l => option(l, labels[l] || l, l === value)).join('') + '</select>';
}

// ---------- shell ----------
function renderShell() {
  const tpl = activeTemplate();
  $('#sidebarTemplate').innerHTML = `<label class="side-label" for="quickTemplate">${esc(t('current_template'))}</label>
    <select id="quickTemplate" class="side-select">${state.templates.map(x => option(x.id, x.name, x.id === state.activeTemplateId)).join('')}</select>
    <p class="side-note">${esc(t('template_picker_hint'))}</p>`;
  const backup = state.settings.lastBackupAt ? t('last_backup', { date: formatDateTime(state.settings.lastBackupAt) }) : t('last_backup_never');
  $('#backupStatus').textContent = backup;
  renderSyncIndicator();
  $$('[data-tab]').forEach(b => {
    const active = b.dataset.tab === ui.tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-current', active ? 'page' : 'false');
  });
  void tpl;
}

function renderSyncIndicator() {
  const dot = $('#syncDot'), text = $('#syncText');
  if (!dot || !text) return;
  const configured = Sync.syncConfigured(state.settings);
  const pending = Object.keys(state.settings.dirty || {}).length + Object.keys(state.settings.deleted || {}).length;
  dot.className = 'dot ' + (!configured ? 'off' : syncState.error ? 'err' : pending ? 'pending' : 'ok');
  text.textContent = configured ? syncStatusText(ctx) : t('local_only');
}

function heading(kicker, title, intro, actions = '') {
  return `<div class="page-head"><div><div class="kicker">${esc(kicker)}</div><h1>${esc(title)}</h1><p class="intro">${esc(intro)}</p></div><div class="page-actions">${actions}</div></div>`;
}

// ---------- report tab ----------
function headerField(key, report, template) {
  const def = Core.HEADER_FIELDS.find(f => f.key === key);
  const value = report.header[key] || '';
  const locked = Core.isLocked(template, key) || Core.isProductLocked(report, key);
  const id = 'h_' + key;
  let control;
  if (key === 'aql') control = aqlControl('h:aql', value, { disabled: locked, id });
  else if (key === 'inspectionLevel') control = levelControl('h:inspectionLevel', value, { disabled: locked, id });
  else {
    const type = def.type === 'date' ? 'date' : 'text';
    control = `<input id="${id}" type="${type}" name="h:${key}" value="${attr(value)}" ${locked ? 'disabled' : ''} ${def.numeric ? 'inputmode="numeric"' : ''} autocomplete="off">`;
  }
  return `<div class="field${locked ? ' locked' : ''}"><label for="${id}">${esc(fieldLabel(key))}${locked ? ` <span class="lock" title="${attr(t('locked_hint'))}">&#128274;</span>` : ''}</label>${control}</div>`;
}

function samplingPanelHtml(report) {
  const { plan, disposition } = Core.reportSampling(report);
  const tpl = activeTemplate();
  let big = '—', foot = esc(t('enter_quantity')), notes = [];
  if (plan) {
    big = String(plan.sampleSize);
    if (plan.lotOfOne) { foot = esc(t('lot_of_one')); }
    else {
      const parts = [`${t('code_letter')}: <b>${esc(plan.tableLetter)}</b> (n=${plan.tableSampleSize})`];
      if (plan.plan) parts.push(`${t('plan')}: <b>${esc(plan.plan.letter)}</b> · Ac <b>${plan.plan.ac}</b> / Re <b>${plan.plan.re}</b>`);
      foot = parts.join(' · ');
      if (plan.plan && plan.plan.arrow === 'down') notes.push(t('arrow_down', { letter: plan.plan.letter }));
      if (plan.plan && plan.plan.arrow === 'up') notes.push(t('arrow_up', { letter: plan.plan.letter }));
      if (plan.fullInspection) notes.push(t('full_inspection'));
      if (!plan.plan) notes.push(t('plan_unavailable'));
    }
  }
  const dispo = disposition === 'accept' ? `<span class="pill pill-ok">${esc(t('disposition_accept'))}</span>`
    : disposition === 'reject' ? `<span class="pill pill-fail">${esc(t('disposition_reject'))}</span>`
      : `<span class="pill pill-empty">${esc(t('disposition_none'))}</span>`;
  return `<div class="sample-big" dir="ltr">${big}</div><div class="sample-foot">${foot}</div>
    ${notes.map(n => `<div class="sample-note">${esc(n)}</div>`).join('')}
    <div class="dispo"><span>${esc(t('disposition'))}</span>${dispo}</div>
    <div class="sample-basis">${esc(t('sampling_basis', { standard: tpl.company.standardName || 'MIL-STD-105D' }))}</div>`;
}

function warningsHtml(report, template) {
  const list = Core.headerWarnings(report).map(w => t('warn_' + w.replace(/-/g, '_')));
  if (template.features.some(f => Core.featureProblems(f).length)) list.push(t('warn_template_problems'));
  if (!list.length) return '';
  return `<div class="alert alert-warn">${list.map(x => `<div>${esc(x)}</div>`).join('')}</div>`;
}

function summaryHtml(report) {
  const c = Core.summarize(report.features, report.results);
  return `<div class="summary-status">${reportStatusPill(report)}</div>
    <div class="metric"><span>${esc(t('summary_ok'))}</span><b>${c.ok}</b></div>
    <div class="metric"><span>${esc(t('summary_fail'))}</span><b class="${c.fail ? 'neg' : ''}">${c.fail}</b></div>
    <div class="metric"><span>${esc(t('summary_review'))}</span><b>${c.review}</b></div>
    <div class="metric"><span>${esc(t('summary_empty'))}</span><b>${c.empty}</b></div>`;
}

function resultRow(f, i, report) {
  const r = report.results[f.id] || Core.blankResult();
  const ev = Core.evaluateFeature(f, r);
  const unit = f.kind === 'numeric' ? Core.unitLabel(f.unit) : '';
  const problems = Core.featureProblems(f);
  let controls;
  if (f.kind === 'numeric') {
    controls = `<td><input class="m-input" type="text" inputmode="decimal" data-measure="min" data-id="${attr(f.id)}" value="${attr(r.min)}" aria-label="${attr(t('col_min'))} ${i + 1}" placeholder="min"></td>
      <td class="max-cell"><input class="m-input" type="text" inputmode="decimal" data-measure="max" data-id="${attr(f.id)}" value="${attr(r.max)}" aria-label="${attr(t('col_max'))} ${i + 1}" placeholder="max"><button type="button" class="copy-min" data-copy-min="${attr(f.id)}" title="${attr(t('copy_min'))}" aria-label="${attr(t('copy_min'))}" tabindex="-1">=</button></td>`;
  } else {
    const [passLabel, failLabel] = f.kind === 'gauge' ? [t('go'), t('nogo')] : [t('pass'), t('fail')];
    controls = `<td colspan="2"><div class="seg" role="group" aria-label="${attr(Core.requirementText(f))}">
      <button type="button" class="seg-btn seg-pass${r.outcome === 'pass' ? ' on' : ''}" data-outcome="pass" data-id="${attr(f.id)}">${esc(passLabel)}</button>
      <button type="button" class="seg-btn seg-fail${r.outcome === 'fail' ? ' on' : ''}" data-outcome="fail" data-id="${attr(f.id)}">${esc(failLabel)}</button>
      <button type="button" class="seg-btn seg-clear${r.outcome ? '' : ' on'}" data-outcome="" data-id="${attr(f.id)}" title="${attr(t('clear'))}">&times;</button></div></td>`;
  }
  const limits = f.kind === 'numeric' ? (Core.limitsText(f) || '—') : (f.kind === 'gauge' ? 'GO / NO-GO' : 'OK / NOT OK');
  const problemText = problems.length ? `<div class="row-problem">${esc(t('feat_problem_' + problems[0].replace(/-/g, '_')))}</div>` : '';
  return `<tr data-row="${attr(f.id)}">
    <td class="num">${i + 1}</td>
    <td class="req"><div>${esc(Core.requirementText(f) || '—')}${unit ? ` <span class="unit">${esc(unit)}</span>` : ''}</div>${problemText}${r.note ? `<div class="row-note-text">${esc(r.note)}</div>` : ''}</td>
    <td class="lim" dir="ltr">${esc(limits)}</td>
    <td class="method">${esc(f.method || '—')}</td>
    ${controls}
    <td class="row-status" title="${attr(reasonText(ev.reason))}">${statusPill(ev.state)}</td>
  </tr>`;
}

function renderReport() {
  ensureDraft();
  const report = state.draft;
  const tpl = activeTemplate();
  const orderKeys = ['reportNo', 'inspectionDate', 'customer', 'purchaseOrder', 'productionOrder', 'quantity', 'inspector'];
  const productKeys = ['partNo', 'partName', 'drawingNo', 'revision', 'catalogNo', 'material', 'generalTolerance', 'aql', 'inspectionLevel'];
  const actions = `<button type="button" class="btn" data-action="new-report">${esc(t('new_report'))}</button>
    <button type="button" class="btn btn-primary" data-action="go-preview">${esc(t('preview_pdf'))}</button>`;
  $('#main').innerHTML = heading(t('report_kicker'), t('report_title'), t('report_intro'), actions) +
    `<div id="warnings">${warningsHtml(report, tpl)}</div>
    <section class="panel"><div class="product-bar">${productBarHtml(report)}</div></section>
    <div class="report-layout"><div class="report-main">
      <section class="panel"><div class="panel-head"><div><h2>${esc(t('section_order'))}</h2><p>${esc(t('section_order_note'))}</p></div></div>
        <div class="panel-body field-grid">${orderKeys.map(k => headerField(k, report, tpl)).join('')}</div></section>
      <section class="panel"><div class="panel-head"><div><h2>${esc(t('section_product'))}</h2><p>${esc(t('section_product_note'))}</p></div><button type="button" class="btn btn-ghost" data-action="edit-template">${esc(t('edit_template'))}</button></div>
        <div class="panel-body field-grid">${productKeys.map(k => headerField(k, report, tpl)).join('')}</div></section>
      <section class="panel"><div class="panel-head"><div><h2>${esc(t('section_results'))}</h2><p>${esc(t('section_results_note'))}</p></div><span class="pill pill-empty">${report.features.length} ${esc(t('rows'))}</span></div>
        <div class="table-wrap"><table class="results" dir="rtl"><colgroup><col class="c-no"><col class="c-req"><col class="c-lim"><col class="c-method"><col class="c-min"><col class="c-max"><col class="c-res"></colgroup>
        <thead><tr><th>${esc(t('col_no'))}</th><th>${esc(t('col_required'))}</th><th>${esc(t('col_limits'))}</th><th>${esc(t('col_method'))}</th><th>${esc(t('col_min'))}</th><th>${esc(t('col_max'))}</th><th>${esc(t('col_result'))}</th></tr></thead>
        <tbody>${report.features.map((f, i) => resultRow(f, i, report)).join('')}</tbody></table></div></section>
      <section class="panel"><div class="panel-head"><h2>${esc(t('section_remarks'))}</h2></div><div class="panel-body"><textarea id="remarks" rows="4" placeholder="${attr(t('remarks_placeholder'))}" dir="auto">${esc(report.remarks || '')}</textarea></div></section>
    </div>
    <aside class="report-side">
      <section class="panel"><div class="panel-head"><h2>${esc(t('section_sampling'))}</h2></div><div class="panel-body">
        <div id="samplingPanel">${samplingPanelHtml(report)}</div>
        <div class="field-grid two">${['nonconforming', 'accepted', 'rejected'].map(k => headerField(k, report, tpl)).join('')}</div>
      </div></section>
      <section class="panel"><div class="panel-body" id="summaryPanel">${summaryHtml(report)}</div>
        <div class="panel-foot"><button type="button" class="btn btn-primary btn-block" data-action="go-preview">${esc(t('preview_pdf'))}</button></div></section>
    </aside></div>`;
}

function productBarHtml(report) {
  const product = draftProduct();
  const chip = product
    ? `<span class="chip" dir="auto">${esc(t('product_current'))}: <b dir="ltr">${esc(product.partNo)}</b> ${product.revision ? `<span>Rev ${esc(product.revision)}</span>` : ''} ${product.partName ? `<span>· ${esc(product.partName)}</span>` : ''}</span>
       <button type="button" class="btn btn-small" data-action="product-open-current">${esc(t('product_open'))}</button>`
    : `<span class="chip">${esc(t('product_none'))}</span>`;
  return `${chip}<div class="product-wrap"><input id="productSearch" type="search" class="search" placeholder="${attr(t('product_pick_ph'))}" value="${attr(ui.productSearch)}" autocomplete="off" aria-label="${attr(t('product_pick'))}"><div id="productResults" class="product-results" hidden></div></div>
    <button type="button" class="btn btn-small" data-action="go-import">${esc(t('product_import'))}</button>`;
}
function renderProductResults() {
  const box = $('#productResults'); if (!box) return;
  const q = ui.productSearch.trim();
  if (!q) { box.hidden = true; box.innerHTML = ''; return; }
  const list = filterProducts(state.products, q).slice(0, 12);
  box.innerHTML = list.length ? list.map(p => `<button type="button" data-action="product-use" data-id="${attr(p.id)}"><b>${esc(p.partNo)}</b> ${p.revision ? 'Rev ' + esc(p.revision) : ''} ${p.partName ? '· ' + esc(p.partName) : ''} ${p.customer ? '<span class="muted">· ' + esc(p.customer) + '</span>' : ''}</button>`).join('')
    : `<button type="button" disabled>${esc(t('products_empty'))}</button>`;
  box.hidden = false;
}

function refreshReportDerived() {
  const report = state.draft, tpl = activeTemplate();
  const sp = $('#samplingPanel'); if (sp) sp.innerHTML = samplingPanelHtml(report);
  const sm = $('#summaryPanel'); if (sm) sm.innerHTML = summaryHtml(report);
  const w = $('#warnings'); if (w) w.innerHTML = warningsHtml(report, tpl);
}
function refreshRow(id) {
  const f = state.draft.features.find(x => x.id === id);
  const row = $(`tr[data-row="${CSS.escape(id)}"]`);
  if (!f || !row) return;
  const ev = Core.evaluateFeature(f, state.draft.results[id]);
  const cell = $('.row-status', row);
  cell.innerHTML = statusPill(ev.state); cell.title = reasonText(ev.reason);
  if (f.kind !== 'numeric') {
    const outcome = state.draft.results[id].outcome || '';
    $$('.seg-btn', row).forEach(b => b.classList.toggle('on', (b.dataset.outcome || '') === outcome));
  }
}

// ---------- archive tab ----------
function renderArchive() {
  const q = ui.archiveQuery.trim().toLowerCase();
  const list = state.archive.filter(r => !q || [r.header.reportNo, r.header.customer, r.header.partNo, r.header.partName, r.header.purchaseOrder, r.header.productionOrder, r.header.catalogNo]
    .some(v => String(v || '').toLowerCase().includes(q)));
  const rows = list.map(r => `<tr>
      <td>${esc(formatDateTime(r.header.inspectionDate ? r.header.inspectionDate + 'T00:00:00' : r.createdAt))}</td>
      <td dir="ltr" class="ltr">${esc(r.header.reportNo || '—')}</td>
      <td>${esc(r.header.customer || '—')}</td>
      <td>${esc([r.header.partNo, r.header.partName].filter(Boolean).join(' · ') || '—')}</td>
      <td dir="ltr">${esc(r.header.quantity || '—')}</td>
      <td>${reportStatusPill(r)}</td>
      <td class="actions"><button type="button" class="btn btn-small" data-action="archive-open" data-id="${attr(r.id)}">${esc(t('archive_open'))}</button>
        <button type="button" class="btn btn-small" data-action="archive-duplicate" data-id="${attr(r.id)}">${esc(t('archive_duplicate'))}</button>
        <button type="button" class="btn btn-small btn-danger" data-action="archive-delete" data-id="${attr(r.id)}">${esc(t('archive_delete'))}</button></td>
    </tr>`).join('');
  const warn = state.archive.length >= Store.MAX_ARCHIVE * 0.8 ? `<div class="alert alert-warn">${esc(t('archive_warn_full', { max: Store.MAX_ARCHIVE }))}</div>` : '';
  $('#main').innerHTML = heading(t('archive_kicker'), t('archive_title'), t('archive_intro')) + warn +
    `<section class="panel"><div class="panel-head"><input id="archiveSearch" type="search" class="search" placeholder="${attr(t('archive_search'))}" value="${attr(ui.archiveQuery)}"><span class="pill pill-empty">${esc(t('archive_count', { n: list.length }))}</span></div>
    ${list.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>${esc(t('col_date'))}</th><th>${esc(t('col_report_no'))}</th><th>${esc(t('col_customer'))}</th><th>${esc(t('col_part'))}</th><th>${esc(t('col_qty'))}</th><th>${esc(t('col_status'))}</th><th>${esc(t('col_actions'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">${esc(t('archive_empty'))}</div>`}</section>`;
}

// ---------- templates tab ----------
function featureEditorRow(f, i, total) {
  const problems = Core.featureProblems(f);
  const numeric = f.kind === 'numeric';
  const kindSel = `<select name="f:kind" data-fid="${attr(f.id)}">${option('numeric', t('kind_numeric'), f.kind === 'numeric')}${option('gauge', t('kind_gauge'), f.kind === 'gauge')}${option('visual', t('kind_visual'), f.kind === 'visual')}</select>`;
  const unitSel = `<select name="f:unit" data-fid="${attr(f.id)}">${['mm', 'in', 'deg', 'um', ''].map(u => option(u, t('unit_' + (u || 'none')), f.unit === u)).join('')}</select>`;
  const tolType = `<select name="f:symmetric" data-fid="${attr(f.id)}">${option('1', t('tol_type_sym'), f.symmetric)}${option('0', t('tol_type_asym'), !f.symmetric)}</select>`;
  const numericFields = numeric ? `
    <div class="fe-field"><label>${esc(t('feat_nominal'))}</label><input name="f:nominal" data-fid="${attr(f.id)}" value="${attr(f.nominal)}" inputmode="decimal" dir="ltr"></div>
    <div class="fe-field fe-tol"><label>${esc(t('feat_tol'))}</label>${tolType}</div>
    <div class="fe-field"><label>${esc(f.symmetric ? '±' : t('feat_upper'))}</label><input name="f:upper" data-fid="${attr(f.id)}" value="${attr(f.upper)}" inputmode="decimal" dir="ltr"></div>
    <div class="fe-field${f.symmetric ? ' hidden' : ''}"><label>${esc(t('feat_lower'))}</label><input name="f:lower" data-fid="${attr(f.id)}" value="${attr(f.lower)}" inputmode="decimal" dir="ltr" ${f.symmetric ? 'disabled' : ''}></div>
    <div class="fe-field"><label>${esc(t('feat_unit'))}</label>${unitSel}</div>` : '';
  const preview = numeric ? `${Core.requirementText(f) || '—'} ${Core.unitLabel(f.unit)} <span class="muted">(${Core.limitsText(f) || '—'})</span>` : (f.label || '—');
  return `<div class="fe-row${problems.length ? ' has-problem' : ''}" data-feature="${attr(f.id)}">
    <div class="fe-index">${i + 1}</div>
    <div class="fe-grid">
      <div class="fe-field fe-kind"><label>${esc(t('feat_kind'))}</label>${kindSel}</div>
      <div class="fe-field fe-label"><label>${esc(t('feat_label'))}</label><input name="f:label" data-fid="${attr(f.id)}" value="${attr(f.label)}" placeholder="${attr(numeric ? t('feat_label_ph_numeric') : t('feat_label_ph_attr'))}" dir="auto"></div>
      ${numericFields}
      <div class="fe-field fe-method"><label>${esc(t('feat_method'))}</label><input name="f:method" data-fid="${attr(f.id)}" value="${attr(f.method)}" dir="auto"></div>
    </div>
    <div class="fe-preview" dir="ltr"><span class="fe-preview-label">${esc(t('feat_preview'))}:</span> <span class="fe-preview-text">${esc(preview).replace(/&lt;span class=&quot;muted&quot;&gt;/g, '<span class="muted">').replace(/&lt;\/span&gt;/g, '</span>')}</span>${problems.length ? `<span class="fe-problem">${esc(t('feat_problem_' + problems[0].replace(/-/g, '_')))}</span>` : ''}</div>
    <div class="fe-tools">
      <button type="button" class="btn btn-icon" data-action="feature-up" data-id="${attr(f.id)}" ${i === 0 ? 'disabled' : ''} title="${attr(t('feat_up'))}" aria-label="${attr(t('feat_up'))}">&uarr;</button>
      <button type="button" class="btn btn-icon" data-action="feature-down" data-id="${attr(f.id)}" ${i === total - 1 ? 'disabled' : ''} title="${attr(t('feat_down'))}" aria-label="${attr(t('feat_down'))}">&darr;</button>
      <button type="button" class="btn btn-icon" data-action="feature-duplicate" data-id="${attr(f.id)}" title="${attr(t('feat_duplicate'))}" aria-label="${attr(t('feat_duplicate'))}">&#10697;</button>
      <button type="button" class="btn btn-icon btn-danger" data-action="feature-remove" data-id="${attr(f.id)}" title="${attr(t('feat_remove'))}" aria-label="${attr(t('feat_remove'))}">&times;</button>
    </div></div>`;
}

function renderTemplates() {
  const tpl = editTemplate();
  ui.editTemplateId = tpl.id;
  const list = state.templates.map(x => `<li class="tpl-item${x.id === tpl.id ? ' selected' : ''}"><button type="button" class="tpl-pick" data-action="template-edit" data-id="${attr(x.id)}">${esc(x.name)}</button>${x.id === state.activeTemplateId ? `<span class="pill pill-ok">${esc(t('template_active'))}</span>` : ''}</li>`).join('');
  const fieldRows = Core.HEADER_FIELDS.map(def => {
    const p = tpl.fields[def.key];
    if (!def.lockable) return `<div class="policy-row"><div class="policy-name">${esc(fieldLabel(def.key))}</div><div class="policy-mode muted">${esc(t('mode_not_lockable'))}</div><div></div></div>`;
    const modeSel = `<select name="p:mode" data-key="${attr(def.key)}">${Core.FIELD_MODES.map(m => option(m, t('mode_' + m), p.mode === m)).join('')}</select>`;
    let valueCtl;
    if (def.key === 'aql') valueCtl = aqlControl('p:aql', p.value);
    else if (def.key === 'inspectionLevel') valueCtl = levelControl('p:inspectionLevel', p.value);
    else valueCtl = `<input name="p:value" data-key="${attr(def.key)}" value="${attr(p.value)}" placeholder="${attr(t('mode_value'))}" dir="auto" ${p.mode === 'blank' ? 'disabled' : ''}>`;
    return `<div class="policy-row"><div class="policy-name">${esc(fieldLabel(def.key))}</div><div class="policy-mode">${modeSel}</div><div class="policy-value">${valueCtl}</div></div>`;
  }).join('');
  const numbering = tpl.numbering;
  $('#main').innerHTML = heading(t('templates_kicker'), t('templates_title'), t('templates_intro'),
    `<button type="button" class="btn" data-action="template-new">${esc(t('template_new'))}</button>
     <button type="button" class="btn" data-action="template-duplicate">${esc(t('template_duplicate'))}</button>
     <button type="button" class="btn btn-danger" data-action="template-delete" ${state.templates.length < 2 ? 'disabled' : ''}>${esc(t('template_delete'))}</button>`) +
    `<div class="tpl-layout"><aside class="panel tpl-list"><div class="panel-head"><h2>${esc(t('template_list'))}</h2></div><ul>${list}</ul>
      ${tpl.id !== state.activeTemplateId ? `<div class="panel-foot"><button type="button" class="btn btn-primary btn-block" data-action="template-use" data-id="${attr(tpl.id)}">${esc(t('template_use'))}</button></div>` : ''}</aside>
    <div class="tpl-editor">
      <section class="panel"><div class="panel-head"><h2>${esc(t('section_company'))}</h2></div><div class="panel-body field-grid">
        <div class="field"><label for="tplName">${esc(t('template_name'))}</label><input id="tplName" name="t:name" value="${attr(tpl.name)}" dir="auto"></div>
        <div class="field"><label for="cName">${esc(t('company_name'))}</label><input id="cName" name="c:name" value="${attr(tpl.company.name)}" dir="auto"></div>
        <div class="field"><label for="cTag">${esc(t('company_tagline'))}</label><input id="cTag" name="c:tagline" value="${attr(tpl.company.tagline)}" dir="auto"></div>
        <div class="field span2"><label for="cFooter">${esc(t('company_footer'))}</label><input id="cFooter" name="c:footer" value="${attr(tpl.company.footer)}" dir="auto"></div>
        <div class="field"><label for="cStd">${esc(t('standard_name'))}</label><input id="cStd" name="c:standardName" value="${attr(tpl.company.standardName)}" dir="ltr"><small class="hint">${esc(t('standard_hint'))}</small></div>
        <div class="field span2"><label for="logoUpload">${esc(t('company_logo'))}</label><div class="logo-row">${tpl.company.logo ? `<img class="logo-preview" src="${attr(tpl.company.logo)}" alt="">` : ''}<input id="logoUpload" type="file" accept="image/png,image/jpeg,image/webp">${tpl.company.logo ? `<button type="button" class="btn btn-small" data-action="logo-remove">${esc(t('logo_remove'))}</button>` : ''}</div><small class="hint">${esc(t('logo_hint'))}</small></div>
      </div></section>
      <section class="panel"><div class="panel-head"><h2>${esc(t('section_numbering'))}</h2></div><div class="panel-body field-grid four">
        <div class="field"><label for="nMode">${esc(t('numbering_mode'))}</label><select id="nMode" name="n:mode">${option('auto', t('numbering_auto'), numbering.mode === 'auto')}${option('manual', t('numbering_manual'), numbering.mode === 'manual')}</select></div>
        <div class="field"><label for="nPrefix">${esc(t('numbering_prefix'))}</label><input id="nPrefix" name="n:prefix" value="${attr(numbering.prefix)}" dir="ltr" ${numbering.mode === 'manual' ? 'disabled' : ''}></div>
        <div class="field"><label for="nNext">${esc(t('numbering_next'))}</label><input id="nNext" name="n:next" type="number" min="1" step="1" value="${attr(numbering.next)}" dir="ltr" ${numbering.mode === 'manual' ? 'disabled' : ''}></div>
        <div class="field"><label for="nWidth">${esc(t('numbering_width'))}</label><input id="nWidth" name="n:width" type="number" min="0" max="8" step="1" value="${attr(numbering.width)}" dir="ltr" ${numbering.mode === 'manual' ? 'disabled' : ''}></div>
        <div class="field span4"><small class="hint" id="numberingPreview">${numbering.mode === 'auto' ? esc(t('numbering_preview', { no: Core.formatReportNo(numbering) })) : ''}</small></div>
      </div></section>
      <section class="panel"><div class="panel-head"><div><h2>${esc(t('section_fields'))}</h2><p>${esc(t('fields_intro'))}</p></div></div><div class="policy-table">${fieldRows}</div></section>
      <section class="panel"><div class="panel-head"><div><h2>${esc(t('section_features'))}</h2><p>${esc(t('features_intro'))}</p></div><span class="pill pill-empty">${tpl.features.length} ${esc(t('rows'))}</span></div>
        <div class="fe-list">${tpl.features.map((f, i) => featureEditorRow(f, i, tpl.features.length)).join('')}</div>
        <div class="panel-foot"><button type="button" class="btn" data-action="feature-add" data-kind="numeric">+ ${esc(t('feat_add'))}</button><button type="button" class="btn" data-action="feature-add" data-kind="gauge">+ ${esc(t('feat_add_gauge'))}</button></div></section>
    </div></div>`;
}

function refreshFeaturePreview(id) {
  const f = featureHost().features.find(x => x.id === id);
  const row = $(`.fe-row[data-feature="${CSS.escape(id)}"]`);
  if (!f || !row) return;
  const problems = Core.featureProblems(f);
  row.classList.toggle('has-problem', problems.length > 0);
  const preview = f.kind === 'numeric' ? `${Core.requirementText(f) || '—'} ${Core.unitLabel(f.unit)} <span class="muted">(${esc(Core.limitsText(f) || '—')})</span>` : esc(f.label || '—');
  $('.fe-preview', row).innerHTML = `<span class="fe-preview-label">${esc(t('feat_preview'))}:</span> <span class="fe-preview-text">${f.kind === 'numeric' ? esc(Core.requirementText(f) || '—') + ' ' + esc(Core.unitLabel(f.unit)) + ` <span class="muted">(${esc(Core.limitsText(f) || '—')})</span>` : preview}</span>${problems.length ? `<span class="fe-problem">${esc(t('feat_problem_' + problems[0].replace(/-/g, '_')))}</span>` : ''}`;
}

// ---------- preview tab ----------
function renderPreview() {
  ensureDraft();
  const report = state.draft;
  const status = Core.reportStatus(report);
  const note = status === 'fail' ? ['alert-fail', t('preview_fail')] : status === 'incomplete' ? ['alert-warn', t('preview_incomplete')] : ['alert-ok', t('preview_pass')];
  $('#main').innerHTML = heading(t('preview_kicker'), t('preview_title'), t('preview_intro'),
    `<button type="button" class="btn" data-action="go-report">${esc(t('back_to_report'))}</button><button type="button" class="btn btn-primary" data-action="print">${esc(t('print_pdf'))}</button>`) +
    `<div class="alert ${note[0]}">${esc(note[1])}</div><div class="hint-line">${esc(t('print_hint'))}</div>
    <div class="paper-wrap"><div class="paper" id="previewPaper">${renderReportSheet(activeTemplate(), report)}</div></div>`;
}

function renderPrintSheet() {
  ensureDraft();
  $('#printSheet').innerHTML = renderReportSheet(activeTemplate(), state.draft);
}

function printReport() {
  renderPrintSheet();
  const original = document.title;
  document.title = reportFileName(state.draft);
  const restore = () => { document.title = original; window.removeEventListener('afterprint', restore); };
  window.addEventListener('afterprint', restore);
  window.print();
  setTimeout(restore, 60000);
}

// ---------- render ----------
function render() {
  ensureDraft();
  renderShell();
  if (ui.tab === 'archive') renderArchive();
  else if (ui.tab === 'templates') renderTemplates();
  else if (ui.tab === 'preview') renderPreview();
  else if (ui.tab === 'products') $('#main').innerHTML = renderProducts(ctx);
  else if (ui.tab === 'import') $('#main').innerHTML = renderImport(ctx);
  else if (ui.tab === 'settings') $('#main').innerHTML = renderSettings(ctx);
  else renderReport();
  renderPrintSheet();
}
let renderTimer;
function renderSoon() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 350); }
function renderKeepingFocus(id) {
  const el = document.getElementById(id); const pos = el ? el.selectionStart : null;
  render();
  const again = document.getElementById(id);
  if (again) { again.focus(); if (pos != null && again.setSelectionRange) try { again.setSelectionRange(pos, pos); } catch (_) { /* not a text input */ } }
}
function go(tab) { ui.tab = tab; window.scrollTo(0, 0); render(); }

// ---------- actions ----------
function newReportAction() {
  const has = Core.reportHasContent(state.draft);
  if (!confirmAction(has ? t('confirm_new_report') : t('confirm_new_report_empty'))) return;
  const archived = startNewReport(activeTemplate());
  go('report');
  toast(archived ? t('toast_archived') : t('toast_new_report'));
}

function switchTemplate(id) {
  const chosen = state.templates.find(x => x.id === id);
  if (!chosen || chosen.id === state.activeTemplateId) return;
  if (!confirmAction(t('confirm_switch_template'))) { renderShell(); return; }
  startNewReport(chosen);
  ui.editTemplateId = chosen.id;
  go('report');
  toast(t('toast_template_changed'));
}

async function importBackupFile(file) {
  if (!file) return;
  if (file.size > Store.MAX_IMPORT_BYTES) return toast(t('toast_import_invalid'));
  let parsed;
  try { parsed = Store.parseBackup(await file.text()); } catch (_) { return toast(t('toast_import_invalid')); }
  if (!confirmAction(t('confirm_import'))) return;
  const { state: merged, counts } = Store.mergeBackup(state, parsed);
  state = merged;
  if (!state.templates.some(x => x.id === state.activeTemplateId)) state.activeTemplateId = state.templates[0].id;
  ui.editTemplateId = state.activeTemplateId;
  persist(); render();
  toast(t('toast_import_ok', { t: counts.addedTemplates + counts.updatedTemplates, r: counts.addedReports + counts.updatedReports }));
}

function exportBackup() {
  const data = Store.buildBackup(state);
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `ucm-inspection-backup-${Core.localDate()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  state.settings.lastBackupAt = new Date().toISOString();
  persist(); renderShell();
  toast(t('toast_backup_exported'));
}

function loadLogo(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) return toast(t('toast_logo_invalid'));
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    URL.revokeObjectURL(url);
    const maxW = 900, maxH = 360;
    const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = file.type === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png');
    if (dataUrl.length > 800000) return toast(t('toast_logo_invalid'));
    const tpl = editTemplate();
    tpl.company.logo = dataUrl; touch(tpl);
    persist(); render(); toast(t('toast_logo_saved'));
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast(t('toast_logo_invalid')); };
  img.src = url;
}

function applyTemplateChangeToDraft(tpl) {
  if (state.draft && state.draft.templateId === tpl.id) {
    state.draft = Core.syncReportFeatures(state.draft, tpl);
    for (const def of Core.HEADER_FIELDS) {
      if (def.lockable && tpl.fields[def.key].mode === 'fixed') state.draft.header[def.key] = tpl.fields[def.key].value;
    }
  }
}

function clickAction(action, el) {
  const tpl = editTemplate();
  switch (action) {
    case 'go-report': return go('report');
    case 'go-preview': return go('preview');
    case 'go-archive': return go('archive');
    case 'edit-template': ui.editTemplateId = state.activeTemplateId; return go('templates');
    case 'new-report': return newReportAction();
    case 'print': return printReport();
    case 'help': return $('#helpDialog').showModal();
    case 'export-backup': return exportBackup();
    case 'import-backup': return $('#importFile').click();
    case 'archive-open': {
      const r = state.archive.find(x => x.id === el.dataset.id);
      if (!r || !confirmAction(t('confirm_open_archived'))) return;
      const old = state.draft;
      state.archive = state.archive.filter(x => x.id !== r.id);
      if (old && Core.reportHasContent(old)) state.archive = [old, ...state.archive].slice(0, Store.MAX_ARCHIVE);
      if (old && Core.reportHasContent(old)) Sync.markDirty(state, 'report', old.id);
      state.draft = r;
      if (state.templates.some(x => x.id === r.templateId)) state.activeTemplateId = r.templateId;
      persist(); scheduleSync(); return go('report');
    }
    case 'archive-duplicate': {
      const r = state.archive.find(x => x.id === el.dataset.id);
      if (!r) return;
      const base = state.templates.find(x => x.id === r.templateId) || activeTemplate();
      startNewReport(base, { carryFrom: r });
      for (const key of ['customer', 'purchaseOrder', 'productionOrder', 'partNo', 'partName', 'drawingNo', 'revision', 'catalogNo', 'material', 'inspector']) {
        if (!Core.isLocked(base, key) && r.header[key]) state.draft.header[key] = r.header[key];
      }
      persist(); go('report'); return toast(t('toast_report_duplicated'));
    }
    case 'archive-delete': {
      const r = state.archive.find(x => x.id === el.dataset.id);
      if (!r || !confirmAction(t('confirm_delete_report', { no: r.header.reportNo || '' }))) return;
      state.archive = state.archive.filter(x => x.id !== r.id);
      Sync.markDeleted(state, 'report', r.id);
      persist(); scheduleSync(); renderArchive(); return toast(t('toast_report_deleted'));
    }
    case 'template-edit': ui.editTemplateId = el.dataset.id; return renderTemplates();
    case 'template-use': return switchTemplate(el.dataset.id);
    case 'template-new': {
      if (state.templates.length >= Store.MAX_TEMPLATES) return toast(t('toast_max_templates'));
      const fresh = Core.defaultTemplate();
      fresh.company = { ...tpl.company };
      fresh.name = t('template_new');
      state.templates.push(fresh); ui.editTemplateId = fresh.id; touch(fresh);
      persist(); renderTemplates(); return toast(t('toast_template_created'));
    }
    case 'template-duplicate': {
      if (state.templates.length >= Store.MAX_TEMPLATES) return toast(t('toast_max_templates'));
      const clone = JSON.parse(JSON.stringify(tpl));
      clone.id = Core.newId(); clone.name = `${tpl.name} (2)`; clone.updatedAt = new Date().toISOString();
      clone.features.forEach(f => { f.id = Core.newId(); });
      state.templates.push(clone); ui.editTemplateId = clone.id; touch(clone);
      persist(); renderTemplates(); return toast(t('toast_template_duplicated'));
    }
    case 'template-delete': {
      if (state.templates.length < 2 || !confirmAction(t('confirm_delete_template', { name: tpl.name }))) return;
      state.templates = state.templates.filter(x => x.id !== tpl.id);
      Sync.markDeleted(state, 'template', tpl.id);
      if (state.activeTemplateId === tpl.id) {
        state.activeTemplateId = state.templates[0].id;
        if (state.draft && state.draft.templateId === tpl.id) startNewReport(state.templates[0]);
      }
      ui.editTemplateId = state.activeTemplateId;
      persist(); renderShell(); renderTemplates(); return toast(t('toast_template_deleted'));
    }
    case 'logo-remove': tpl.company.logo = ''; touch(tpl); persist(); return renderTemplates();
    case 'feature-add': {
      const host = featureHost();
      if (host.features.length >= Core.MAX_FEATURES) return;
      const last = host.features[host.features.length - 1];
      const f = Core.blankFeature(el.dataset.kind || 'numeric');
      if (f.kind === 'numeric' && last && last.kind === 'numeric') { f.method = last.method; f.unit = last.unit; f.upper = last.upper; f.lower = last.lower; f.symmetric = last.symmetric; }
      host.features.push(f); host.touch();
      persist(); host.rerender();
      const input = $(`.fe-row[data-feature="${CSS.escape(f.id)}"] input[name="f:label"]`);
      if (input) input.focus();
      return toast(t('toast_feature_added'));
    }
    case 'feature-remove': {
      const host = featureHost();
      if (host.features.length < 2) return toast(t('toast_last_feature'));
      if (!confirmAction(t('confirm_remove_feature'))) return;
      host.record.features = host.features.filter(f => f.id !== el.dataset.id); host.touch();
      persist(); return host.rerender();
    }
    case 'feature-duplicate': {
      const host = featureHost();
      const i = host.features.findIndex(f => f.id === el.dataset.id);
      if (i === -1 || host.features.length >= Core.MAX_FEATURES) return;
      host.features.splice(i + 1, 0, { ...host.features[i], id: Core.newId() }); host.touch();
      persist(); return host.rerender();
    }
    case 'feature-up': case 'feature-down': {
      const host = featureHost();
      const i = host.features.findIndex(f => f.id === el.dataset.id);
      const j = action === 'feature-up' ? i - 1 : i + 1;
      if (i === -1 || j < 0 || j >= host.features.length) return;
      [host.features[i], host.features[j]] = [host.features[j], host.features[i]]; host.touch();
      persist(); return host.rerender();
    }
    case 'go-products': return go('products');
    case 'go-import': ui.import = newImportState(); return go('import');
    case 'go-settings': return go('settings');
    case 'product-open-current': { const p = draftProduct(); if (p) { ui.editProductId = p.id; go('products'); } return undefined; }
    case 'product-use': {
      const p = state.products.find(x => x.id === el.dataset.id); if (!p) return undefined;
      if (Core.reportHasContent(state.draft) && !confirmAction(t('confirm_change_product'))) return undefined;
      ui.productSearch = '';
      startNewReportForProduct(p); return go('report');
    }
    default: {
      if (onProductsAction(ctx, action, el)) return undefined;
      if (action.startsWith('im-')) return onImportAction(ctx, action, el);
      if (action.startsWith('sync-')) return onSettingsAction(ctx, action);
      return undefined;
    }
  }
}

function onInput(event) {
  const el = event.target;
  const name = el.name || '';
  if (el.id === 'archiveSearch') { ui.archiveQuery = el.value; renderArchive(); $('#archiveSearch').focus(); const s = $('#archiveSearch'); s.setSelectionRange(s.value.length, s.value.length); return; }
  if (ui.tab === 'import') { onImportInput(ctx, el); return; }
  if (ui.tab === 'settings') { onSettingsInput(ctx, el); renderSyncIndicator(); return; }
  if (ui.tab === 'products' && !name.startsWith('f:')) { onProductsInput(ctx, el); return; }
  if (ui.tab === 'report' && el.id === 'productSearch') { ui.productSearch = el.value; renderProductResults(); return; }
  if (ui.tab === 'report') {
    const report = state.draft;
    if (name.startsWith('h:')) {
      let key = name.slice(2);
      let value = el.value;
      if (key.endsWith('__other')) { key = key.slice(0, -7); }
      else if (key === 'aql' && value === '__other') { const other = $('.aql-other', el.parentElement); other.hidden = false; other.focus(); value = other.value; }
      else if (key === 'aql') { const other = $('.aql-other', el.parentElement); if (other) other.hidden = true; }
      if (!Core.HEADER_KEYS.includes(key) || Core.isLocked(activeTemplate(), key) || Core.isProductLocked(report, key)) return;
      report.header[key] = value; report.updatedAt = new Date().toISOString();
      refreshReportDerived(); persistSoon(); return;
    }
    if (el.dataset.measure) {
      const r = report.results[el.dataset.id]; if (!r) return;
      r[el.dataset.measure] = el.value; report.updatedAt = new Date().toISOString();
      refreshRow(el.dataset.id); refreshReportDerived(); persistSoon(); return;
    }
    if (el.id === 'remarks') { report.remarks = el.value; report.updatedAt = new Date().toISOString(); persistSoon(); return; }
  }
  if (ui.tab === 'templates' || ui.tab === 'products') {
    const tpl = editTemplate();
    if (name === 't:name') { tpl.name = el.value; touch(tpl); persistSoon(); renderShellSoon(); return; }
    if (name.startsWith('c:')) { tpl.company[name.slice(2)] = el.value; touch(tpl); persistSoon(); return; }
    if (name.startsWith('n:')) {
      const k = name.slice(2);
      if (k === 'mode') { tpl.numbering.mode = el.value === 'manual' ? 'manual' : 'auto'; touch(tpl); persist(); renderTemplates(); return; }
      if (k === 'next') { const n = Number(el.value); tpl.numbering.next = Number.isSafeInteger(n) && n >= 1 ? n : tpl.numbering.next; }
      if (k === 'width') { const n = Number(el.value); tpl.numbering.width = Number.isSafeInteger(n) ? Math.max(0, Math.min(8, n)) : tpl.numbering.width; }
      if (k === 'prefix') tpl.numbering.prefix = el.value.slice(0, 40);
      touch(tpl); persistSoon();
      const prev = $('#numberingPreview'); if (prev) prev.textContent = tpl.numbering.mode === 'auto' ? t('numbering_preview', { no: Core.formatReportNo(tpl.numbering) }) : '';
      return;
    }
    if (name === 'p:mode') {
      const key = el.dataset.key; if (!tpl.fields[key]) return;
      tpl.fields[key].mode = Core.FIELD_MODES.includes(el.value) ? el.value : 'blank';
      const valueInput = $(`[name="p:value"][data-key="${CSS.escape(key)}"]`); if (valueInput) valueInput.disabled = tpl.fields[key].mode === 'blank';
      touch(tpl); applyTemplateChangeToDraft(tpl); persist(); return;
    }
    if (name === 'p:value' || name === 'p:aql' || name === 'p:aql__other' || name === 'p:inspectionLevel') {
      let key = el.dataset.key || name.slice(2).replace('__other', '');
      let value = el.value;
      if (name === 'p:aql') {
        const other = $('.aql-other', el.parentElement);
        if (value === '__other') { other.hidden = false; other.focus(); value = other.value; } else other.hidden = true;
      }
      if (!tpl.fields[key]) return;
      tpl.fields[key].value = value.slice(0, 240); touch(tpl); applyTemplateChangeToDraft(tpl); persistSoon(); return;
    }
    if (name.startsWith('f:')) {
      const host = featureHost();
      const f = host.features.find(x => x.id === el.dataset.fid); if (!f) return;
      const k = name.slice(2);
      if (k === 'kind') { f.kind = Core.FEATURE_KINDS.includes(el.value) ? el.value : 'numeric'; if (f.kind !== 'numeric') { f.nominal = ''; f.upper = ''; f.lower = ''; f.unit = ''; } else if (!f.unit) f.unit = 'mm'; host.touch(); persist(); host.rerender(); return; }
      if (k === 'symmetric') { f.symmetric = el.value === '1'; host.touch(); persist(); host.rerender(); return; }
      if (['label', 'nominal', 'upper', 'lower', 'method', 'unit', 'note', 'suffix'].includes(k)) f[k] = el.value;
      host.touch(); persistSoon(); refreshFeaturePreview(f.id);
    }
  }
}
let shellTimer;
function renderShellSoon() { clearTimeout(shellTimer); shellTimer = setTimeout(renderShell, 400); }

function onChange(event) {
  const el = event.target;
  if (el.id === 'quickTemplate') return switchTemplate(el.value);
  if (el.id === 'importFile') { const f = el.files && el.files[0]; el.value = ''; return importBackupFile(f); }
  if (el.id === 'logoUpload') { const f = el.files && el.files[0]; el.value = ''; return loadLogo(f); }
  if (ui.tab === 'import') return onImportChange(ctx, el);
  return undefined;
}

function onDrag(event) {
  const zone = event.target.closest && event.target.closest('#dropZone');
  if (!zone) return;
  if (event.type === 'dragover') { event.preventDefault(); zone.classList.add('over'); }
  if (event.type === 'dragleave') zone.classList.remove('over');
  if (event.type === 'drop') { event.preventDefault(); zone.classList.remove('over'); const f = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]; if (f) startImport(ctx, f); }
}

// ---------- sync ----------
const normalizers = { product: Store.normalizeProduct, template: Store.normalizeTemplate, report: Store.normalizeReport };
function scheduleSync(delay = 2500) {
  if (!Sync.syncConfigured(state.settings)) return;
  clearTimeout(syncState.timer);
  syncState.timer = setTimeout(() => runSync(false), delay);
}
async function runSync(manual = false) {
  if (!Sync.syncConfigured(state.settings) || syncState.running) return false;
  if (navigator.onLine === false) { renderSyncIndicator(); return false; }
  syncState.running = true;
  try {
    let result;
    let rounds = 0;
    do { result = await Sync.runSync(state, normalizers); rounds++; } while (rounds < 10 && result.pulled && (result.pulled.added + result.pulled.updated + result.pulled.deleted) >= 500);
    syncState.error = '';
    ensureDraft();
    persist();
    const changed = result.pulled.added + result.pulled.updated + result.pulled.deleted;
    if (changed && ['products', 'archive', 'templates', 'settings'].includes(ui.tab)) render(); else renderSyncIndicator();
    if (manual) toast(t('toast_synced'));
    return true;
  } catch (error) {
    syncState.error = error.message === 'unauthorized' ? t('sync_unauthorized') : String(error.message || error);
    renderSyncIndicator();
    if (manual) toast(t('toast_sync_failed'));
    return false;
  } finally { syncState.running = false; }
}

function onClick(event) {
  const nav = event.target.closest('[data-tab]');
  if (nav) return go(nav.dataset.tab);
  const outcome = event.target.closest('[data-outcome]');
  if (outcome && ui.tab === 'report') {
    const r = state.draft.results[outcome.dataset.id]; if (!r) return;
    r.outcome = outcome.dataset.outcome || ''; state.draft.updatedAt = new Date().toISOString();
    refreshRow(outcome.dataset.id); refreshReportDerived(); persistSoon(); return;
  }
  const copy = event.target.closest('[data-copy-min]');
  if (copy) {
    const id = copy.dataset.copyMin; const r = state.draft.results[id]; if (!r) return;
    r.max = r.min; const input = $(`input[data-measure="max"][data-id="${CSS.escape(id)}"]`); if (input) { input.value = r.min; input.focus(); }
    refreshRow(id); refreshReportDerived(); persistSoon(); return;
  }
  const btn = event.target.closest('[data-action]');
  if (btn) return clickAction(btn.dataset.action, btn);
  return undefined;
}

function onKeydown(event) {
  if (event.key !== 'Enter' || ui.tab !== 'report') return;
  const el = event.target;
  if (!(el instanceof HTMLInputElement) || !el.dataset.measure) return;
  event.preventDefault();
  if (el.dataset.measure === 'max' && !el.value.trim()) {
    const r = state.draft.results[el.dataset.id];
    if (r && r.min.trim()) { r.max = r.min; el.value = r.min; refreshRow(el.dataset.id); refreshReportDerived(); persistSoon(); }
  }
  const inputs = $$('input.m-input');
  const i = inputs.indexOf(el);
  const next = inputs[i + 1] || $('#remarks');
  if (next) { next.focus(); if (next.select) next.select(); }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) toast(t('toast_update_available')); });
    });
  }).catch(() => { /* offline support is optional */ });
}

function init() {
  state = Store.loadState(storage);
  ui.editTemplateId = state.activeTemplateId;
  ensureDraft();
  // static text
  $$('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
  $('#helpSteps').innerHTML = t('help_steps').map(s => `<li>${esc(s)}</li>`).join('');
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);
  for (const type of ['dragover', 'dragleave', 'drop']) document.addEventListener(type, onDrag);
  document.addEventListener('click', event => { if (!event.target.closest('.product-wrap')) { const box = $('#productResults'); if (box) box.hidden = true; } }, true);
  window.addEventListener('beforeunload', () => { if (ui.saveTimer) persist(); });
  window.addEventListener('beforeprint', renderPrintSheet);
  window.addEventListener('online', () => scheduleSync(500));
  render();
  persist();
  registerServiceWorker();
  if (Sync.syncConfigured(state.settings)) { scheduleSync(300); setInterval(() => scheduleSync(0), 5 * 60 * 1000); }
  window.UCM = { get state() { return state; }, get ui() { return ui; }, render, Core, Store, Sync, reportFileName, runSync, startImport: file => startImport(ctx, file) };
}

/** Shared context for the UI modules. */
const ctx = {
  get state() { return state; }, get ui() { return ui; }, syncState, version: APP_VERSION,
  persist, persistSoon, render, renderSoon, renderKeepingFocus, renderListSoon: renderSoon, go, toast, confirm: confirmAction, heading, formatDateTime,
  markDirty: (kind, id) => { Sync.markDirty(state, kind, id); scheduleSync(); },
  markDeleted: (kind, id) => { Sync.markDeleted(state, kind, id); scheduleSync(); },
  activeTemplate, startNewReportForProduct, featureEditorRow, runSync,
  syncDraftWithProduct: p => { if (state.draft && state.draft.productId === p.id) { state.draft = Core.syncReportFeatures(state.draft, activeTemplate(), p); for (const key of Core.PRODUCT_FIELDS) if (String(p[key] || '').trim()) state.draft.header[key] = String(p[key]); } },
  aiAvailable: () => Sync.syncConfigured(state.settings) && (!syncState.health || syncState.health.ai !== false),
  fileUrl: id => (Sync.syncConfigured(state.settings) ? Sync.fileUrl(state.settings, id) : ''),
};

init();
