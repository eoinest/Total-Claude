#!/usr/bin/env node
/**
 * dq-ditchscan — is the ditch of Carthage continuous, or is it locally filled in?
 *
 * `probe-ditch-ds.mjs` answers in aggregate: five path stations plus the gates. The
 * heightfield's own `assertDitchCut` answers in aggregate too — 88/88 stations, 6.00 m
 * median. Neither can see a 200 m stretch that has been backfilled by some other stage,
 * because neither samples densely enough to have a station inside it.
 *
 * This walks the *whole* frontage at 10 m and takes a 0.5 m transect at every station, so a
 * local infill shows up as a run of low relief at a particular x rather than as a slightly
 * worse median.
 *
 * Every height comes from `TerrainSystem.heightAt` — the function the sim stands men on.
 *
 *   node tools/scratch/dq-ditchscan.mjs --port=5456 --json=tools/scratch/dq-ditchscan.json
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const PORT = Number(args.get('port') ?? 5456);
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
console.log(`[dq-ditchscan] ${url}`);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 300)}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE ${m.text().slice(0, 300)}`);
  const t = m.text();
  if (/\[carthage\] ditch:/.test(t)) console.log(`  ${t}`);
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
  /** The pathfinder's own 14 m stencil, not a 7 m one. See probe-ditch-ds.mjs's note. */
  const navGrad = (x, z) =>
    Math.hypot((h(x + 7, z) - h(x - 7, z)) / 14, (h(x, z + 7) - h(x, z - 7)) / 14);

  const r = { map: terrain.map?.id ?? '?', waterLevel: terrain.waterLevel };

  const ditch = city?.getDitch?.() ?? null;
  r.plan = ditch
    ? {
        built: ditch.built,
        width: ditch.width,
        depth: ditch.depth,
        bottomWidth: ditch.bottomWidth,
        offset: ditch.offset,
        x0: ditch.path[0].x,
        x1: ditch.path[ditch.path.length - 1].x,
      }
    : null;

  // The wall line as the masonry itself stands on it.
  const samples = city?.getCircuitSamples?.(5) ?? [];
  const wallZAt =
    samples.length >= 2
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
  if (!wallZAt) return { ...r, fatal: 'no circuit samples' };
  r.wallX = { min: samples[0].x, max: samples[samples.length - 1].x, n: samples.length };

  const normalAt = (x) => {
    const dz = (wallZAt(x + 1) - wallZAt(x - 1)) * 0.5;
    const len = Math.hypot(1, dz);
    return { nx: dz / len, nz: -1 / len };
  };

  // Perpendicular distance from a point to the published ditch centreline, so the scan can
  // say whether the transect crosses where the plan says the trench is.
  const line = ditch?.path ?? [];
  const toCentreline = (x, z) => {
    let best = Infinity;
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k];
      const b = line[k + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
      const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (d < best) best = d;
    }
    return best;
  };

  // Gates and posterns, so a designed causeway is not read as a defect.
  const gates = (city?.getGates?.() ?? []).map((g) => ({ id: g.id, x: g.x, z: g.z }));
  r.openings = gates;

  const X0 = -968;
  const X1 = 1013;
  const STEP = 10;
  const DMAX = 60;
  const DSTEP = 0.5;

  const stations = [];
  for (let x = X0; x <= X1 + 1e-6; x += STEP) {
    const cz = wallZAt(x);
    const n = normalAt(x);
    const prof = [];
    for (let d = 0; d <= DMAX + 1e-9; d += DSTEP) {
      prof.push({ d: +d.toFixed(1), y: h(x + n.nx * d, cz + n.nz * d) });
    }
    const yAt = (d) => prof[Math.round(d / DSTEP)].y;
    const footY = prof[0].y;

    // Deepest point of the transect. Window 4..50 keeps the wall's own bench out of it at
    // the near end and the natural fall to the coast out of it at the far end; the plan puts
    // the bed at d = 19.55 +/- 1.
    let deepest = { d: -1, y: Infinity };
    for (const p of prof) if (p.d >= 4 && p.d <= 50 && p.y < deepest.y) deepest = p;

    // The two lips. Inner: the highest ground between the wall face and the fall. Outer: the
    // highest ground between the bed and 60 m out. A hole you can see needs both.
    let innerLip = -Infinity;
    for (const p of prof) if (p.d >= 0 && p.d <= Math.max(4, deepest.d)) innerLip = Math.max(innerLip, p.y);
    let outerLip = -Infinity;
    for (const p of prof) if (p.d >= deepest.d && p.d <= DMAX) outerLip = Math.max(outerLip, p.y);

    // Grade of the counterscarp as the nav grid reads it, at the bed.
    const ng = navGrad(x + n.nx * deepest.d, cz + n.nz * deepest.d);

    const nearestOpening = gates.reduce(
      (acc, g) => {
        const dd = Math.abs(g.x - x);
        return dd < acc.d ? { d: dd, id: g.id } : acc;
      },
      { d: Infinity, id: '' },
    );

    stations.push({
      x: +x.toFixed(1),
      wallZ: +cz.toFixed(1),
      footY: +footY.toFixed(2),
      y8: +yAt(8).toFixed(2),
      y20: +yAt(20).toFixed(2),
      y30: +yAt(30).toFixed(2),
      innerLip: +innerLip.toFixed(2),
      outerLip: +outerLip.toFixed(2),
      deepest: +deepest.y.toFixed(2),
      atD: deepest.d,
      // Same definition as probe-ditch-ds.mjs, so the two are comparable.
      relief: +(footY - deepest.y).toFixed(2),
      // The honest one: how deep the hole is measured from the *lower* of its two lips.
      reliefBoth: +(Math.min(innerLip, outerLip) - deepest.y).toFixed(2),
      planD: line.length ? +toCentreline(x + n.nx * 19.55, cz + n.nz * 19.55).toFixed(2) : -1,
      navGrad: +ng.toFixed(3),
      standable: nav ? (nav.isStandable(x + n.nx * deepest.d, cz + n.nz * deepest.d, 2.0) ? 1 : 0) : -1,
      opening: nearestOpening.d <= 30 ? nearestOpening.id : '',
      openingD: +nearestOpening.d.toFixed(0),
    });
  }
  r.stations = stations;

  // Full profiles at a handful of stations, chosen after the fact: the worst interior one,
  // the best one, and the causeway. A table of extrema is not a profile.
  const interior = stations.filter((s) => !s.opening || !/gate|byrsae|uticensis|maritima/.test(s.opening));
  const pick = (s) => ({
    x: s.x,
    prof: (() => {
      const cz = wallZAt(s.x);
      const n = normalAt(s.x);
      const o = [];
      for (let d = 0; d <= 60; d += 1) o.push(+h(s.x + n.nx * d, cz + n.nz * d).toFixed(2));
      return o;
    })(),
  });
  const sorted = [...interior].sort((a, b) => a.reliefBoth - b.reliefBoth);
  r.profiles = {
    worstInterior: pick(sorted[0]),
    medianInterior: pick(sorted[sorted.length >> 1]),
    best: pick(sorted[sorted.length - 1]),
    atGate: pick(stations.reduce((a, b) => (Math.abs(b.x) < Math.abs(a.x) ? b : a))),
  };

  return r;
});

