/*
 * UCM Inspection Studio sync + AI worker (Cloudflare Workers, D1, R2).
 *
 *   GET  /api/health          -> { ok, version, ai }
 *   POST /api/sync            -> { cursor, changes } (last-write-wins by updatedAt, server sequence cursor)
 *   PUT  /api/files/:id       -> store an original PDF / image in R2
 *   GET  /api/files/:id       -> fetch it back
 *   POST /api/extract         -> Claude reads page images into structured inspection data
 *   cron                      -> daily JSON snapshot of all records into R2 (backups/)
 *
 * Auth: Authorization: Bearer <WORKSPACE_KEY> on every /api route except OPTIONS.
 */
import Anthropic from '@anthropic-ai/sdk';

const VERSION = '1.0.0';
const KINDS = new Set(['product', 'template', 'report']);
const MAX_SYNC_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 600 * 1024;
const PULL_PAGE = 500;

function cors(env, extra = {}) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
    ...extra,
  };
}
const json = (env, body, status = 200) => new Response(JSON.stringify(body), { status, headers: cors(env, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }) });

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
function authorized(request, env) {
  if (!env.WORKSPACE_KEY || env.WORKSPACE_KEY.length < 16) return false;
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  return Boolean(m) && timingSafeEqual(m[1].trim(), env.WORKSPACE_KEY);
}

async function nextSeq(env, count) {
  const row = await env.DB.prepare('UPDATE meta SET value = value + ? WHERE key = ? RETURNING value').bind(count, 'seq').first();
  if (!row) throw new Error('meta row missing; run schema.sql');
  return Number(row.value) - count + 1;
}

function validateChange(ch) {
  if (!ch || typeof ch !== 'object') return 'change';
  if (!KINDS.has(ch.kind)) return 'kind';
  if (typeof ch.id !== 'string' || !ch.id || ch.id.length > 120) return 'id';
  if (typeof ch.updatedAt !== 'string' || ch.updatedAt.length > 40) return 'updatedAt';
  if (ch.deleted && ch.data != null) return 'deleted-with-data';
  if (!ch.deleted && (!ch.data || typeof ch.data !== 'object')) return 'data';
  return null;
}

async function handleSync(request, env) {
  if (Number(request.headers.get('Content-Length') || 0) > MAX_SYNC_BYTES) return json(env, { error: 'too-large' }, 413);
  let body;
  try { body = await request.json(); } catch (_) { return json(env, { error: 'bad-json' }, 400); }
  const changes = Array.isArray(body.changes) ? body.changes : [];
  const cursor = Number.parseInt(String(body.cursor || '0'), 10) || 0;
  if (changes.length > 2000) return json(env, { error: 'too-many-changes' }, 413);
  for (const ch of changes) {
    const problem = validateChange(ch);
    if (problem) return json(env, { error: 'invalid-change', detail: problem, id: ch && ch.id }, 400);
  }
  let written = 0;
  if (changes.length) {
    const base = await nextSeq(env, changes.length);
    const stmt = env.DB.prepare(`INSERT INTO records (kind, id, updated_at, seq, deleted, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, seq = excluded.seq, deleted = excluded.deleted, data = excluded.data
      WHERE excluded.updated_at >= records.updated_at`);
    const batch = [];
    changes.forEach((ch, i) => {
      const data = ch.deleted ? null : JSON.stringify(ch.data);
      if (data && data.length > MAX_RECORD_BYTES) return;
      batch.push(stmt.bind(ch.kind, ch.id, ch.updatedAt, base + i, ch.deleted ? 1 : 0, data));
    });
    if (batch.length) {
      const results = await env.DB.batch(batch);
      written = results.reduce((n, r) => n + (r.meta && r.meta.changes ? r.meta.changes : 0), 0);
    }
  }
  const pushed = new Set(changes.map(ch => ch.kind + ':' + ch.id));
  const rows = await env.DB.prepare('SELECT kind, id, updated_at, seq, deleted, data FROM records WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2').bind(cursor, PULL_PAGE + 1).all();
  const list = rows.results || [];
  const more = list.length > PULL_PAGE;
  const page = more ? list.slice(0, PULL_PAGE) : list;
  const out = [];
  for (const r of page) {
    if (pushed.has(r.kind + ':' + r.id)) continue;
    out.push({ kind: r.kind, id: r.id, updatedAt: r.updated_at, deleted: Boolean(r.deleted), data: r.deleted ? null : JSON.parse(r.data) });
  }
  const newCursor = page.length ? Number(page[page.length - 1].seq) : (await currentSeq(env));
  return json(env, { cursor: String(Math.max(cursor, newCursor)), changes: out, more, written, serverTime: new Date().toISOString() });
}

