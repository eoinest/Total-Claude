#!/usr/bin/env node
/**
 * `r3-density` — how tightly men actually stand, measured in the running battle.
 *
 * Round three's work list carries a fifth item that is **not** in this pass's scope and is
 * explicitly to be judged before anyone touches it:
 *
 *   > "Formations pack far tighter than Rome II's, so melees read as a mass rather than
 *   > individual actions. Judge whether that is a spacing constant or a real animation-variety
 *   > problem before touching it — it may not be yours."
 *
 * `src/sim/` is another agent's. So this measures and hands back rather than changing
 * anything, and it measures the three things that would tell the three hypotheses apart:
 *
 *   1. **Nearest-neighbour distance**, over living men, in metres — the dressed spacing as it
 *      actually comes out of separation and pathing, which is not the same number as
 *      `BASE_SPACING_X` and is the only version of it a camera sees.
 *   2. The same, restricted to men **in contact**, because a melee is where the complaint is
 *      and because `PRESS_RANKS` deliberately compresses ranks into a fight.
 *   3. **Animation phase and clip spread** across those same men. If a melee reads as a mass
 *      because two hundred men are playing one clip at one phase, that is a different bug in
 *      a different file from a spacing constant, and the fix for one is not the fix for the
 *      other.
 *
 * Usage:
 *   node tools/scratch/r3-density.mjs --port=5231 --at=96
 *   node tools/scratch/r3-density.mjs --port=5231 --map=carthage --at=110
 */

import { chromium } from 'playwright';
import process from 'node:process';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5231);
const AT = Number(args.get('at') ?? 96);
const MAP = args.get('map') ?? null;
const BASE = `http://127.0.0.1:${PORT}`;

const alive = await fetch(`${BASE}/`).then((r) => r.ok).catch(() => false);
if (!alive) { console.error(`No dev server on ${PORT}.`); process.exit(2); }

const cfg = { timeOfDay: 12.0 };
if (MAP) { cfg.map = MAP; cfg.opponent = 2; }
const token = Buffer.from(JSON.stringify(cfg)).toString('base64url');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto(`${BASE}/?harness=1&quality=high&w=1280&h=720&battle=${token}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 420000 });
// `advance` runs the sim without waiting on real time, which is what `shoot.mjs` does for
// its own `at:` field. Waiting on the clock instead would take as long as the battle.
await page.evaluate((t) => window.__game.advance(t), AT);

const out = await page.evaluate(() => {
  const g = window.__game;
  const p = g.battle.pool;
  const n = p.count;
  const live = [];
  for (let i = 0; i < n; i++) if (p.aliveAt(i)) live.push(i);
  // Nearest neighbour by a uniform grid, so this is O(n) rather than O(n^2) on 8,000 men.
  const CELL = 2.0;
  const grid = new Map();
  const kk = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  for (const i of live) {
    const k = kk(p.x[i], p.z[i]);
    let b = grid.get(k); if (!b) grid.set(k, b = []);
    b.push(i);
  }
  const nnAll = [], nnFight = [];
  const clips = new Map();
  const phases = [];
  for (const i of live) {
    const cx = Math.floor(p.x[i] / CELL), cz = Math.floor(p.z[i] / CELL);
    let best = 1e9;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = grid.get(`${cx + dx},${cz + dz}`);
        if (!b) continue;
        for (const j of b) {
          if (j === i) continue;
          const d = Math.hypot(p.x[i] - p.x[j], p.z[i] - p.z[j]);
          if (d < best) best = d;
        }
      }
    }
    if (best > 1e8) continue;
    nnAll.push(best);
    const fighting = p.target && p.target[i] >= 0;
    if (fighting) {
      nnFight.push(best);
      const c = p.animClip[i];
      clips.set(c, (clips.get(c) ?? 0) + 1);
      phases.push(p.animTime[i] % 1);
    }
  }
  const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * f)] : NaN; };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  // Phase spread: a synchronised cohort has all its phases in one bin.
  const bins = new Array(10).fill(0);
  for (const ph of phases) bins[Math.min(9, Math.floor(ph * 10))]++;
  const tot = phases.length || 1;
  let H = 0;
  for (const b of bins) { const pr = b / tot; if (pr > 0) H -= pr * Math.log2(pr); }
  return {
    time: g.simTime(), live: live.length, fighting: nnFight.length,
    nnAll: { mean: mean(nnAll), p10: q(nnAll, 0.10), p50: q(nnAll, 0.50), p90: q(nnAll, 0.90) },
    nnFight: { mean: mean(nnFight), p10: q(nnFight, 0.10), p50: q(nnFight, 0.50), p90: q(nnFight, 0.90) },
    clips: [...clips.entries()].sort((a, b) => b[1] - a[1]),
    phaseEntropy: H, phaseMax: Math.log2(10),
  };
}).catch((e) => ({ error: String(e) }));

if (out.error) { console.error(out.error); await browser.close(); process.exit(1); }
const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  n/a');
console.log(`\nr3-density — ${MAP ?? 'campus martius'} at t+${out.time.toFixed(0)}s, ${out.live} living, ${out.fighting} in contact\n`);
console.log('nearest neighbour, metres     mean    p10    p50    p90');
console.log(`  all living men             ${f(out.nnAll.mean)}  ${f(out.nnAll.p10)}  ${f(out.nnAll.p50)}  ${f(out.nnAll.p90)}`);
console.log(`  men in contact             ${f(out.nnFight.mean)}  ${f(out.nnFight.p10)}  ${f(out.nnFight.p50)}  ${f(out.nnFight.p90)}`);
console.log(`\nBASE_SPACING_X.foot is 0.86 m and SOLDIER_RADIUS*2 is 0.84, so a dressed rank`);
console.log(`cannot read below about 0.85; anything under that is the press, not the drill.`);
console.log(`\nmelee clip mix (clip id: men)  ${out.clips.map(([c, k]) => `${c}:${k}`).join('  ')}`);
console.log(`animation phase entropy       ${out.phaseEntropy.toFixed(3)} of ${out.phaseMax.toFixed(3)} bits`);
console.log('  (10 bins over the cycle; 3.32 is perfectly desynchronised, 0 is one drill squad)');
if (errors.length) console.log(`\npage errors:\n  ${errors.slice(0, 4).join('\n  ')}`);
await browser.close();
