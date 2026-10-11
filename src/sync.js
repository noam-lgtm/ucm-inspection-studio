/*
 * Cloud sync client (optional). The app stays local-first: every change is
 * saved in the browser immediately; this module pushes dirty records to the
 * sync server and pulls records changed elsewhere. Conflicts resolve by the
 * newer updatedAt (last write wins), which is adequate for a small team.
 *
 * Record kinds: product | report (archived reports). Drafts are not synced.
 */

export const KINDS = Object.freeze(['product', 'report']);

export function syncConfigured(settings) {
  const s = settings && settings.sync;
  return Boolean(s && s.url && s.key);
}

function listOf(state, kind) {
  return kind === 'product' ? state.products : state.archive;
}

/** Mark a record as needing a push. Call after any local modification. */
export function markDirty(state, kind, id) {
  if (!KINDS.includes(kind) || !id) return;
  state.settings.dirty = state.settings.dirty || {};
  state.settings.dirty[kind + ':' + id] = true;
}

/** Mark a record as deleted (tombstone pushed on next sync). */
export function markDeleted(state, kind, id) {
  if (!KINDS.includes(kind) || !id) return;
  state.settings.deleted = state.settings.deleted || {};
  state.settings.deleted[kind + ':' + id] = new Date().toISOString();
  if (state.settings.dirty) delete state.settings.dirty[kind + ':' + id];
}

/** Build the list of changes to push. When `everything` is true, all records are sent (first sync). */
export function collectChanges(state, everything = false) {
  const changes = [];
  const dirty = state.settings.dirty || {};
  for (const kind of KINDS) {
    for (const rec of listOf(state, kind) || []) {
      if (everything || dirty[kind + ':' + rec.id]) {
        changes.push({ kind, id: rec.id, updatedAt: rec.updatedAt || new Date(0).toISOString(), deleted: false, data: rec });
      }
    }
  }
  for (const [key, at] of Object.entries(state.settings.deleted || {})) {
    const [kind, ...rest] = key.split(':');
    changes.push({ kind, id: rest.join(':'), updatedAt: at, deleted: true, data: null });
  }
  return changes;
}

/**
 * Apply records received from the server. Returns counts and a new state (mutates in place for simplicity).
 * Local dirty records that are newer than the incoming copy are kept.
 */
export function applyRemote(state, remoteChanges, normalizers) {
  const counts = { added: 0, updated: 0, deleted: 0, skipped: 0 };
  const dirty = state.settings.dirty || {};
  for (const ch of remoteChanges || []) {
    if (!KINDS.includes(ch.kind) || !ch.id) { counts.skipped++; continue; }
    const list = listOf(state, ch.kind);
    const i = list.findIndex(r => r.id === ch.id);
    const local = i === -1 ? null : list[i];
    const key = ch.kind + ':' + ch.id;
    if (local && dirty[key] && String(local.updatedAt || '') > String(ch.updatedAt || '')) { counts.skipped++; continue; }
    if (ch.deleted) {
      if (i !== -1) { list.splice(i, 1); counts.deleted++; } else counts.skipped++;
      delete dirty[key];
      continue;
    }
    let rec;
    try { rec = normalizers[ch.kind](ch.data); } catch (_) { counts.skipped++; continue; }
    rec.id = ch.id;
    if (i === -1) { list.push(rec); counts.added++; } else { list[i] = rec; counts.updated++; }
    delete dirty[key];
  }
  if (state.archive) state.archive.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return counts;
}

/** After a successful push, clear the dirty flags and tombstones that were sent. */
export function acknowledgePush(state, changes) {
  const dirty = state.settings.dirty || {};
  for (const ch of changes) {
    if (ch.deleted) { if (state.settings.deleted) delete state.settings.deleted[ch.kind + ':' + ch.id]; }
    else delete dirty[ch.kind + ':' + ch.id];
  }
}

export function apiUrl(base, path) {
  return String(base || '').replace(/\/+$/, '') + path;
}

/**
 * One sync round trip. `fetchImpl` is injectable for tests.
 * @returns {Promise<{pushed:number, pulled:object, cursor:string}>}
 */
export async function runSync(state, normalizers, fetchImpl = globalThis.fetch) {
  const cfg = state.settings.sync;
  if (!syncConfigured(state.settings)) throw new Error('not-configured');
  const everything = !cfg.cursor;
  const changes = collectChanges(state, everything);
  const res = await fetchImpl(apiUrl(cfg.url, '/api/sync'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify({ cursor: cfg.cursor || '', changes }),
  });
  if (res.status === 401 || res.status === 403) throw new Error('unauthorized');
  if (!res.ok) throw new Error('http-' + res.status);
  const body = await res.json();
  if (!body || typeof body !== 'object' || !Array.isArray(body.changes)) throw new Error('bad-response');
  acknowledgePush(state, changes);
  const pulled = applyRemote(state, body.changes, normalizers);
  cfg.cursor = String(body.cursor || cfg.cursor || '');
  cfg.lastSyncAt = new Date().toISOString();
  return { pushed: changes.length, pulled, cursor: cfg.cursor };
}

export async function checkHealth(url, key, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(apiUrl(url, '/api/health'), { headers: { Authorization: 'Bearer ' + key } });
  if (res.status === 401 || res.status === 403) throw new Error('unauthorized');
  if (!res.ok) throw new Error('http-' + res.status);
  return res.json();
}

/** Upload an original file (PDF/image). Returns { id, size }. */
export async function uploadFile(settings, id, blob, fetchImpl = globalThis.fetch) {
  const cfg = settings.sync;
  const res = await fetchImpl(apiUrl(cfg.url, '/api/files/' + encodeURIComponent(id)), {
    method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream', Authorization: 'Bearer ' + cfg.key }, body: blob,
  });
  if (!res.ok) throw new Error('http-' + res.status);
  return res.json();
}

export function fileUrl(settings, id) {
  return apiUrl(settings.sync.url, '/api/files/' + encodeURIComponent(id));
}

/** Ask the server's AI extractor to read page images. `pages` = [{ mime, base64 }]. */
export async function aiExtract(settings, pages, hints, fetchImpl = globalThis.fetch) {
  const cfg = settings.sync;
  const res = await fetchImpl(apiUrl(cfg.url, '/api/extract'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify({ pages, hints }),
  });
  if (res.status === 401 || res.status === 403) throw new Error('unauthorized');
  if (res.status === 501) throw new Error('ai-disabled');
  if (!res.ok) throw new Error('http-' + res.status);
  return res.json();
}
