#!/usr/bin/env node
/**
 * Does skipping the submit change the battle? Three arms, three independent page loads, one
 * schedule, hashes compared at every checkpoint.
 *
 *   A  advance(dt, 1000/60)                    — the shipped fast-forward
 *   B  advance(dt, 1000/60, {render:false})    — same step, no rasterisation
 *   C  advance(dt, 166,     {render:false})    — the coarse step `fastForward` uses
 *
 * A vs B isolates the submit. B vs C isolates the step size, which is a different question and
 * has to be asked separately: a coarser step changes how many ticks land in a frame, and only
 * a hash can say whether anything in the sim can tell.
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5788);
const AT = (args.get('at') ?? '0,30,90,150,200').split(',').map(Number);
const EXTRA = args.get('battle') ? `&${args.get('battle')}` : '';
const base = `http://127.0.0.1:${PORT}`;
const HASH_FN = `
window.__poolHash = () => {
  const p = window.__game.battle.pool;
  const dv = new DataView(new ArrayBuffer(4));
  let h = 0x811c9dc5;
  const mix = (u) => { h ^= u & 0xff; h = (h * 0x01000193) >>> 0; h ^= (u >>> 8) & 0xff; h = (h * 0x01000193) >>> 0;
    h ^= (u >>> 16) & 0xff; h = (h * 0x01000193) >>> 0; h ^= (u >>> 24) & 0xff; h = (h * 0x01000193) >>> 0; };
  const f = (v) => { dv.setFloat32(0, v); mix(dv.getUint32(0)); };
  let alive = 0;
  for (let i = 0; i < p.count; i++) { f(p.x[i]); f(p.z[i]); mix(p.state[i]); f(p.hp[i]);
    if (p.state[i] !== 10 && p.state[i] !== 11) alive++; }
  return { hash: (h >>> 0).toString(16).padStart(8, '0'), count: p.count, alive };
};`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function run(label, stepMs, render) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`${base}/?harness=1&quality=high&w=960&h=540${EXTRA}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  await page.evaluate(() => window.__game.engine.stop());
  await page.evaluate(HASH_FN);
  const marks = [];
  let prev = 0, wall = 0;
  for (const at of AT) {
    if (at > prev) {
      const t0 = Date.now();
      await page.evaluate(([s, ms, r]) => window.__game.engine.advance(s, ms, { render: r }), [at - prev, stepMs, render]);
      wall += Date.now() - t0;
      prev = at;
    }
    marks.push({ at, ...(await page.evaluate(() => window.__poolHash())) });
  }
  await page.close();
  console.log(`  ${label.padEnd(34)} ${marks.map((m) => m.hash).join(' ')}   alive ${marks.at(-1).alive}   wall ${(wall / 1000).toFixed(1)}s`);
  return { label, marks, wall, errors };
}
console.log(`checkpoints ${AT.join(',')}   battle "${EXTRA || '(default)'}"`);
const A = await run('A advance(dt, 1000/60)', 1000 / 60, true);
const B = await run('B advance(dt, 1000/60, no-render)', 1000 / 60, false);
const C = await run('C advance(dt, 166,     no-render)', 166, false);
// 1000/6 is five whole sim ticks to the last bit, so `n * stepMs` lands on the same total
// elapsed time as the 1000/60 arm and the tick *count* is identical. If D matches A, the only
// thing a coarse step changes is how many ticks share a frame, and the sim cannot tell.
const D = await run('D advance(dt, 1000/6,   no-render)', 1000 / 6, false);
let bad = 0;
for (let i = 0; i < AT.length; i++) {
  if (A.marks[i].hash !== B.marks[i].hash) { console.log(`!! A vs B differ at t+${AT[i]}: ${A.marks[i].hash} vs ${B.marks[i].hash}`); bad++; }
  if (A.marks[i].hash !== C.marks[i].hash) { console.log(`?? A vs C differ at t+${AT[i]}: ${A.marks[i].hash} vs ${C.marks[i].hash} (step size, not the submit)`); }
  if (A.marks[i].hash !== D.marks[i].hash) { console.log(`?? A vs D differ at t+${AT[i]}: ${A.marks[i].hash} vs ${D.marks[i].hash} (tick grouping)`); }
}
console.log(bad ? `FAIL: skipping the submit changed the sim at ${bad} checkpoint(s)` : 'PASS: A == B at every checkpoint — the submit does not touch the sim');
console.log(`speedup  no-render ${(A.wall / B.wall).toFixed(1)}x   no-render + coarse step ${(A.wall / C.wall).toFixed(1)}x`);
console.log(`speedup  D (exact five-tick step, no-render) ${(A.wall / D.wall).toFixed(1)}x`);
for (const r of [A, B, C, D]) if (r.errors.length) console.log(r.label, 'ERRORS', r.errors.slice(0, 4));
await browser.close();
