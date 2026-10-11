/* UI layer: state, rendering and events. All model logic lives in core.js / sampling.js / storage.js. */
import * as Core from './core.js';
import { t } from './i18n.js';
import * as Store from './storage.js';
import { renderReportSheet, escapeHtml, reportFileName } from './report-sheet.js';
import * as Sync from './sync.js';
import { renderImport, onImportInput, onImportChange, onImportAction, onImportKeydown, startImport, newImportState } from './ui-import.js';
import { renderProducts, onProductsInput, onProductsAction, filterProducts, productLabel } from './ui-products.js';
import { renderSettings, onSettingsInput, onSettingsAction, syncStatusText } from './ui-settings.js';
import { CONFIG } from './config.js';

const APP_VERSION = '3.0.0';

const esc = escapeHtml;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const storage = window.localStorage;

let state;
const ui = { tab: 'report', editProductId: null, archiveQuery: '', productQuery: '', productSearch: '', saveTimer: null, toastTimer: null, import: newImportState() };
const syncState = { running: false, error: '', health: null, testMessage: '', timer: null };

// ---------- persistence ----------
function persist() {
  clearTimeout(ui.saveTimer); ui.saveTimer = null;
  try { Store.saveState(storage, state); return true; }
  catch (_) { toast(t('toast_storage_error')); return false; }
}
function persistSoon() { clearTimeout(ui.saveTimer); ui.saveTimer = setTimeout(() => { persist(); scheduleSync(); }, 300); }

function draftProduct() { return state.draft && state.draft.productId ? state.products.find(p => p.id === state.draft.productId) || null : null; }

function ensureDraft() {
  if (!state.draft) state.draft = Core.createReport(null);
  const product = draftProduct();
  if (product) state.draft = Core.syncReportWithProduct(state.draft, product);
}

/** Move the current draft to the archive (if it has content) and open a new one for `product`. Returns true when archived. */
function startNewReport(product) {
  const old = state.draft;
  let archived = false;
  if (old && Core.reportHasContent(old)) {
    old.updatedAt = new Date().toISOString();
    state.archive = [old, ...state.archive.filter(r => r.id !== old.id)].slice(0, Store.MAX_ARCHIVE);
    Sync.markDirty(state, 'report', old.id);
    archived = true;
  }
  state.draft = Core.createReport(product, old, new Date());
  persist(); scheduleSync();
  return archived;
}
/** Make `report` the current draft (archiving the previous draft when it holds content). */
function openReport(report) {
  const old = state.draft;
  if (old && old.id !== report.id && Core.reportHasContent(old)) {
    old.updatedAt = new Date().toISOString();
    state.archive = [old, ...state.archive.filter(r => r.id !== old.id)].slice(0, Store.MAX_ARCHIVE);
    Sync.markDirty(state, 'report', old.id);
  }
  state.draft = JSON.parse(JSON.stringify(report));
  persist(); scheduleSync();
}
function startNewReportForProduct(product) {
  const archived = startNewReport(product);
  toast(archived ? t('toast_archived') : t('toast_new_report'));
}

