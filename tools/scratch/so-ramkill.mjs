/**
 * What kills Rome's ram crew, by attacker, in the first ninety seconds.
 *
 * The crew goes 32 -> 6 in forty seconds at 111 m from the gate and the machine never lands
 * a blow, in twelve runs of twelve. "They all die" is the owner's own first hypothesis and it
 * is obviously true; the question this answers is *who is killing them*, which nothing in the
 * reports so far has said. `BattleSystem.damage` is wrapped rather than sampled, because a
 * ten-second poll can see a crew shrink and cannot see what shrank it.
 */
import { chromium } from 'playwright';
const args = new Map(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const PORT = Number(args.get('port') ?? 5473);
const MAP = args.get('map') ?? 'campus-martius';
const base = `http://127.0.0.1:${PORT}`;
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=metal','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(`${base}/?harness=1&quality=high&map=${MAP}&scenario=assault`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 240000 });

await p.evaluate(() => {
  const g = window.__game, b = g.battle, s = b.siege;
  const crewIds = new Set(s.ramReport().map(r => r.unitId));
  window.__crewIds = [...crewIds];
  const members = new Set();
  for (const id of crewIds) { const u = b.unitById(id); if (u) for (const i of u.members) members.add(i); }
  window.__ledger = { killedBy: {}, hurtBy: {}, deaths: [], startMen: members.size };
  const orig = b.damage.bind(b);
  b.damage = (i, amount, fx, fz, attackerUnitId) => {
    const was = b.pool.aliveAt(i);
    const dead = orig(i, amount, fx, fz, attackerUnitId);
    if (was && members.has(i)) {
      const a = b.unitById(attackerUnitId);
      const key = a ? `${a.typeId}#${a.id}` : `unattributed(${attackerUnitId})`;
      window.__ledger.hurtBy[key] = (window.__ledger.hurtBy[key] ?? 0) + amount;
      if (dead) {
        window.__ledger.killedBy[key] = (window.__ledger.killedBy[key] ?? 0) + 1;
        window.__ledger.deaths.push({ t: +g.engine.context.time.simTime.toFixed(1), by: key,
          d: a ? +Math.hypot(a.x - b.pool.x[i], a.z - b.pool.z[i]).toFixed(0) : -1 });
      }
    }
    return dead;
  };
});
const rows = [];
for (const to of [20, 40, 60, 80, 100, 140]) {
  await p.evaluate((n) => window.__game.engine.advance(n, 166), to - (rows.length ? rows[rows.length-1].t : 0));
  rows.push(await p.evaluate(() => {
    const g = window.__game, s = g.battle.siege;
    const r = s.ramReport()[0];
    return { t: Math.round(g.engine.context.time.simTime), state: r.state, crew: r.crewAlive,
      rout: r.crewRouting, d: +r.distFromTarget.toFixed(0), blows: r.blows };
  }));
}
const led = await p.evaluate(() => window.__ledger);
console.log(`# ${MAP} — who kills the ram crew (${led.startMen} men at t+0)`);
for (const r of rows) console.log(`  t+${String(r.t).padStart(3)}  ${r.state.padEnd(10)} ${String(r.d).padStart(3)} m  `
  + `crew ${String(r.crew).padStart(2)}${r.rout ? ' ROUT' : '    '}  ${r.blows} blows`);
const rank = (o) => Object.entries(o).sort((a, c) => c[1] - a[1]).slice(0, 8);
console.log('  killed by:', rank(led.killedBy).map(([k, v]) => `${k} ${v}`).join(', ') || 'nobody');
console.log('  damage by:', rank(led.hurtBy).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ') || 'none');
console.log('  first deaths:', led.deaths.slice(0, 8).map(d => `t+${d.t} ${d.by} @${d.d}m`).join(' | '));
console.log('  total crew deaths:', led.deaths.length);
console.log('errors:', errs.slice(0, 3));
await b.close();
