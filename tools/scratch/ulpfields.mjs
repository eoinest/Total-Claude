#!/usr/bin/env node
/**
 * Throwaway: which `UNIT_F64_FIELDS` are real float64 accumulators, and which are float32
 * values in a float64 box?
 *
 * `ulpunit.mjs` showed `UnitGroupState.x` carrying `...80000000`, `...60000000`, `...a0000000`
 * frame after frame — the low 29 bits always zero, which is a float32 stored in a double — and
 * a one-ULP nudge to it gone by the next tick. If that is true of every field then the `uf64`
 * layer cannot see a one-ULP disagreement at all; if it is true of some, `NetSession.testMarker`
 * should be perturbing one of the others.
 */
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const PORT = 5973;
const ROOT = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = await startVite({ port: PORT, root: ROOT, label: 'ulpfields' });
const browser = await launchBrowser({ label: 'ulpfields', port: PORT, root: ROOT });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const q = 'map=campus-martius&scenario=field&tier=high&size=small'
  + '&deploy=0&autoplay=1&quality=high&menu=0&seed=1';
await page.goto(`${vite.base}/?${q}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await sleep(6000);

const FIELDS = ['x', 'z', 'facing', 'targetX', 'targetZ', 'targetFacing',
  'morale', 'maxMorale', 'fatigue', 'ammo', 'chargeTimer', 'routTimer', 'spacingX', 'spacingZ'];

const snap = () => page.evaluate((fs) => {
  const g = window.__game;
  const dv = new DataView(new ArrayBuffer(8));
  const bits = (v) => { dv.setFloat64(0, v); return `${dv.getUint32(0).toString(16)}${dv.getUint32(4).toString(16).padStart(8, '0')}`; };
  const out = { tick: g.engine.time.tick };
  for (const f of fs) {
    // Across the first twelve units, so a field that is float32 on one and float64 on another
    // is not read off a single lucky sample.
    out[f] = g.battle.units.slice(0, 12).map((u) => bits(u[f])).join(' ');
  }
  return out;
}, FIELDS);

const rows = [];
for (let i = 0; i < 3; i++) { rows.push(await snap()); await sleep(400); }

console.log('field           low-29-bits-zero?  sample');
for (const f of FIELDS) {
  const all = rows.flatMap((r) => r[f].split(' '));
  const clean = all.filter((b) => /0{7}$/.test(b)).length;
  console.log(`${f.padEnd(15)} ${String(clean).padStart(2)}/${all.length}`.padEnd(34)
    + rows[0][f].split(' ').slice(0, 3).join(' '));
}

console.log('\n--- does a one-ULP nudge to each field survive one tick? ---');
for (const f of FIELDS) {
  const r = await page.evaluate((field) => {
    const u = window.__game.battle.units[0];
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, u[field]);
    dv.setUint32(4, (dv.getUint32(4) + 1) >>> 0);
    u[field] = dv.getFloat64(0);
    const bits = (v) => { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v); return `${d.getUint32(0).toString(16)}${d.getUint32(4).toString(16).padStart(8, '0')}`; };
    return { set: bits(u[field]), tick: window.__game.engine.time.tick };
  }, f);
  await sleep(220);
  const after = await page.evaluate((field) => {
    const u = window.__game.battle.units[0];
    const d = new DataView(new ArrayBuffer(8));
    d.setFloat64(0, u[field]);
    return { bits: `${d.getUint32(0).toString(16)}${d.getUint32(4).toString(16).padStart(8, '0')}`, tick: window.__game.engine.time.tick };
  }, f);
  const kept = !/0{7}$/.test(after.bits);
  console.log(`${f.padEnd(15)} set ${r.set} @${r.tick} -> ${after.bits} @${after.tick}  `
    + `${kept ? 'ODD BITS SURVIVE' : 'back to a float32 value'}`);
}

await page.close();
await browser.close();
await vite.stop?.();
process.exit(0);