if (out.fatal) {
  console.error(`fatal: ${out.fatal}`);
  process.exit(2);
}

const S = out.stations;
console.log(`\n== ${out.map} ==  water datum ${out.waterLevel}`);
if (out.plan) {
  console.log(
    `published ditch: ${out.plan.width} x ${out.plan.depth} m, bottom ${out.plan.bottomWidth} m, ` +
      `offset ${out.plan.offset.toFixed(2)} m, built=${out.plan.built}, ` +
      `path x ${out.plan.x0.toFixed(0)}..${out.plan.x1.toFixed(0)}`,
  );
}
console.log(`openings: ${out.openings.map((g) => `${g.id}@${g.x.toFixed(0)}`).join('  ')}`);
console.log(`\n${S.length} stations, x ${S[0].x}..${S[S.length - 1].x} at 10 m, transect 0..60 m at 0.5 m`);

// ---- per-station table ------------------------------------------------------
console.log(
  '\n      x    wallZ   foot    y@8   y@20   y@30  inLip outLip   bed   at d  relief  bothLip  navG  stand  opening',
);
for (const s of S) {
  console.log(
    `  ${String(s.x).padStart(6)} ${String(s.wallZ).padStart(7)} ` +
      `${s.footY.toFixed(2).padStart(6)} ${s.y8.toFixed(2).padStart(6)} ${s.y20.toFixed(2).padStart(6)} ` +
      `${s.y30.toFixed(2).padStart(6)} ${s.innerLip.toFixed(2).padStart(6)} ${s.outerLip.toFixed(2).padStart(6)} ` +
      `${s.deepest.toFixed(2).padStart(6)} ${String(s.atD).padStart(5)} ` +
      `${s.relief.toFixed(2).padStart(7)} ${s.reliefBoth.toFixed(2).padStart(8)} ` +
      `${s.navGrad.toFixed(3).padStart(6)} ${String(s.standable).padStart(6)}  ${s.opening}`,
  );
}

// ---- distribution -----------------------------------------------------------
const bucket = (v) => (v > 4 ? '>4' : v >= 2 ? '2-4' : v >= 0.5 ? '0.5-2' : '<0.5');
for (const [name, key] of [
  ['relief (foot - bed)', 'relief'],
  ['relief (lower lip - bed)', 'reliefBoth'],
]) {
  const counts = { '>4': 0, '2-4': 0, '0.5-2': 0, '<0.5': 0 };
  for (const s of S) counts[bucket(s[key])]++;
  console.log(
    `\ndistribution of ${name}:  >4 m: ${counts['>4']}   2-4 m: ${counts['2-4']}   ` +
      `0.5-2 m: ${counts['0.5-2']}   <0.5 m: ${counts['<0.5']}   (of ${S.length})`,
  );
}

