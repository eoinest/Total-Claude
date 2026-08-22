/**
 * HOW DEEP IS A LINE WHEN IT FIGHTS?
 *
 * The clash frame at Pydna shows ~1,000 men in melee reading as a **single rank** of figures
 * a metre apart, with the reserves in compact blocks behind. That is an impression off one
 * frame, so this measures it: for each unit, the extent of its living men along its own facing
 * normal (depth) and across it (frontage), before contact and during the melee.
 *
 * A `legio-cohort` of 320 in `line` at the sim's 0.72 m rank pitch should be roughly 40 m wide
 * and 6 m deep — eight ranks. If depth at contact is one or two metres, the ranks have gone and
 * a clash of eight thousand is being drawn as a picket fence.
 */
import { argsOf, boot, ledger, dump, ff, ROOT } from './jg-lib.mjs';
import path from 'node:path';
const A = argsOf();
const PORT = Number(A.get('port') ?? 5911);
const OUT = path.join(ROOT, 'screenshots/judge/ranks');
const L = ledger('rank depth at the clash');

const MEASURE = () => {
  const g = window.__game, b = g.battle, p = b.pool;
  const out = [];
  for (const u of b.units) {
    if (u.destroyed || u.alive < 30) continue;
    // the unit's own facing, from its heading if published, else from its members' spread
    const fx = Math.sin(u.facing ?? 0), fz = Math.cos(u.facing ?? 0);
    let n = 0, sd = 0, sw = 0, d2 = 0, w2 = 0, dmin = 1e9, dmax = -1e9, wmin = 1e9, wmax = -1e9;
    for (const i of u.members) {
      if (p.hp[i] <= 0) continue;
      const dx = p.x[i] - u.x, dz = p.z[i] - u.z;
      const dep = dx * fx + dz * fz;      // along facing
      const wid = dx * -fz + dz * fx;     // across facing
      n++; sd += dep; sw += wid; d2 += dep * dep; w2 += wid * wid;
      dmin = Math.min(dmin, dep); dmax = Math.max(dmax, dep);
      wmin = Math.min(wmin, wid); wmax = Math.max(wmax, wid);
    }
    if (n < 20) continue;
    const sdD = Math.sqrt(Math.max(0, d2 / n - (sd / n) ** 2));
    const sdW = Math.sqrt(Math.max(0, w2 / n - (sw / n) ** 2));
    out.push({ id: u.id, t: u.typeId, f: u.faction, n, order: u.order,
      depthSpan: +(dmax - dmin).toFixed(1), widthSpan: +(wmax - wmin).toFixed(1),
      depthSd: +sdD.toFixed(2), widthSd: +sdW.toFixed(2),
      // men per square metre over the 1-sd core, the density a frame reads
      density: +(n / Math.max(1, (dmax - dmin) * (wmax - wmin))).toFixed(3),
      ranksIfPitch072: +((dmax - dmin) / 0.72).toFixed(1) });
  }
  return { t: +g.simTime().toFixed(1), units: out };
};

let browser, page;
try {
  const r = await boot({ port: PORT, map: 'pydna', scenario: 'field', tier: 'ultra', out: OUT, label: 'rk', seed: 4265438264 });
  ({ browser, page } = r);
  await page.mouse.move(800, 780); await page.waitForTimeout(300);
  await page.click('.dep-begin'); await page.waitForTimeout(600);
  const marks = {};
  for (const t of [5, 60, 110, 140, 200, 300]) {
    await ff(page, t - (Object.keys(marks).length ? Number(Object.keys(marks).slice(-1)[0]) : 0));
    const m = await page.evaluate(MEASURE);
    marks[t] = m;
    const line = m.units.filter(u => /legio-cohort|juthungi-warband/.test(u.t));
    L.say(`\nt+${m.t}`);
    for (const u of line.slice(0, 8)) {
      L.say(`  ${String(u.id).padStart(2)} ${u.t.padEnd(18)} n=${String(u.n).padStart(3)} order=${u.order}  frontage ${String(u.widthSpan).padStart(6)} m   depth ${String(u.depthSpan).padStart(6)} m  (${u.ranksIfPitch072} ranks at 0.72 m)  density ${u.density}/m2`);
    }
  }
  const t5 = marks[5].units.filter(u => /legio-cohort/.test(u.t));
  const t140 = marks[140].units.filter(u => /legio-cohort/.test(u.t));
  const avg = (a, f) => a.length ? +(a.reduce((x, u) => x + f(u), 0) / a.length).toFixed(1) : 0;
  L.say(`\nlegio-cohort mean depth: t+5 ${avg(t5, u => u.depthSpan)} m -> t+140 ${avg(t140, u => u.depthSpan)} m`);
  L.say(`legio-cohort mean frontage: t+5 ${avg(t5, u => u.widthSpan)} m -> t+140 ${avg(t140, u => u.widthSpan)} m`);
  L.ck('a 320-man cohort forms more than three ranks at the start',
    avg(t5, u => u.depthSpan) > 2.2, '>2.2 m deep (>3 ranks at 0.72 m)', `${avg(t5, u => u.depthSpan)} m`);
  L.ck('a cohort still has ranks when it is fighting',
    avg(t140, u => u.depthSpan) > 2.2, '>2.2 m deep in the melee', `${avg(t140, u => u.depthSpan)} m`);
  L.ck('the fighting line is denser than one man per two square metres',
    avg(t140, u => u.density) > 0.5, '>0.5 men/m2', `${avg(t140, u => u.density)}`);
  await dump(OUT, 'ranks', { marks, rows: L.rows, log: L.log });
} catch (e) { L.ck('ran without throwing', false, 'no throw', String(e).slice(0, 300)); }
finally { if (browser) await browser.close(); }
L.summary();
