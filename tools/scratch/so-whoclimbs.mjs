/**
 * Who is on the parapet, by unit class — the measurement behind "26 horsemen standing on the
 * wall-walk", taken on whatever port you name so the two trees can be compared.
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5473);
const MAP = args.get('map') ?? 'carthage';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(`http://127.0.0.1:${PORT}/?harness=1&quality=high&map=${MAP}&scenario=assault`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
const look = () => p.evaluate(() => {
  const g = window.__game, bt = g.battle, s = bt.siege, pool = bt.pool;
  const byClass = {}, enrolled = {};
  for (const u of bt.units) {
    if (u.destroyed) continue;
    const cls = bt.typeOf(u).unitClass;
    let up = 0;
    for (const i of u.members) if (pool.aliveAt(i) && (s.stationOf[i] >= 0 || bt.elevated[i] === 1)) up++;
    if (up > 0) byClass[cls] = (byClass[cls] ?? 0) + up;
  }
  for (const l of s.ladders ?? []) for (const id of l.boarders ?? []) {
    const u = bt.unitById(id); if (!u) continue;
    const cls = bt.typeOf(u).unitClass;
    enrolled[cls] = (enrolled[cls] ?? 0) + 1;
  }
  for (const t of s.towers ?? []) for (const id of t.boarders ?? []) {
    const u = bt.unitById(id); if (!u) continue;
    const cls = bt.typeOf(u).unitClass;
    enrolled[cls] = (enrolled[cls] ?? 0) + 1;
  }
  return { t: Math.round(g.engine.context.time.simTime), byClass, enrolled };
});
const out = [];
for (const to of [90, 150, 240]) {
  await p.evaluate((n) => window.__game.engine.advance(n, 166), to - (out.length ? out[out.length-1].t : 0));
  out.push(await look());
}
console.log(`# ${MAP} port ${PORT} — men above the ground, by unit class`);
for (const r of out) console.log(`  t+${String(r.t).padStart(3)}  on the stone ${JSON.stringify(r.byClass)}   `
  + `boarding files ${JSON.stringify(r.enrolled)}`);
console.log('errors:', errs.slice(0,2));
await b.close();
