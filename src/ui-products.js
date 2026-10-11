/* Products tab: list, search, editor (fields + characteristics), new report from product. */
import * as Core from './core.js';
import { t } from './i18n.js';
import { escapeHtml as esc } from './report-sheet.js';
import { LEVELS, SUPPORTED_AQLS } from './sampling.js';

const attr = esc;
const option = (v, label, sel) => `<option value="${attr(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
const FIELDS = ['partNo', 'revision', 'partName', 'catalogNo', 'customer', 'drawingNo', 'material', 'generalTolerance', 'aql', 'inspectionLevel'];

export function productLabel(p) {
  return [p.partNo, p.revision ? 'Rev ' + p.revision : '', p.partName].filter(Boolean).join(' · ');
}

export function filterProducts(products, query) {
  const q = String(query || '').trim().toLowerCase();
  const list = (products || []).filter(p => !q || [p.partNo, p.partName, p.customer, p.catalogNo, p.drawingNo, p.revision].some(v => String(v || '').toLowerCase().includes(q)));
  return list.sort((a, b) => String(a.partNo).localeCompare(String(b.partNo), undefined, { numeric: true }) || String(b.revision).localeCompare(String(a.revision), undefined, { numeric: true }));
}

export function renderProducts(ctx) {
  const state = ctx.state;
  const ui = ctx.ui;
  const list = filterProducts(state.products, ui.productQuery);
  const selected = state.products.find(p => p.id === ui.editProductId) || null;
  const items = list.map(p => `<li class="tpl-item${selected && selected.id === p.id ? ' selected' : ''}"><button type="button" class="tpl-pick" data-action="product-edit" data-id="${attr(p.id)}"><b dir="ltr">${esc(p.partNo || '—')}</b> <span class="pill pill-empty">${esc(p.revision || '—')}</span><br><small>${esc(p.partName || '')}${p.customer ? ' · ' + esc(p.customer) : ''}</small></button></li>`).join('');
  const head = ctx.heading(t('products_kicker'), t('products_title'), t('products_intro'),
    `<button type="button" class="btn btn-primary" data-action="go-import">${esc(t('product_import'))}</button><button type="button" class="btn" data-action="product-new">${esc(t('product_new'))}</button>`);
  const editor = selected ? productEditor(ctx, selected) : `<div class="empty">${esc(state.products.length ? t('product_choose') : t('products_empty'))}</div>`;
  return head + `<div class="tpl-layout"><aside class="panel tpl-list"><div class="panel-head"><input id="productSearch" type="search" class="search" placeholder="${attr(t('products_search'))}" value="${attr(ui.productQuery || '')}"></div>
      ${list.length ? `<ul>${items}</ul>` : `<div class="empty">${esc(t('products_empty'))}</div>`}<div class="panel-foot"><span class="hint">${esc(t('product_count', { n: list.length }))}</span></div></aside>
    <div class="tpl-editor">${editor}</div></div>`;
}

function productEditor(ctx, p) {
  const fields = FIELDS.map(key => {
    let control;
    if (key === 'aql') control = `<select name="pr:aql">${option('', '—', !p.aql)}${SUPPORTED_AQLS.map(a => option(a, a, p.aql === a)).join('')}${!SUPPORTED_AQLS.includes(p.aql) && p.aql ? option(p.aql, p.aql, true) : ''}</select>`;
    else if (key === 'inspectionLevel') control = `<select name="pr:inspectionLevel">${option('', '—', !p.inspectionLevel)}${LEVELS.map(l => option(l, t('level_label')[l] || l, p.inspectionLevel === l)).join('')}</select>`;
    else control = `<input name="pr:${attr(key)}" value="${attr(p[key] || '')}" dir="${key === 'partNo' || key === 'revision' ? 'ltr' : 'auto'}">`;
    return `<div class="field"><label>${esc(t('f_' + key))}</label>${control}</div>`;
  }).join('');
  const revisions = Core.productRevisions(ctx.state.products, p.partNo).filter(x => x.id !== p.id);
  const revs = revisions.length ? `<div class="hint">${esc(t('product_revisions'))}: ${revisions.map(x => `<button type="button" class="text-link" data-action="product-edit" data-id="${attr(x.id)}">${esc(x.revision || '—')}</button>`).join(' ')}</div>` : '';
  const source = p.sourceReportNo ? `<span class="hint">${esc(t('product_source', { no: p.sourceReportNo }))}</span>` : '';
  const file = p.sourceFileId && ctx.fileUrl ? `<a class="text-link" href="${attr(ctx.fileUrl(p.sourceFileId))}" target="_blank" rel="noopener">${esc(t('product_source_file'))}</a>` : '';
  return `<section class="panel"><div class="panel-head"><div><h2>${esc(t('product_details'))}</h2><p>${esc(t('product_updated'))} ${esc(ctx.formatDateTime(p.updatedAt))} ${source} ${file}</p></div>
      <div class="compact-actions"><button type="button" class="btn btn-primary" data-action="product-report" data-id="${attr(p.id)}">${esc(t('product_new_report'))}</button><button type="button" class="btn" data-action="product-duplicate" data-id="${attr(p.id)}">${esc(t('product_new_revision'))}</button><button type="button" class="btn btn-danger" data-action="product-delete" data-id="${attr(p.id)}">${esc(t('product_delete'))}</button></div></div>
      <div class="panel-body field-grid">${fields}<div class="field span2">${revs}</div></div></section>
    <section class="panel"><div class="panel-head"><div><h2>${esc(t('product_features'))}</h2><p>${esc(t('features_intro'))}</p></div><span class="pill pill-empty">${p.features.length} ${esc(t('rows'))}</span></div>
      <div class="fe-list">${p.features.map((f, i) => ctx.featureEditorRow(f, i, p.features.length)).join('')}</div>
      <div class="panel-foot"><button type="button" class="btn" data-action="feature-add" data-kind="numeric">+ ${esc(t('feat_add'))}</button><button type="button" class="btn" data-action="feature-add" data-kind="gauge">+ ${esc(t('feat_add_gauge'))}</button></div></section>`;
}

/** Input events for the product fields. Returns true if handled. */
export function onProductsInput(ctx, el) {
  const name = el.name || '';
  if (el.id === 'productSearch') { ctx.ui.productQuery = el.value; ctx.renderKeepingFocus('productSearch'); return true; }
  if (!name.startsWith('pr:')) return false;
  const p = ctx.state.products.find(x => x.id === ctx.ui.editProductId); if (!p) return true;
  const key = name.slice(3);
  if (!FIELDS.includes(key)) return true;
  p[key] = key === 'inspectionLevel' && !LEVELS.includes(el.value) ? '' : el.value;
  p.updatedAt = new Date().toISOString();
  ctx.markDirty('product', p.id); ctx.persistSoon();
  if (ctx.state.draft && ctx.state.draft.productId === p.id) ctx.syncDraftWithProduct(p);
  if (key === 'partNo' || key === 'revision' || key === 'partName') ctx.renderListSoon();
  return true;
}

export function onProductsAction(ctx, action, el) {
  const state = ctx.state;
  switch (action) {
    case 'product-edit': ctx.ui.editProductId = el.dataset.id; ctx.render(); return true;
    case 'product-new': {
      const p = Core.blankProduct();
      const tpl = ctx.activeTemplate();
      p.generalTolerance = tpl.fields.generalTolerance.value; p.aql = tpl.fields.aql.value; p.inspectionLevel = tpl.fields.inspectionLevel.value;
      p.features = [Core.blankFeature('numeric')];
      state.products.push(p); ctx.ui.editProductId = p.id; ctx.markDirty('product', p.id); ctx.persist(); ctx.render(); ctx.toast(t('toast_product_created'));
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
      const p = state.products.find(x => x.id === el.dataset.id); if (!p) return true;
      if (!ctx.confirm(t('confirm_delete_product', { name: productLabel(p) }))) return true;
      state.products = state.products.filter(x => x.id !== p.id);
      ctx.markDeleted('product', p.id);
      if (ctx.ui.editProductId === p.id) ctx.ui.editProductId = null;
      ctx.persist(); ctx.render(); ctx.toast(t('toast_product_deleted'));
      return true;
    }
    case 'product-report': {
      const p = state.products.find(x => x.id === el.dataset.id); if (!p) return true;
      if (Core.reportHasContent(state.draft) && !ctx.confirm(t('confirm_change_product'))) return true;
      ctx.startNewReportForProduct(p); ctx.go('report'); return true;
    }
    default: return false;
  }
}
