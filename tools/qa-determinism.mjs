#!/usr/bin/env node
/**
 * QA: determinism at the current scale.
 *
 * Two independent page loads, advanced by an identical schedule, must produce a
 * bit-identical soldier pool. The claim in README.md ("a battle replays identically —
 * verified by hashing every soldier's state across independent runs") was last checked at
 * 2,544 men; this runs it at ~8,970.
 *
 * Hashes x/z/state/hp per soldier at several checkpoints. On divergence it reports the
 * first differing soldier index and the field that differs, which is what actually
 * localises the culprit.
 *
 * Usage: node tools/qa-determinism.mjs [--port=5226] [--until=200] [--json=path]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5226);
const JSON_OUT = args.get('json') ?? null;
const CHECKPOINTS = (args.get('at') ?? '0,30,90,150,200').split(',').map(Number);

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) { console.error('vite did not start'); process.exit(1); }
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const HASH_FN = `
  window.__poolHash = () => {
    const p = window.__game.battle.pool;
    // FNV-1a over the exact bit patterns, so a 1-ULP drift is caught rather than rounded
    // away. Reading the float bits via a shared DataView avoids any toFixed() smoothing.
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    let h = 0x811c9dc5;
    const mix = (u) => {
      h ^= u & 0xff;        h = (h * 0x01000193) >>> 0;
      h ^= (u >>> 8) & 0xff;  h = (h * 0x01000193) >>> 0;
      h ^= (u >>> 16) & 0xff; h = (h * 0x01000193) >>> 0;
      h ^= (u >>> 24) & 0xff; h = (h * 0x01000193) >>> 0;
    };
    const f = (v) => { dv.setFloat32(0, v); mix(dv.getUint32(0)); };
    let alive = 0;
    for (let i = 0; i < p.count; i++) {
      f(p.x[i]); f(p.z[i]); mix(p.state[i]); f(p.hp[i]);
      if (p.state[i] !== 10 && p.state[i] !== 11) alive++;
    }
    return { hash: (h >>> 0).toString(16).padStart(8, '0'), count: p.count, alive };
  };
  window.__poolDump = () => {
    const p = window.__game.battle.pool;
    return {
      count: p.count,
      x: Array.from(p.x.subarray(0, p.count)),
      z: Array.from(p.z.subarray(0, p.count)),
      state: Array.from(p.state.subarray(0, p.count)),
      hp: Array.from(p.hp.subarray(0, p.count)),
      unitId: Array.from(p.unitId.subarray(0, p.count)),
    };
  };
`;

/** One independent run: fresh page, rAF stopped, advanced by the identical schedule. */
async function run(label) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/?harness=1&quality=high&w=960&h=540`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  // Stop the rAF loop: otherwise wall-clock time between Playwright calls advances one run
  // more than the other and every hash diverges for an uninteresting reason.
  await page.evaluate(() => window.__game.engine.stop());
  await page.evaluate(HASH_FN);

  const marks = [];
  let prev = 0;
  for (const at of CHECKPOINTS) {
    if (at > prev) {
      // Identical step size in both runs, so the fixed-step schedule matches exactly.
      await page.evaluate((secs) => window.__game.engine.advance(secs, 1000 / 60), at - prev);
      prev = at;
    }
    const h = await page.evaluate(() => window.__poolHash());
    marks.push({ at, ...h, simTime: await page.evaluate(() => +window.__game.simTime().toFixed(3)) });
    console.log(`  ${label}  t+${String(at).padStart(3)}  simTime ${marks.at(-1).simTime.toFixed(3)}  ` +
      `count ${h.count}  alive ${h.alive}  hash ${h.hash}`);
  }
  return { page, marks, errors };
}

console.log('• run A');
const A = await run('A');
console.log('• run B');
const B = await run('B');

let failed = 0;
console.log('\n--- comparison ---');
const diffs = [];
for (let i = 0; i < CHECKPOINTS.length; i++) {
  const a = A.marks[i], b = B.marks[i];
  const same = a.hash === b.hash && a.count === b.count && a.alive === b.alive;
  console.log(`  t+${String(a.at).padStart(3)}  A ${a.hash} (${a.alive}/${a.count})   ` +
    `B ${b.hash} (${b.alive}/${b.count})   ${same ? 'IDENTICAL' : 'DIVERGED'}`);
  if (!same) { failed++; diffs.push(a.at); }
}

// Localise the first divergence: which soldier, which field.
let firstDiff = null;
if (diffs.length) {
  const at = diffs[0];
  console.log(`\n  localising the first divergence at t+${at}...`);
  const [da, db] = [await A.page.evaluate(() => window.__poolDump()), await B.page.evaluate(() => window.__poolDump())];
  const bad = [];
  const n = Math.min(da.count, db.count);
  for (let i = 0; i < n && bad.length < 12; i++) {
    const fields = [];
    if (da.x[i] !== db.x[i]) fields.push(`x ${da.x[i]} vs ${db.x[i]}`);
    if (da.z[i] !== db.z[i]) fields.push(`z ${da.z[i]} vs ${db.z[i]}`);
    if (da.state[i] !== db.state[i]) fields.push(`state ${da.state[i]} vs ${db.state[i]}`);
    if (da.hp[i] !== db.hp[i]) fields.push(`hp ${da.hp[i]} vs ${db.hp[i]}`);
    if (fields.length) bad.push({ i, unitId: da.unitId[i], fields });
  }
  let differing = 0;
  for (let i = 0; i < n; i++) {
    if (da.x[i] !== db.x[i] || da.z[i] !== db.z[i] || da.state[i] !== db.state[i] || da.hp[i] !== db.hp[i]) differing++;
  }
  firstDiff = { at, differing, of: n, sample: bad };
  console.log(`  ${differing}/${n} soldiers differ (${(differing / n * 100).toFixed(2)}%)`);
  for (const d of bad) console.log(`    soldier ${String(d.i).padStart(5)} (unit ${d.unitId}): ${d.fields.join('; ')}`);
}

const errors = [...new Set([...A.errors, ...B.errors])];
if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
}

if (JSON_OUT) await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify({ A: A.marks, B: B.marks, diffs, firstDiff, errors }, null, 2));
await browser.close();
if (server) server.kill('SIGTERM');
console.log(failed
  ? `\n✗ determinism BROKEN at ${failed}/${CHECKPOINTS.length} checkpoints (${A.marks.at(-1).count} soldiers)`
  : `\n✓ deterministic across ${CHECKPOINTS.length} checkpoints at ${A.marks.at(-1).count} soldiers`);
process.exit(failed ? 1 : 0);
