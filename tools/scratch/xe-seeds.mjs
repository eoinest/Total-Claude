#!/usr/bin/env node
/**
 * Cross-engine determinism over several seeds, because one battle holding is not evidence.
 *
 * `docs/MULTIPLAYER.md` §7.2: the escape is a stochastic boundary-crossing process, so a
 * different seed escapes at a different time and some seeds will not escape at all inside ten
 * minutes. That cuts both ways, and the direction that matters here is the flattering one — a
 * single battle running identically in three engines could be a seed that was never going to
 * fork. §3 Stage 3 says the same thing in the imperative: *"Do not start this on the strength of
 * one seed. Run a 30-seed sweep."*
 *
 * `sanitiseConfig` fills every field it is not given from `DEFAULT_CONFIG`, so a token of
 * `{"seed": N}` is the default field battle with one thing changed.
 *
 *     node tools/scratch/xe-seeds.mjs --seeds=11,22,33,44 --at=0,200,400 --port=5951
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const SEEDS = (args.get('seeds') ?? '11,22,33,44').split(',').map(Number);
const AT = args.get('at') ?? '0,200,400';
const PORT = args.get('port') ?? '5951';
const ENGINES = args.get('engines') ?? 'chromium,firefox,webkit';

const token = (seed) => Buffer.from(JSON.stringify({ seed })).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const rows = [];
for (const seed of SEEDS) {
  console.log(`\n########## seed ${seed} ##########`);
  const r = spawnSync('node', [
    'tools/qa-xengine.mjs', `--port=${PORT}`, `--at=${AT}`, `--engines=${ENGINES}`,
    `--battle=battle=${token(seed)}`,
  ], { cwd: ROOT, encoding: 'utf8', env: process.env });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(out);
  const verdict = out.split('\n').filter((l) => l.startsWith('✓') || l.startsWith('✗')).join(' | ');
  const alive = [...out.matchAll(/^ {2}(\S+)\s+t\+\s*(\d+).*alive (\d+)/gm)]
    .filter((m) => m[2] === String(AT.split(',').at(-1)))
    .map((m) => `${m[1]} ${m[3]}`);
  rows.push({ seed, code: r.status, verdict, alive });
}

console.log('\n\n================ summary ================');
for (const r of rows) {
  console.log(`seed ${String(r.seed).padStart(11)}  exit ${r.code}  ${r.alive.join('  ')}`);
  console.log(`  ${r.verdict}`);
}
const bad = rows.filter((r) => r.code !== 0);
console.log(`\n${rows.length - bad.length}/${rows.length} seeds identical in ${ENGINES}`);
process.exit(bad.length ? 1 : 0);
