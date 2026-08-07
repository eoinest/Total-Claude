#!/usr/bin/env node
/**
 * How many men each bank of ladders puts over the parapet, with nobody touching anything.
 *
 * A control. The climb arm of `qa-siegecommand` stalled after `main` was merged in, and the
 * banks the *escalade parties themselves* were working stalled with it — which is either
 * something in my order path or something in front of the wall that nobody can now walk
 * through. This measures the parties alone, so the answer does not depend on my feature
 * existing, and can therefore be run on a tree that does not have it.
 */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5412);
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(`${base}/?harness=1&autoplay=0&map=carthage&scenario=assault&quality=low&w=1280&h=720`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
const read = () => page.evaluate(() => {
  const s = window.__game.battle.siege;
  const b = window.__game.battle;
  const banks = new Map();
  for (const l of s.ladders) {
    const e = banks.get(l.unitId) ?? { crossed: 0, station: l.station, queue: 0 };
    e.crossed += l.crossed;
    e.queue += l.crossing ? l.crossing.queue.length : 0;
    banks.set(l.unitId, e);
  }
  const out = [];
  for (const [uid, e] of banks) {
    const u = b.unitById(uid);
    const p = b.pool;
    // How far the nearest man of the party still on the ground is from his own ladder foot:
    // the number that separates "the party is spent" from "the party cannot get there".
    let near = Infinity, ground = 0;
    const feet = s.ladders.filter((l) => l.unitId === uid);
    if (u) {
      for (const i of u.members) {
        if (!p.aliveAt(i) || s.stationOf[i] >= 0 || s.crossOf[i] !== -1) continue;
        ground++;
        for (const l of feet) near = Math.min(near, Math.hypot(p.x[i] - l.x, p.z[i] - l.z));
      }
    }
    out.push({
      station: e.station, crossed: e.crossed, queue: e.queue,
      alive: u ? u.alive : 0, routing: u ? u.order === 8 : null, ground,
      nearestFoot: Number.isFinite(near) ? +near.toFixed(1) : null,
    });
  }
  return { t: +window.__game.simTime().toFixed(0), banks: out };
});
for (const at of [120, 240, 420]) {
  await page.evaluate((n) => window.__game.engine.advance(n, 166), at === 120 ? 120 : 120);
  const r = await read();
  console.log(`t+${String(r.t).padStart(3)}  ` + r.banks.map((b) =>
    `[st ${b.station} across ${b.crossed} q ${b.queue} alive ${b.alive} onGround ${b.ground} `
    + `nearestFoot ${b.nearestFoot}${b.routing ? ' ROUT' : ''}]`).join(' '));
}
await browser.close();
