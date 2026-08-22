#!/usr/bin/env node
/**
 * Probe: the geometry of a contact line, by rank.
 *
 * `probe-melee.mjs --case=reach` answers "do they fight". This answers *why*, and it is
 * built to settle one specific argument: whether `Combat`'s acquisition radius
 * (`def.reach + ACQUIRE_PAD`) is large enough for the distances the formation code
 * actually produces.
 *
 * The load-bearing design choice is that it does **not** evaluate the rule. It records,
 * per rank, the distance from every living man to his nearest living enemy, and prints
 * the coverage that *any* candidate radius would have given. So one run of the unchanged
 * tree answers "what would reach + 0.86 have caught?" without building that arm — which
 * matters, because two runs of this project are not comparable (HANDOFF trap 6) and the
 * distances themselves are the thing under test.
 *
 * It also reports the two numbers Josh Kappler's PR #1 rests on: the centre-to-centre
 * distance across the contact seam, and the share of men standing inside a neighbour's
 * 0.84 m body.
 *
 * Usage:
 *   node tools/probe-meleegeom.mjs --port=5591 [--json=path] [--seconds=60]
 */

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { spawnVite } from './lib/devtree.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const PORT = Number(args.get('port') ?? 5591);
const JSON_OUT = args.get('json') ?? null;
const SECONDS = Number(args.get('seconds') ?? 60);
const LABEL = args.get('label') ?? '';

