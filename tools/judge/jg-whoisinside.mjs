/**
 * WHO ARE THE SIXTY MEN WHO TAKE THE CITY?
 *
 * Both maps end the same way: `reason: 'objective'`, condition B, sixty storming men more
 * than 14 m past the curtain, `stormHolding` 0, and the card printing "The wall was carried."
 *
 * `BattleFlow.censusWall` counts a man inside on three tests — right faction, `elevated === 0`,
 * alive — and **there is no test on his unit's order** (`src/sim/BattleFlow.ts` l.669). Every
 * run I have watched has the escalade parties breaking on the parapet a few seconds before the
 * inside count starts climbing, and `Siege.routOffTheWall` gives a broken lodgement a
 * `Descend` plan aimed 40 m off the wall on the side its men are standing.
 *
 * So the hypothesis this settles: **the sixty men who take the city are broken men running
 * away.** It reproduces the census man by man, and for each man reports his unit's order,
 * rout timer and morale. If most of them belong to routing units then the deciding condition
 * of both sieges is satisfied by a rout, and every sentence the game prints about it is wrong.
 */
import { argsOf, boot, ledger, dump, ff, shot, aim, ROOT } from './jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const MAP = A.get('map') ?? 'carthage';
const SEED = Number(A.get('seed') ?? 4265438264);
const PORT = Number(A.get('port') ?? 5911);
const OUT = path.join(ROOT, `screenshots/judge/inside-${MAP}`);
const L = ledger(`who is inside — ${MAP}`);

/** Reproduce `censusWall`'s inside test, man by man, and attribute each man to his unit. */
const CENSUS = () => {
  const g = window.__game, b = g.battle, p = b.pool;
  const flow = g.engine.context.tryGet('battleFlow');
  const o = flow?.objective; if (!o) return null;
  // Rebuild the WallLine the arbiter built, from the same public accessor it uses.
  const city = g.engine.context.tryGet('city');
  const bays = (city?.getGarrisonBays?.() ?? []).filter(x => x.stage !== 'gap');
  if (!bays.length) return { err: 'no bays' };
  const mx = bays.map(x => (x.x0 + x.x1) / 2), mz = bays.map(x => (x.z0 + x.z1) / 2);
  const nx = bays.map(x => x.nx), nz = bays.map(x => x.nz);
  const half = bays.map(x => Math.hypot(x.x1 - x.x0, x.z1 - x.z0) / 2);
  const x0 = mx[0], pitch = bays.length > 1 ? (mx[bays.length - 1] - mx[0]) / (bays.length - 1) : 1;
  const MARGIN = o.insideMargin, last = mx.length - 1;
  const storm = o.storm;
  const byUnit = new Map();
  let inside = 0;
  for (let i = 0; i < p.count; i++) {
    if (p.faction[i] !== storm || b.elevated[i] !== 0 || !p.aliveAt(i)) continue;
    const k = Math.max(0, Math.min(last, Math.round((p.x[i] - x0) / pitch)));
    const dx = p.x[i] - mx[k], dz = p.z[i] - mz[k];
    const depth = dx * nx[k] + dz * nz[k];
    if (depth >= -MARGIN) continue;
    const lateral = Math.abs(dx * -nz[k] + dz * nx[k]);
    if (lateral > half[k] + MARGIN) continue;
    inside++;
    const uid = b.unitOf ? b.unitOf(i) : -1;
    const key = uid;
    const e = byUnit.get(key) ?? { unit: key, men: 0, depths: [] };
    e.men++; e.depths.push(Math.round(-depth));
    byUnit.set(key, e);
  }
  const rows = [...byUnit.values()].map(e => {
    const u = e.unit >= 0 ? b.unitById(e.unit) : null;
    return { ...e, type: u?.typeId ?? '?', order: u?.order ?? null, alive: u?.alive ?? null,
      morale: u ? Math.round(u.morale) : null, routTimer: u?.routTimer ?? null,
      routing: u ? (u.order === 9 || u.routTimer > 0) : null,
      minDepth: Math.min(...e.depths), maxDepth: Math.max(...e.depths) };
  }).sort((a, c) => c.men - a.men);
  return { arbiterInside: o.stormInside, myInside: inside, needInside: o.needInside,
    holding: o.stormHolding, onWall: o.stormOnWall, rows,
    t: Math.round(g.simTime() * 10) / 10 };
};

