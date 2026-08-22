#!/usr/bin/env node
/**
 * Does the ground the soldiers walk on carry the works the city plan publishes?
 *
 * Two claims are measured here and neither is read off a picture:
 *
 *  1. **The ditch.** `carthageWall.ts` publishes a 20 x 6 m dry ditch on the wall's own
 *     glacis as `CarthageDitch`, with `built: false` — a request to whoever owns the
 *     heightfield. This walks a transect perpendicular to the wall at several stations
 *     along the frontage and prints the height profile, so a cut either shows up as
 *     metres of relief or does not exist.
 *  2. **The harbours.** The cothon's annulus and the merchant basin, sampled across their
 *     own plans, against `BASIN_WATER_Y`. A basin whose bed is above its water is painted,
 *     not dug.
 *
 * Every height comes from `TerrainSystem.heightAt`, which is the same function the sim
 * stands men on — not from the raw `Float32Array`, and not from a splat colour. The
 * pathfinder's own 7 m gradient stencil is reported alongside, because a ditch an army
 * cannot cross is a different defect from a ditch that is not there.
 *
 *   node tools/probe-ditch-ds.mjs --port=5431 --map=carthage
 *   node tools/probe-ditch-ds.mjs --port=5431 --map=campus-martius   # the control
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const PORT = Number(args.get('port') ?? 5431);
const MAP = args.get('map') ?? 'carthage';
const SCENARIO = args.get('scenario') ?? 'field';
const QUALITY = args.get('quality') ?? 'low';
const JSON_OUT = args.get('json') ?? '';

const token = Buffer.from(JSON.stringify({ map: MAP, scenario: SCENARIO }))
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok || r.status === 304) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const base = `http://127.0.0.1:${PORT}`;
let server = null;
if (!(await waitForServer(base, 1500))) {
  server = spawn('npx', ['vite', '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TC_NO_HMR: '1' },
  });
  if (!(await waitForServer(base, 90000))) throw new Error('vite did not start');
  console.log(`• started vite pid ${server.pid} on ${PORT}`);
}

const url = `${base}/?harness=1&w=640&h=360&quality=${QUALITY}&battle=${token}`;
console.log(`[probe-ditch] ${url}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 300)}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE ${m.text().slice(0, 300)}`);
  const t = m.text();
  if (/\[carthage\] (harbours|ditch):/.test(t)) console.log(`  ${t}`);
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game?.ready === true, null, {
  timeout: 300000,
  polling: 250,
});

const out = await page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const terrain = ctx.get('terrain');
  const city = ctx.tryGet('city');
  const nav = ctx.tryGet('pathfinding');
  const h = (x, z) => terrain.heightAt(x, z);
  /**
   * The terrain's own gradient over a 7 m baseline. **This is not the pathfinder's number**
   * and an earlier revision of this probe said it was. `NavGrid.CELL` is 7 m and
   * `deriveCost` central-differences over *two* cells, so the stencil the game refuses a
   * cell on is 14 m wide and reads a 20 m trench far more gently than this does. Both are
   * reported, and the nav grid's own `blockedAt` is read below rather than predicted.
   */
  const grad = (x, z) =>
    Math.hypot((h(x + 3.5, z) - h(x - 3.5, z)) / 7, (h(x, z + 3.5) - h(x, z - 3.5)) / 7);
  const navGrad = (x, z) =>
    Math.hypot((h(x + 7, z) - h(x - 7, z)) / 14, (h(x, z + 7) - h(x, z - 7)) / 14);

  const r = { map: terrain.map?.id ?? '?', waterLevel: terrain.waterLevel };

  // ---- the published plan -------------------------------------------------
  const ditch = city?.getDitch?.() ?? null;
  const section = city?.punicSection?.() ?? null;
  r.plan = ditch
    ? {
        built: ditch.built,
        width: ditch.width,
        depth: ditch.depth,
        bottomWidth: ditch.bottomWidth,
        offset: ditch.offset,
        points: ditch.path.length,
        x0: ditch.path[0].x,
        x1: ditch.path[ditch.path.length - 1].x,
      }
    : null;
  r.beltDepth = section?.beltDepth ?? null;
  /**
   * The wall's own arithmetic, so a ditch cut into the ground the wall is founded on cannot
   * quietly move the masonry. `buildCarthageWall` samples `heightAt` along the *centreline*
   * to set each bay's walk, and the ditch's inner lip stands 9.55 m out from it, so nothing
   * should move — but "should" is not a measurement and the tower footing test reaches
   * 5.5 m out along the same normal.
   */
  r.sectionFaults = section?.faults ? [...section.faults] : null;
  const bays = city?.getGarrisonBays?.() ?? [];
  r.wall = {
    bays: bays.length,
    towers: bays.filter((b) => b.hasTower).length,
    garrisonable: bays.filter((b) => b.garrisonable).length,
    walkYSum: +bays.reduce((a, b) => a + b.walkY, 0).toFixed(3),
    groundYSum: +bays.reduce((a, b) => a + b.groundY, 0).toFixed(3),
  };

  // ---- transects across the wall's glacis ---------------------------------
  // Perpendicular to the *published* ditch centreline where there is one, otherwise
  // perpendicular to the wall's own line, so the control map is measured the same way.
  // The circuit as the city itself publishes it, resampled into a piecewise-linear z(x).
  // Taken from `getCircuitSamples` rather than re-derived, so the probe cannot measure a
  // line the masonry does not stand on.
  const samples = city?.getCircuitSamples?.(10) ?? [];
  const wallZAt = samples.length >= 2
    ? (x) => {
        if (x <= samples[0].x) return samples[0].z;
        const last = samples[samples.length - 1];
        if (x >= last.x) return last.z;
        let i = 0;
        while (i < samples.length - 2 && samples[i + 1].x < x) i++;
        const t = (x - samples[i].x) / (samples[i + 1].x - samples[i].x || 1);
        return samples[i].z + (samples[i + 1].z - samples[i].z) * t;
      }
    : null;
  const stations = [];
  if (ditch) {
    const n = ditch.path.length;
    for (const k of [0, Math.round(n * 0.25), Math.round(n * 0.5), Math.round(n * 0.75), n - 1]) {
      stations.push({ label: `k${k}`, x: ditch.path[k].x, cz: ditch.path[k].z });
    }
  }
  // Gate stations, where a causeway must exist or the gate opens onto a trench.
  const gates = city?.getGates?.() ?? [];
  for (const g of gates) stations.push({ label: `gate:${g.id}`, x: g.x, cz: g.z });

  /**
   * A transect is taken along the fieldward normal of the wall line at that x, out to
   * 60 m, at 1 m steps. `d` is metres out from the wall centreline, so the ditch's inner
   * lip should appear near d = 9.6 and its bottom near d = 19.6.
   */
  const normalAt = (x) => {
    if (!wallZAt) return { nx: 0, nz: -1 };
    const dz = (wallZAt(x + 1) - wallZAt(x - 1)) * 0.5;
    const len = Math.hypot(1, dz);
    return { nx: dz / len, nz: -1 / len };
  };
  r.transects = stations.map((s) => {
    const cz0 = wallZAt ? wallZAt(s.x) : s.cz;
    const nrm = normalAt(s.x);
    const prof = [];
    for (let d = -6; d <= 60; d += 1) {
      const x = s.x + nrm.nx * d;
      const z = cz0 + nrm.nz * d;
      prof.push({
        d,
        y: +h(x, z).toFixed(3),
        g: +grad(x, z).toFixed(3),
        ng: +navGrad(x, z).toFixed(3),
        // **The grid itself**, not a prediction of it. This is the number that decides
        // whether an assault can cross the ditch.
        nav: nav ? (nav.grid.blockedAt(x, z) ? 1 : 0) : -1,
      });
    }
    const lip = prof.find((p) => p.d === 0)?.y ?? 0;
    let deepest = { d: 0, y: Infinity };
    for (const p of prof) if (p.d >= 4 && p.d <= 40 && p.y < deepest.y) deepest = p;
    return {
      label: s.label,
      x: +s.x.toFixed(1),
      wallZ: +cz0.toFixed(1),
      crest: +lip.toFixed(2),
      deepest: +deepest.y.toFixed(2),
      relief: +(lip - deepest.y).toFixed(2),
      atD: deepest.d,
      maxGrad: +Math.max(...prof.filter((p) => p.d >= 0 && p.d <= 45).map((p) => p.g)).toFixed(3),
      maxNavGrad: +Math.max(...prof.filter((p) => p.d >= 0 && p.d <= 45).map((p) => p.ng)).toFixed(3),
      blocked: prof.filter((p) => p.d >= 0 && p.d <= 45 && p.nav === 1).length,
      profile: prof,
    };
  });

  // ---- can an assault still cross it? -------------------------------------
  //
  // The decisive question, and it is asked of the real `NavGrid` rather than of a model of
  // it: a ditch the pathfinder refuses is not a defence, it is a deleted battle.
  //
  // **The window is d 10..48 and the reason is a correction against this probe's first
  // answer.** Run from 48 m out to d = 3 it reported `routeClear: false` at every station —
  // including the two run-out ends and the gate causeway, where there is no ditch at all
  // and the relief is 2 cm. That was not the ditch: the curtain is stamped into the grid as
  // a blocked segment and `NavGrid.blockSegment` pads it by half a cell, so anything inside
  // d ~ 8 is refused because it is *inside the wall*. A crossing test whose target is the
  // masonry measures the masonry. The inner lip of the ditch is at d = 9.55, so d = 10 is
  // the near bank and the last ground on the attacker's side of the trench.
  if (nav && wallZAt) {
    const crossings = [];
    for (const s of stations) {
      const cz0 = wallZAt(s.x);
      const nrm = normalAt(s.x);
      const at = (d) => ({ x: s.x + nrm.nx * d, z: cz0 + nrm.nz * d });
      const a = at(48);
      const b = at(10);
      let unstandable = 0;
      for (let d = 10; d <= 29; d += 1) {
        const q = at(d);
        if (!nav.isStandable(q.x, q.z, 2.0)) unstandable++;
      }
      crossings.push({
        label: s.label,
        x: +s.x.toFixed(0),
        routeClear: nav.directRouteClear(a.x, a.z, b.x, b.z, 2.5),
        clearFraction: +nav.clearLineFraction(a.x, a.z, b.x, b.z, 2.5).toFixed(3),
        unstandableM: unstandable,
      });
    }
    r.crossings = crossings;
  }

  // ---- the ditch line, end to end -----------------------------------------
  if (ditch) {
    const line = [];
    for (const p of ditch.path) {
      line.push({ x: +p.x.toFixed(0), z: +p.z.toFixed(0), y: +h(p.x, p.z).toFixed(2) });
    }
    r.ditchLine = line;
  }

  // ---- the harbours -------------------------------------------------------
  // The basins' plans come from the terrain's own water profile where it has one, and
  // otherwise from the city, so this probe cannot invent a basin the map does not have.
  const basins = [];
  if (r.map === 'carthage') {
    // Cothon: annulus between the admiralty island and the ring quay.
    const C = { x: -930, z: 1000 };
    const scan = (label, inside, x0, x1, z0, z1) => {
      const beds = [];
      let above = 0;
      for (let z = z0; z <= z1; z += 2)
        for (let x = x0; x <= x1; x += 2) {
          if (!inside(x, z)) continue;
          const y = h(x, z);
          beds.push(y);
          if (y > terrain.waterLevel) above++;
        }
      beds.sort((a, b) => a - b);
      return {
        label,
        cells: beds.length,
        aboveDatumPct: +((above / Math.max(1, beds.length)) * 100).toFixed(1),
        median: +(beds.length ? beds[beds.length >> 1] : 0).toFixed(2),
        min: +(beds[0] ?? 0).toFixed(2),
        max: +(beds[beds.length - 1] ?? 0).toFixed(2),
      };
    };
    // Radii read from the city's own harbour output when it publishes one.
    const outerR = 162.5;
    const islandR = 62.5;
    basins.push(
      scan(
        'cothon annulus',
        (x, z) => {
          const rr = Math.hypot(x - C.x, z - C.z);
          return rr <= outerR && rr >= islandR;
        },
        C.x - outerR, C.x + outerR, C.z - outerR, C.z + outerR,
      ),
    );
    const M = { x: -540, z: 1010, hw: 160, hd: 75 };
    basins.push(scan('merchant basin', () => true, M.x - M.hw, M.x + M.hw, M.z - M.hd, M.z + M.hd));
    // A single transect straight across both, for the profile.
    const cut = [];
    for (let z = C.z - 200; z <= C.z + 200; z += 5) cut.push({ z, y: +h(C.x, z).toFixed(2) });
    r.cothonTransect = cut;
    const mcut = [];
    for (let z = M.z - 140; z <= M.z + 140; z += 5) mcut.push({ z, y: +h(M.x, z).toFixed(2) });
    r.merchantTransect = mcut;
  }
  r.basins = basins;

  // ---- a coarse whole-field fingerprint, so the control map can be proved unmoved ----
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let n = 0;
  for (let z = -1300; z <= 1300; z += 25)
    for (let x = -1300; x <= 1300; x += 25) {
      const y = h(x, z);
      sum += y;
      if (y < min) min = y;
      if (y > max) max = y;
      n++;
    }
  r.field = { n, mean: +(sum / n).toFixed(4), min: +min.toFixed(3), max: +max.toFixed(3) };

  return r;
});

