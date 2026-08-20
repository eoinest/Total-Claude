#!/usr/bin/env node
/**
 * Recon: boot the Carthage assault and dump the order of battle plus the siege geometry,
 * so the morale trace that follows knows which units are the escalade and where the wall is.
 */
import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5629);
const T = Number(args.get('t') ?? 60);
const base = `http://127.0.0.1:${PORT}`;
const up = await fetch(`${base}/src/main.ts`).catch(() => null);
if (!up || !up.ok) { console.error(`no dev server at ${base}`); process.exit(2); }

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`); });

await page.goto(`${base}/?harness=1&map=carthage&scenario=assault&quality=high&w=960&h=540`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 600000 });

const boot = await page.evaluate(() => {
  const g = window.__game, b = g.battle, ctx = g.engine.context;
  const s = b.siege;
  const morale = ctx.tryGet ? ctx.tryGet('morale') : null;
  return {
    hasMorale: !!morale,
    moraleKeys: morale ? Object.keys(morale.moraleTerms(0)) : [],
    simTime: g.simTime(),
    stationCount: s ? s.stationCount : -1,
    nRuns: s ? s.nRuns : -1,
    ladders: s && s.ladders ? s.ladders.length : -1,
    owned: s && s.owned ? [...s.owned] : [],
    units: b.units.map((u) => ({
      id: u.id, typeId: u.typeId, faction: u.faction, alive: u.alive,
      init: u.initialStrength, morale: +u.morale.toFixed(1), max: u.maxMorale,
      x: +u.x.toFixed(1), z: +u.z.toFixed(1),
      side: s ? s.wallSideAt(u.x, u.z) : 0,
      garr: s ? s.isGarrisoned(u.id) : false,
      own: s ? s.ownsUnit(u.id) : false,
    })),
  };
});
console.log(JSON.stringify(boot, null, 1));

// Walk forward and print a coarse picture.
for (let t = 0; t < T; t += 10) {
  await page.evaluate(() => window.__game.engine.advance(10, 1000 / 60));
  const row = await page.evaluate(() => {
    const g = window.__game, b = g.battle, s = b.siege;
    const ctx = g.engine.context;
    const m = ctx.tryGet('morale');
    const rows = [];
    for (const u of b.units) {
      if (u.destroyed) continue;
      const sig = window.__sig ? window.__sig(u.id) : null;
      rows.push([u.id, u.faction, u.alive, +u.morale.toFixed(1), u.order,
        s ? (s.ownsUnit(u.id) ? 1 : 0) : 0, s ? (s.isGarrisoned(u.id) ? 1 : 0) : 0,
        +(b.levelOf(u.id)).toFixed(1)]);
    }
    return { t: +g.simTime().toFixed(1), stormOnWall: s ? s.stormOnWall : null,
      wallShots: s ? s.wallShots : null, wallKills: s ? s.wallKills : null,
      moraleBand: m ? b.units.filter((u)=>!u.destroyed).map((u)=>m.bandOf(u.id)) : [],
      rows };
  });
  console.log(JSON.stringify(row));
}
console.log('ERRS', JSON.stringify(errs.slice(0, 10)));
await browser.close();