// ---------- helpers ----------
function toast(message) {
  const el = $('#toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function confirmAction(message) { return window.confirm(message); }
const attr = esc;
function fieldLabel(key) { return t('f_' + key); }
function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('he-IL', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function statusPill(s) {
  const map = { ok: ['ok', 'st_ok'], 'manual-pass': ['ok', 'st_manual_pass'], fail: ['fail', 'st_fail'], review: ['review', 'st_review'], empty: ['empty', 'st_empty'] };
  const [cls, key] = map[s] || map.review;
  return `<span class="pill pill-${cls}">${esc(t(key))}</span>`;
}
function reasonText(reason) { return t('reason_' + String(reason || '').replace(/-/g, '_')); }
function reportStatusPill(report) {
  const s = Core.reportStatus(report);
  const cls = s === 'pass' ? 'ok' : s === 'fail' ? 'fail' : 'review';
  return `<span class="pill pill-${cls}">${esc(t('report_status_' + s))}</span>`;
}

// ---------- shell ----------
function renderShell() {
  renderSyncIndicator();
  $$('[data-tab]').forEach(b => {
    const active = b.dataset.tab === ui.tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-current', active ? 'page' : 'false');
  });
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
function headerField(key, report, { locked = false } = {}) {
  const def = Core.HEADER_FIELDS.find(f => f.key === key);
  const value = report.header[key] || '';
  const id = 'h_' + key;
  const type = def.type === 'date' ? 'date' : 'text';
  const control = `<input id="${id}" type="${type}" name="h:${key}" value="${attr(value)}" ${locked ? 'disabled' : ''} ${def.numeric ? 'inputmode="numeric"' : ''} dir="${key === 'customer' || key === 'inspector' || key === 'partName' ? 'auto' : 'ltr'}" autocomplete="off">`;
  const extra = key === 'quantity' ? `<small class="hint" id="samplingLine">${esc(samplingLine(report))}</small>` : '';
  return `<div class="field${locked ? ' locked' : ''}"><label for="${id}">${esc(fieldLabel(key))}</label>${control}${extra}</div>`;
}

function samplingLine(report) {
  const { plan } = Core.reportSampling(report);
  if (!plan) return t('enter_quantity', { level: report.header.inspectionLevel || 'II' });
  if (plan.lotOfOne) return t('sample_line_one');
  if (plan.fullInspection) return t('sample_line_full', { n: plan.sampleSize });
  if (!plan.plan) return t('sample_line_no_plan', { n: plan.sampleSize });
  return t('sample_line', { n: plan.sampleSize, letter: plan.plan.letter, ac: plan.plan.ac, re: plan.plan.re });
}

function warningsHtml(report) {
  const list = Core.headerWarnings(report).map(w => t('warn_' + w.replace(/-/g, '_')));
  if (report.features.some(f => Core.featureProblems(f).length)) list.push(t('warn_product_problems'));
  if (!list.length) return '';
  return `<div class="alert alert-warn">${list.map(x => `<div>${esc(x)}</div>`).join('')}</div>`;
}

function resultRow(f, i, report) {
  const r = report.results[f.id] || Core.blankResult();
  const ev = Core.evaluateFeature(f, r);
  const problems = Core.featureProblems(f);
  let controls;
  if (f.kind === 'numeric') {
    controls = `<td><input class="m-input" type="text" inputmode="decimal" data-measure="min" data-id="${attr(f.id)}" value="${attr(r.min)}" aria-label="${attr(t('col_min'))} ${i + 1}" placeholder="min"></td>
      <td class="max-cell"><input class="m-input" type="text" inputmode="decimal" data-measure="max" data-id="${attr(f.id)}" value="${attr(r.max)}" aria-label="${attr(t('col_max'))} ${i + 1}" placeholder="max"><button type="button" class="copy-min" data-copy-min="${attr(f.id)}" title="${attr(t('copy_min'))}" aria-label="${attr(t('copy_min'))}" tabindex="-1">=</button></td>`;
  } else {
    controls = `<td colspan="2"><div class="seg" role="group" aria-label="${attr(Core.requirementText(f))}">
      <button type="button" class="seg-btn seg-pass${r.outcome === 'pass' ? ' on' : ''}" data-outcome="pass" data-id="${attr(f.id)}">${esc(t('go'))}</button>
      <button type="button" class="seg-btn seg-fail${r.outcome === 'fail' ? ' on' : ''}" data-outcome="fail" data-id="${attr(f.id)}">${esc(t('nogo'))}</button>
      <button type="button" class="seg-btn seg-clear${r.outcome ? '' : ' on'}" data-outcome="" data-id="${attr(f.id)}" title="${attr(t('clear'))}">&times;</button></div></td>`;
  }
  const tol = Core.printedTolerances(f);
  const tolText = f.kind === 'numeric' ? (f.symmetric ? '±' + tol.plus : `−${tol.minus} / +${tol.plus}`) : 'GO / NO-GO';
  const limits = f.kind === 'numeric' ? (Core.limitsText(f) || '—') : '';
  const problemText = problems.length ? `<div class="row-problem">${esc(t('feat_problem_' + problems[0].replace(/-/g, '_')))}</div>` : '';
  return `<tr data-row="${attr(f.id)}">
    <td class="num">${i + 1}</td>
    <td class="req"><div>${esc(Core.printedRequired(f) || '—')}</div>${problemText}</td>
    <td class="lim" dir="ltr">${esc(tolText)}${limits ? `<div class="lim-range">${esc(limits)}</div>` : ''}</td>
    <td class="method">${esc(f.method || '—')}</td>
    ${controls}
    <td class="row-status" title="${attr(reasonText(ev.reason))}">${statusPill(ev.state)}</td>
  </tr>`;
}

function renderReport() {
  ensureDraft();
  const report = state.draft;
  const product = draftProduct();
  if (!product) {
    $('#main').innerHTML = heading(t('report_kicker'), t('report_title'), t('report_intro')) +
      `<section class="panel"><div class="empty-start">
        <h2>${esc(t('no_product_title'))}</h2><p>${esc(t('no_product_text'))}</p>
        <div class="page-actions"><button type="button" class="btn btn-primary" data-action="go-import">${esc(t('product_import'))}</button>
        ${state.products.length ? `<button type="button" class="btn" data-action="go-products">${esc(t('nav_products'))}</button>` : ''}</div>
        ${state.products.length ? `<div class="product-wrap"><input id="productSearch" type="search" class="search" placeholder="${attr(t('product_pick_ph'))}" value="${attr(ui.productSearch)}" autocomplete="off"><div id="productResults" class="product-results" hidden></div></div>` : ''}
      </div></section>`;
    renderProductResults();
    return;
  }
  const orderKeys = ['reportNo', 'inspectionDate', 'inspector', 'productionOrder', 'purchaseOrder', 'quantity', 'customer', 'totalInspected', 'accepted', 'rejected'];
  const productKeys = ['partNo', 'revision', 'partName', 'catalogNo', 'generalTolerance', 'aql'];
  const actions = `<button type="button" class="btn" data-action="new-report">${esc(t('new_report'))}</button>
    <button type="button" class="btn btn-primary" data-action="go-preview">${esc(t('preview_pdf'))}</button>`;
  $('#main').innerHTML = heading(t('report_kicker'), t('report_title'), t('report_intro'), actions) +
    `<div id="warnings">${warningsHtml(report)}</div>
    <section class="panel"><div class="product-bar">
      <span class="chip" dir="auto">${esc(t('product_current'))}: <b dir="ltr">${esc(product.partNo)}</b> ${product.revision ? `<span>Rev ${esc(product.revision)}</span>` : ''} ${product.partName ? `<span>· ${esc(product.partName)}</span>` : ''}</span>
      <button type="button" class="btn btn-small" data-action="product-open-current">${esc(t('edit_product'))}</button>
      <div class="product-wrap"><input id="productSearch" type="search" class="search" placeholder="${attr(t('product_pick_ph'))}" value="${attr(ui.productSearch)}" autocomplete="off" aria-label="${attr(t('product_pick_ph'))}"><div id="productResults" class="product-results" hidden></div></div>
      <button type="button" class="btn btn-small" data-action="go-import">${esc(t('product_import'))}</button>
    </div></section>
    <section class="panel"><div class="panel-head"><div><h2>${esc(t('section_order'))}</h2><p>${esc(t('section_order_note'))}</p></div><div id="statusPill">${reportStatusPill(report)}</div></div>
      <div class="panel-body field-grid">${orderKeys.map(k => headerField(k, report)).join('')}</div></section>
    <section class="panel"><div class="panel-head"><div><h2>${esc(t('section_product'))}</h2><p>${esc(t('section_product_note'))}</p></div><button type="button" class="btn btn-ghost" data-action="product-open-current">${esc(t('edit_product'))}</button></div>
      <div class="panel-body field-grid">${productKeys.map(k => headerField(k, report, { locked: true })).join('')}</div></section>
    <section class="panel"><div class="panel-head"><div><h2>${esc(t('section_results'))}</h2><p>${esc(t('section_results_note'))}</p></div><span class="pill pill-empty">${report.features.length} ${esc(t('rows'))}</span></div>
      <div class="table-wrap"><table class="results" dir="rtl"><colgroup><col class="c-no"><col class="c-req"><col class="c-lim"><col class="c-method"><col class="c-min"><col class="c-max"><col class="c-res"></colgroup>
      <thead><tr><th>${esc(t('col_no'))}</th><th>${esc(t('col_required'))}</th><th>${esc(t('col_tol'))}</th><th>${esc(t('col_method'))}</th><th>${esc(t('col_min'))}</th><th>${esc(t('col_max'))}</th><th>${esc(t('col_result'))}</th></tr></thead>
      <tbody>${report.features.map((f, i) => resultRow(f, i, report)).join('')}</tbody></table></div></section>
    <section class="panel"><div class="panel-head"><h2>${esc(t('section_remarks'))}</h2></div><div class="panel-body"><textarea id="remarks" rows="3" placeholder="${attr(t('remarks_placeholder'))}" dir="auto">${esc(report.remarks || '')}</textarea></div>
      <div class="panel-foot"><button type="button" class="btn btn-primary" data-action="go-preview">${esc(t('preview_pdf'))}</button></div></section>`;
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
  const report = state.draft;
  const sl = $('#samplingLine'); if (sl) sl.textContent = samplingLine(report);
  const sp = $('#statusPill'); if (sp) sp.innerHTML = reportStatusPill(report);
  const w = $('#warnings'); if (w) w.innerHTML = warningsHtml(report);
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
        <button type="button" class="btn btn-small btn-danger" data-action="archive-delete" data-id="${attr(r.id)}">${esc(t('archive_delete'))}</button></td>
    </tr>`).join('');
  const warn = state.archive.length >= Store.MAX_ARCHIVE * 0.8 ? `<div class="alert alert-warn">${esc(t('archive_warn_full', { max: Store.MAX_ARCHIVE }))}</div>` : '';
  $('#main').innerHTML = heading(t('archive_kicker'), t('archive_title'), t('archive_intro')) + warn +
    `<section class="panel"><div class="panel-head"><input id="archiveSearch" type="search" class="search" placeholder="${attr(t('archive_search'))}" value="${attr(ui.archiveQuery)}"><span class="pill pill-empty">${esc(t('archive_count', { n: list.length }))}</span></div>
    ${list.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>${esc(t('col_date'))}</th><th>${esc(t('col_report_no'))}</th><th>${esc(t('col_customer'))}</th><th>${esc(t('col_part'))}</th><th>${esc(t('col_qty'))}</th><th>${esc(t('col_status'))}</th><th>${esc(t('col_actions'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="empty">${esc(t('archive_empty'))}</div>`}</section>`;
}

// ---------- printed sheet: measure rows, split into A4 pages ----------
const PAGE_SAFETY_PX = 14;
function paginateReport(report) {
  const host = $('#measureSheet');
  const all = report.features.map((_, i) => i);
  host.innerHTML = renderReportSheet(report, { pages: [all, []], measure: true });
  const probe = document.createElement('div'); probe.style.height = '274mm'; host.appendChild(probe);
  const pageHeight = probe.offsetHeight; probe.remove();
  const pagesEl = $$('.rs-page', host);
  // Space taken on a page by everything except the rows: running header (+ masthead on page 1), table header, footer.
  const fixed = pagesEl.map(p => { const table = $('.rs-table', p); return table.offsetTop + $('thead', table).offsetHeight + $('.rs-footer', p).offsetHeight; });
  const tail = $('.rs-tail', pagesEl[1]).offsetHeight; // summary, remarks, signature, notes (last page only)
  const rowHeights = $$('.rs-table tbody tr', pagesEl[0]).map(tr => tr.offsetHeight);
  host.innerHTML = '';
  const pages = [];
  let current = [], used = 0;
  const capacity = () => pageHeight - fixed[pages.length === 0 ? 0 : 1] - PAGE_SAFETY_PX;
  for (let i = 0; i < rowHeights.length; i++) {
    if (current.length && used + rowHeights[i] > capacity()) { pages.push(current); current = []; used = 0; }
    current.push(i); used += rowHeights[i];
  }
  // The closing block must fit under the last rows; otherwise the last rows move with it so no page holds the summary alone.
  if (current.length && used + tail > capacity()) {
    const moved = current.splice(Math.max(1, current.length - 3));
    pages.push(current); current = moved;
    used = moved.reduce((sum, i) => sum + rowHeights[i], 0);
    if (current.length && used + tail > capacity()) { pages.push(current); current = []; }
  }
  pages.push(current);
  return pages;
}
function sheetHtml(report) { return renderReportSheet(report, { pages: paginateReport(report) }); }

// ---------- preview ----------
function renderPreview() {
  ensureDraft();
  const report = state.draft;
  const status = Core.reportStatus(report);
  const note = status === 'fail' ? ['alert-fail', t('preview_fail')] : status === 'incomplete' ? ['alert-warn', t('preview_incomplete')] : ['alert-ok', t('preview_pass')];
  $('#main').innerHTML = heading(t('preview_kicker'), t('preview_title'), t('preview_intro'),
    `<button type="button" class="btn" data-action="go-report">${esc(t('back_to_report'))}</button><button type="button" class="btn btn-primary" data-action="print">${esc(t('print_pdf'))}</button>`) +
    `<div class="alert ${note[0]}">${esc(note[1])}</div><div class="hint-line">${esc(t('print_hint'))}</div>
    <div class="paper-wrap" id="previewPaper">${sheetHtml(report)}</div>`;
}

function renderPrintSheet() {
  ensureDraft();
  $('#printSheet').innerHTML = sheetHtml(state.draft);
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
  else if (ui.tab === 'preview') renderPreview();
  else if (ui.tab === 'products') $('#main').innerHTML = renderProducts(ctx);
  else if (ui.tab === 'import') $('#main').innerHTML = renderImport(ctx);
  else if (ui.tab === 'settings') $('#main').innerHTML = renderSettings(ctx);
  else renderReport();
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
  const product = draftProduct();
  const has = Core.reportHasContent(state.draft);
  if (!confirmAction(has ? t('confirm_new_report') : t('confirm_new_report_empty'))) return;
  startNewReportForProduct(product);
  go('report');
}

async function importBackupFile(file) {
  if (!file) return;
  if (file.size > Store.MAX_IMPORT_BYTES) return toast(t('toast_import_invalid'));
  let parsed;
  try { parsed = Store.parseBackup(await file.text()); } catch (_) { return toast(t('toast_import_invalid')); }
  if (!confirmAction(t('confirm_import'))) return;
  const { state: merged, counts } = Store.mergeBackup(state, parsed);
  state = merged;
  for (const p of parsed.products) Sync.markDirty(state, 'product', p.id);
  for (const r of parsed.archive) Sync.markDirty(state, 'report', r.id);
  persist(); scheduleSync(); render();
  toast(t('toast_import_ok', { p: counts.addedProducts + counts.updatedProducts, r: counts.addedReports + counts.updatedReports }));
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
  persist(); render();
  toast(t('toast_backup_exported'));
}

function clickAction(action, el) {
  switch (action) {
    case 'go-report': return go('report');
    case 'go-preview': return go('preview');
    case 'go-archive': return go('archive');
    case 'go-products': return go('products');
    case 'go-settings': return go('settings');
    case 'go-import': ui.import = newImportState(); return go('import');
    case 'new-report': return newReportAction();
    case 'print': return printReport();
    case 'help': return $('#helpDialog').showModal();
    case 'export-backup': return exportBackup();
    case 'import-backup': return $('#importFile').click();
    case 'archive-open': {
      const r = state.archive.find(x => x.id === el.dataset.id);
      if (!r || !confirmAction(t('confirm_open_archived'))) return undefined;
      const old = state.draft;
      state.archive = state.archive.filter(x => x.id !== r.id);
      if (old && Core.reportHasContent(old)) { state.archive = [old, ...state.archive].slice(0, Store.MAX_ARCHIVE); Sync.markDirty(state, 'report', old.id); }
      Sync.markDeleted(state, 'report', r.id);
      state.draft = r;
      persist(); scheduleSync(); return go('report');
    }
    case 'archive-delete': {
      const r = state.archive.find(x => x.id === el.dataset.id);
      if (!r || !confirmAction(t('confirm_delete_report', { no: r.header.reportNo || '' }))) return undefined;
      state.archive = state.archive.filter(x => x.id !== r.id);
      Sync.markDeleted(state, 'report', r.id);
      persist(); scheduleSync(); renderArchive(); return toast(t('toast_report_deleted'));
    }
    case 'lock-logout': {
      if (!confirmAction(t('lock_logout_confirm'))) return undefined;
      state.settings.sync.key = ''; state.settings.sync.cursor = ''; persist();
      showLock(); return undefined;
    }
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
  if (el.id === 'archiveSearch') { ui.archiveQuery = el.value; renderKeepingFocus('archiveSearch'); return; }
  if (ui.tab === 'import') { onImportInput(ctx, el); return; }
  if (ui.tab === 'settings') { onSettingsInput(ctx, el); renderSyncIndicator(); return; }
  if (ui.tab === 'products') { onProductsInput(ctx, el); return; }
  if (ui.tab === 'report' && el.id === 'productSearch') { ui.productSearch = el.value; renderProductResults(); return; }
  if (ui.tab === 'report') {
    const report = state.draft;
    if (name.startsWith('h:')) {
      const key = name.slice(2);
      if (!Core.ORDER_FIELDS.includes(key) && key !== 'customer') return;
      report.header[key] = el.value; report.updatedAt = new Date().toISOString();
      refreshReportDerived(); persistSoon(); return;
    }
    if (el.dataset.measure) {
      const r = report.results[el.dataset.id]; if (!r) return;
      r[el.dataset.measure] = el.value; report.updatedAt = new Date().toISOString();
      refreshRow(el.dataset.id); refreshReportDerived(); persistSoon(); return;
    }
    if (el.id === 'remarks') { report.remarks = el.value; report.updatedAt = new Date().toISOString(); persistSoon(); }
  }
}

function onChange(event) {
  const el = event.target;
  if (el.id === 'importFile') { const f = el.files && el.files[0]; el.value = ''; return importBackupFile(f); }
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
const normalizers = { product: Store.normalizeProduct, report: Store.normalizeReport };
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
    if (changed && ['products', 'archive', 'settings'].includes(ui.tab)) render(); else renderSyncIndicator();
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
  if (ui.tab === 'import') { onImportKeydown(ctx, event); return; }
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

// ---------- lock screen (company access key, verified against the sync server) ----------
function lockRequired() { return Boolean(CONFIG.syncUrl) && !state.settings.sync.key; }
function showLock() {
  const lock = $('#lockScreen'); lock.hidden = false; $('#appShell').setAttribute('aria-hidden', 'true');
  $('#lockError').textContent = ''; $('#lockKey').value = ''; setTimeout(() => $('#lockKey').focus(), 50);
}
function hideLock() { $('#lockScreen').hidden = true; $('#appShell').removeAttribute('aria-hidden'); }
async function onLockSubmit(event) {
  event.preventDefault();
  const key = $('#lockKey').value.trim();
  const button = $('#lockSubmit'); const error = $('#lockError');
  if (!key) return;
  button.disabled = true; error.textContent = t('lock_checking');
  try {
    const health = await Sync.checkHealth(CONFIG.syncUrl, key);
    state.settings.sync.url = CONFIG.syncUrl; state.settings.sync.key = key; state.settings.sync.cursor = '';
    syncState.health = health; syncState.error = '';
    persist(); hideLock(); render();
    scheduleSync(200);
  } catch (err) {
    error.textContent = err.message === 'unauthorized' ? t('lock_wrong') : t('lock_offline');
  } finally { button.disabled = false; }
}

function init() {
  state = Store.loadState(storage);
  if (CONFIG.syncUrl && state.settings.sync.url !== CONFIG.syncUrl) { state.settings.sync.url = CONFIG.syncUrl; state.settings.sync.cursor = ''; }
  ensureDraft();
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
  $('#lockForm').addEventListener('submit', onLockSubmit);
  if (lockRequired()) showLock(); else render();
  persist();
  registerServiceWorker();
  if (Sync.syncConfigured(state.settings)) { scheduleSync(300); setInterval(() => scheduleSync(0), 5 * 60 * 1000); }
  window.UCM = { get state() { return state; }, get ui() { return ui; }, render, Core, Store, Sync, reportFileName, runSync, paginateReport, startImport: file => startImport(ctx, file) };
}

/** Shared context for the UI modules. */
const ctx = {
  get state() { return state; }, get ui() { return ui; }, syncState, version: APP_VERSION,
  persist, persistSoon, render, renderSoon, renderKeepingFocus, go, toast, confirm: confirmAction, heading, formatDateTime, productLabel,
  markDirty: (kind, id) => { Sync.markDirty(state, kind, id); scheduleSync(); },
  markDeleted: (kind, id) => { Sync.markDeleted(state, kind, id); scheduleSync(); },
  startNewReportForProduct, openReport, runSync,
  syncDraftWithProduct: p => { if (state.draft && state.draft.productId === p.id) state.draft = Core.syncReportWithProduct(state.draft, p); },
  aiAvailable: () => Sync.syncConfigured(state.settings) && (!syncState.health || syncState.health.ai !== false),
  fileUrl: id => (Sync.syncConfigured(state.settings) ? Sync.fileUrl(state.settings, id) : ''),
};

init();