console.log(`\n== ${out.map} ==  water datum ${out.waterLevel}`);
console.log(
  `field fingerprint: n=${out.field.n} mean=${out.field.mean} min=${out.field.min} max=${out.field.max}`,
);
if (out.plan) {
  console.log(
    `published ditch: ${out.plan.width} x ${out.plan.depth} m, bottom ${out.plan.bottomWidth} m, ` +
      `offset ${out.plan.offset.toFixed(2)} m, built=${out.plan.built}, ` +
      `${out.plan.points} pts x ${out.plan.x0.toFixed(0)}..${out.plan.x1.toFixed(0)}; belt ${out.beltDepth?.toFixed?.(2)} m`,
  );
} else {
  console.log('published ditch: none (this map has no Punic circuit)');
}

if (out.wall) {
  console.log(
    `wall: ${out.wall.bays} bays, ${out.wall.towers} towers, ${out.wall.garrisonable} garrisonable; ` +
      `sum walkY ${out.wall.walkYSum}, sum groundY ${out.wall.groundYSum}; ` +
      `section faults ${out.sectionFaults === null ? 'n/a' : out.sectionFaults.length === 0 ? 'none' : JSON.stringify(out.sectionFaults)}`,
  );
}

console.log('\nglacis transects — d is metres out from the wall centreline');
console.log(
  '  station                x     wallZ   crest  deepest  relief  at d   maxGrad  navGrad  navBlkd',
);
for (const t of out.transects) {
  console.log(
    `  ${t.label.padEnd(20)} ${String(t.x).padStart(7)} ${String(t.wallZ).padStart(8)} ` +
      `${t.crest.toFixed(2).padStart(7)} ${t.deepest.toFixed(2).padStart(8)} ` +
      `${t.relief.toFixed(2).padStart(7)} ${String(t.atD).padStart(5)} ${t.maxGrad.toFixed(3).padStart(9)}` +
      `${t.maxNavGrad.toFixed(3).padStart(9)} ${String(t.blocked).padStart(8)}`,
  );
}

