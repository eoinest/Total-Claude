/**
 * THE CONTAGION GEOMETRY — descriptive only, no verdict, no p-value.
 *
 * `Morale.ts` makes a rout spread by distance between unit *anchors*:
 *
 *   CONTAGION_RANGE = 145;                      // metres
 *   spreadPanic  : every unbroken unit of the same faction within 145 m takes
 *                  CONTAGION_SHOCK * (1 - d/145) the moment one breaks
 *   witnessPressure: friend routing within 145 m adds P_WITNESS_FRIEND 1.5 * near,
 *                  enemy routing within 145 m subtracts P_WITNESS_ENEMY 2.2 * near,
 *                  each capped at 3, and the two are SUBTRACTED from one another
 *
 * That last line is the interesting one. If a unit can see about as many enemy units breaking
 * as friendly ones, the two terms cancel and the positive feedback that "turns one broken
 * cohort into a lost battle" is damped. So the geometry to measure is not how flat the ground
 * is, it is **how many unit pairs sit inside 145 m, split by whether they are the same side**.
 *
 * Reports, per faction, at each mark: own-side pairs within 145 m, cross-side pairs within
 * 145 m, their ratio, and the mean distance from each unit to its nearest enemy unit.
 *
 *   node tools/scratch/fv-envelope.mjs --port=5966 --tag=mainsrc --runs=3
 */
import { argsOf, boot, ledger, dump, ff, ROOT } from '../judge/jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const PORT = Number(A.get('port') ?? 5966);
const TAG = A.get('tag') ?? 'run';
const RUNS = Number(A.get('runs') ?? 3);
const MARKS = (A.get('marks') ?? '100,150,200').split(',').map(Number);
const OUT = path.join(ROOT, 'screenshots/judge/envelope');
const SEEDS = [4265438264, 1, 7, 99, 12345, 777777, 2718281828, 31415926].slice(0, RUNS);
const L = ledger(`envelope ${TAG}`);

const acc = new Map();   // mark -> rows
for (const seed of SEEDS) {
  let browser;
  try {
    const r = await boot({ port: PORT, map: 'campus-martius', scenario: 'field', tier: 'ultra',
      out: OUT, label: `env-${TAG}-${seed}`, seed, query: 'autoplay=1&deploy=0' });
    browser = r.browser;
    const page = r.page;
    let t = 0;
    for (const mark of MARKS) {
      await ff(page, mark - t); t = mark;
      const s = await page.evaluate(() => {
        const R = 145;
        const b = window.__game.battle;
        const us = b.units.filter((u) => !u.destroyed && u.alive > 0)
          .map((u) => ({ f: u.faction, x: u.x, z: u.z, r: u.order === 9 || u.routTimer > 0 }));
        const out = {};
        for (const f of [0, 1]) {
          let own = 0, cross = 0, ownRouting = 0, crossRouting = 0, nSum = 0, nN = 0;
          for (const a of us) {
            if (a.f !== f) continue;
            let near = Infinity;
            for (const c of us) {
              if (c === a) continue;
              const d = Math.sqrt((c.x - a.x) ** 2 + (c.z - a.z) ** 2);
              if (c.f !== a.f && d < near) near = d;
              if (d > R) continue;
              if (c.f === a.f) { own++; if (c.r) ownRouting++; }
              else { cross++; if (c.r) crossRouting++; }
            }
            if (near < Infinity) { nSum += near; nN++; }
          }
          out[f] = { units: us.filter((u) => u.f === f).length, own: own / 2, cross,
            ownRouting, crossRouting, nearestEnemyMean: nN ? nSum / nN : null,
            routing: us.filter((u) => u.f === f && u.r).length };
        }
        return { t: Math.round(window.__game.simTime() * 10) / 10, ...out };
      });
      (acc.get(mark) ?? acc.set(mark, []).get(mark)).push({ seed, ...s });
      for (const f of [0, 1]) {
        const q = s[f];
        L.say(`${TAG} seed ${String(seed).padStart(10)} t+${String(s.t).padStart(6)} f${f} units ${String(q.units).padStart(2)} routing ${q.routing}`
          + `  own-side pairs<145m ${String(q.own).padStart(3)}  cross-side ${String(q.cross).padStart(3)}`
          + `  routers seen: friendly ${String(q.ownRouting).padStart(2)} enemy ${String(q.crossRouting).padStart(2)}`
          + `  nearest enemy unit mean ${q.nearestEnemyMean?.toFixed(1)} m`);
      }
    }
  } catch (e) {
    L.say(`seed ${seed}: THREW ${String(e).slice(0, 160)}`);
  } finally { if (browser) await browser.close(); }
}
L.say('');
for (const [mark, rows] of acc) {
  for (const f of [0, 1]) {
    const m = (g) => rows.reduce((a, r) => a + g(r[f]), 0) / rows.length;
    L.say(`${TAG} t+${mark} f${f}  n=${rows.length}  own-side pairs ${m((q) => q.own).toFixed(1)}  cross-side ${m((q) => q.cross).toFixed(1)}`
      + `  cross/own ${(m((q) => q.cross) / Math.max(1e-9, m((q) => q.own))).toFixed(2)}`
      + `  friendly routers seen ${m((q) => q.ownRouting).toFixed(1)}  enemy routers seen ${m((q) => q.crossRouting).toFixed(1)}`
      + `  nearest enemy ${m((q) => q.nearestEnemyMean ?? 0).toFixed(1)} m`);
  }
}
await dump(OUT, `envelope-${TAG}`, { tag: TAG, marks: MARKS, seeds: SEEDS, acc: [...acc], log: L.log });
