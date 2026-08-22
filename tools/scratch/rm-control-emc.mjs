/**
 * Control for `rm-tier-emc`: is the battle running at all, and is the damage wrap live?
 *
 * `rm-tier-emc` reported the gate crew at full strength for 300 s with 540 ballistarii on the
 * curtain 50 m away and *zero* attributed damage — which is either a real finding or an
 * instrument that measures nothing. A self-consistent instrument can never fail, so this one
 * counts every point of damage in the whole battle, not just the crew's, and prints the
 * headcount of both sides beside it.
 */
import { chromium } from 'playwright';
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5905);
const MAP = A.get('map') ?? 'campus-martius';
const QUALITY = A.get('quality') ?? 'ultra';
const SEED = Number(A.get('seed') ?? 4265438264);
const UNTIL = Number(A.get('until') ?? 300);
const DIFFICULTY = A.get('difficulty') ?? 'hard';
const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 400, height: 240 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 200)); });
await p.goto(`http://127.0.0.1:${PORT}/?harness=1&w=400&h=240&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${tok({ map: MAP, scenario: 'assault', quality: QUALITY, seed: SEED, difficulty: DIFFICULTY })}`,
  { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
await p.evaluate(() => window.__game.engine.stop());
console.log('config:', await p.evaluate(() => JSON.stringify(window.__game.battle.config)));
await p.evaluate(() => {
  const g = window.__game, b = g.battle;
  window.__L = { total: 0, events: 0, byAttacker: {}, byVictimUnit: {} };
  const unitOf = new Map();
  for (const u of b.units) for (const i of u.members) unitOf.set(i, u);
  const orig = b.damage.bind(b);
  b.damage = (i, amount, fx, fz, aid) => {
    const r = orig(i, amount, fx, fz, aid);
    const L = window.__L; L.total += amount; L.events++;
    const a = b.unitById(aid); const ak = a ? a.typeId : 'none';
    L.byAttacker[ak] = (L.byAttacker[ak] ?? 0) + amount;
    const v = unitOf.get(i); const vk = v ? v.typeId : '?';
    L.byVictimUnit[vk] = (L.byVictimUnit[vk] ?? 0) + amount;
    return r;
  };
});
for (let t = 0; t < UNTIL; t += 50) {
  const row = await p.evaluate((s) => {
    const g = window.__game, ctx = g.engine.context;
    g.fastForward(s);
    const b = g.battle, si = b.siege;
    const bySide = {};
    for (const u of b.units) { const k = String(u.faction); bySide[k] = (bySide[k] ?? 0) + u.alive; }
    const r = si.ramReport()[0] ?? {};
    const shooters = b.units.filter((u) => u.typeId === 'ballistarii')
      .map((u) => `${u.id}:${u.alive}@${Math.hypot(u.x - r.x, u.z - r.z).toFixed(0)}m/ord${u.order}/tgt${u.targetUnitId ?? -1}`);
    return { t: +ctx.time.simTime.toFixed(0), bySide, dmg: window.__L.total | 0, ev: window.__L.events,
      ram: `${r.state}/crew${r.crewAlive}/blows${r.blows}`, shooters };
  }, 50);
  console.log(`t+${row.t}  men ${JSON.stringify(row.bySide)}  dmgTotal ${row.dmg} in ${row.ev} events  ram ${row.ram}`);
  console.log('    ballistarii:', row.shooters.join('  '));
}
const L = await p.evaluate(() => window.__L);
console.log('by attacker:', JSON.stringify(L.byAttacker));
console.log('by victim  :', JSON.stringify(L.byVictimUnit));
console.log('errors:', errs.slice(0, 5));
await b.close();
