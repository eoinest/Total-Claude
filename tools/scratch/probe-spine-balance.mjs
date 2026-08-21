#!/usr/bin/env node
/**
 * What the two-ended station clip does to how an assault ends. **Measured, not tuned.**
 *
 * Restoring five refused links to walkable flights changes how a garrison moves, and moving
 * a garrison differently is a balance change whether or not anybody chose it. This reports
 * the shape of that change and adjusts nothing: survivors by faction at four checkpoints,
 * how much of the wall is manned, and whether the wall comes down.
 *
 * `qa-determinism` already proves the two arms are the *same battle* — same map, same
 * scenario, same headcount, bit-identical between two loads of one tree — so a difference
 * here is the change and not a different fight. That is the check that matters most: this
 * project has shipped three "re-recorded" pins that were measuring another battle entirely,
 * and the tell was a headcount that did not match its own scenario. The headcount is printed
 * at every checkpoint for exactly that reason.
 *
 * Usage:
 *   node tools/scratch/probe-spine-balance.mjs --port=5953 --map=campus-martius --label=after
 */
import { chromium } from 'playwright';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5953));
const MAP = arg('map', 'campus-martius');
const LABEL = arg('label', '');
const TIMES = arg('at', '0,60,120,200').split(',').map(Number);

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: 'assault' })).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=high&scenario=assault&battle=${token}`;
const r = await fetch(`http://127.0.0.1:${PORT}/src/main.ts`).catch(() => null);
if (!r || !r.ok) { console.error('no dev server on', PORT); process.exit(2); }

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });

await p.evaluate(() => {
  const g = window.__game;
  const b2 = g.battle;
  const s = b2.elevation ?? b2.siege;
  window.__bal = {
    g, b: b2, s,
    snap() {
      const pool = b2.pool;
      const byFaction = {};
      let onWall = 0;
      for (let i = 0; i < pool.count; i++) {
        if (pool.state[i] === 10 || pool.state[i] === 11) continue;
        const f = pool.faction ? pool.faction[i] : -1;
        byFaction[f] = (byFaction[f] ?? 0) + 1;
        if (b2.elevated[i]) onWall++;
      }
      const w = s.wallReport();
      // Units, which is what the player sees win or lose, and their faction.
      const units = { };
      for (const u of b2.units) {
        if (u.destroyed) continue;
        units[u.faction] = (units[u.faction] ?? 0) + 1;
      }
      return { count: pool.count, alive: Object.values(byFaction).reduce((a, v) => a + v, 0),
        byFaction, units, onWall,
        runs: w.runs, stations: w.stations, dead: w.deadStations, reachable: w.reachable,
        links: w.links, unbridged: w.unbridged, refused: w.refusedSteps };
    },
  };
});

const rows = [];
let el = 0;
for (const t of TIMES) {
  if (t > el) { await p.evaluate((d) => window.__bal.g.fastForward(d), t - el); el = t; }
  const s = await p.evaluate(() => window.__bal.snap());
  rows.push({ t, ...s });
  console.log(`t+${String(t).padStart(3)}  pool ${s.count}  alive ${s.alive}  `
    + `by faction ${JSON.stringify(s.byFaction)}  units ${JSON.stringify(s.units)}  `
    + `on the wall ${s.onWall}  stations ${s.stations} (${s.dead} dead)  `
    + `links ${s.links.towerPass + s.links.step} walk / ${s.links.stair} stair  `
    + `reachable ${s.reachable}/${s.runs}  unbridged ${s.unbridged} (${s.refused} refused)`);
}
if (errs.length) console.log(`PAGE ERRORS ${errs.length}: ${errs.join(' | ')}`);
console.log(JSON.stringify({ map: MAP, label: LABEL, rows, errs }));
await b.close();
