/**
 * Does the graphics tier change the ram's battle, and if so by what mechanism?
 *
 * The claim under test: at `ultra` the gate crew is shot off the road sixteen metres short of
 * the Porta Flaminia and lands zero blows; at `medium` it reaches the gate and lands 26. Same
 * map, same scenario, same seed. `SimQuality` has one member, `maxSoldiers`, so the only path
 * a tier has into the simulation is `fittedUnitScale`.
 *
 * One seed cannot tell a mechanism from a coin toss, so this runs N seeds per tier and prints
 * the distribution, and it wraps `BattleSystem.damage` so the crew's death is attributed
 * rather than inferred.
 *
 *   node tools/scratch/rm-tier-emc.mjs --port=5905 --seeds=8 --tiers=ultra,medium
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5905);
const MAP = A.get('map') ?? 'campus-martius';
const TIERS = (A.get('tiers') ?? 'ultra,medium').split(',');
const UNTIL = Number(A.get('until') ?? 400);
const STEP = Number(A.get('step') ?? 10);
const SEEDS = Number(A.get('seeds') ?? 8);
const SEED0 = Number(A.get('seed0') ?? 4265438264);
const DIFFICULTY = A.get('difficulty') ?? 'hard';
const LABEL = A.get('label') ?? 'tier';
const K = 0x9e3779b1;
const OUT = path.join(ROOT, 'screenshots/rams');
await mkdir(OUT, { recursive: true });
const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const all = [];

for (const quality of TIERS) {
  console.log(`\n=== ${MAP} ${quality} ${DIFFICULTY} ===`);
  for (let i = 0; i < SEEDS; i++) {
    const seed = (SEED0 + i * K) >>> 0;
    const cfg = { map: MAP, scenario: 'assault', quality, seed, difficulty: DIFFICULTY };
    const p = await browser.newPage({ viewport: { width: 400, height: 240 } });
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
    await p.goto(`http://127.0.0.1:${PORT}/?harness=1&w=400&h=240&quality=${quality}&scenario=assault&autoplay=1&battle=${tok(cfg)}`,
      { waitUntil: 'domcontentloaded', timeout: 120000 });
    await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
    await p.evaluate(() => window.__game.engine.stop());

    // Attribute every point of damage the gate crew takes, and remember who owned the ropes
    // at the time — `recrew` reassigns mid-battle, so a fixed member set would go stale.
    const setup = await p.evaluate(() => {
      const g = window.__game, b = g.battle, s = b.siege;
      const gateRam = s.ramReport().find((r) => r.kind === 'gate');
      window.__ram = gateRam ? gateRam.id : -1;
      window.__ledger = { hurtBy: {}, killedBy: {}, deaths: [] };
      const crewMembers = () => {
        const set = new Set();
        for (const r of s.ramReport()) { const u = b.unitById(r.unitId); if (u) for (const i of u.members) set.add(i); }
        return set;
      };
      let members = crewMembers();
      let refreshedAt = 0;
      const orig = b.damage.bind(b);
      b.damage = (i, amount, fx, fz, attackerUnitId) => {
        const t = g.engine.context.time.simTime;
        if (t - refreshedAt > 2) { members = crewMembers(); refreshedAt = t; }
        const was = b.pool.aliveAt(i);
        const dead = orig(i, amount, fx, fz, attackerUnitId);
        if (was && members.has(i)) {
          const a = b.unitById(attackerUnitId);
          const key = a ? `${a.typeId}#${a.id}` : `unattributed`;
          const L = window.__ledger;
          L.hurtBy[key] = (L.hurtBy[key] ?? 0) + amount;
          if (dead) {
            L.killedBy[key] = (L.killedBy[key] ?? 0) + 1;
            L.deaths.push({ t: +t.toFixed(1), by: key,
              d: a ? +Math.hypot(a.x - b.pool.x[i], a.z - b.pool.z[i]).toFixed(0) : -1 });
          }
        }
        return dead;
      };
      // Garrison census: how many men of each wall type, and how far each unit is from the ram.
      const gar = {};
      for (const u of b.units) {
        if (!s.isGarrisoned?.(u.id)) continue;
        const r = (gar[u.typeId] ??= { units: 0, men: 0 });
        r.units++; r.men += u.alive;
      }
      const gate = s.gateReport();
      return {
        unitScale: b.unitSizeScale, men: b.units.reduce((a, u) => a + u.alive, 0),
        units: b.units.length, garrison: gar,
        gate: { id: gate.id, x: +gate.x.toFixed(1), z: +gate.z.toFixed(1) },
        ram: gateRam ? { x: +gateRam.x.toFixed(1), z: +gateRam.z.toFixed(1), crew: gateRam.crewAlive,
          d: +gateRam.distFromTarget.toFixed(1), dims: gateRam.dims } : null,
      };
    });

    const series = [];
    for (let t = 0; t < UNTIL; t += STEP) {
      series.push(await p.evaluate((s) => {
        const g = window.__game, ctx = g.engine.context;
        g.fastForward(s);
        const b = g.battle, si = b.siege;
        const flow = ctx.get('battleFlow');
        const gr = si.gateReport();
        const rr = si.ramReport().find((x) => x.id === window.__ram) ?? {};
        return { t: +ctx.time.simTime.toFixed(0), blows: gr.blows, open: gr.open, hp: +(gr.hp ?? 0).toFixed(2),
          state: rr.state, crew: rr.crewAlive ?? 0, rout: !!rr.crewRouting, owned: !!rr.owned,
          x: +(rr.x ?? 0).toFixed(0), z: +(rr.z ?? 0).toFixed(0), d: +(rr.distFromTarget ?? 0).toFixed(0),
          result: flow.result ? `${flow.result.victor}/${flow.result.reason}@${flow.result.at.toFixed(0)}` : null };
      }, STEP));
    }
    const led = await p.evaluate(() => window.__ledger);
    await p.close();

    const maxBlows = Math.max(...series.map((r) => r.blows));
    const opened = series.find((r) => r.open);
    const firstRout = series.find((r) => r.rout);
    const dead = series.find((r) => r.crew === 0);
    const rank = (o) => Object.entries(o).sort((a, c) => c[1] - a[1]).slice(0, 4);
    const rec = { quality, seed, setup, maxBlows, openedAt: opened ? opened.t : null,
      routAt: firstRout ? firstRout.t : null, deadAt: dead ? dead.t : null,
      minD: Math.min(...series.map((r) => r.d)),
      hurtBy: rank(led.hurtBy), killedBy: rank(led.killedBy), deaths: led.deaths.length,
      series, errs };
    all.push(rec);
    console.log(`  ${String(seed).padStart(11)} scale ${setup.unitScale.toFixed(4)} men ${setup.men}`
      + `  blows ${String(maxBlows).padStart(2)}/26  open ${opened ? 't+' + opened.t : 'never'}`
      + `  closest ${rec.minD} m  rout ${firstRout ? 't+' + firstRout.t : 'never'}`
      + `  hurt: ${rank(led.hurtBy).map(([k, v]) => `${k} ${Math.round(v)}`).join(' ') || 'nobody'}`);
  }
}

console.log('\n=== summary ===');
for (const q of TIERS) {
  const r = all.filter((x) => x.quality === q);
  const blows = r.map((x) => x.maxBlows).sort((a, b) => a - b);
  const med = blows[Math.floor(blows.length / 2)];
  console.log(`  ${q.padEnd(7)} blows [${blows.join(', ')}] median ${med}`
    + `  gate opened ${r.filter((x) => x.openedAt !== null).length}/${r.length}`
    + `  closest approach median ${[...r.map((x) => x.minD)].sort((a, b) => a - b)[Math.floor(r.length / 2)]} m`);
}
await writeFile(path.join(OUT, `${LABEL}.json`), JSON.stringify(all, null, 1));
await browser.close();
