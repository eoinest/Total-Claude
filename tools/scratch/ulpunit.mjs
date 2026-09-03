#!/usr/bin/env node
/**
 * Throwaway: does a one-ULP nudge to `battle.units[0].x` survive in this battle?
 *
 * `qa-p2p --only=desync` reports the `ulp` fault firing, `NetSession.testMarker` setting
 * `perturbedUnit` to 0, and then sixty-two checkpoints agreeing bit for bit — so the write
 * happened and the difference vanished. `qa-net --only=ulp` catches the identical perturbation
 * of the identical unit in the identical battle. One page, no networking, no transport: watch
 * unit 0's `x` bits frame by frame, nudge them, and watch again.
 */
import process from 'node:process';
import { launchBrowser, startVite } from '../lib/browser-budget.mjs';

const PORT = 5972;
const ROOT = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = await startVite({ port: PORT, root: ROOT, label: 'ulpunit' });
const browser = await launchBrowser({ label: 'ulpunit', port: PORT, root: ROOT });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  console.error:', m.text()); });

const q = 'map=campus-martius&scenario=field&tier=high&size=small'
  + '&deploy=0&autoplay=1&quality=high&menu=0&seed=1';
await page.goto(`${vite.base}/?${q}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
await sleep(4000);

const read = () => page.evaluate(() => {
  const g = window.__game;
  const u = g.battle.units[0];
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, u.x);
  const sys = g.engine.context;
  const elev = sys.tryGet?.('elevation') ?? null;
  return {
    tick: g.engine.time.tick,
    id: u.id,
    x: u.x,
    bits: `${dv.getUint32(0).toString(16)}${dv.getUint32(4).toString(16).padStart(8, '0')}`,
    targetX: u.targetX,
    order: u.order,
    alive: u.alive,
    ownedByElevation: elev && typeof elev.ownsUnit === 'function' ? elev.ownsUnit(u.id) : 'n/a',
    uf64: g.hashes().uf64,
  };
});

console.log('--- ten frames, untouched ---');
for (let i = 0; i < 6; i++) { console.log(JSON.stringify(await read())); await sleep(120); }

console.log('--- nudge x by one FLOAT32 ULP ---');
console.log(await page.evaluate(() => {
  const u = window.__game.battle.units[0];
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = u.x;
  u32[0] = (u32[0] + 1) >>> 0;
  u.x = f32[0];
  const after = new DataView(new ArrayBuffer(8));
  after.setFloat64(0, u.x);
  return `now ${after.getUint32(0).toString(16)}${after.getUint32(4).toString(16).padStart(8, '0')}`;
}));

console.log('--- six frames, after ---');
for (let i = 0; i < 6; i++) { console.log(JSON.stringify(await read())); await sleep(120); }

/*
 * And the same question about a unit that is definitely under orders: whichever unit has a
 * target it has not reached. If the anchor of a *moving* unit keeps a nudge and the anchor of
 * unit 0 does not, that is the answer and it is about what the unit was doing.
 */
console.log('--- which units are moving, and who owns their anchor ---');
console.log(JSON.stringify(await page.evaluate(() => {
  const g = window.__game;
  const elev = g.engine.context.tryGet?.('elevation') ?? null;
  const sg = g.engine.context.tryGet?.('siege') ?? null;
  return g.battle.units.slice(0, 8).map((u) => ({
    id: u.id,
    moving: Math.hypot(u.targetX - u.x, u.targetZ - u.z) > 0.01,
    d: Math.round(Math.hypot(u.targetX - u.x, u.targetZ - u.z) * 100) / 100,
    elev: elev?.ownsUnit?.(u.id) ?? null,
    siege: sg?.ownsUnit?.(u.id) ?? null,
  }));
}), null, 1));

await page.close();
await browser.close();
await vite.stop?.();
process.exit(0);
