#!/usr/bin/env node
/** Why an ascent order does nothing: every gate between the click and `sendToWall`. */
import { chromium } from 'playwright';
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 5491);
const MAP = process.argv.find((a) => a.startsWith('--map='))?.slice(6) ?? '';
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`${base}/?harness=1&autoplay=0&quality=low&w=480&h=270&scenario=assault${MAP ? `&map=${MAP}` : ''}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
const r = await page.evaluate(() => {
  const g = window.__game, b = g.battle, s = b.siege, p = b.pool;
  const city = g.engine.context.get('city');
  g.engine.stop();
  const step = () => g.engine.advance(1 / 30, 1000 / 60, { render: false });
  for (let k = 0; k < 60; k++) step();
  const bays = city.getGarrisonBays();
  const mid = (q) => ({ x: (q.x0 + q.x1) * 0.5, z: (q.z0 + q.z1) * 0.5, nx: q.nx, nz: q.nz });
  const defender = b.units.find((q) => s.isGarrisoned(q.id))?.faction;
  let u = null;
  for (const q of b.units) {
    if (q.destroyed || q.faction !== defender) continue;
    if (s.ownsUnit(q.id) || s.isGarrisoned(q.id)) continue;
    if (!u || q.alive > u.alive) u = q;
  }
  let best = null, bd = Infinity;
  for (const q of bays) {
    if (!q.garrisonable) continue;
    const c = mid(q); const d = (c.x - u.x) ** 2 + (c.z - u.z) ** 2;
    if (d < bd) { bd = d; best = q; }
  }
  const c = mid(best);
  const wt = s.wallTargetAt(c.x, c.z);
  const near = s.stationNear(c.x, c.z);
  const side = s.wallSideAt(u.x, u.z);
  // what wallTargetAt is measuring
  const dx = c.x - s.sx[near], dz = c.z - s.sz[near];
  const off = dx * s.snx[near] + dz * s.snz[near];
  const along = Math.abs(-s.snz[near] * dx + s.snx[near] * dz);
  // stairs
  const stairs = s.links.filter((l) => l.kind === 2).map((l) => ({
    id: l.id, runA: l.runA, runB: l.runB,
    ax: +l.ax.toFixed(1), az: +l.az.toFixed(1),
    dFromUnit: +Math.hypot(l.ax - u.x, l.az - u.z).toFixed(1),
  }));
  const destRun = s.sRun[wt >= 0 ? wt : near];
  const chosen = s.nearestStairLink(u.x, u.z, destRun);
  const sent = s.sendToWall(u, c.x, c.z);
  return {
    unit: { id: u.id, type: u.typeId, alive: u.alive, width: u.width, x: +u.x.toFixed(1), z: +u.z.toFixed(1), order: u.order },
    bay: best.index, click: { x: +c.x.toFixed(1), z: +c.z.toFixed(1) },
    bayY: +best.walkY.toFixed(2),
    wallTargetAt: wt, stationNear: near, dead: s.sDead[near],
    off: +off.toFixed(2), inner: +s.sInner[near].toFixed(2), outer: +s.sOuter[near].toFixed(2),
    along: +along.toFixed(2),
    sideOfUnit: side, destRun, chosenStair: chosen,
    stairCount: stairs.length, stairs,
    sendToWallReturned: sent,
    ownedAfter: s.ownsUnit(u.id), planAfter: s.plans.has(u.id),
    runsOfStairs: stairs.map((x) => x.runB),
    runNext: Array.from(s.runNext),
  };
});
console.log(JSON.stringify(r, null, 1));
if (errs.length) console.log('errs', errs);
await browser.close();
