#!/usr/bin/env node
/** Recon: boot a map through the real menu and dump the order of battle + wall furniture. */
import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5477);
const MAP = args.get('map') ?? 'campus-martius';
const WARM = Number(args.get('warm') ?? 20);
const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });
const settle = (ms = 300) => page.waitForTimeout(ms);

await page.goto(`${base}/?quality=high&autoplay=0`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.menu .begin', { timeout: 60000 });
await page.click(`.menu [data-map="${MAP}"]`); await settle(220);
await page.click('.menu [data-scen="assault"]'); await settle(220);
await page.click('.menu .begin');
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await settle(600);
if (await page.evaluate(() => !!document.querySelector('.dep-begin'))) { await page.click('.dep-begin'); await settle(700); }
await page.evaluate((w) => window.__game.engine.advance(w, 166), WARM);
await settle(300);

const dump = await page.evaluate(() => {
  const g = window.__game;
  const s = g.battle.siege;
  const city = g.engine.context.tryGet('city');
  const side = (x, z) => { const st = s.stationNear(x, z); if (st < 0) return 0;
    return (x - s.sx[st]) * s.snx[st] + (z - s.sz[st]) * s.snz[st] < 0 ? -1 : 1; };
  const units = g.battle.units.filter((u) => !u.destroyed).map((u) => ({
    id: u.id, typeId: u.typeId, faction: u.faction, alive: u.alive,
    x: +u.x.toFixed(1), z: +u.z.toFixed(1), side: side(u.x, u.z),
    garr: s.isGarrisoned(u.id), owned: s.owned.has(u.id),
  }));
  const stairs = (city?.getWallStairs?.() ?? []).map((st) => ({
    bay: st.bay, foot: [+st.footX.toFixed(1), +st.footZ.toFixed(1)],
    top: [+st.topX.toFixed(1), +st.topY.toFixed(2), +st.topZ.toFixed(1)],
  }));
  return {
    plan: city?.cityPlan ? { id: city.cityPlan.id, garrison: city.cityPlan.garrison, gate: city.cityPlan.siegeGateId } : null,
    playerFaction: 0,
    units,
    stations: s.nStations,
    stairs: stairs.length, stairSample: stairs.slice(0, 4),
    towers: (s.towers ?? []).map((t) => ({ id: t.id, x: +t.x.toFixed(1), z: +t.z.toFixed(1), station: t.station, state: t.state, unitId: t.unitId, boarders: t.boarders.slice() })),
    ladders: (s.ladders ?? []).map((l) => ({ x: +l.x.toFixed(1), z: +l.z.toFixed(1), station: l.station, unitId: l.unitId, boarders: l.boarders.slice() })),
    rams: (s.rams ?? []).map((r) => ({ x: +r.x.toFixed(1), z: +r.z.toFixed(1), unitId: r.unitId, wreck: r.wreck, great: !!r.great })),
    breachLinks: (s.breachLinks ?? []).slice(),
    links: (s.links ?? []).reduce((m, l) => { m[l.kind] = (m[l.kind] ?? 0) + 1; return m; }, {}),
    gates: city?.getGates?.() ?? [],
  };
});
console.log(JSON.stringify(dump, null, 1));
console.log('ERRS', errs.slice(0, 5));
await browser.close();
