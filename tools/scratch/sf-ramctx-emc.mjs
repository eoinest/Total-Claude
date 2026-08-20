/**
 * What battle is `so-ramline.mjs` actually measuring?
 *
 * It boots `?harness=1&quality=high&map=campus-martius&scenario=assault` — no `autoplay`,
 * no seed — and prints only the ram. This prints the context the ram is standing in: who is
 * commanded by the AI, whether `BattleFlow` has already declared a result, and what the
 * objective reads. A ram schedule taken across a battle that ended two minutes earlier is
 * not a schedule.
 */
import { chromium } from 'playwright';
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5491);
const URLQ = A.get('url') ?? `?harness=1&quality=high&map=campus-martius&scenario=assault`;
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
await p.goto(`http://127.0.0.1:${PORT}/${URLQ}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
await p.evaluate(() => window.__game.engine.stop());
if (await p.evaluate(() => !!document.querySelector('.dep-begin'))) { await p.click('.dep-begin'); await p.waitForTimeout(400); }
const meta = await p.evaluate(() => {
  const g = window.__game, ctx = g.engine.context;
  const ai = ctx.tryGet('tacticalAI') ?? ctx.tryGet('ai');
  return {
    seed: g.battle.rng?.getState?.() ?? null,
    url: location.search,
    commanded: ai && ai.commanded ? [...ai.commanded] : (ai ? Object.keys(ai) .filter((k) => /command/i.test(k)) : 'no ai in context'),
    units: g.battle.units.length,
    strength: { ...g.battle.strength },
  };
});
console.log('# context:', JSON.stringify(meta));
console.log('   t   result                     stormOnWall  holding  inside  garrOnWall  blows  crew  storm  garr');
for (const to of [40, 80, 120, 134, 160, 200, 220, 260, 300]) {
  const row = await p.evaluate((n) => {
    const g = window.__game, ctx = g.engine.context;
    const now = ctx.time.simTime;
    if (n > now) g.engine.advance(n - now, 166);
    const flow = ctx.get('battleFlow');
    const o = flow.objective ?? {};
    const gr = g.battle.siege.gateReport();
    const rr = (g.battle.siege.ramReport() ?? []).filter((x) => x.kind === 'gate')[0] ?? {};
    return { t: +ctx.time.simTime.toFixed(0), result: flow.result ? `${flow.result.victor} ${flow.result.reason} @${flow.result.at.toFixed(0)}` : '-',
      onWall: o.stormOnWall ?? 0, holding: o.stormHolding ?? 0, inside: o.stormInside ?? 0, garr: o.garrisonOnWall ?? 0,
      blows: gr.blows, crew: rr.crewAlive, rout: rr.crewRouting, s1: g.battle.strength[1], s0: g.battle.strength[0] };
  }, to);
  console.log(`${String(row.t).padStart(4)}   ${String(row.result).padEnd(24)}  ${String(row.onWall).padStart(10)} ${String(row.holding).padStart(8)} ${String(row.inside).padStart(7)} ${String(row.garr).padStart(11)}  ${String(row.blows).padStart(5)} ${String(row.crew).padStart(5)}${row.rout ? 'R' : ' '} ${String(row.s1).padStart(6)} ${String(row.s0).padStart(5)}`);
}
console.log('errors:', errs.slice(0, 3));
await b.close();