let browser, page;
try {
  const r = await boot({ port: PORT, map: MAP, scenario: 'assault', tier: 'ultra',
    out: OUT, label: 'i', seed: SEED });
  ({ browser, page } = r);
  await page.mouse.move(800, 760); await page.waitForTimeout(300);
  // Give the pool a unit lookup if the product does not publish one.
  const hasUnitOf = await page.evaluate(() => typeof window.__game.battle.unitOf === 'function');
  if (!hasUnitOf) {
    await page.evaluate(() => {
      const b = window.__game.battle;
      const own = new Int32Array(b.pool.capacity ?? b.pool.count + 1).fill(-1);
      for (const u of b.units) for (const i of u.members) own[i] = u.id;
      b.unitOf = (i) => own[i] ?? -1;
    });
    L.say('built a member->unit index in the page (the product does not publish one)');
  }
  await page.click('.dep-begin'); await page.waitForTimeout(600);

  const samples = [];
  for (let t = 0; t < 400; t += 5) {
    await ff(page, 5);
    const c = await page.evaluate(CENSUS);
    if (!c || c.err) continue;
    samples.push(c);
    if (c.myInside > 0 || c.onWall > 0) {
      L.say(`t+${String(c.t).padStart(6)} arbiter inside=${String(c.arbiterInside).padStart(3)} mine=${String(c.myInside).padStart(3)} onWall=${String(c.onWall).padStart(4)} holding=${c.holding}`);
      for (const row of c.rows) L.say(`         unit ${String(row.unit).padStart(2)} ${String(row.type).padEnd(18)} ${String(row.men).padStart(3)} men inside (depth ${row.minDepth}-${row.maxDepth} m)  order=${row.order} routing=${row.routing} routTimer=${row.routTimer} morale=${row.morale} aliveInUnit=${row.alive}`);
    }
    const done = await page.evaluate(() => !!document.querySelector('.rs-panel'));
    if (done) { L.say(`\nthe battle ended at t+${c.t}`); break; }
  }

  const decisive = samples.filter(s => s.myInside >= 55).slice(0, 3)
    .concat(samples[samples.length - 1] ? [samples[samples.length - 1]] : []);
  const last = samples[samples.length - 1];
  L.say(`\n=== the decisive census ===`);
  if (last) {
    L.say(`t+${last.t}: ${last.myInside} men inside (arbiter says ${last.arbiterInside}), need ${last.needInside}`);
    let routing = 0, formed = 0;
    for (const row of last.rows) { if (row.routing) routing += row.men; else formed += row.men; }
    L.say(`  of those men: ${routing} belong to units that are ROUTING, ${formed} to units still in order`);
    L.ck('the men who take the city are men still fighting',
      formed > routing, 'more formed men inside than routing men', `${formed} formed vs ${routing} routing`);
    L.ck('the break-in is not carried by a rout', routing < last.needInside,
      `fewer than ${last.needInside} routing men inside`, routing);
    L.say(`  unit by unit: ${JSON.stringify(last.rows.map(r => ({ u: r.unit, t: r.type, men: r.men, routing: r.routing, order: r.order, morale: r.morale })))}`);
    // and my reproduction must agree with the arbiter's, or I am measuring the wrong thing
    L.ck('my reproduction of the census agrees with the arbiter',
      Math.abs(last.myInside - last.arbiterInside) <= 3, `within 3 of ${last.arbiterInside}`, last.myInside);
    const hud = await page.evaluate(() => window.__HUD());
    L.say(`  the card: ${JSON.stringify(hud.result?.flavour)}`);
    L.say(`  the honours: ${hud.result?.honours}`);
  }
  await dump(OUT, `inside-${MAP}`, { map: MAP, seed: SEED, samples, rows: L.rows, log: L.log });
} catch (e) {
  L.ck('ran without throwing', false, 'no throw', String(e).slice(0, 400));
} finally { if (browser) await browser.close(); }
L.summary();
