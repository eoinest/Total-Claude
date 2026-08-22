/**
 * WHICH MORALE TERM MOVED — read off the product's own published breakdown.
 *
 * Descriptive only, and deliberately not a second judge: it reports no verdict, no outcome and
 * no p-value, so it cannot contradict `tools/judge`. It exists because the field battle's
 * verdict is `rout`, `BattleFlow` reads that off men in units that are not routing, and
 * `MoraleSystem` already publishes the per-unit pressure breakdown the UI draws
 * (`moraleTerms`, laid out by `TERM_NAMES`). So the question "which pressure changed" does not
 * need a model of the morale system — it needs the morale system asked.
 *
 * `ground` is the term to watch. `Morale.ts` l.422-428:
 *
 *     const dh = b.groundAt(u.x, u.z) - b.groundAt(enemy.x, enemy.z);
 *     tGround = -clamp(dh / 8, -1, 1) * 2;
 *
 * — terrain height difference against your melee opponent, worth up to +/-2 pressure a second,
 * and `battleCoreMask` damps exactly the relief that produces it.
 *
 *   node tools/scratch/fv-terms.mjs --port=5963 --seed=4265438264 --tag=mainsrc
 */
import { argsOf, boot, ledger, dump, ff, ROOT } from '../judge/jg-lib.mjs';
import path from 'node:path';

const A = argsOf();
const PORT = Number(A.get('port') ?? 5971);
const SEED = Number(A.get('seed') ?? 4265438264);
const TAG = A.get('tag') ?? 'run';
const MARKS = (A.get('marks') ?? '80,100,120,140,160,180,200,240').split(',').map(Number);
const OUT = path.join(ROOT, 'screenshots/judge/terms');
const L = ledger(`terms ${TAG} seed ${SEED}`);

const { browser, page } = await boot({
  port: PORT, map: 'campus-martius', scenario: 'field', tier: 'ultra',
  out: OUT, label: `terms-${TAG}`, seed: SEED, query: 'autoplay=1&deploy=0',
});
const snaps = [];
try {
  // The read API is optional on the seam, so prove it is there before believing a table of zeros.
  const has = await page.evaluate(() => {
    const m = window.__game.engine.context.tryGet('morale');
    return !!(m && typeof m.moraleTerms === 'function');
  });
  L.ck('the morale system publishes its own term breakdown', has, true, has);
  if (!has) throw new Error('no moraleTerms on the morale subsystem — this probe cannot run');

  let t = 0;
  for (const mark of MARKS) {
    await ff(page, mark - t); t = mark;
    const s = await page.evaluate(() => {
      const g = window.__game, b = g.battle;
      const m = g.engine.context.tryGet('morale');
      const rows = [];
      for (const u of b.units) {
        if (u.destroyed) continue;
        rows.push({
          id: u.id, f: u.faction, alive: u.alive, morale: u.morale, max: u.maxMorale,
          routing: u.order === 9 || u.routTimer > 0,
          x: u.x, z: u.z, y: b.groundAt(u.x, u.z),
          terms: m.moraleTerms(u.id),
        });
      }
      return { t: Math.round(g.simTime() * 100) / 100, rows };
    });
    snaps.push(s);
    // Aggregate per faction, men-weighted, over units not already broken.
    const keys = Object.keys(s.rows[0]?.terms ?? {});
    for (const f of [0, 1]) {
      const rs = s.rows.filter((r) => r.f === f && !r.routing);
      if (!rs.length) { L.say(`t+${s.t} f${f}: nothing in order`); continue; }
      const men = rs.reduce((a, r) => a + r.alive, 0);
      const w = (k) => rs.reduce((a, r) => a + (r.terms[k] ?? 0) * r.alive, 0) / Math.max(1, men);
      const mor = rs.reduce((a, r) => a + r.morale * r.alive, 0) / Math.max(1, men);
      const gs = rs.map((r) => r.terms.ground ?? 0).filter((v) => v !== 0);
      const spread = gs.length ? `${Math.min(...gs).toFixed(2)}..${Math.max(...gs).toFixed(2)} over ${gs.length}u` : 'none in melee';
      L.say(`t+${String(s.t).padStart(6)} f${f} units ${String(rs.length).padStart(2)} men ${String(men).padStart(4)} morale ${mor.toFixed(1)}  `
        + keys.map((k) => `${k[0]}${k[1]}${w(k) >= 0 ? '+' : ''}${w(k).toFixed(2)}`).join(' ')
        + `  | ground per-unit ${spread}`);
    }
  }
  await dump(OUT, `terms-${TAG}-${SEED}`, { tag: TAG, seed: SEED, marks: MARKS, snaps, log: L.log });
} finally { await browser.close(); L.summary(); }
