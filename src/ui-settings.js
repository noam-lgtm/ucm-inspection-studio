/* Settings tab: sync server, AI availability, backups. */
import { t } from './i18n.js';
import { escapeHtml as esc } from './report-sheet.js';
import { checkHealth, syncConfigured } from './sync.js';

const attr = esc;

export function syncStatusText(ctx) {
  const s = ctx.state.settings;
  if (!syncConfigured(s)) return t('sync_off');
  const pending = Object.keys(s.dirty || {}).length + Object.keys(s.deleted || {}).length;
  if (ctx.syncState.error) return t('sync_error', { err: ctx.syncState.error });
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return t('sync_offline');
  if (pending) return t('sync_pending', { n: pending });
  return t('sync_ok');
}

export function renderSettings(ctx) {
  const s = ctx.state.settings;
  const sync = s.sync || { url: '', key: '' };
  const health = ctx.syncState.health;
  const aiLine = health ? (health.ai ? t('sync_ai_on', { model: health.model || '' }) : t('sync_ai_off')) : '—';
  return ctx.heading(t('settings_kicker'), t('settings_title'), t('settings_intro')) +
    `<section class="panel"><div class="panel-head"><h2>${esc(t('sync_section'))}</h2><span class="pill ${ctx.syncState.error ? 'pill-fail' : syncConfigured(s) ? 'pill-ok' : 'pill-empty'}" id="syncStatusPill">${esc(syncStatusText(ctx))}</span></div>
      <div class="panel-body field-grid">
        <div class="field span2"><label for="syncUrl">${esc(t('sync_url'))}</label><input id="syncUrl" name="st:url" value="${attr(sync.url)}" dir="ltr" placeholder="https://ucm-inspection-sync.<account>.workers.dev" autocomplete="off"></div>
        <div class="field"><label for="syncKey">${esc(t('sync_key'))}</label><input id="syncKey" name="st:key" type="password" value="${attr(sync.key)}" dir="ltr" autocomplete="off"></div>
        <div class="field span2"><label>${esc(t('sync_status'))}</label><div class="hint" id="syncDetail">${esc(sync.lastSyncAt ? t('sync_last', { date: ctx.formatDateTime(sync.lastSyncAt) }) : '')} ${ctx.syncState.testMessage ? ' · ' + esc(ctx.syncState.testMessage) : ''}</div></div>
        <div class="field"><label>${esc(t('sync_ai'))}</label><div class="hint">${esc(aiLine)}</div></div>
        <div class="field span2"><label class="toggle"><input type="checkbox" name="st:autoAi" ${s.autoAi !== false ? 'checked' : ''}> ${esc(t('sync_auto_ai'))}</label></div>
        <div class="field span4 page-actions"><button type="button" class="btn" data-action="sync-test">${esc(t('sync_test'))}</button><button type="button" class="btn btn-primary" data-action="sync-now" ${syncConfigured(s) ? '' : 'disabled'}>${esc(t('sync_now'))}</button></div>
        <div class="field span4"><small class="hint">${esc(t('sync_hint'))}</small></div>
      </div></section>
    <section class="panel"><div class="panel-head"><h2>${esc(t('backup_section'))}</h2></div><div class="panel-body page-actions">
      <button type="button" class="btn" data-action="export-backup">${esc(t('export_backup'))}</button><button type="button" class="btn" data-action="import-backup">${esc(t('import_backup'))}</button>
      <span class="hint">${esc(s.lastBackupAt ? t('last_backup', { date: ctx.formatDateTime(s.lastBackupAt) }) : t('last_backup_never'))}</span></div></section>
    <section class="panel"><div class="panel-head"><h2>${esc(t('about_section'))}</h2></div><div class="panel-body"><p class="hint">${esc(t('about_text', { version: ctx.version }))}</p></div></section>`;
}

export function onSettingsInput(ctx, el) {
  const name = el.name || '';
  const s = ctx.state.settings;
  if (name === 'st:url') { s.sync.url = el.value.trim(); s.sync.cursor = ''; ctx.persistSoon(); return true; }
  if (name === 'st:key') { s.sync.key = el.value.trim(); s.sync.cursor = ''; ctx.persistSoon(); return true; }
  if (name === 'st:autoAi') { s.autoAi = el.checked; ctx.persistSoon(); return true; }
  return false;
}

export async function onSettingsAction(ctx, action) {
  const s = ctx.state.settings;
  if (action === 'sync-test') {
    ctx.syncState.testMessage = '…'; ctx.render();
    try {
      const h = await checkHealth(s.sync.url, s.sync.key);
      ctx.syncState.health = h; ctx.syncState.error = ''; ctx.syncState.testMessage = t('sync_test_ok');
    } catch (error) {
      ctx.syncState.health = null; ctx.syncState.testMessage = t('sync_test_fail', { err: error.message === 'unauthorized' ? t('sync_unauthorized') : error.message });
    }
    ctx.render(); return true;
  }
  if (action === 'sync-now') { await ctx.runSync(true); ctx.render(); return true; }
  return false;
}
