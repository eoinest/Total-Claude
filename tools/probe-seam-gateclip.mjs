#!/usr/bin/env node
/**
 * Probe: does `Siege`'s gatehouse clip actually fire, and what does it cost when it does not.
 *
 * The seam under test is `CityView.getGateBlock?()` in `src/sim/Siege.ts`, which declares
 * `{ x, z, hw, hd, rot, topY }`, against `CitySystem.getGateBlock()`, which returns a
 * `GateBlockOut` whose plan fields are `nx, nz, dx, dz, halfRun, halfDepth`. Neither side
 * imports the other's type, so the disagreement is invisible to `tsc` and `insideBlock`
 * reads `undefined` for all three of the fields it compares.
 *
 * Everything here is measured through the page, off the real `CitySystem` instance and the
 * real `Siege` spine. Nothing re-derives geometry the code under test computed: the
 * footprint test is run against the *published record's own* field names, so a probe that
 * agreed with the bug could not pass.
 *
 * Usage: node tools/probe-seam-gateclip.mjs [--port=5381] [--map=campus-martius]
 *                                           [--seconds=240] [--json=path] [--tag=before]
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const PORT = Number(args.get('port') ?? 5381);
const MAP = args.get('map') ?? 'campus-martius';
const SECONDS = Number(args.get('seconds') ?? 240);
const JSON_OUT = args.get('json') ?? null;
const TAG = args.get('tag') ?? 'run';

const BASE_CONFIG = {
  unitSize: 'ultra',
  rome: {
    'legio-cohort': 6, 'praetorian-cohort': 2, 'urban-cohort': 2,
    sagittarii: 2, equites: 3, scorpio: 1,
  },
  juthungi: {
    'juthungi-warband': 6, 'juthungi-spears': 3, 'juthungi-skirmishers': 3,
    'juthungi-chosen': 2, 'juthungi-berserkers': 2, 'juthungi-riders': 3,
  },
  quality: 'ultra',
  difficulty: 'hard',
  seed: 4265438264,
  scenario: 'assault',
  map: MAP,
};

const encodeConfig = (c) => Buffer.from(JSON.stringify(c)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const waitForServer = async (base, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(base, { signal: AbortSignal.timeout(1000) }); if (r.ok) return true; }
    catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1200))) {
  console.log(`• starting vite on ${PORT}`);
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 120000))) { console.error('vite did not start'); process.exit(1); }
} else {
  console.log(`• reusing dev server on ${PORT}`);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const log = [];
page.on('console', (m) => log.push(m.text()));
page.on('pageerror', (e) => log.push(`PAGEERROR ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) log.push(`HTTP ${r.status()} ${r.url()}`); });

const url = `${base}/?harness=1&quality=ultra&w=1280&h=720&battle=${encodeConfig(BASE_CONFIG)}`;
console.log(`• loading ${MAP} (assault)`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
try {
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 300000 });
} catch (err) {
  console.error(`!! never ready: ${err.message}`);
  for (const l of log.slice(-60)) console.error('  ' + l.slice(0, 300));
  await browser.close(); if (server) server.kill('SIGTERM'); process.exit(1);
}

/** Static geometry: the seam, the footprint, and which stations stand inside it. */
const STATIC = () => {
  const g = window.__game;
  const ctx = g.engine.context;
  const city = ctx.tryGet('city');
  const siege = g.battle.siege;
  const out = { ok: true };

  // --- the seam itself, read exactly as the consumer's declared type says to -------------
  const gb = city && city.getGateBlock ? city.getGateBlock() : null;
  out.gateBlockPresent = !!gb;
  if (!gb) return out;
  out.gateBlockKeys = Object.keys(gb).sort();
  // What `Siege.CityView.getGateBlock` says is there.
  out.declaredByConsumer = ['x', 'z', 'hw', 'hd', 'rot', 'topY'];
  out.declaredResolved = {};
  for (const k of out.declaredByConsumer) {
    const v = gb[k];
    out.declaredResolved[k] = v === undefined ? 'UNDEFINED' : v;
  }
  out.declaredMissing = out.declaredByConsumer.filter((k) => gb[k] === undefined);
  out.actual = {
    x: gb.x, z: gb.z, nx: gb.nx, nz: gb.nz, dx: gb.dx, dz: gb.dz,
    halfRun: gb.halfRun, halfDepth: gb.halfDepth, topY: gb.topY, sillY: gb.sillY,
  };

  // --- what the shipped `insideBlock` computes, replicated verbatim ----------------------
  const shippedInside = (b, x, z) => {
    const dx = x - b.x, dz = z - b.z;
    const c = Math.cos(-b.rot), s = Math.sin(-b.rot);
    return Math.abs(dx * c - dz * s) <= b.hw && Math.abs(dx * s + dz * c) <= b.hd;
  };
  // --- the truth, using the record's own published field names ---------------------------
  const trueInside = (b, x, z) => {
    const ex = x - b.x, ez = z - b.z;
    const along = ex * b.dx + ez * b.dz;
    const across = ex * b.nx + ez * b.nz;
    return Math.abs(along) <= b.halfRun && Math.abs(across) <= b.halfDepth;
  };

  // --- the spine ------------------------------------------------------------------------
  const n = siege.nStations;
  out.nStations = n;
  const bays = city.getGarrisonBays();
  const byBay = new Map();
  let insideTrue = 0, insideShipped = 0;
  const xsIn = [];
  const dropSamples = [];
  for (let i = 0; i < n; i++) {
    const x = siege.sx[i], z = siege.sz[i], y = siege.sy[i], b = siege.sBay[i];
    if (!byBay.has(b)) byBay.set(b, { bay: b, count: 0, inside: 0, minX: Infinity, maxX: -Infinity });
    const r = byBay.get(b);
    r.count++;
    if (trueInside(gb, x, z)) {
      r.inside++; insideTrue++;
      if (x < r.minX) r.minX = x;
      if (x > r.maxX) r.maxX = x;
      xsIn.push(x);
      if (dropSamples.length < 400) {
        dropSamples.push({
          bay: b, x: +x.toFixed(3), z: +z.toFixed(3), walkY: +y.toFixed(3),
          crownTopY: +gb.topY.toFixed(3), crownSillY: +gb.sillY.toFixed(3),
          belowTopY: +(gb.topY - y).toFixed(3), belowSillY: +(gb.sillY - y).toFixed(3),
          masonryTopAt: city.masonryTopAt ? +city.masonryTopAt(x, z).toFixed(3) : null,
        });
      }
    }
    if (shippedInside(gb, x, z)) insideShipped++;
  }
  out.stationsInsideFootprint = insideTrue;
  out.stationsShippedClipWouldCatch = insideShipped;
  out.byBay = [...byBay.values()].map((r) => ({
    ...r, minX: r.inside ? +r.minX.toFixed(2) : null, maxX: r.inside ? +r.maxX.toFixed(2) : null,
  })).filter((r) => r.inside > 0 || r.count > 0);
  out.gateBays = out.byBay.filter((r) => r.inside > 0);
  out.insideXRange = xsIn.length ? [+Math.min(...xsIn).toFixed(2), +Math.max(...xsIn).toFixed(2)] : null;
  out.dropSamples = dropSamples.slice(0, 6);
  out.meanBelowCrownSillM = dropSamples.length
    ? +(dropSamples.reduce((s, d) => s + d.belowSillY, 0) / dropSamples.length).toFixed(3) : null;
  out.meanBelowCrownTopM = dropSamples.length
    ? +(dropSamples.reduce((s, d) => s + d.belowTopY, 0) / dropSamples.length).toFixed(3) : null;
  // Which bays are garrisonable and how long their runs are, for the "36 stations" figure.
  out.bayCount = bays.length;
  const gateBayIdx = out.gateBays.map((r) => r.bay);
  out.gateBayDetail = gateBayIdx.map((bi) => {
    const b = bays.find((q) => q.index === bi);
    return b ? {
      index: b.index, length: +b.length.toFixed(2), towerHalf: +b.towerHalf.toFixed(2),
      walkY: +b.walkY.toFixed(3), garrisonable: b.garrisonable, isGate: b.isGate,
      x0: +b.x0.toFixed(2), x1: +b.x1.toFixed(2),
    } : null;
  });
  return out;
};

