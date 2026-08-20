#!/usr/bin/env node
/**
 * Probe: do the cross-subsystem seams agree with the objects on the other side of them?
 *
 * This is the runtime half of `src/core/seams.ts`. That module compares every declared
 * consumer shape against the live provider once the world is built; this boots both maps in
 * a real browser and fails if it found anything. It is the check that would have caught the
 * gatehouse clip — `Siege` asked `CitySystem` for `hw`/`hd`/`rot` and `CitySystem` publishes
 * `halfRun`/`halfDepth`/`dx,dz`, and both sides typechecked for the whole life of the
 * feature.
 *
 * It also reports which optional accessors are simply *absent*, which is a legitimate state
 * but is the other half of the same story: `breachWall` is declared and called by `Siege` and
 * no city implements it.
 *
 * Usage: node tools/probe-seams.mjs [--port=5383] [--maps=campus-martius,carthage]
 *                                   [--scenario=assault] [--json=path]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5383);
const MAPS = (args.get('maps') ?? 'campus-martius,carthage').split(',');
const SCENARIO = args.get('scenario') ?? 'assault';
const JSON_OUT = args.get('json') ?? null;

const BASE_CONFIG = {
  unitSize: 'ultra',
  rome: { 'legio-cohort': 6, 'praetorian-cohort': 2, 'urban-cohort': 2, sagittarii: 2, equites: 3, scorpio: 1 },
  juthungi: {
    'juthungi-warband': 6, 'juthungi-spears': 3, 'juthungi-skirmishers': 3,
    'juthungi-chosen': 2, 'juthungi-berserkers': 2, 'juthungi-riders': 3,
  },
  quality: 'ultra', difficulty: 'hard', seed: 4265438264, scenario: SCENARIO,
};
const encodeConfig = (c) => Buffer.from(JSON.stringify(c)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const waitForServer = async (b, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(b, { signal: AbortSignal.timeout(1000) }); if (r.ok) return true; }
    catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  console.log(`• starting vite on ${PORT}`);
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 120000))) { console.error('vite did not start'); process.exit(1); }
} else console.log(`• reusing dev server on ${PORT}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const results = [];
let bad = 0;
for (const map of MAPS) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const log = [];
  page.on('console', (m) => log.push(m.text()));
  page.on('pageerror', (e) => log.push(`PAGEERROR ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) log.push(`HTTP ${r.status()} ${r.url()}`); });

  const url = `${base}/?harness=1&quality=ultra&w=1280&h=720&battle=${encodeConfig({ ...BASE_CONFIG, map })}`;
  console.log(`\n=== ${map} ===`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  try {
    await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 300000 });
  } catch (err) {
    console.error(`!! ${map} never became ready: ${err.message}`);
    for (const l of log.slice(-50)) console.error('  ' + l.slice(0, 300));
    bad++; await page.close(); continue;
  }
  // A few frames, so anything bound lazily on the first tick is bound.
  await page.evaluate(() => window.__game.advance(1));

  const report = await page.evaluate(() => globalThis.__seams ?? null);
  const errors = log.filter((l) => l.startsWith('PAGEERROR') || l.startsWith('HTTP'));
  results.push({ map, report, errors });

  if (!report) { console.error('!! no __seams report — installSeamCheck did not run'); bad++; }
  else {
    console.log(`checked ${report.checked} seam(s), skipped ${report.skipped.length}, `
      + `faults ${report.faults.length}`);
    for (const s of report.skipped) console.log(`  skipped (provider not registered): ${s}`);
    for (const a of report.absent ?? []) console.log(`  absent optional: ${a}`);
    for (const u of report.unchecked ?? []) console.log(`  not compared: ${u}`);
    for (const f of report.faults) {
      console.log(`  FAULT ${f.kind}: ${f.consumer} -> '${f.provider}'.${f.member}`
        + (f.missingFields ? ` missing [${f.missingFields.join(', ')}]` : '')
        + (f.detail ? ` — ${f.detail}` : ''));
      if (f.presentFields) console.log(`         provider has [${f.presentFields.join(', ')}]`);
    }
    if (report.faults.length > 0) bad++;
  }
  console.log(`pageerrors/http: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log('  ' + e.slice(0, 300));
  if (errors.length > 0) bad++;
  await page.close();
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(results, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

await browser.close();
if (server) server.kill('SIGTERM');
console.log(bad === 0 ? '\nPASS — every seam agrees on every map' : `\nFAIL — ${bad} map(s) with faults`);
process.exit(bad === 0 ? 0 : 1);