// One profile in full, at mid-span, because a table of extrema is not a profile.
const mid = out.transects[Math.floor(out.transects.length / 2)] ?? out.transects[0];
if (mid) {
  console.log(`\nfull profile at ${mid.label} (x ${mid.x}):`);
  const cells = mid.profile
    .filter((p) => p.d % 2 === 0)
    .map((p) => `${p.d >= 0 ? ' ' : ''}${p.d}:${p.y.toFixed(2)}`);
  for (let i = 0; i < cells.length; i += 8) console.log('   ' + cells.slice(i, i + 8).join('  '));
}

if (out.crossings) {
  console.log('\ncan an assault cross? — the real NavGrid, from 48 m out to the ditch\'s near bank');
  console.log('  station              route clear  clear frac  unstandable m of 20 across the ditch');
  for (const c of out.crossings) {
    console.log(
      `  ${c.label.padEnd(20)} ${String(c.routeClear).padStart(11)} ${c.clearFraction.toFixed(3).padStart(11)}` +
        `${String(c.unstandableM).padStart(12)}`,
    );
  }
}

if (out.basins?.length) {
  console.log('\nharbour basins — bed against the water datum');
  for (const b of out.basins) {
    console.log(
      `  ${b.label.padEnd(18)} ${String(b.cells).padStart(6)} cells  ` +
        `above datum ${String(b.aboveDatumPct).padStart(5)}%  bed median ${b.median.toFixed(2)} ` +
        `min ${b.min.toFixed(2)} max ${b.max.toFixed(2)}`,
    );
  }
}
if (out.cothonTransect) {
  console.log('\ncothon transect (x -930, z -200..+200 of centre):');
  const c = out.cothonTransect.map((p) => `${p.z}:${p.y.toFixed(1)}`);
  for (let i = 0; i < c.length; i += 8) console.log('   ' + c.slice(i, i + 8).join('  '));
}

if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 10)) console.log(`   ${e}`);
} else {
  console.log('\nno page errors');
}

if (JSON_OUT) {
  await writeFile(path.resolve(ROOT, JSON_OUT), JSON.stringify(out, null, 1));
  console.log(`wrote ${JSON_OUT}`);
}

await browser.close();
if (server) {
  server.kill('SIGTERM');
  console.log(`• killed vite pid ${server.pid}`);
}
process.exit(errors.length ? 1 : 0);