// ---- the ASCII map ----------------------------------------------------------
// One row per station, so a run of low values at a particular x is a visible block.
console.log('\nrelief (lower lip - bed) against x — # is a metre, | marks 6 m spec');
for (const s of S) {
  const n = Math.max(0, Math.round(s.reliefBoth * 4));
  const bar = '#'.repeat(Math.min(n, 30));
  const spec = 24; // 6 m * 4
  let row = bar.padEnd(31, ' ');
  row = row.slice(0, spec) + '|' + row.slice(spec + 1);
  const tag = s.opening ? ` <- ${s.opening}` : '';
  console.log(`  ${String(s.x).padStart(6)} ${s.reliefBoth.toFixed(2).padStart(5)} ${row}${tag}`);
}

// ---- neighbour consistency: the causeway defect ------------------------------
// "A number that cannot be true given its neighbour is the tell." A single station 1.5 m
// off both of its neighbours is an instrument artefact or a 10 m feature; either way it is
// not a stretch of filled ditch.
console.log('\nstations that disagree with both neighbours by > 1.5 m (single-sample artefacts):');
let anomalies = 0;
for (let i = 1; i < S.length - 1; i++) {
  const a = S[i - 1].reliefBoth;
  const b = S[i].reliefBoth;
  const c = S[i + 1].reliefBoth;
  if (Math.abs(b - a) > 1.5 && Math.abs(b - c) > 1.5) {
    console.log(
      `  x ${String(S[i].x).padStart(6)}: ${b.toFixed(2)} between ${a.toFixed(2)} and ${c.toFixed(2)}` +
        (S[i].opening ? `  (at ${S[i].opening})` : ''),
    );
    anomalies++;
  }
}
if (!anomalies) console.log('  none — every value is supported by its neighbours');

// ---- contiguous runs below 2 m ----------------------------------------------
console.log('\ncontiguous runs with relief < 2.0 m (lower lip - bed):');
let runStart = null;
const runs = [];
for (let i = 0; i <= S.length; i++) {
  const low = i < S.length && S[i].reliefBoth < 2.0;
  if (low && runStart === null) runStart = i;
  if (!low && runStart !== null) {
    runs.push([runStart, i - 1]);
    runStart = null;
  }
}
if (!runs.length) console.log('  none');
for (const [a, b] of runs) {
  const xs = S.slice(a, b + 1);
  const opens = [...new Set(xs.map((s) => s.opening).filter(Boolean))];
  console.log(
    `  x ${String(S[a].x).padStart(6)} .. ${String(S[b].x).padStart(6)}  ` +
      `(${xs.length} stations, ${(S[b].x - S[a].x + 10).toFixed(0)} m)  ` +
      `min ${Math.min(...xs.map((s) => s.reliefBoth)).toFixed(2)} ` +
      `max ${Math.max(...xs.map((s) => s.reliefBoth)).toFixed(2)}` +
      (opens.length ? `  openings: ${opens.join(',')}` : '  openings: none'),
  );
}

// ---- where the bed actually is ----------------------------------------------
const cut = S.filter((s) => s.reliefBoth >= 2);
if (cut.length) {
  const ds = cut.map((s) => s.atD).sort((a, b) => a - b);
  console.log(
    `\nbed position over the ${cut.length} cut stations: min d ${ds[0]} median ${ds[ds.length >> 1]} ` +
      `max ${ds[ds.length - 1]} (plan says 19.55)`,
  );
  const rb = cut.map((s) => s.reliefBoth).sort((a, b) => a - b);
  console.log(
    `relief over those: min ${rb[0].toFixed(2)} p10 ${rb[Math.floor(rb.length * 0.1)].toFixed(2)} ` +
      `median ${rb[rb.length >> 1].toFixed(2)} max ${rb[rb.length - 1].toFixed(2)}`,
  );
  const ng = cut.map((s) => s.navGrad).sort((a, b) => a - b);
  console.log(`nav gradient at the bed: median ${ng[ng.length >> 1].toFixed(3)} max ${ng[ng.length - 1].toFixed(3)}`);
  console.log(`unstandable beds: ${cut.filter((s) => s.standable === 0).length} of ${cut.length}`);
}

// ---- profiles ---------------------------------------------------------------
for (const [name, p] of Object.entries(out.profiles)) {
  console.log(`\nprofile ${name} at x ${p.x} (d = 0..60 at 1 m):`);
  for (let i = 0; i < p.prof.length; i += 10) {
    console.log(
      `   d${String(i).padStart(2)}: ` +
        p.prof
          .slice(i, i + 10)
          .map((v) => v.toFixed(2).padStart(6))
          .join(''),
    );
  }
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
