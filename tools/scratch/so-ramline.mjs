/**
 * The default ram timeline, arm by arm, on a port you name.
 *
 * The five numbers the brief pins: the head reaches the leaves at t+100, 26 blows land, the
 * gate is open at t+220, the machine has withdrawn by t+260, and the crew goes 16 -> 13 and
 * never routs. Nothing is ordered here — this is the *shipped* deployment, so any movement in
 * these figures is a regression rather than a decision.
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5473);
const MAP = args.get('map') ?? 'rome';
const base = `http://127.0.0.1:${PORT}`;
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--hide-scrollbars'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });
await p.goto(`${base}/?harness=1&quality=high&map=${MAP}&scenario=assault`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });
await p.waitForTimeout(500);
if (await p.evaluate(() => !!document.querySelector('.dep-begin'))) { await p.click('.dep-begin'); await p.waitForTimeout(600); }

const snap = () => p.evaluate(() => {
  const g = window.__game, s = g.battle.siege;
  const r = s.ramReport().filter(x => x.kind === 'gate');
  return { t: +g.engine.context.time.simTime.toFixed(1), gate: s.gateReport(),
    rams: r.map(x => ({ id: x.id, state: x.state, gateId: x.gateId, blows: x.blows,
      gateBlows: x.gateBlows, d: +x.distFromTarget.toFixed(1), crew: x.crewAlive,
      routing: x.crewRouting, owned: x.owned })) };
});
const rows = [];
rows.push({ mark: 't+0', ...(await snap()) });
for (const to of [40, 80, 100, 120, 160, 200, 220, 240, 260, 300]) {
  await p.evaluate((n) => window.__game.engine.advance(n, 166), to - rows[rows.length-1].t);
  rows.push({ mark: `t+${to}`, ...(await snap()) });
}
console.log(`# ${MAP} assault, port ${PORT} — the shipped ram, no order given`);
for (const r of rows) {
  const m = r.rams[0];
  console.log(`${r.mark.padEnd(6)} sim ${String(r.t).padStart(6)}  ${m ? `${m.state.padEnd(11)} ${String(m.d).padStart(5)} m  ${String(m.blows).padStart(2)} blows (gate ${m.gateBlows})  crew ${String(m.crew).padStart(2)}${m.routing?' ROUT':'    '}  owned ${m.owned}` : 'no ram'}  | gate ${r.gate.id} open=${r.gate.open} breached=${r.gate.breached} hp=${(r.gate.hp*100).toFixed(0)}%`);
}
const g = rows[rows.length-1].gate;
console.log('gates:', g.gates.filter(x=>!x.id.startsWith('postern')).map(x=>`${x.id} open=${x.open} broken=${x.broken} blows=${x.blows}`).join(' | '));
console.log('errors:', errs.slice(0,4));
await b.close();
