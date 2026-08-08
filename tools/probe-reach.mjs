#!/usr/bin/env node
/**
 * the launch solve's reach test, graded.
 *
 * `maxRange` is a level-ground bound and `d` is a horizontal distance, so on a siege map the
 * test knows nothing about the parapet between them. This prints, per weapon and in 30 s
 * slices, how many shots the test refused, how many of those it refused *because* of height,
 * how many it now allows because the shooter is above his target, and — the number that says
 * whether any of it is right — how many shots left with no ballistic root at all and so at
 * `lowRoot`'s flat 45 degrees into whatever is in front of them.
 *
 * `refusedTooHigh`, `reachedDownhill` and `noSolution` are only present on the after tree; the
 * before tree prints `unreachable` alone and that is the 43 % figure.
 *
 * Usage: node tools/probe-reach.mjs --port=5715 --map=carthage --warm=30 --window=240
 */
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5715);
const MAP = args.get('map') ?? 'carthage';
const SCENARIO = args.get('scenario') ?? 'assault';
const WARM = Number(args.get('warm') ?? 30);
const WINDOW = Number(args.get('window') ?? 240);
const SLICE = Number(args.get('slice') ?? 30);
const JSON_OUT = args.get('json') ?? null;

const base = `http://127.0.0.1:${PORT}`;
const served = await fetch(`${base}/src/sim/Projectiles.ts`).then((r) => r.text()).catch(() => '');
if (!served) { console.error(`FATAL: nothing served at ${base}`); process.exit(2); }
const arm = served.includes('cRefusedHigh') ? 'AFTER — reach bound knows the height' : 'BEFORE — level-ground bound';
console.log(`source: ${base}  (${served.length} bytes)  ${arm}`);
console.log(`plan:   map=${MAP} scenario=${SCENARIO} warm=${WARM}s window=${WINDOW}s slice=${SLICE}s`);

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `${base}/?harness=1&quality=high&autoplay=0&scenario=${SCENARIO}&w=640&h=400&battle=${token}`;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });

const advance = async (s) => {
  let left = s;
  while (left > 1e-6) { const step = Math.min(5, left); await page.evaluate((x) => window.__game.engine.advance(x, 166), step); left -= step; }
};
const kinds = async () => page.evaluate(() => {
  const pr = window.__game.engine.context.get('projectiles');
  const d = pr.debugProjectiles();
  const b = window.__game.battle;
  return { t: window.__game.simTime(), kinds: d.kinds, credit: b.creditRefused ?? null,
    hEdges: d.refuseHeightEdgesM ?? null, hBands: d.refuseByHeight ?? null,
    oEdges: d.refuseOverEdges ?? null, oBands: d.refuseByOver ?? null };
});
const reset = async () => page.evaluate(() => window.__game.engine.context.get('projectiles').debugResetCensus());

await advance(WARM);
const rows = [];
const HSUM = [];
const OSUM = [];
const n = Math.max(1, Math.round(WINDOW / SLICE));
console.log('');
console.log('slice      kind      attempts  refused   %ref   tooHigh  downhill  noSolve  hitMan  killed  masonry');
for (let k = 0; k < n; k++) {
  await reset();
  const a = await kinds();
  await advance(SLICE);
  const c = await kinds();
  if (c.hBands) { c.hBands.forEach((v, q) => { HSUM[q] = (HSUM[q] ?? 0) + v; }); c.oBands.forEach((v, q) => { OSUM[q] = (OSUM[q] ?? 0) + v; }); }
  for (const kk of c.kinds) {
    const attempts = kk.launched + kk.unreachable;
    if (attempts === 0) continue;
    rows.push({ t0: a.t, t1: c.t, ...kk, attempts });
    console.log(
      `${a.t.toFixed(0).padStart(4)}-${c.t.toFixed(0).padStart(4)} ${String(kk.kind).padEnd(9)}`
      + `${String(attempts).padStart(9)}${String(kk.unreachable).padStart(9)}`
      + `${String(((100 * kk.unreachable) / attempts).toFixed(1)).padStart(7)}`
      + `${String(kk.refusedTooHigh ?? '-').padStart(10)}${String(kk.reachedDownhill ?? '-').padStart(10)}`
      + `${String(kk.noSolution ?? '-').padStart(9)}`
      + `${String(kk.hitMan).padStart(8)}${String(kk.killed).padStart(8)}${String(kk.intoMasonry).padStart(9)}`
    );
  }
}
console.log('');
console.log('pooled over the window');
console.log('kind        attempts  refused   %ref   tooHigh  downhill  noSolve  hitMan  killed  masonry  maxRangeM');
const byKind = new Map();
for (const r of rows) {
  const e = byKind.get(r.kind) ?? { attempts: 0, unreachable: 0, refusedTooHigh: 0, reachedDownhill: 0, noSolution: 0, hitMan: 0, killed: 0, intoMasonry: 0, maxRangeM: r.maxRangeM };
  e.attempts += r.attempts; e.unreachable += r.unreachable;
  e.refusedTooHigh += r.refusedTooHigh ?? 0; e.reachedDownhill += r.reachedDownhill ?? 0;
  e.noSolution += r.noSolution ?? 0;
  e.hitMan += r.hitMan; e.killed += r.killed; e.intoMasonry += r.intoMasonry;
  byKind.set(r.kind, e);
}
for (const [kind, e] of byKind) {
  console.log(
    `${kind.padEnd(11)}${String(e.attempts).padStart(9)}${String(e.unreachable).padStart(9)}`
    + `${String(((100 * e.unreachable) / e.attempts).toFixed(1)).padStart(7)}`
    + `${String(e.refusedTooHigh).padStart(10)}${String(e.reachedDownhill).padStart(10)}${String(e.noSolution).padStart(9)}`
    + `${String(e.hitMan).padStart(8)}${String(e.killed).padStart(8)}${String(e.intoMasonry).padStart(9)}`
    + `${String(e.maxRangeM).padStart(11)}`
  );
}
const fin = await kinds();
if (fin.hBands) {
  console.log('');
  console.log('refusals by height of the target above the muzzle (pooled over the window)');
  console.log('  bands ' + ['<-12','<-6','<-2','<2','<6','<12','<18','<24','24+'].map((s2)=>s2.padStart(6)).join(''));
  console.log('  n     ' + HSUM.map((v)=>String(v).padStart(6)).join(''));
  console.log('refusals by how far past the bound, as a multiple of it');
  console.log('  bands ' + ['<1.1','<1.25','<1.5','<2','<3','<5','5+'].map((s2)=>s2.padStart(7)).join(''));
  console.log('  n     ' + OSUM.map((v)=>String(v).padStart(7)).join(''));
}
console.log(`\ncreditRefused (same-faction kill credits refused, should be 0): ${fin.credit}`);
if (errors.length) { console.log(`page errors: ${errors.length}`); for (const e of [...new Set(errors)].slice(0, 6)) console.log('  ' + e); }
if (JSON_OUT) { await writeFile(JSON_OUT, JSON.stringify({ map: MAP, scenario: SCENARIO, rows }, null, 2)); console.log(`wrote ${JSON_OUT}`); }
await browser.close();
process.exit(0);
