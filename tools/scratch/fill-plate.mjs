#!/usr/bin/env node
/**
 * A figure-ground plate of Rome's fabric, drawn from the plan, with **no browser**.
 *
 * `tools/scratch/figure-ground.mjs` photographs the built geometry and is the honest answer
 * to "how much of this is roof"; it costs a browser slot and four minutes. This costs 300 ms
 * and answers a different question that phase 5 needs constantly: *which* ground between
 * street lines has nothing on it, and what that ground is. Everything is drawn from the
 * shipped `cityPlan()` and `buildDistricts()`.
 *
 *   grey    a block's inset polygon — the ground between street lines
 *   red     a monument precinct as the generator sees it (box + ambitus)
 *   blue    ground the terrain says is under water
 *   yellow  an aqueduct corridor
 *   black   a building footprint
 *
 * So a black-on-grey patch is fabric, a bare grey patch is the generator giving up, and a
 * bare red or blue patch is ground that is already something.
 *
 *   node --experimental-transform-types --import ./tools/lib/ts-resolve.mjs \
 *     tools/scratch/fill-plate.mjs --out=screenshots/rome-fill/plate.png [--cx= --cz= --span=]
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import '../../src/terrain/topography.ts';
import '../../src/city/rome/survey.ts';
import '../../src/city/rome/apertures.ts';
import '../../src/city/rome/section.ts';
import '../../src/city/rome/monuments.ts';
import '../../src/city/rome/ways.ts';
import '../../src/city/rome/layout.ts';
import { cityPlan, buildDistricts, inTheRiverAt } from '../../src/city/rome/fabric.ts';
import { AQUEDUCTS, LANDMARKS, PLAZAS, MON_AMBITUS, romeKeepOut } from '../../src/city/rome/layout.ts';
import { romeWallZ } from '../../src/terrain/topography.ts';

const args = new Map(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const CX = Number(args.get('cx') ?? 300);
const CZ = Number(args.get('cz') ?? 980);
const SPAN = Number(args.get('span') ?? 2000);
const PX = Number(args.get('px') ?? 1800);
const OUT = path.resolve(args.get('out') ?? 'screenshots/rome-fill/plate.png');

const plan = cityPlan();
const out = buildDistricts(() => 20, romeKeepOut(), 'rome-fabric', romeWallZ);

const s = PX / SPAN;
// North up: world +Z is south, so screen y grows with z.
const sx = (x) => (x - CX) * s + PX / 2;
const sy = (z) => (z - CZ) * s + PX / 2;
const poly = (pts) => pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.z).toFixed(1)}`).join(' ');
const rect = (r) => {
  const c = Math.cos(r.rot);
  const sn = Math.sin(r.rot);
  // three.js: local +X -> world (cos, -sin).
  const ax = { x: c * r.hw, z: -sn * r.hw };
  const az = { x: sn * r.hd, z: c * r.hd };
  return poly([
    { x: r.x - ax.x - az.x, z: r.z - ax.z - az.z },
    { x: r.x + ax.x - az.x, z: r.z + ax.z - az.z },
    { x: r.x + ax.x + az.x, z: r.z + ax.z + az.z },
    { x: r.x - ax.x + az.x, z: r.z - ax.z + az.z },
  ]);
};

const parts = [];
parts.push(`<rect width="${PX}" height="${PX}" fill="#ffffff"/>`);

// The water, as a raster of the terrain's own answer at 4 m.
{
  const STEP = 4;
  const cells = [];
  for (let z = CZ - SPAN / 2; z < CZ + SPAN / 2; z += STEP) {
    for (let x = CX - SPAN / 2; x < CX + SPAN / 2; x += STEP) {
      if (inTheRiverAt(x + STEP / 2, z + STEP / 2)) {
        cells.push(`<rect x="${sx(x).toFixed(1)}" y="${sy(z).toFixed(1)}" width="${(STEP * s).toFixed(1)}" height="${(STEP * s).toFixed(1)}"/>`);
      }
    }
  }
  parts.push(`<g fill="#bcd6e8">${cells.join('')}</g>`);
}

// Ground between street lines.
for (const b of plan.blocks) {
  if (b.kind !== 'block' || b.inset.length < 3) continue;
  parts.push(`<polygon points="${poly(b.inset)}" fill="#d8d5cd" stroke="#b3aea3" stroke-width="0.6"/>`);
}
// Faces that are not blocks, so the reader can see what was called a square.
for (const b of plan.blocks) {
  if (b.kind === 'block' || b.face.ring.length < 3) continue;
  const fill = b.kind === 'plaza' ? '#efe7d2' : b.kind === 'pomerium' ? '#e8e8e8' : '#f4f6ee';
  parts.push(`<polygon points="${poly(b.face.ring)}" fill="${fill}" stroke="#cfc9bb" stroke-width="0.4"/>`);
}
// The authored squares.
for (const p of PLAZAS) parts.push(`<polygon points="${rect({ ...p, hw: p.hw + 2, hd: p.hd + 2 })}" fill="#e6dcc0"/>`);
// Aqueduct corridors.
for (const a of AQUEDUCTS) {
  parts.push(`<polyline points="${poly(a.path)}" fill="none" stroke="#e3d24a" stroke-width="${(16 * s).toFixed(1)}" stroke-opacity="0.8" stroke-linejoin="round" stroke-linecap="round"/>`);
}
// Monument precincts as the generator sees them.
for (const l of LANDMARKS) {
  parts.push(`<polygon points="${rect({ x: l.x, z: l.z, hw: l.hw + MON_AMBITUS, hd: l.hd + MON_AMBITUS, rot: l.rot })}" fill="#d98b7a" fill-opacity="0.85"/>`);
}
// The fabric.
for (const f of out.footprints) parts.push(`<polygon points="${rect(f)}" fill="#1c1c1c"/>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PX}" height="${PX}" viewBox="0 0 ${PX} ${PX}">${parts.join('')}</svg>`;
await mkdir(path.dirname(OUT), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(OUT);
console.log(`${OUT}  centre (${CX}, ${CZ})  span ${SPAN} m  ${(1 / s).toFixed(3)} m/px  ${out.footprints.length} footprints`);
