#!/usr/bin/env node
/**
 * Scratch: which parameter moves Carthage's garrison, `?replay=` or something it implies?
 *
 * The finding so far: a `?replay=` boot of `map=carthage&scenario=assault` lays 1,340 men — the
 * whole Punic garrison, units 0-9, whole units at a time — about 3.96 m along x from where an
 * ordinary boot lays them, with `uf64` and `uctl` bit-identical, so every `UnitGroupState` and
 * every discrete decision agrees and only the men are in the wrong place. dx varies slightly by
 * slot, which on a curved wall means a different arc position rather than a translation.
 *
 * This boots the same battle several ways and prints the t+0 pool hash for each, so the
 * responsible flag is the one that changes it.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import process from 'node:process';
import { ensureServer } from '../lib/menu-boot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PORT = Number(process.argv[2] ?? 5942);
const B = 'map=carthage&scenario=assault';
const { base, server } = await ensureServer({
  port: PORT, root: ROOT, cacheDir: path.join(ROOT, '.vite-cache', `bisect-${PORT}`),
});
const br = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});

const read = async (q, label) => {
  const p = await br.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => console.log(`  ${label} PAGEERROR`, e.message.slice(0, 160)));
  await p.goto(`${base}/?${q}`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000 });
  await p.evaluate(() => { window.__game.engine.stop(); });
  const out = await p.evaluate(() => {
    const g = window.__game;
    const u0 = g.battle.units[0];
    const p0 = g.battle.pool;
    const i0 = u0.members[0];
    return {
      h: g.engine.time.tick === 0 ? g.hashes() : { note: `tick ${g.engine.time.tick}` },
      tick: g.engine.time.tick,
      scale: g.battle.unitSizeScale,
      quality: g.engine.context.quality.maxSoldiers,
      dep: !!g.deployment,
      garrisoned: !!g.battle.siege?.isGarrisoned?.(u0.id),
      u0: { id: u0.id, x: u0.x, z: u0.z, f: u0.facing, w: u0.width, order: u0.order },
      m0: { x: p0.x[i0], y: p0.y[i0], z: p0.z[i0] },
      cfg: { map: g.replay.record()?.cfg.map, scen: g.replay.record()?.cfg.scenario,
        seed: g.replay.record()?.cfg.seed, size: g.replay.record()?.cfg.unitSize,
        q: g.replay.record()?.cfg.quality, tod: g.replay.record()?.cfg.timeOfDay,
        diff: g.replay.record()?.cfg.difficulty, opp: g.replay.record()?.cfg.opponent },
    };
  });
  const token = await p.evaluate(() => window.__game.replay.token());
  await p.close();
  console.log(`${label.padEnd(34)} ${out.h.hash ?? out.h.note}  u0 x=${out.u0.x.toFixed(4)} `
    + `m0 x=${out.m0.x.toFixed(4)} garr=${out.garrisoned} scale=${out.scale} `
    + `pool=${out.quality} dep=${out.dep}`);
  return { out, token };
};

const a = await read(`${B}&menu=0&deploy=0&autoplay=0`, 'A  plain, deploy=0 autoplay=0');
console.log('   A cfg', JSON.stringify(a.out.cfg));
await read(`${B}&menu=0`, 'A2 plain, menu=0 only');
await read(`${B}&menu=0&autoplay=1`, 'A3 autoplay=1');
await read(`replay=${a.token}`, 'B  replay only');
await read(`${B}&menu=0&deploy=0&autoplay=0&replay=${a.token}`, 'B1 replay + A\'s params');
await read(`${B}&menu=0&deploy=0&autoplay=0&quality=ultra`, 'A4 quality=ultra explicit');
await read(`${B}&menu=0&deploy=0&autoplay=0&difficulty=hard`, 'A5 difficulty=hard');

await br.close();
if (server) server.kill('SIGTERM');