const statics = await page.evaluate(STATIC);
console.log('\n--- static ---');
console.log(JSON.stringify(statics, null, 2).slice(0, 4000));

// --- the census over `SECONDS` of assault ------------------------------------------------
/**
 * Attribute every garrison shot to the ground its shooter stood on.
 *
 * `debugWallShots` pools the whole circuit, so it cannot say how many of the launches came
 * off the 22 stations inside the gatehouse. This wraps `launch` from the page — it reads
 * only, calls no RNG and takes no branch, so the run is the same run — and counts a launch
 * as "in the footprint" when the shooter's own pool position is inside the *published*
 * `GateBlockOut` box. A wall launch is detected by `Siege.wallShots` moving, which is the
 * same predicate the census itself uses, so the two totals are directly comparable.
 */
await page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context;
  const pr = ctx.tryGet('projectiles');
  const city = ctx.tryGet('city');
  const b = g.battle;
  const pool = b.pool;
  const gb = city.getGateBlock();
  const inFoot = (x, z) => {
    const ex = x - gb.x, ez = z - gb.z;
    return Math.abs(ex * gb.dx + ez * gb.dz) <= gb.halfRun
      && Math.abs(ex * gb.nx + ez * gb.nz) <= gb.halfDepth;
  };
  const proto = Object.getPrototypeOf(pr);
  const orig = proto.launch;
  const tally = { wall: 0, wallInFootprint: 0, ground: 0 };
  window.__seamTally = tally;
  proto.launch = function patched(i, u, m, target, power) {
    const w0 = b.siege.wallShots;
    const r = orig.call(this, i, u, m, target, power);
    if (b.siege.wallShots > w0) {
      tally.wall++;
      if (inFoot(pool.x[i], pool.z[i])) tally.wallInFootprint++;
    } else tally.ground++;
    return r;
  };
  pr.debugResetCensus?.();
});
console.log(`\n• advancing ${SECONDS} s…`);
await page.evaluate(async (target) => {
  const g = window.__game;
  const end = g.simTime() + target;
  while (g.simTime() < end - 1e-6) g.advance(Math.min(0.25, end - g.simTime()));
}, SECONDS);

