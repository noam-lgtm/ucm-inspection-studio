#!/usr/bin/env node
/*
 * One-shot setup of the sync server on Cloudflare (free plan).
 * Run from the `worker` folder after `npx wrangler login`:
 *     node setup.mjs
 * It creates the database and the file bucket, applies the schema, generates the
 * workspace key, deploys the Worker and prints the URL + key to paste into the app.
 * Safe to run again: existing resources are reused.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(here);
const DB_NAME = 'ucm-inspection';
const BUCKET = 'ucm-inspection-files';
const wranglerBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(args, { input, quiet = false } = {}) {
  const r = spawnSync(wranglerBin, ['wrangler', ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  if (!quiet) process.stdout.write(r.stdout || '');
  if (r.status !== 0) { process.stderr.write(r.stderr || ''); throw new Error(`wrangler ${args.join(' ')} failed`); }
  return (r.stdout || '') + (r.stderr || '');
}
const step = msg => console.log('\n==> ' + msg);

try {
  step('בודק התחברות ל-Cloudflare');
  const who = run(['whoami'], { quiet: true });
  if (/not authenticated|You are not logged in/i.test(who)) throw new Error('לא מחובר. הריצו קודם: npx wrangler login');

  step(`מסד נתונים ${DB_NAME}`);
  let list = run(['d1', 'list', '--json'], { quiet: true });
  let dbs = JSON.parse(list.slice(list.indexOf('[')));
  let db = dbs.find(d => d.name === DB_NAME);
  if (!db) { run(['d1', 'create', DB_NAME], { quiet: true }); list = run(['d1', 'list', '--json'], { quiet: true }); dbs = JSON.parse(list.slice(list.indexOf('['))); db = dbs.find(d => d.name === DB_NAME); }
  if (!db) throw new Error('יצירת מסד הנתונים נכשלה');
  const id = db.uuid || db.id;
  let toml = fs.readFileSync('wrangler.toml', 'utf8');
  toml = toml.replace(/database_id = "[^"]*"/, `database_id = "${id}"`);
  fs.writeFileSync('wrangler.toml', toml);
  console.log('database_id =', id);

  step('טבלאות');
  run(['d1', 'execute', DB_NAME, '--remote', '--file=./schema.sql'], { quiet: true });

  step(`אחסון קבצים ${BUCKET}`);
  const buckets = run(['r2', 'bucket', 'list'], { quiet: true });
  if (!buckets.includes(BUCKET)) run(['r2', 'bucket', 'create', BUCKET], { quiet: true });

  step('מפתח גישה');
  const keyFile = path.join(here, '.workspace-key');
  let key = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
  if (!key) { key = randomBytes(24).toString('hex'); fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 }); }
  run(['secret', 'put', 'WORKSPACE_KEY'], { input: key + '\n', quiet: true });

  step('פריסה');
  const out = run(['deploy'], { quiet: true });
  const url = (out.match(/https:\/\/[\w.-]+\.workers\.dev/) || [])[0] || '(לא נמצאה כתובת בפלט של wrangler deploy; ראו למעלה)';

  console.log('\n==================================================');
  console.log('הסנכרון מוכן. בכל מחשב: הגדרות ← סנכרון ← להדביק:');
  console.log('כתובת שרת הסנכרון: ' + url);
  console.log('מפתח גישה:         ' + key);
  console.log('(המפתח שמור גם בקובץ worker/.workspace-key – אל תעלו אותו ל-GitHub)');
  console.log('==================================================\n');
} catch (error) {
  console.error('\nשגיאה: ' + error.message);
  process.exit(1);
}
