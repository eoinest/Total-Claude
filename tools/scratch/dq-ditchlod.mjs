#!/usr/bin/env node
/**
 * dq-ditchlod — the ditch the *renderer* draws, not the ditch the sim walks in.
 *
 * `dq-ditchscan.mjs` proves the cut is in the heightfield: `TerrainSystem.heightAt` reports
 * ~6.00 m of relief along 165 of 199 stations. But the terrain mesh is a geometry clipmap
 * (`src/terrain/clipmap.ts`) whose vertices are displaced from a *mipmapped* height texture
 * (`src/terrain/TerrainMaterial.ts`, `clipmapVertex` / `terrainHeightLod`), and its centre is
 * snapped to the **camera position** in `TerrainSystem.preRender`. So the geometry a frame
 * actually shows depends on how far the ground is from the eye, and a 20 m trench filtered
 * through a coarse mip is a shallower trench than the one the men stand in.
 *
 * This reconstructs the mip chain the way `THREE`'s automatic mipmap generation does — a
 * 2x2 box reduction per level — samples the ditch transect through each level with the same
 * vertex spacing the matching clipmap ring uses, and reports what depth survives.
 *
 *   node tools/scratch/dq-ditchlod.mjs --port=5457
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
const PORT = Number(args.get('port') ?? 5457);
const JSON_OUT = args.get('json') ?? '';

const token = Buffer.from(JSON.stringify({ map: 'carthage', scenario: 'assault' }))
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

const url = `${base}/?harness=1&w=640&h=360&quality=high&battle=${token}`;
console.log(`[dq-ditchlod] ${url}`);
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 300000, polling: 250 });

const out = await page.evaluate(() => {
  const ctx = window.__game.engine.context;
  const terrain = ctx.get('terrain');
  const city = ctx.tryGet('city');
  const hf = terrain.heightField;
  const r = { res: hf.res, spacing: hf.spacing, halfExtent: hf.halfExtent };

  // ---- the mip chain, as THREE's automatic generator makes it -----------------
  // A 2x2 box reduce per level. The texture is res x res; the top level is the field.
  const levels = [{ res: hf.res, spacing: hf.spacing, data: hf.data }];
  for (let l = 1; l <= 6; l++) {
    const p = levels[l - 1];
    const nres = p.res >> 1;
    if (nres < 4) break;
    const d = new Float32Array(nres * nres);
    for (let j = 0; j < nres; j++)
      for (let i = 0; i < nres; i++) {
        const a = p.data[(j * 2) * p.res + i * 2];
        const b = p.data[(j * 2) * p.res + Math.min(i * 2 + 1, p.res - 1)];
        const c = p.data[Math.min(j * 2 + 1, p.res - 1) * p.res + i * 2];
        const e = p.data[Math.min(j * 2 + 1, p.res - 1) * p.res + Math.min(i * 2 + 1, p.res - 1)];
        d[j * nres + i] = (a + b + c + e) * 0.25;
      }
    levels.push({ res: nres, spacing: (hf.halfExtent * 2) / (nres - 1), data: d });
  }
  r.mipRes = levels.map((l) => l.res);

  // Bilinear read of a given mip, in world coordinates.
  const sampleMip = (l, x, z) => {
    const L = levels[Math.max(0, Math.min(levels.length - 1, l))];
    const sp = (hf.halfExtent * 2) / L.res; // texel size at this level
    // Texel centres, matching a GL texture read.
    const fx = (x + hf.halfExtent) / sp - 0.5;
    const fz = (z + hf.halfExtent) / sp - 0.5;
    let i0 = Math.floor(fx);
    let j0 = Math.floor(fz);
    const tx = fx - i0;
    const tz = fz - j0;
    const cl = (v) => Math.max(0, Math.min(L.res - 1, v));
    const g = (i, j) => L.data[cl(j) * L.res + cl(i)];
    const a = g(i0, j0) * (1 - tx) + g(i0 + 1, j0) * tx;
    const b = g(i0, j0 + 1) * (1 - tx) + g(i0 + 1, j0 + 1) * tx;
    return a * (1 - tz) + b * tz;
  };
  // Trilinear, since `textureLod` with a fractional lod blends two levels.
  const sampleLod = (lod, x, z) => {
    const l0 = Math.floor(lod);
    const f = lod - l0;
    return sampleMip(l0, x, z) * (1 - f) + sampleMip(l0 + 1, x, z) * f;
  };

  // ---- the clipmap rings ------------------------------------------------------
  // From src/terrain/clipmap.ts and TerrainMaterial.clipmapVertex.
  const CLIP_CELLS = 192;
  const CLIP_LEVELS = 7;
  const CLIP_BASE_SPACING = 0.5;
  const halfCells = CLIP_CELLS / 2;
  const rings = [];
  for (let lvl = 0; lvl < CLIP_LEVELS; lvl++) {
    const s = CLIP_BASE_SPACING * Math.pow(2, lvl);
    rings.push({
      lvl,
      vertexSpacing: s,
      // Chebyshev half-extent of this level about the clip centre = the camera.
      reachM: halfCells * s,
      innerM: lvl === 0 ? 0 : halfCells * (s / 2),
      lod: Math.max(0, Math.log2(s / hf.spacing)),
    });
  }
  r.rings = rings;

  // ---- the ditch transect, drawn as each ring would draw it -------------------
  // Take it at a station the dense scan proved is a full 6 m cut and well away from the
  // gate causeway and both run-outs.
  const samples = city?.getCircuitSamples?.(5) ?? [];
  const wallZAt = (x) => {
    if (x <= samples[0].x) return samples[0].z;
    const last = samples[samples.length - 1];
    if (x >= last.x) return last.z;
    let i = 0;
    while (i < samples.length - 2 && samples[i + 1].x < x) i++;
    const t = (x - samples[i].x) / (samples[i + 1].x - samples[i].x || 1);
    return samples[i].z + (samples[i + 1].z - samples[i].z) * t;
  };

  const STATIONS = [-400, -200, 200, 400, 700];
  r.transects = [];
  for (const X of STATIONS) {
    const cz = wallZAt(X);
    const dz = (wallZAt(X + 1) - wallZAt(X - 1)) * 0.5;
    const len = Math.hypot(1, dz);
    const n = { nx: dz / len, nz: -1 / len };
    const rows = [];
    // CPU truth first.
    {
      const prof = [];
      for (let d = 0; d <= 45; d += 0.5) prof.push(terrain.heightAt(X + n.nx * d, cz + n.nz * d));
      const lip = Math.max(prof[0], prof[prof.length - 1]);
      rows.push({ what: 'heightAt (the sim)', vs: hf.spacing, lod: 0, relief: +(lip - Math.min(...prof)).toFixed(2) });
    }
    for (const ring of rings) {
      // The mesh only has vertices every `vertexSpacing` metres, and their heights come
      // from mip `lod`. Between them the surface is a straight line, so the deepest thing
      // the frame can show is the deepest *vertex*, at whatever phase the grid lands on.
      // Take the worst and the best phase, because the clipmap grid is snapped to the
      // camera and the phase is not something a shot can choose.
      const s = ring.vertexSpacing;
      let bestRelief = -Infinity;
      let worstRelief = Infinity;
      for (let ph = 0; ph < 1; ph += 0.125) {
        const ys = [];
        for (let d = -s * 2; d <= 45 + s * 2; d += s) {
          const dd = d + ph * s;
          ys.push({ d: dd, y: sampleLod(ring.lod, X + n.nx * dd, cz + n.nz * dd) });
        }
        const inband = ys.filter((p) => p.d >= 0 && p.d <= 45);
        if (inband.length < 3) continue;
        const lip = Math.max(inband[0].y, inband[inband.length - 1].y);
        const rel = lip - Math.min(...inband.map((p) => p.y));
        bestRelief = Math.max(bestRelief, rel);
        worstRelief = Math.min(worstRelief, rel);
      }
      rows.push({
        what: `clip level ${ring.lvl}`,
        vs: s,
        lod: +ring.lod.toFixed(2),
        reachM: ring.reachM,
        innerM: ring.innerM,
        relief: +bestRelief.toFixed(2),
        reliefWorstPhase: +worstRelief.toFixed(2),
      });
    }
    r.transects.push({ x: X, rows });
  }

  // ---- what the mip chain alone does, ignoring vertex spacing -----------------
  // So the two causes can be told apart: mip filtering vs. triangle size.
  r.mipOnly = [];
  {
    const X = -400;
    const cz = wallZAt(X);
    const dz = (wallZAt(X + 1) - wallZAt(X - 1)) * 0.5;
    const len = Math.hypot(1, dz);
    const n = { nx: dz / len, nz: -1 / len };
    for (let l = 0; l <= 5; l++) {
      const prof = [];
      for (let d = 0; d <= 45; d += 0.25) prof.push(sampleMip(l, X + n.nx * d, cz + n.nz * d));
      r.mipOnly.push({
        mip: l,
        texelM: +((hf.halfExtent * 2) / (hf.res >> l)).toFixed(2),
        relief: +(Math.max(prof[0], prof[prof.length - 1]) - Math.min(...prof)).toFixed(2),
      });
    }
  }

  return r;
});

console.log(`\nheightfield ${out.res}² at ${out.spacing.toFixed(3)} m; mip chain res ${out.mipRes.join(' → ')}`);
console.log('\nclipmap rings (centre is snapped to the CAMERA position, TerrainSystem.preRender):');
console.log('  lvl  vertex spacing   covers (Chebyshev from eye)   heightmap lod');
for (const r of out.rings) {
  console.log(
    `  ${String(r.lvl).padStart(3)} ${r.vertexSpacing.toFixed(2).padStart(11)} m   ` +
      `${r.innerM.toFixed(0).padStart(6)} .. ${r.reachM.toFixed(0).padStart(6)} m` +
      `${r.lod.toFixed(2).padStart(18)}`,
  );
}

console.log('\nmip filtering alone (no vertex-spacing loss), transect at x -400:');
for (const m of out.mipOnly) {
  console.log(`  mip ${m.mip}  texel ${m.texelM.toFixed(2).padStart(6)} m   relief ${m.relief.toFixed(2)} m`);
}

for (const t of out.transects) {
  console.log(`\nditch at x ${t.x} — what each clipmap ring can draw:`);
  console.log('  surface                vertex spacing   lod    relief   worst phase   ring covers');
  for (const row of t.rows) {
    console.log(
      `  ${row.what.padEnd(22)} ${row.vs.toFixed(2).padStart(10)} m ${String(row.lod).padStart(6)} ` +
        `${row.relief.toFixed(2).padStart(8)} m ${(row.reliefWorstPhase ?? row.relief).toFixed(2).padStart(11)} m   ` +
        (row.reachM !== undefined ? `${row.innerM.toFixed(0)}..${row.reachM.toFixed(0)} m` : ''),
    );
  }
}

if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors.slice(0, 6)) console.log(`   ${e}`);
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
process.exit(0);
