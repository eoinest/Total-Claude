#!/usr/bin/env node
/**
 * How far did `standOnDeploymentGround` move each map's field battle?
 *
 * The rule is a `max` over three terms and it is silent about which one won, so the only way
 * to know a map is unmoved is to measure it against the layout `deployBattle` produces before
 * the rule runs — and that layout is knowable without a "before" tree, because `centred(6, 64)`
 * is `-160 … +160` on every map there is. This recovers the shift from the six legionary
 * cohorts and prints it beside the box the rule solved against.
 *
 *   node tools/scratch/probe-standshift.mjs --port=5932 --maps=campus-martius,pydna,carthage
 */
import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5932);
const MAPS = (args.get('maps') ?? 'campus-martius,pydna,carthage').split(',');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
for (const map of MAPS) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=high&w=960&h=540&map=${map}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  await page.evaluate(() => window.__game.engine.stop());
  const out = await page.evaluate(async () => {
    const g = window.__game;
    const maps = await import('/src/maps/index.ts');
    const id = maps.activeMap().id;
    const ground = maps.activeMap().terrain.deploy;
    const cohorts = g.battle.units.filter((u) => u.typeId === 'legio-cohort').map((u) => u.x);
    // `centred(n, 64)` is symmetric about 0, so the mean of the block is the shift outright.
    const shift = cohorts.length ? cohorts.reduce((a, b) => a + b, 0) / cohorts.length : NaN;
    const pool = g.battle.pool;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pool.count; i++) {
      if (pool.hp[i] <= 0) continue;
      if (pool.x[i] < lo) lo = pool.x[i];
      if (pool.x[i] > hi) hi = pool.x[i];
    }
    return { id, ground, cohorts, shift, men: [+lo.toFixed(1), +hi.toFixed(1)], units: g.battle.units.length };
  });
  console.log(`${out.id.padEnd(15)} shift ${out.shift.toFixed(3).padStart(9)} m  `
    + `cohorts ${out.cohorts.map((x) => x.toFixed(1)).join(', ')}  men x ${out.men[0]}..${out.men[1]}`);
  console.log(`${''.padEnd(15)} axisX ${out.ground.axisX}  north ${JSON.stringify(out.ground.north)}`);
  console.log(`${''.padEnd(15)} ${''.padEnd(6)}  south ${JSON.stringify(out.ground.south)}`);
  await page.close();
}
await browser.close();