const census = await page.evaluate(() => {
  const g = window.__game;
  const ctx = g.engine.context;
  const pr = ctx.tryGet('projectiles');
  const city = ctx.tryGet('city');
  const siege = g.battle.siege;
  const b = g.battle;
  const pool = b.pool;
  const gb = city.getGateBlock();
  const inFoot = (x, z) => {
    const ex = x - gb.x, ez = z - gb.z;
    return Math.abs(ex * gb.dx + ez * gb.dz) <= gb.halfRun
      && Math.abs(ex * gb.nx + ez * gb.nz) <= gb.halfDepth;
  };
  // Who is standing where at the end of the interval.
  let elevated = 0, elevatedInFoot = 0, owned = 0;
  for (let i = 0; i < pool.capacity; i++) {
    if (!pool.aliveAt(i)) continue;
    if (b.elevated[i] !== 0) {
      elevated++;
      if (inFoot(pool.x[i], pool.z[i])) elevatedInFoot++;
    }
  }
  for (let s = 0; s < siege.nStations; s++) if (siege.sOwner[s] >= 0) owned++;
  return {
    simTime: +g.simTime().toFixed(2),
    wallShots: siege.wallShots,
    wallKills: siege.wallKills,
    nStations: siege.nStations,
    nRuns: siege.nRuns,
    stationsOwned: owned,
    menElevated: elevated,
    menElevatedInFootprint: elevatedInFoot,
    tally: window.__seamTally,
    wall: pr?.debugWallShots?.() ?? null,
  };
});
console.log('\n--- census ---');
console.log(JSON.stringify(census.wall?.total ?? {}, null, 2));
console.log('skips', JSON.stringify(census.wall?.skips ?? {}));
console.log('siege.wallShots', census.wallShots, 'siege.wallKills', census.wallKills);
console.log('attribution', JSON.stringify(census.tally));
console.log('stations', census.nStations, 'runs', census.nRuns, 'owned', census.stationsOwned,
  'menElevated', census.menElevated, 'inFootprint', census.menElevatedInFootprint);

const errors = log.filter((l) => l.startsWith('PAGEERROR') || l.startsWith('HTTP'));
console.log(`\npageerrors/http: ${errors.length}`);
for (const e of errors.slice(0, 20)) console.log('  ' + e.slice(0, 300));

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT),
    JSON.stringify({ tag: TAG, map: MAP, seconds: SECONDS, statics, census, errors }, null, 2));
  console.log(`wrote ${JSON_OUT}`);
}

await browser.close();
if (server) server.kill('SIGTERM');