async function currentSeq(env) {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind('seq').first();
  return row ? Number(row.value) : 0;
}

const FILE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
async function putFile(request, env, id) {
  if (!/^[\w.-]{1,120}$/.test(id)) return json(env, { error: 'bad-id' }, 400);
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!FILE_TYPES.has(type)) return json(env, { error: 'unsupported-type' }, 415);
  const max = (Number(env.MAX_FILE_MB) || 25) * 1024 * 1024;
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > max) return json(env, { error: 'too-large' }, 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > max) return json(env, { error: 'too-large' }, 413);
  await env.FILES.put('files/' + id, bytes, { httpMetadata: { contentType: type } });
  await env.DB.prepare('INSERT OR REPLACE INTO files (id, content_type, size, created_at) VALUES (?1, ?2, ?3, ?4)').bind(id, type, bytes.byteLength, new Date().toISOString()).run();
  return json(env, { id, size: bytes.byteLength, contentType: type });
}
async function getFile(env, id) {
  if (!/^[\w.-]{1,120}$/.test(id)) return json(env, { error: 'bad-id' }, 400);
  const obj = await env.FILES.get('files/' + id);
  if (!obj) return json(env, { error: 'not-found' }, 404);
  return new Response(obj.body, { headers: cors(env, { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline' }) });
}

// ---------- AI extraction ----------
const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['header', 'rows', 'notes'],
  properties: {
    header: {
      type: 'object', additionalProperties: false,
      required: ['reportNo', 'partNo', 'revision', 'partName', 'catalogNo', 'customer', 'purchaseOrder', 'productionOrder', 'quantity', 'aql', 'sampleSize', 'accepted', 'rejected', 'generalTolerance', 'inspector', 'inspectionDate', 'drawingNo', 'material'],
      properties: Object.fromEntries(['reportNo', 'partNo', 'revision', 'partName', 'catalogNo', 'customer', 'purchaseOrder', 'productionOrder', 'quantity', 'aql', 'sampleSize', 'accepted', 'rejected', 'generalTolerance', 'inspector', 'inspectionDate', 'drawingNo', 'material'].map(k => [k, { type: 'string' }])),
    },
    rows: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['no', 'requiredText', 'kind', 'label', 'nominal', 'upper', 'lower', 'symmetric', 'unit', 'suffix', 'method', 'min', 'max', 'outcome', 'confidence', 'note'],
        properties: {
          no: { type: 'integer' },
          requiredText: { type: 'string', description: 'The Required cell exactly as printed, using the symbols Ø ± ° R M where shown' },
          kind: { type: 'string', enum: ['numeric', 'gauge', 'visual'] },
          label: { type: 'string', description: 'Prefix such as Ø, R, Depth, or the thread/visual designation for non-numeric rows' },
          nominal: { type: 'string', description: 'Nominal value as printed, empty if unreadable' },
          upper: { type: 'string', description: 'Upper deviation, signed, e.g. +0.05, 0.1 for symmetric; empty if not shown' },
          lower: { type: 'string', description: 'Lower deviation, signed, e.g. -0.05 or 0; empty for symmetric or not shown' },
          symmetric: { type: 'boolean' },
          unit: { type: 'string', enum: ['mm', 'in', 'deg', 'um', ''] },
          suffix: { type: 'string', description: 'Trailing qualifier such as x 45°, (x3), MIN DEEP, THRU' },
          method: { type: 'string' },
          min: { type: 'string', description: 'Actual min result as printed, empty if none' },
          max: { type: 'string' },
          outcome: { type: 'string', enum: ['pass', 'fail', ''] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          note: { type: 'string', description: 'Why confidence is low or what was ambiguous' },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const EXTRACT_SYSTEM = `You read Final Inspection Reports from a CNC machining shop (English and Hebrew) and return the data as JSON matching the schema.
Rules:
- Copy numbers exactly as printed. Never invent a nominal or a tolerance that is not visible. If a cell is unreadable, leave the value empty and set confidence below 0.5 with a note.
- The "Required" column may contain pictures of drawing dimensions. Read them carefully: Ø means diameter (label "Ø"), R means radius, ∠ or ° means an angle, ⊥/▽-like depth symbols become label "Depth" or the printed word.
- Tolerances: TOL-/TOL+ columns are magnitudes (0.1 means ±0.1 when both equal; 0 and 0.03 means +0.03 / 0). Deviations inside the Required text (e.g. "20 0 +0.03") take precedence.
- Threads (M8x1.25, 2-56 UNC, 1/4-20 UNF) and GO/NO-GO checks are kind "gauge"; a check mark (✓, £ glyph, V, OK) in the result columns means outcome "pass", an X means "fail".
- Angle rows use unit "deg". Default unit is "mm".
- A row number may be split across two pages; report every row once. Keep the row numbers printed on the form.
- Dates on these forms are day/month/year; return YYYY-MM-DD.
- Hints from the PDF text layer are provided when available: trust them for cells that have text, and use the picture for cells marked as images.`;

async function handleExtract(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json(env, { error: 'ai-disabled' }, 501);
  let body;
  try { body = await request.json(); } catch (_) { return json(env, { error: 'bad-json' }, 400); }
  const pages = Array.isArray(body.pages) ? body.pages.slice(0, 8) : [];
  if (!pages.length) return json(env, { error: 'no-pages' }, 400);
  for (const p of pages) {
    if (!p || !['image/jpeg', 'image/png', 'image/webp'].includes(p.mime) || typeof p.base64 !== 'string' || p.base64.length > 7 * 1024 * 1024) return json(env, { error: 'bad-page' }, 400);
  }
  const content = [];
  pages.forEach((p, i) => {
    content.push({ type: 'text', text: `Page ${i + 1} of ${pages.length}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.base64 } });
  });
  const hints = body.hints && typeof body.hints === 'object' ? JSON.stringify(body.hints).slice(0, 60000) : '';
  content.push({ type: 'text', text: (hints ? `Text-layer hints (JSON): ${hints}\n\n` : '') + 'Extract the header fields and every inspection row from these pages.' });
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 150000, maxRetries: 2 });
  const params = {
    model: env.AI_MODEL || 'claude-opus-5-5',
    max_tokens: 16000,
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
  };
  let response;
  try {
    // Server-side refusal fallbacks are enabled by default on Claude Opus 5.5 (beta); fall back to a plain call if the beta is unavailable.
    try {
      response = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (error) {
      if (error instanceof Anthropic.BadRequestError) response = await client.messages.create(params);
      else throw error;
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return json(env, { error: 'ai-auth' }, 502);
    if (error instanceof Anthropic.RateLimitError) return json(env, { error: 'ai-rate-limit' }, 503);
    if (error instanceof Anthropic.APIError) return json(env, { error: 'ai-error', status: error.status, message: error.message }, 502);
    return json(env, { error: 'ai-error', message: String(error && error.message || error) }, 502);
  }
  if (response.stop_reason === 'refusal') return json(env, { error: 'ai-refused', category: response.stop_details && response.stop_details.category || null }, 502);
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return json(env, { error: 'ai-bad-json' }, 502); }
  return json(env, { ...parsed, model: response.model, usage: response.usage, stopReason: response.stop_reason });
}

// ---------- backups ----------
async function backup(env) {
  const rows = await env.DB.prepare('SELECT kind, id, updated_at, seq, deleted, data FROM records ORDER BY seq').all();
  const records = (rows.results || []).map(r => ({ kind: r.kind, id: r.id, updatedAt: r.updated_at, seq: r.seq, deleted: Boolean(r.deleted), data: r.deleted ? null : JSON.parse(r.data) }));
  const date = new Date().toISOString().slice(0, 10);
  const key = `backups/${date}.json`;
  await env.FILES.put(key, JSON.stringify({ format: 'ucm-inspection-server-backup', version: 1, exportedAt: new Date().toISOString(), records }), { httpMetadata: { contentType: 'application/json' } });
  // keep the last 60 daily snapshots
  const listed = await env.FILES.list({ prefix: 'backups/' });
  const keys = (listed.objects || []).map(o => o.key).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - 60))) await env.FILES.delete(old);
  return { key, records: records.length };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (!url.pathname.startsWith('/api/')) return json(env, { ok: true, service: 'ucm-inspection-sync', version: VERSION }, 200);
    if (!authorized(request, env)) return json(env, { error: 'unauthorized' }, 401);
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') return json(env, { ok: true, version: VERSION, ai: Boolean(env.ANTHROPIC_API_KEY), model: env.AI_MODEL || 'claude-opus-5-5', time: new Date().toISOString() });
      if (url.pathname === '/api/sync' && request.method === 'POST') return await handleSync(request, env);
      const file = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
      if (file && request.method === 'PUT') return await putFile(request, env, decodeURIComponent(file[1]));
      if (file && request.method === 'GET') return await getFile(env, decodeURIComponent(file[1]));
      if (url.pathname === '/api/extract' && request.method === 'POST') return await handleExtract(request, env);
      if (url.pathname === '/api/backup' && request.method === 'POST') return json(env, await backup(env));
      return json(env, { error: 'not-found' }, 404);
    } catch (error) {
      return json(env, { error: 'server-error', message: String(error && error.message || error) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(backup(env));
  },
};
