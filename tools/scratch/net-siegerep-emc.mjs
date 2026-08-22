#!/usr/bin/env node
/**
 * Scratch: where does a *siege* replay lose the float32 pool at t+0?
 *
 * The report: on `map=carthage&scenario=assault` the record's t+0 pool hash is `8ca295e0` (which
 * is also the pinned baseline) and the playback's is `fa60a0ea`, while `uf64`, `uctl`, `count`
 * and `alive` are all identical. So the roster, the orders and every discrete decision agree and
 * only the men's float32 x/z/hp/state differ. The playback is the side that is wrong.
 *
 * Three readings, in order, because they separate three different causes:
 *   A  an ordinary boot, hashed the instant `ready` is true          — the control
 *   B  a `?replay=` boot, hashed the instant `ready` is true          — a boot difference
 *   C  the same page after `qa-replay`'s 1.5 s tick-ceilinged frame pump — an update-phase write
 */
import { chromium } from 'playwright';
import path from 'node:path';
import process from 'node:process';
import { ensureServer } from '../lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = Number(process.argv[2] ?? 5941);
const BATTLE = process.argv[3] ?? 'map=carthage&scenario=assault';
const { base, server } = await ensureServer({
  port: PORT, root: ROOT, cacheDir: path.join(ROOT, '.vite-cache', `siegerep-${PORT}`),
});

const b = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const open = async (q) => {
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
  await p.goto(`${base}/?${q}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  return p;
};
const H = (p) => p.evaluate(() => window.__game.hashes());
/** Every man's float32 x/z/state/hp plus his unit, so two boots can be differenced. */
const POOL = (p) => p.evaluate(() => {
  const g = window.__game;
  const b = g.battle;
  const pl = b.pool;
  const unitOf = new Int32Array(pl.count).fill(-1);
  for (const u of b.units) for (const i of u.members) if (i < pl.count) unitOf[i] = u.id;
  const out = [];
  for (let i = 0; i < pl.count; i++) {
    out.push([pl.x[i], pl.z[i], pl.state[i], pl.hp[i], unitOf[i], pl.y[i], pl.slot[i]]);
  }
  return { tick: g.engine.time.tick, out };
});

// --- A: an ordinary boot, hashed before anything has had a chance to run a frame ---
const a = await open(`${BATTLE}&menu=0&deploy=0&autoplay=0`);
// Stop the loop *before* reading, or the two pages are hashed at two different ticks and
// every difference is the clock rather than the build.
await a.evaluate(() => { window.__game.engine.stop(); });
const hA = await H(a);
const pA = await POOL(a);
console.log('A ordinary boot          ', JSON.stringify(hA), 'tick', pA.tick);
// A record of that battle, with no orders in it at all: the simplest possible token.
const token = await a.evaluate(async () => window.__game.replay.token());
const recMarks = await a.evaluate(() => window.__game.replay.record().marks);
console.log('A record mark 0          ', JSON.stringify(recMarks[0]));
await a.close();

// --- B: the same battle from the token, hashed at the same moment ---
const c = await open(`replay=${token}`);
await c.evaluate(() => { window.__game.engine.stop(); });
const hB = await H(c);
const pB = await POOL(c);
console.log('B replay boot            ', JSON.stringify(hB), 'tick', pB.tick);

// --- the diff ---
{
  const byUnit = new Map();
  let n = 0;
  const F32 = new Float32Array(1);
  const f32 = (v) => { F32[0] = v; return F32[0]; };
  const samples = [];
  for (let i = 0; i < Math.min(pA.out.length, pB.out.length); i++) {
    const x = pA.out[i];
    const y = pB.out[i];
    if (f32(x[0]) === f32(y[0]) && f32(x[1]) === f32(y[1]) && x[2] === y[2] && f32(x[3]) === f32(y[3])) continue;
    n++;
    byUnit.set(x[4], (byUnit.get(x[4]) ?? 0) + 1);
    if (samples.length < 6) {
      samples.push({ i, unit: x[4], slot: x[6],
        dx: y[0] - x[0], dz: y[1] - x[1], dy: y[5] - x[5],
        dstate: y[2] - x[2], dhp: y[3] - x[3] });
    }
  }
  console.log(`\n${n} of ${pA.out.length} men differ on x/z/state/hp`);
  console.log('by unit id:', JSON.stringify([...byUnit].sort((p2, q) => q[1] - p2[1]).slice(0, 12)));
  for (const s2 of samples) console.log('  ', JSON.stringify(s2));
  const units = await c.evaluate(() => window.__game.battle.units.map(
    (u) => ({ id: u.id, t: u.typeId, f: u.faction, n: u.members.length, w: u.width })));
  const bad = [...byUnit.keys()];
  console.log('units involved:', JSON.stringify(units.filter((u) => bad.includes(u.id))));
}
console.log('B refusal                ', JSON.stringify(await c.evaluate(() => ({
  refusal: window.__game.replay.refusal, diverged: window.__game.replay.divergedAt,
  mode: window.__game.replay.mode, tick: window.__game.engine.time.tick,
}))));

// --- C: after the gate's frame pump ---
await c.evaluate(() => {
  const g = window.__game;
  g.engine.stop();
  const t = g.engine.time;
  t.tickCeiling = t.tick;
  g.engine.advance(1.5, 1000 / 60, { render: false });
  t.tickCeiling = -1;
});
const hC = await H(c);
console.log('C after the 1.5 s pump   ', JSON.stringify(hC));

const same = (x, y) => (x.hash === y.hash ? 'pool SAME' : `pool ${x.hash} vs ${y.hash}`);
console.log(`\nA vs B  ${same(hA, hB)}  uf64 ${hA.uf64 === hB.uf64 ? 'same' : 'DIFF'}`
  + `  count ${hA.count}/${hB.count} alive ${hA.alive}/${hB.alive}`);
console.log(`B vs C  ${same(hB, hC)}  uf64 ${hB.uf64 === hC.uf64 ? 'same' : 'DIFF'}`);
console.log(`A vs C  ${same(hA, hC)}`);

await c.close();
await b.close();
if (server) server.kill('SIGTERM');
