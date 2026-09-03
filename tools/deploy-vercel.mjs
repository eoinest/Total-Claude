#!/usr/bin/env node
/**
 * Deploy the built site to Vercel via the REST API.
 *
 * The CLI cannot do this. In non-interactive mode it demands an explicit `--scope`, and
 * it rejects a personal account there outright ("You cannot set your Personal Account as
 * the scope"), offering only the teams you belong to. Since this project belongs in a
 * personal scope and not in any of them, the API is the only non-interactive route.
 *
 * Uploads `dist/` as a prebuilt static deployment: every file is hashed, uploaded once by
 * digest, then referenced in a single deployment request. Omitting `teamId` is what puts
 * it in the personal scope.
 *
 * Usage: node tools/deploy-vercel.mjs [--name total-claude] [--dir dist] [--preview]
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Accepts both `--name=value` and `--name value`. The `--flag` form alone yields 'true'.
// The earlier version only handled `--name=value`, so `--name total-claude` set the name
// to the literal string "true" and silently created a project called `true`.
const args = new Map();
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    if (m[2] !== undefined) args.set(m[1], m[2]);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args.set(m[1], argv[++i]);
    else args.set(m[1], 'true');
  }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.resolve(ROOT, args.get('dir') ?? 'dist');
const NAME = args.get('name') ?? 'total-claude';
const TARGET = args.has('preview') ? undefined : 'production';

// The CLI stores its token here; reuse it rather than asking for a new one.
const AUTH = path.join(homedir(), 'Library', 'Application Support', 'com.vercel.cli', 'auth.json');
const token = JSON.parse(await readFile(AUTH, 'utf8')).token;
if (!token) throw new Error('no Vercel token in the CLI auth file — run `vercel login`');

const api = async (url, init = {}) => {
  const r = await fetch(`https://api.vercel.com${url}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${url} → ${r.status}: ${text.slice(0, 400)}`);
  return body;
};

const me = await api('/v2/user');
console.log(`• deploying as ${me.user.username} (${me.user.email}) — personal scope, no team`);

// ---------------------------------------------------------------------------
// Collect and hash every file in the output directory.
// ---------------------------------------------------------------------------

/**
 * `dist/.tc-build.json` is the one file in here that is not the site.
 *
 * `tools/lib/dist-build.mjs` writes it so `npm run host` can tell whether the build it is about
 * to serve is older than the source — a local question, answered locally. Uploading it would put
 * this machine's build time and node version on a public URL for no reason, and would make the
 * deployment's file count differ from the build's for a file nothing fetches.
 */
const NOT_THE_SITE = new Set(['.tc-build.json']);

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else if (!(dir === base && NOT_THE_SITE.has(e.name))) {
      out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/') });
    }
  }
  return out;
}

const found = await walk(DIR);
if (found.length === 0) throw new Error(`${DIR} is empty — run \`npm run build\` first`);

let total = 0;
const files = [];
for (const f of found) {
  const buf = await readFile(f.abs);
  const sha = createHash('sha1').update(buf).digest('hex');
  files.push({ file: f.rel, sha, size: buf.length, buf });
  total += buf.length;
}
const mb = (n) => `${(n / (1 << 20)).toFixed(1)} MiB`;
console.log(`• ${files.length} files, ${mb(total)}`);

// ---------------------------------------------------------------------------
// Upload by digest. Vercel dedupes, so re-deploys only send what changed.
// ---------------------------------------------------------------------------

let uploaded = 0;
let sent = 0;
const CONCURRENCY = 8;
const queue = [...files];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      await api('/v2/files', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-vercel-digest': f.sha,
          'Content-Length': String(f.size),
        },
        body: f.buf,
      });
      uploaded++;
      sent += f.size;
      if (uploaded % 20 === 0 || uploaded === files.length) {
        process.stdout.write(`\r  uploaded ${uploaded}/${files.length} (${mb(sent)})   `);
      }
    }
  })
);
console.log();

// ---------------------------------------------------------------------------
// Create the deployment. No `teamId` → personal scope. No `builds`/`framework`
// → Vercel serves the uploaded tree as static output, which is what dist is.
// ---------------------------------------------------------------------------

const dep = await api('/v13/deployments?skipAutoDetectionConfirmation=1', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: NAME,
    target: TARGET,
    files: files.map(({ file, sha, size }) => ({ file, sha, size })),
    projectSettings: {
      framework: null,
      buildCommand: null,
      installCommand: null,
      outputDirectory: null,
    },
  }),
});

console.log(`• deployment ${dep.id} created (${dep.readyState})`);

// ---------------------------------------------------------------------------
// Wait for it to go live.
// ---------------------------------------------------------------------------

const deadline = Date.now() + 10 * 60 * 1000;
let state = dep.readyState;
while (Date.now() < deadline && !['READY', 'ERROR', 'CANCELED'].includes(state)) {
  await new Promise((r) => setTimeout(r, 3000));
  const s = await api(`/v13/deployments/${dep.id}`);
  if (s.readyState !== state) {
    state = s.readyState;
    console.log(`  ${state}`);
  }
}

if (state !== 'READY') {
  console.error(`\ndeployment did not become READY (last state: ${state})`);
  console.error(`inspect: https://vercel.com/${me.user.username}/${NAME}/${dep.id}`);
  process.exit(1);
}

const final = await api(`/v13/deployments/${dep.id}`);
const urls = [final.url, ...(final.alias ?? [])].filter(Boolean);
console.log('\n✓ live:');
for (const u of [...new Set(urls)]) console.log(`   https://${u}`);
console.log(`\n  dashboard: https://vercel.com/${me.user.username}/${NAME}`);
