/* Products tab: list, search, editor (fields + characteristics), new report from product. */
import * as Core from './core.js';
import { t } from './i18n.js';
import { escapeHtml as esc } from './report-sheet.js';
import { LEVELS, SUPPORTED_AQLS } from './sampling.js';

const attr = esc;
const option = (v, label, sel) => `<option value="${attr(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
const FIELDS = ['partNo', 'revision', 'partName', 'catalogNo', 'customer', 'generalTolerance', 'aql', 'inspectionLevel'];

export function productLabel(p) {
  return [p.partNo, p.revision ? 'Rev ' + p.revision : '', p.partName].filter(Boolean).join(' · ');
}

export function filterProducts(products, query) {
  const q = String(query || '').trim().toLowerCase();
  const list = (products || []).filter(p => !q || [p.partNo, p.partName, p.customer, p.catalogNo, p.revision].some(v => String(v || '').toLowerCase().includes(q)));
  return list.sort((a, b) => String(a.partNo).localeCompare(String(b.partNo), undefined, { numeric: true }) || String(b.revision).localeCompare(String(a.revision), undefined, { numeric: true }));
}

/** Preview line of one characteristic: what will be printed, and the limits used for the verdict. */
export function featurePreviewHtml(f) {
  const problems = Core.featureProblems(f);
  const text = f.kind === 'numeric' ? `${esc(Core.requirementText(f) || '—')} <span class="muted">(${esc(Core.limitsText(f) || '—')})</span>` : esc(f.label || '—');
  return `<span class="fe-preview-label">${esc(t('feat_preview'))}:</span> <span class="fe-preview-text">${text}</span>${problems.length ? `<span class="fe-problem">${esc(t('feat_problem_' + problems[0].replace(/-/g, '_')))}</span>` : ''}`;
}

/** One editable characteristic row (shared with the import review). `inp` builds the inputs. */
export function featureFields(f, inp, sel) {
  const numeric = f.kind === 'numeric';
  const kindSel = sel('kind', [['numeric', t('kind_numeric')], ['gauge', t('kind_gauge')]], f.kind);
  const numericFields = numeric ? `
    <div class="fe-field"><label>${esc(t('feat_nominal'))}</label>${inp('nominal', f.nominal, 'dir="ltr" inputmode="decimal"')}</div>
    <div class="fe-field fe-tol"><label>${esc(t('feat_tol'))}</label>${sel('symmetric', [['1', t('tol_type_sym')], ['0', t('tol_type_asym')]], f.symmetric ? '1' : '0')}</div>
    <div class="fe-field"><label>${esc(f.symmetric ? '±' : t('feat_upper'))}</label>${inp('upper', f.upper, 'dir="ltr" inputmode="decimal"')}</div>
    <div class="fe-field${f.symmetric ? ' hidden' : ''}"><label>${esc(t('feat_lower'))}</label>${inp('lower', f.lower, 'dir="ltr" inputmode="decimal"' + (f.symmetric ? ' disabled' : ''))}</div>
    <div class="fe-field"><label>${esc(t('feat_unit'))}</label>${sel('unit', ['mm', 'in', 'deg', 'um', ''].map(u => [u, t('unit_' + (u || 'none'))]), f.unit)}</div>
    <div class="fe-field"><label>${esc(t('feat_suffix'))}</label>${inp('suffix', f.suffix, 'dir="ltr"')}</div>` : '';
  return `<div class="fe-field fe-kind"><label>${esc(t('feat_kind'))}</label>${kindSel}</div>
    <div class="fe-field fe-label"><label>${esc(t('feat_label'))}</label>${inp('label', f.label, `dir="auto" placeholder="${attr(numeric ? t('feat_label_ph_numeric') : t('feat_label_ph_attr'))}"`)}</div>
    ${numericFields}
    <div class="fe-field fe-method"><label>${esc(t('feat_method'))}</label>${inp('method', f.method, 'dir="auto"')}</div>`;
}

function featureEditorRow(f, i, total) {
  const problems = Core.featureProblems(f);
  const inp = (name, value, extra = '') => `<input name="f:${name}" data-fid="${attr(f.id)}" value="${attr(value)}" ${extra}>`;
  const sel = (name, options, value) => `<select name="f:${name}" data-fid="${attr(f.id)}">${options.map(([v, l]) => option(v, l, v === value)).join('')}</select>`;
  return `<div class="fe-row${problems.length ? ' has-problem' : ''}" data-feature="${attr(f.id)}">
    <div class="fe-index">${i + 1}</div>
    <div class="fe-grid">${featureFields(f, inp, sel)}</div>
    <div class="fe-preview" dir="ltr">${featurePreviewHtml(f)}</div>
    <div class="fe-tools">
      <button type="button" class="btn btn-icon" data-action="feature-up" data-id="${attr(f.id)}" ${i === 0 ? 'disabled' : ''} title="${attr(t('feat_up'))}" aria-label="${attr(t('feat_up'))}">&uarr;</button>
      <button type="button" class="btn btn-icon" data-action="feature-down" data-id="${attr(f.id)}" ${i === total - 1 ? 'disabled' : ''} title="${attr(t('feat_down'))}" aria-label="${attr(t('feat_down'))}">&darr;</button>
      <button type="button" class="btn btn-icon" data-action="feature-duplicate" data-id="${attr(f.id)}" title="${attr(t('feat_duplicate'))}" aria-label="${attr(t('feat_duplicate'))}">&#10697;</button>
      <button type="button" class="btn btn-icon btn-danger" data-action="feature-remove" data-id="${attr(f.id)}" title="${attr(t('feat_remove'))}" aria-label="${attr(t('feat_remove'))}">&times;</button>
    </div></div>`;
}

export function renderProducts(ctx) {
  const state = ctx.state;
  const ui = ctx.ui;
  const list = filterProducts(state.products, ui.productQuery);
  const selected = state.products.find(p => p.id === ui.editProductId) || null;
  const items = list.map(p => `<li class="list-item${selected && selected.id === p.id ? ' selected' : ''}"><button type="button" class="list-pick" data-action="product-edit" data-id="${attr(p.id)}"><b dir="ltr">${esc(p.partNo || '—')}</b> <span class="pill pill-empty">${esc(p.revision || '—')}</span><br><small>${esc(p.partName || '')}${p.customer ? ' · ' + esc(p.customer) : ''}</small></button></li>`).join('');
  const head = ctx.heading(t('products_kicker'), t('products_title'), t('products_intro'),
    `<button type="button" class="btn btn-primary" data-action="go-import">${esc(t('product_import'))}</button><button type="button" class="btn" data-action="product-new">${esc(t('product_new'))}</button>`);
  const editor = selected ? productEditor(ctx, selected) : `<div class="empty">${esc(state.products.length ? t('product_choose') : t('products_empty'))}</div>`;
  return head + `<div class="split-layout"><aside class="panel side-list"><div class="panel-head"><input id="productSearch" type="search" class="search" placeholder="${attr(t('products_search'))}" value="${attr(ui.productQuery || '')}"></div>
      ${list.length ? `<ul>${items}</ul>` : `<div class="empty">${esc(t('products_empty'))}</div>`}<div class="panel-foot"><span class="hint">${esc(t('product_count', { n: list.length }))}</span></div></aside>
    <div class="product-editor">${editor}</div></div>`;
}

function productEditor(ctx, p) {
  const fields = FIELDS.map(key => {
    let control;
    if (key === 'aql') control = `<select name="pr:aql">${option('', '—', !p.aql)}${SUPPORTED_AQLS.map(a => option(a, a, p.aql === a)).join('')}${!SUPPORTED_AQLS.includes(p.aql) && p.aql ? option(p.aql, p.aql, true) : ''}</select>`;
    else if (key === 'inspectionLevel') control = `<select name="pr:inspectionLevel">${LEVELS.map(l => option(l, t('level_label')[l] || l, p.inspectionLevel === l)).join('')}</select>`;
    else control = `<input name="pr:${attr(key)}" value="${attr(p[key] || '')}" dir="${key === 'partNo' || key === 'revision' ? 'ltr' : 'auto'}">`;
    return `<div class="field"><label>${esc(t('f_' + key))}</label>${control}</div>`;
  }).join('');
  const revisions = Core.productRevisions(ctx.state.products, p.partNo).filter(x => x.id !== p.id);
  const revs = revisions.length ? `<div class="hint">${esc(t('product_revisions'))}: ${revisions.map(x => `<button type="button" class="text-link" data-action="product-edit" data-id="${attr(x.id)}">${esc(x.revision || '—')}</button>`).join(' ')}</div>` : '';
  const source = p.sourceReportNo ? `<span class="hint">${esc(t('product_source', { no: p.sourceReportNo }))}</span>` : '';
  const file = p.sourceFileId && ctx.fileUrl(p.sourceFileId) ? `<a class="text-link" href="${attr(ctx.fileUrl(p.sourceFileId))}" target="_blank" rel="noopener">${esc(t('product_source_file'))}</a>` : '';
  return `<section class="panel"><div class="panel-head"><div><h2>${esc(t('product_details'))}</h2><p>${esc(t('product_updated'))} ${esc(ctx.formatDateTime(p.updatedAt))} ${source} ${file}</p></div>
      <div class="compact-actions"><button type="button" class="btn btn-primary" data-action="product-report" data-id="${attr(p.id)}">${esc(t('product_new_report'))}</button><button type="button" class="btn" data-action="product-duplicate" data-id="${attr(p.id)}">${esc(t('product_new_revision'))}</button><button type="button" class="btn btn-danger" data-action="product-delete" data-id="${attr(p.id)}">${esc(t('product_delete'))}</button></div></div>
      <div class="panel-body field-grid">${fields}<div class="field span2">${revs}</div></div></section>
    <section class="panel"><div class="panel-head"><div><h2>${esc(t('product_features'))}</h2></div><span class="pill pill-empty">${p.features.length} ${esc(t('rows'))}</span></div>
      <div class="fe-list">${p.features.map((f, i) => featureEditorRow(f, i, p.features.length)).join('')}</div>
      <div class="panel-foot"><button type="button" class="btn" data-action="feature-add" data-kind="numeric">+ ${esc(t('feat_add'))}</button><button type="button" class="btn" data-action="feature-add" data-kind="gauge">+ ${esc(t('feat_add_gauge'))}</button></div></section>`;
}

function editing(ctx) { return ctx.state.products.find(x => x.id === ctx.ui.editProductId) || null; }
function touch(ctx, p) {
  p.updatedAt = new Date().toISOString();
  ctx.markDirty('product', p.id);
  ctx.syncDraftWithProduct(p);
}

/** Input events on the products tab. Returns true if handled. */
export function onProductsInput(ctx, el) {
  const name = el.name || '';
  if (el.id === 'productSearch') { ctx.ui.productQuery = el.value; ctx.renderKeepingFocus('productSearch'); return true; }
  const p = editing(ctx); if (!p) return false;
  if (name.startsWith('pr:')) {
    const key = name.slice(3);
    if (!FIELDS.includes(key)) return true;
    p[key] = key === 'inspectionLevel' && !LEVELS.includes(el.value) ? 'II' : el.value;
    touch(ctx, p); ctx.persistSoon();
    if (key === 'partNo' || key === 'revision' || key === 'partName') ctx.renderSoon();
    return true;
  }
  if (name.startsWith('f:')) {
    const f = p.features.find(x => x.id === el.dataset.fid); if (!f) return true;
    const k = name.slice(2);
    if (k === 'kind') { f.kind = Core.FEATURE_KINDS.includes(el.value) ? el.value : 'numeric'; if (f.kind !== 'numeric') { f.nominal = ''; f.upper = ''; f.lower = ''; f.unit = ''; } else if (!f.unit) f.unit = 'mm'; touch(ctx, p); ctx.persist(); ctx.render(); return true; }
    if (k === 'symmetric') { f.symmetric = el.value === '1'; touch(ctx, p); ctx.persist(); ctx.render(); return true; }
    if (['label', 'nominal', 'upper', 'lower', 'method', 'unit', 'suffix'].includes(k)) f[k] = el.value;
    touch(ctx, p); ctx.persistSoon();
    const row = document.querySelector(`.fe-row[data-feature="${CSS.escape(f.id)}"]`);
    if (row) { row.classList.toggle('has-problem', Core.featureProblems(f).length > 0); row.querySelector('.fe-preview').innerHTML = featurePreviewHtml(f); }
    return true;
  }
  return false;
}

export function onProductsAction(ctx, action, el) {
  const state = ctx.state;
  const p = editing(ctx);
  switch (action) {
    case 'product-edit': ctx.ui.editProductId = el.dataset.id; ctx.render(); return true;
    case 'product-new': {
      const fresh = Core.blankProduct();
      fresh.features = [Core.blankFeature('numeric')];
      state.products.push(fresh); ctx.ui.editProductId = fresh.id; ctx.markDirty('product', fresh.id); ctx.persist(); ctx.render(); ctx.toast(t('toast_product_created'));
      const input = document.querySelector('input[name="pr:partNo"]'); if (input) input.focus();
      return true;
    }
    case 'product-duplicate': {
      const src = state.products.find(x => x.id === el.dataset.id); if (!src) return true;
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = Core.newId(); copy.revision = ''; copy.createdAt = copy.updatedAt = new Date().toISOString(); copy.sourceFileId = ''; copy.sourceReportNo = '';
      copy.features.forEach(f => { f.id = Core.newId(); });
      state.products.push(copy); ctx.ui.editProductId = copy.id; ctx.markDirty('product', copy.id); ctx.persist(); ctx.render();
      const input = document.querySelector('input[name="pr:revision"]'); if (input) input.focus();
      return true;
    }
    case 'product-delete': {
      const victim = state.products.find(x => x.id === el.dataset.id); if (!victim) return true;
      if (!ctx.confirm(t('confirm_delete_product', { name: productLabel(victim) }))) return true;
      state.products = state.products.filter(x => x.id !== victim.id);
      ctx.markDeleted('product', victim.id);
      if (ctx.ui.editProductId === victim.id) ctx.ui.editProductId = null;
      ctx.persist(); ctx.render(); ctx.toast(t('toast_product_deleted'));
      return true;
    }
    case 'product-report': {
      const target = state.products.find(x => x.id === el.dataset.id); if (!target) return true;
      if (Core.reportHasContent(state.draft) && !ctx.confirm(t('confirm_change_product'))) return true;
      ctx.startNewReportForProduct(target); ctx.go('report'); return true;
    }
    case 'feature-add': {
      if (!p || p.features.length >= Core.MAX_FEATURES) return true;
      const last = p.features[p.features.length - 1];
      const f = Core.blankFeature(el.dataset.kind || 'numeric');
      if (f.kind === 'numeric' && last && last.kind === 'numeric') { f.method = last.method; f.unit = last.unit; f.upper = last.upper; f.lower = last.lower; f.symmetric = last.symmetric; }
      p.features.push(f); touch(ctx, p); ctx.persist(); ctx.render();
      const input = document.querySelector(`.fe-row[data-feature="${CSS.escape(f.id)}"] input[name="f:label"]`);
      if (input) input.focus();
      return true;
    }
    case 'feature-remove': {
      if (!p) return true;
      if (p.features.length < 2) { ctx.toast(t('toast_last_feature')); return true; }
      if (!ctx.confirm(t('confirm_remove_feature'))) return true;
      p.features = p.features.filter(f => f.id !== el.dataset.id); touch(ctx, p); ctx.persist(); ctx.render(); return true;
    }
    case 'feature-duplicate': {
      if (!p) return true;
      const i = p.features.findIndex(f => f.id === el.dataset.id);
      if (i === -1 || p.features.length >= Core.MAX_FEATURES) return true;
      p.features.splice(i + 1, 0, { ...p.features[i], id: Core.newId() }); touch(ctx, p); ctx.persist(); ctx.render(); return true;
    }
    case 'feature-up': case 'feature-down': {
      if (!p) return true;
      const i = p.features.findIndex(f => f.id === el.dataset.id);
      const j = action === 'feature-up' ? i - 1 : i + 1;
      if (i === -1 || j < 0 || j >= p.features.length) return true;
      [p.features[i], p.features[j]] = [p.features[j], p.features[i]]; touch(ctx, p); ctx.persist(); ctx.render(); return true;
    }
    default: return false;
  }
}
