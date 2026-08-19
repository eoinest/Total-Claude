/**
 * An uncommanded siege, run long, to see whether it ever ends.
 *
 * The playtest reached t+904 with four towers frozen at `boarding` and no verdict. This
 * drives the same battle with nobody touching it and reports the tower states, who still
 * owns which cohort, and whether the battle produced a result — on whatever port you name,
 * so the two trees can be compared.
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5473);
const MAP = args.get('map') ?? 'carthage';
const UNTIL = Number(args.get('until') ?? 960);
const base = `http://127.0.0.1:${PORT}`;
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(`${base}/?harness=1&quality=high&map=${MAP}&scenario=assault`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await p.evaluate(() => {
  window.__verdict = null;
  window.__game.engine.events.on('battleEnded', (e) => { window.__verdict = e; });
});
const snap = () => p.evaluate(() => {
  const g = window.__game, s = g.battle.siege;
  const names = ['approach','docking','landing','boarding','spent'];
  return {
    t: Math.round(g.engine.context.time.simTime),
    towers: s.towers.map(t => `#${t.id} ${names[t.state]}${s.ownsUnit(t.unitId) ? ' owned' : ' free'}`),
    idle: s.towers.map(t => +(t.idle ?? -1).toFixed(0)),
    crossed: s.towers.reduce((a, t) => a + t.crossed, 0),
    owned: s.owned ? s.owned.size : -1,
    verdict: window.__verdict,
    alive: [0, 1].map(f => g.battle.units.filter(u => u.faction === f && !u.destroyed && u.alive > 0).length),
  };
});
const rows = [];
let t = 0;
for (const to of [120, 240, 360, 480, 600, 720, 840, UNTIL]) {
  await p.evaluate((n) => window.__game.engine.advance(n, 166), to - t);
  t = to;
  rows.push(await snap());
}
console.log(`# ${MAP}, port ${PORT} — nobody touches it`);
for (const r of rows) {
  console.log(`t+${String(r.t).padStart(4)}  towers [${r.towers.join(' | ')}]  idle ${r.idle.join(',')}  `
    + `crossed ${r.crossed}  siege-owned units ${r.owned}  units alive ${r.alive.join(' v ')}  `
    + `verdict ${r.verdict ? JSON.stringify(r.verdict) : 'none'}`);
}
console.log('errors:', errs.slice(0, 3));
await b.close();
