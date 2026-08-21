#!/usr/bin/env node
/**
 * How much height does a wall link bridge?
 *
 * `Siege.recut()` severs a run when consecutive stations differ by more than 0.62 m in y.
 * `Siege.buildLinks()` then rejoins two runs on **horizontal gap alone** — it computes
 * `const step = Math.abs(sy[b] - sy[a])` and the next line is `void step;`. So the number
 * that split the run is measured, named, and thrown away by the code that puts it back.
 *
 * This reads every link off the live sim and prints the height it spans.
 *
 * Usage: node tools/scratch/probe-linkstep.mjs --port=5931 [--map=campus-martius]
 */
import { chromium } from 'playwright';
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const PORT = Number(arg('port', 5931));
const MAP = arg('map', 'campus-martius');
const token = Buffer.from(JSON.stringify({ map: MAP, scenario: 'assault' })).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = `http://127.0.0.1:${PORT}/?harness=1&w=1280&h=720&quality=ultra&scenario=assault&battle=${token}`;
const r = await fetch(`http://127.0.0.1:${PORT}/src/main.ts`).catch(() => null);
if (!r || !r.ok) { console.error('no dev server on', PORT); process.exit(2); }
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });
const out = await p.evaluate(() => {
  const g = window.__game;
  const S = g.battle?.elevation ?? g.siege;
  const links = S.links;               // private, but this is a probe
  const KIND = ['TowerPass', 'Step', 'Stair', 'Breach'];
  const rows = links.map((l) => ({
    id: l.id, kind: KIND[l.kind], runA: l.runA, runB: l.runB,
    gap: +Math.hypot(l.bx - l.ax, l.bz - l.az).toFixed(2),
    dy: +Math.abs(l.by - l.ay).toFixed(2),
    ax: +l.ax.toFixed(1), ay: +l.ay.toFixed(2), by: +l.by.toFixed(2),
  }));
  return { nRuns: S.nRuns, nStations: S.nStations, rows };
});
const walk = out.rows.filter((r) => r.kind === 'TowerPass' || r.kind === 'Step');
walk.sort((a, b2) => b2.dy - a.dy);
console.log(`runs ${out.nRuns}, stations ${out.nStations}, walk-to-walk links ${walk.length}`);
console.log('\nworst height a walk-to-walk crossing bridges:');
console.log('  kind        runs      x       gap     ay      by      dy');
for (const l of walk.slice(0, 14)) {
  console.log(`  ${l.kind.padEnd(10)} ${String(l.runA).padStart(3)}→${String(l.runB).padEnd(3)} ${String(l.ax).padStart(7)} ${String(l.gap).padStart(7)} ${String(l.ay).padStart(7)} ${String(l.by).padStart(7)} ${String(l.dy).padStart(7)}`);
}
const over = (t) => walk.filter((l) => l.dy > t).length;
console.log(`\nover 0.62 m (recut's own threshold): ${over(0.62)} of ${walk.length}`);
console.log(`over 1.2 m  (STAIR_STEP_OVER, mid-thigh): ${over(1.2)}`);
console.log(`over 3.0 m  (a storey):                   ${over(3.0)}`);
console.log(`over 6.0 m  (the whole curtain):          ${over(6.0)}`);
const s = out.rows.filter((r) => r.kind === 'Stair');
console.log(`\nstairs ${s.length}, rise ${Math.min(...s.map(x=>x.dy)).toFixed(2)}–${Math.max(...s.map(x=>x.dy)).toFixed(2)} m`);
await b.close();
