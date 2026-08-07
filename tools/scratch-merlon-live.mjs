import { chromium } from 'playwright';
const PORT = Number(process.env.PORT || 5307);
const SECS = Number(process.env.SECS || 60);
const WARM = Number(process.env.WARM || 6);
const base = `http://127.0.0.1:${PORT}`;
const errs = [];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`${base}/?harness=1&quality=ultra&autoplay=0&scenario=assault&w=640&h=400`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });

// ---- geometry: does the model agree with the stone, and do embrasures land in gaps? ----
const geom = await page.evaluate(() => {
  const c = window.__game.engine.context.get('city');
  const bays = c.getGarrisonBays().filter((b) => b.garrisonable && b.walkable && b.stage === 'finished');
  const b = bays[Math.floor(bays.length / 2)];
  const off = b.parapetOuter - 0.45;
  const at = (s) => c.masonryTopAt(b.x0 + b.dx * s + b.nx * off, b.z0 + b.dz * s + b.nz * off);
  // Edges of the model along one bay, at 1 mm.
  const edges = [];
  let prev = at(0) > b.walkY + 1.3;
  for (let s = 0.001; s <= b.length; s += 0.001) {
    const m = at(s) > b.walkY + 1.3;
    if (m !== prev) { edges.push(+s.toFixed(3)); prev = m; }
  }
  const merlons = [], gaps = [];
  for (let i = 1; i < edges.length; i++) (i % 2 === (at(0) > b.walkY + 1.3 ? 1 : 0) ? gaps : merlons).push(+(edges[i] - edges[i - 1]).toFixed(4));
  // Embrasure centres: are they in a gap, and how far from the nearest edge?
  const emb = [];
  const seen = new Set();
  for (let s = 0; s <= b.length; s += 0.1) {
    const e = c.embrasureAt ? c.embrasureAt(b.x0 + b.dx * s + b.nx * (b.parapetInner - 0.42), b.z0 + b.dz * s + b.nz * (b.parapetInner - 0.42)) : null;
    if (!e) continue;
    const tc = (e.x - b.x0) * b.dx + (e.z - b.z0) * b.dz;
    const key = tc.toFixed(2);
    if (seen.has(key)) continue;
    seen.add(key);
    const topAtCentre = c.masonryTopAt(e.x + e.nx * off, e.z + e.nz * off);
    emb.push({ t: +tc.toFixed(3), inGap: topAtCentre < b.walkY + 1.3, clearAboveSill: +(topAtCentre - b.walkY).toFixed(2) });
  }
  return {
    bay: b.index, length: +b.length.toFixed(3), towerHalf: b.towerHalf,
    crestOverWalk: +(b.crestY - b.walkY).toFixed(3), sillOverWalk: +(b.sillY - b.walkY).toFixed(3),
    parapetInner: +b.parapetInner.toFixed(3), parapetOuter: +b.parapetOuter.toFixed(3),
    firstEdge: edges[0], nMerlons: merlons.length,
    merlonW: merlons.length ? +(merlons.reduce((a, v) => a + v, 0) / merlons.length).toFixed(4) : null,
    gapW: gaps.length ? +(gaps.reduce((a, v) => a + v, 0) / gaps.length).toFixed(4) : null,
    stepMeasured: merlons.length && gaps.length ? +((merlons[0] ?? 0) + (gaps[1] ?? gaps[0] ?? 0)).toFixed(4) : null,
    embrasures: emb.length, embrasuresInGap: emb.filter((e) => e.inGap).length,
    embSample: emb.slice(0, 6),
  };
});
console.log('GEOM ' + JSON.stringify(geom));

await page.evaluate((w) => window.__game.engine.advance(w, 166), WARM);
const pre = await page.evaluate(() => ({ ...window.__game.battle.strength }));
await page.evaluate(() => window.__game.engine.context.get('projectiles').debugResetCensus());
await page.evaluate((s) => window.__game.engine.advance(s, 166), SECS);
const out = await page.evaluate(() => {
  const g = window.__game;
  const pr = g.engine.context.get('projectiles');
  return { wall: pr.debugWallShots(), kinds: pr.debugProjectiles().kinds.filter((k) => k.launched > 0), strength: { ...g.battle.strength }, t: g.simTime() };
});
out.strengthBefore = pre;
out.windowS = SECS;
console.log('CENSUS ' + JSON.stringify(out));
console.log('pageerror: ' + JSON.stringify(errs.slice(0, 5)));
await browser.close();
