/**
 * Rome's assault is over at t+57 in every run. Who is inside the city, and how did they get in?
 *
 * `BattleFlow` ends a storm when `stormInside >= 60` — sixty storming men more than
 * `INSIDE_MARGIN` = 14 m cityward of the curtain line. Measured over eight seeds at the
 * shipped tier, the Juthungi take the objective at **t+56-59**, which is before the ram has
 * reached the gate and before a ladder has been climbed. Every ram figure anybody has ever
 * quoted for this map is therefore read out of a battle `finish()` has already ended.
 *
 * This names the men. `censusWall` clamps a man's bay index to the ends of the circuit, so a
 * unit standing off the end of the wall is measured against the end bay's midline — and the
 * depth test does not ask whether there is any masonry at that bay at all.
 */
import { chromium } from 'playwright';
const A = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const PORT = Number(A.get('port') ?? 5905);
const MAP = A.get('map') ?? 'campus-martius';
const QUALITY = A.get('quality') ?? 'ultra';
const SEED = Number(A.get('seed') ?? 4265438264);
const UNTIL = Number(A.get('until') ?? 120);
const tok = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 400, height: 240 } });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await p.goto(`http://127.0.0.1:${PORT}/?harness=1&w=400&h=240&quality=${QUALITY}&scenario=assault&autoplay=1&battle=${tok({ map: MAP, scenario: 'assault', quality: QUALITY, seed: SEED })}`,
  { waitUntil: 'domcontentloaded', timeout: 120000 });
await p.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });
await p.evaluate(() => window.__game.engine.stop());
for (let t = 0; t < UNTIL; t += 10) {
  const row = await p.evaluate((s) => {
    const g = window.__game, ctx = g.engine.context;
    g.fastForward(s);
    const b = g.battle, flow = ctx.get('battleFlow');
    const o = flow.objective ?? {};
    // Re-derive the same depth test per unit, so the census can be attributed.
    const city = ctx.tryGet('city');
    const bays = city.getGarrisonBays();
    const x0 = (bays[0].x0 + bays[0].x1) * 0.5;
    const pitch = (bays[1].x0 - bays[0].x0);
    const inside = {};
    const pool = b.pool;
    for (const u of b.units) {
      if (u.faction === 0 || u.destroyed) continue;
      let n = 0;
      for (const i of u.members) {
        if (!pool.aliveAt(i) || b.elevated[i] !== 0) continue;
        const k = Math.max(0, Math.min(bays.length - 1, Math.round((pool.x[i] - x0) / pitch)));
        const bay = bays[k];
        const mx = (bay.x0 + bay.x1) * 0.5, mz = (bay.z0 + bay.z1) * 0.5;
        const depth = (pool.x[i] - mx) * bay.nx + (pool.z[i] - mz) * bay.nz;
        if (depth < -14) { n++; }
      }
      if (n > 0) inside[`${u.typeId}#${u.id}@(${u.x.toFixed(0)},${u.z.toFixed(0)})`] = n;
    }
    return { t: +ctx.time.simTime.toFixed(0), onWall: o.stormOnWall ?? 0, holding: o.stormHolding ?? 0,
      garr: o.garrisonOnWall ?? 0, insideN: o.stormInside ?? 0, inside,
      result: flow.result ? `${flow.result.victor}/${flow.result.reason}@${flow.result.at.toFixed(0)}` : null };
  }, 10);
  console.log(`t+${String(row.t).padStart(3)}  onWall ${row.onWall} holding ${row.holding} garrison ${row.garr}`
    + `  INSIDE ${row.insideN}  ${row.result ?? ''}`);
  const e = Object.entries(row.inside);
  if (e.length) console.log('      ', e.map(([k, v]) => `${k} ${v}`).join('  '));
}
await b.close();