const waitForServer = async (url, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || r.status === 304) return true;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
const preexisting = await waitForServer(base, 1200);
if (!preexisting) {
  server = spawnVite(['--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 60000))) { console.error('vite did not start'); process.exit(1); }
}
// Which tree answered? See the same note in probe-melee.mjs — several vites run here.
let rev = 'unknown';
try {
  rev = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  const dirty = execSync('git status --porcelain -- src/', { cwd: ROOT }).toString().trim();
  if (dirty) rev += '+dirty';
} catch { /* not a checkout */ }
console.log(`[server] ${base} — ${preexisting ? 'pre-existing' : 'started here'}, tree ${rev}`
  + (LABEL ? ` — ${LABEL}` : ''));

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const ONLY = args.get('pairs') ?? '';
const PAIRS = [
  { id: 'legio-vs-warband', a: 'legio-cohort', b: 'juthungi-warband', fa: 'line', fb: 'horde' },
  { id: 'legio-vs-chosen', a: 'legio-cohort', b: 'juthungi-chosen', fa: 'line', fb: 'line' },
  // The control: both sides carry spears, so the acquisition radius already spans the
  // rank interval. Anything that moves this pair is not a short-weapon fix.
  { id: 'urban-vs-spears', a: 'urban-cohort', b: 'juthungi-spears', fa: 'line', fb: 'line' },
].filter((s) => !ONLY || ONLY.split(',').includes(s.id));

const HELPERS = `
window.__pg = (() => {
  const g = window.__game;
  const b = g.battle;
  const ctx = g.engine.context;
  const p = b.pool;
  const DEAD = 11, DYING = 10, FIGHTING = 4;
  const alive = (i) => p.state[i] !== DEAD && p.state[i] !== DYING;
  const shielded = { n: 0, where: new Set() };
  const shieldRender = () => {
    for (const s of (g.engine.systems || g.engine.subsystems || [])) {
      for (const hook of ['update', 'preRender', 'resize']) {
        const fn = s[hook];
        if (typeof fn !== 'function') continue;
        const bound = fn.bind(s);
        s[hook] = (...a) => {
          try { return bound(...a); }
          catch (e) { shielded.n++; shielded.where.add(s.name + '.' + hook + ': ' + e.message); }
        };
      }
    }
  };
  const teardown = async () => {
    for (const u of b.units) {
      if (u.destroyed) continue;
      for (const i of u.members) if (alive(i)) p.setState(i, DEAD);
      u.alive = 0;
      u.destroyed = true;
    }
    const shared = await import('/src/sim/combatShared.ts');
    shared.resetCombatShared();
    const mor = ctx.tryGet('morale');
    if (mor && mor.redeploy) mor.redeploy();
    for (const name of ['tactical-ai', 'general-ai', 'battleFlow', 'projectiles']) {
      const s = ctx.tryGet(name);
      if (s && s.fixedUpdate) s.fixedUpdate = () => {};
    }
    shieldRender();
  };
  const meterDamage = () => {
    const m = { blows: 0, kills: 0 };
    const orig = b.damage.bind(b);
    b.damage = (i, amount, fx, fz, aid) => {
      const lethal = orig(i, amount, fx, fz, aid);
      m.blows++; if (lethal) m.kills++;
      return lethal;
    };
    m.restore = () => { b.damage = orig; };
    return m;
  };
  const q = (sorted, f) => sorted.length
    ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] * 1000) / 1000
    : -1;
  return { g, b, ctx, p, DEAD, DYING, FIGHTING, alive, teardown, meterDamage, q,
           shieldReport: () => ({ n: shielded.n, where: [...shielded.where].slice(0, 3) }) };
})();
`;

const runPair = async (page, spec, seconds) => page.evaluate(async ([spec, seconds]) => {
  const P = window.__pg;
  const { b, ctx, p } = P;
  await P.teardown();
  b.unitSizeScale = 1;
  const idA = b.spawnUnit(spec.a, 0, 2.5, Math.PI, spec.fa);
  const idB = b.spawnUnit(spec.b, 0, -2.5, 0, spec.fb);
  const A = b.unitById(idA), B = b.unitById(idB);
  if (!A || !B) return { pair: spec.id, error: 'spawn failed' };
  if (A.alive < 100 || B.alive < 100) {
    return { pair: spec.id, error: `pool exhausted A=${A.alive} B=${B.alive}` };
  }
  const defA = b.typeOf(A), defB = b.typeOf(B);
  ctx.events.emit('orderIssued', { unitIds: [A.id], kind: 'halt' });
  ctx.events.emit('orderIssued', { unitIds: [B.id], kind: 'halt' });

  // Settle: run to contact plus two seconds, then take the geometry snapshot.
  let contactT = -1;
  for (let t = 0; t < 40 && contactT < 0; t++) {
    P.g.advance(1);
    if (A.contactLock || B.contactLock) contactT = t;
  }
  P.g.advance(2);

  /** Nearest living enemy distance, and rank, for every living man of `ua`. */
  const snapshot = (ua, ub) => {
    const rows = [];
    for (const i of ua.members) {
      if (!P.alive(i)) continue;
      let best = Infinity;
      for (const j of ub.members) {
        if (!P.alive(j)) continue;
        if (Math.abs(p.y[j] - p.y[i]) > 1.9) continue;
        const dx = p.x[j] - p.x[i], dz = p.z[j] - p.z[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < best) best = d2;
      }
      rows.push({ rank: p.rank[i], d: best < Infinity ? Math.sqrt(best) : 999 });
    }
    return rows;
  };

  /** Share of living men standing inside another living man's 0.84 m body, either side. */
  const overlapShare = () => {
    const all = [];
    for (const u of [A, B]) for (const i of u.members) if (P.alive(i)) all.push(i);
    let inside = 0;
    let worst = 0;
    for (const i of all) {
      let over = 0;
      for (const j of all) {
        if (j === i) continue;
        const dx = p.x[j] - p.x[i], dz = p.z[j] - p.z[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < 0.84 * 0.84) { over = Math.max(over, 0.84 - Math.sqrt(d2)); }
      }
      if (over > 0.005) inside++;
      if (over > worst) worst = over;
    }
    return {
      n: all.length,
      insideShare: Math.round(inside / Math.max(1, all.length) * 1000) / 1000,
      worstOverlap: Math.round(worst * 1000) / 1000,
    };
  };

  const geomA = snapshot(A, B);
  const geomB = snapshot(B, A);
  const overlap = overlapShare();
  const frontGap = Math.round(Math.min(999, b.frontGapOf(A.id)) * 1000) / 1000;
  const anchorSep = Math.round(Math.hypot(A.x - B.x, A.z - B.z) * 1000) / 1000;

  // Meter the fight. Per-rank engagement is sampled every second so a dead front rank
  // being backfilled shows up as the second rank taking over rather than as an average.
  const meter = P.meterDamage();
  const t0 = P.g.simTime();
  const a0 = A.alive, b0 = B.alive;
  const rankFight = new Float64Array(8);
  const rankAlive = new Float64Array(8);
  let samples = 0;
  for (let t = 0; t < seconds; t++) {
    P.g.advance(1);
    for (const i of A.members) {
      if (!P.alive(i)) continue;
      const r = Math.min(7, p.rank[i]);
      rankAlive[r]++;
      if (p.target[i] >= 0) rankFight[r]++;
    }
    samples++;
    if (A.alive === 0 || B.alive === 0 || A.order === 5 || B.order === 5) break;
  }
  const elapsed = P.g.simTime() - t0;
  const blows = meter.blows, kills = meter.kills;
  meter.restore();

  const byRank = [];
  for (let r = 0; r < 6; r++) {
    const rows = geomA.filter((x) => x.rank === r).map((x) => x.d).sort((x, y) => x - y);
    byRank.push({
      rank: r,
      men: rows.length,
      minD: P.q(rows, 0), p25: P.q(rows, 0.25), medD: P.q(rows, 0.5), p75: P.q(rows, 0.75),
      // Mean number of this rank's men holding a target, over the metered window.
      engaged: Math.round(rankFight[r] / Math.max(1, samples) * 10) / 10,
      aliveMean: Math.round(rankAlive[r] / Math.max(1, samples) * 10) / 10,
      dists: rows.map((d) => Math.round(d * 1000) / 1000),
    });
  }

  // `Combat`'s own frontage ceiling, restated here so the report can say whether the men
  // fighting are limited by the design rule or by geometry getting in first.
  const capOf = (u, def) => Math.max(6, Math.round(
    Math.min(u.width, u.alive) * (def.reach >= 2.2 ? 1.8 : 1.2)));

  return {
    pair: spec.id, contactT,
    engageCapA: capOf(A, defA), engageCapB: capOf(B, defB),
    engagedA: Math.round(rankFight.reduce((s, x) => s + x, 0) / Math.max(1, samples) * 10) / 10,
    reachA: defA.reach, reachB: defB.reach,
    widthA: A.width, spacingZA: Math.round(A.spacingZ * 1000) / 1000,
    frontGap, anchorSep, overlap,
    seconds: Math.round(elapsed * 10) / 10,
    blowsPerSec: Math.round(blows / elapsed * 100) / 100,
    killsPerMin: Math.round((a0 - A.alive + b0 - B.alive) / elapsed * 60 * 10) / 10,
    lostA: a0 - A.alive, lostB: b0 - B.alive, initA: a0, initB: b0,
    byRank,
    allDistsB: geomB.map((x) => Math.round(x.d * 1000) / 1000).sort((x, y) => x - y),
    shield: P.shieldReport(),
  };
}, [spec, seconds]);

const results = [];
for (const spec of PAIRS) {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.setDefaultTimeout(240000);
  await page.goto(`${base}/?harness=1&quality=high&autoplay=1&w=480&h=270`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.ready === true, undefined, { timeout: 240000 });
  await page.evaluate((src) => { new Function(src)(); }, HELPERS);
  const r = await runPair(page, spec, SECONDS);
  r.pageErrors = errors.slice(0, 3);
  results.push(r);
  await page.close();

  if (r.error) { console.log(`\n${r.pair}: ERROR ${r.error}`); continue; }
  console.log(`\n=== ${r.pair} — reach A ${r.reachA} m, B ${r.reachB} m, `
    + `front-to-front ${r.frontGap} m, rank interval ${r.spacingZA} m ===`);
  console.log(`  blows/s ${r.blowsPerSec}   kills/min ${r.killsPerMin}   `
    + `lost ${r.lostA}/${r.initA} vs ${r.lostB}/${r.initB} over ${r.seconds}s`);
  console.log(`  A engaged ${r.engagedA} of an ENGAGE_PER_WIDTH cap of ${r.engageCapA}`);
  console.log(`  inside a 0.84 m body: ${(r.overlap.insideShare * 100).toFixed(1)}% of `
    + `${r.overlap.n} men, worst overlap ${r.overlap.worstOverlap} m`);
  console.log('  rank | men | nearest enemy  min /  p25 /  med /  p75 | engaged (mean)');
  for (const q of r.byRank) {
    if (!q.men) continue;
    console.log(`   ${q.rank}   | ${String(q.men).padStart(3)} |`
      + `               ${q.minD.toFixed(2)} / ${q.p25.toFixed(2)} / `
      + `${q.medD.toFixed(2)} / ${q.p75.toFixed(2)} | ${q.engaged}`);
  }
  // What any candidate acquisition pad would have covered, from the same snapshot.
  console.log('  coverage of rank 0 / rank 1 / rank 2 at reach + pad:');
  for (const pad of [0.25, 0.5, 0.7, 0.86, 1.0, 1.2]) {
    const R = r.reachA + pad;
    const cov = (rank) => {
      const q = r.byRank[rank];
      if (!q || !q.men) return '  - ';
      const n = q.dists.filter((d) => d <= R).length;
      return `${String(Math.round(n / q.men * 100)).padStart(3)}%`;
    };
    console.log(`    +${pad.toFixed(2)} (R=${R.toFixed(2)} m): ${cov(0)} / ${cov(1)} / ${cov(2)}`);
  }
  if (r.shield.n) console.log(`  [render faults shielded: ${r.shield.n}]`, r.shield.where);
  if (r.pageErrors.length) console.log('  [page errors]', r.pageErrors);
}

await browser.close();
if (server) server.kill();
if (JSON_OUT) {
  await writeFile(JSON_OUT, JSON.stringify({ rev, label: LABEL, results }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
