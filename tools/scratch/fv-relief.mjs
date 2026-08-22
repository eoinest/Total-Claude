/**
 * THE GROUND UNDER THE BATTLE, read out of the running product — descriptive only.
 *
 * Not a second judge. It reports no verdict, no outcome and no p-value; the outcome mix is the
 * judge's rig's business and this cannot disagree with it. It exists to answer one mechanism
 * question the shape rig has no column for:
 *
 *   `BattleSystem.SAME_LEVEL_DY` is 1.9 m. Target selection (`BattleSystem` l.1554) drops any
 *   enemy unit whose `unitY` differs by more than that, and the two per-soldier melee probes
 *   (l.2911, l.3096) drop any blow across more than that. So terrain relief is not cosmetic in
 *   this simulation: it decides who can hit whom.
 *
 *   `battleCoreMask` damps three octaves of relief inside the fighting corridor -- 2.6 m at
 *   1/540 by 0.45, 0.95 m at 1/150 by 0.72, 0.34 m at 1/46 by 0.82 -- and `0060874` moved that
 *   corridor from (0, -30, 540, 360) to (205, -30, 745, 360).
 *
 * So: boot the field battle, let it form up, and read every living man's world position out of
 * the pool. Report the relief the men are actually standing on, and how many opposing pairs
 * inside melee reach are separated by more than `SAME_LEVEL_DY`.
 *
 *   node tools/scratch/fv-relief.mjs --port=5971 --seed=4265438264 --tag=mainsrc
 */
import { argsOf, boot, ledger, dump, ff, ROOT } from '../judge/jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const PORT = Number(A.get('port') ?? 5971);
const SEED = Number(A.get('seed') ?? 4265438264);
const TAG = A.get('tag') ?? 'run';
const AT = Number(A.get('at') ?? 100);
const OUT = path.join(ROOT, 'screenshots/judge/relief');
const L = ledger(`relief ${TAG} seed ${SEED} at t+${AT}`);

const { browser, page } = await boot({
  port: PORT, map: 'campus-martius', scenario: 'field', tier: 'ultra',
  out: OUT, label: `relief-${TAG}`, seed: SEED, query: 'autoplay=1&deploy=0',
});
try {
  await ff(page, AT);
  const r = await page.evaluate(() => {
    const g = window.__game, b = g.battle, p = b.pool;
    const men = [];
    for (let i = 0; i < p.count; i++) {
      if (!p.aliveAt(i)) continue;
      if (b.elevated && b.elevated[i] !== 0) continue;
      men.push({ f: p.faction[i], x: p.x[i], y: p.y[i], z: p.z[i] });
    }
    // Relief: spread of y, and the local gradient over a 20 m grid of occupied cells.
    const ys = men.map((m) => m.y);
    const cell = new Map();
    for (const m of men) {
      const k = `${Math.round(m.x / 20)},${Math.round(m.z / 20)}`;
      const c = cell.get(k) ?? { n: 0, sy: 0, lo: 1e9, hi: -1e9 };
      c.n++; c.sy += m.y; c.lo = Math.min(c.lo, m.y); c.hi = Math.max(c.hi, m.y);
      cell.set(k, c);
    }
    // Opposing pairs within melee reach, and how many are separated by more than 1.9 m of y.
    // Bucketed on a 4 m grid so this is O(n) rather than O(n^2) over ~8,000 men.
    const REACH = 4.0, DY = 1.9;
    const grid = new Map();
    for (const m of men) {
      const k = `${Math.floor(m.x / REACH)},${Math.floor(m.z / REACH)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)).push(m);
    }
    let pairs = 0, blocked = 0, maxdy = 0;
    for (const m of men) {
      if (m.f !== 0) continue;                       // count each pair once, from Rome's side
      const gx = Math.floor(m.x / REACH), gz = Math.floor(m.z / REACH);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const o = grid.get(`${gx + dx},${gz + dz}`);
        if (!o) continue;
        for (const q of o) {
          if (q.f === 0) continue;
          const d2 = (q.x - m.x) ** 2 + (q.z - m.z) ** 2;
          if (d2 > REACH * REACH) continue;
          pairs++;
          const dy = Math.abs(q.y - m.y);
          if (dy > maxdy) maxdy = dy;
          if (dy > DY) blocked++;
        }
      }
    }
    const cells = [...cell.values()].filter((c) => c.n >= 4);
    const within = cells.map((c) => c.hi - c.lo).sort((a, b2) => a - b2);
    const q = (v, f) => v.length ? v[Math.min(v.length - 1, Math.floor(v.length * f))] : null;
    return {
      men: men.length,
      byFaction: men.reduce((a, m) => (a[m.f] = (a[m.f] ?? 0) + 1, a), {}),
      yMin: Math.min(...ys), yMax: Math.max(...ys),
      xMin: Math.min(...men.map((m) => m.x)), xMax: Math.max(...men.map((m) => m.x)),
      occupiedCells: cells.length,
      reliefWithin20m: { median: q(within, 0.5), p90: q(within, 0.9), max: within[within.length - 1] },
      meleePairs: pairs, blockedByDy: blocked, maxPairDy: maxdy,
      // The macro shape a formation actually feels: y spread across the whole occupied area.
      ySpread: Math.max(...ys) - Math.min(...ys),
    };
  });
  L.say(`men ${r.men} ${JSON.stringify(r.byFaction)}  x ${r.xMin.toFixed(1)}..${r.xMax.toFixed(1)}`);
  L.say(`y ${r.yMin.toFixed(2)}..${r.yMax.toFixed(2)}  spread ${r.ySpread.toFixed(2)} m over ${r.occupiedCells} occupied 20 m cells`);
  L.say(`relief inside one 20 m cell: median ${r.reliefWithin20m.median?.toFixed(3)} m  p90 ${r.reliefWithin20m.p90?.toFixed(3)} m  max ${r.reliefWithin20m.max?.toFixed(3)} m`);
  L.say(`opposing men within 4 m: ${r.meleePairs} pairs; ${r.blockedByDy} of them are more than SAME_LEVEL_DY (1.9 m) apart in y; worst pair dy ${r.maxPairDy.toFixed(3)} m`);
  await dump(OUT, `relief-${TAG}-${SEED}-t${AT}`, { tag: TAG, seed: SEED, at: AT, ...r, log: L.log });
} finally { await browser.close(); }
