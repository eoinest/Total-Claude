#!/usr/bin/env node
/**
 * Build-time asset optimiser.
 *
 * The downloaded Poly Haven set is 214 MB — 165 MB of it 2K JPEGs. That is a fine
 * working set and a terrible web payload: a first-time visitor would wait minutes, and
 * on a hosted deployment it burns bandwidth for no visual gain. Two facts make it easy
 * to cut hard:
 *
 *  1. `src/terrain/groundTextures.ts` already halves every ground texture to 1024 (and
 *     normals to 512) at load time via `createImageBitmap`, so shipping 2K means
 *     downloading four times the pixels and immediately throwing three of them away.
 *  2. Nothing in `src/` constructs an `FBXLoader` or a `GLTFLoader`. Both the terrain and
 *     the unit pipelines ended up fully procedural, so the 30 MB of Quaternius models is
 *     never fetched at runtime. They stay in the repo for provenance and future use, but
 *     they have no business in a deployment.
 *
 * This writes an optimised copy of `public/assets` into `dist/assets` after Vite has
 * built, rewriting `manifest.json` to point at the new files. It never modifies the
 * originals.
 *
 * Usage:  node tools/optimize-assets.mjs [--out=dist/assets] [--quality=82] [--keep-models]
 */

import sharp from 'sharp';
import { mkdir, readFile, writeFile, readdir, stat, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'public', 'assets');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  })
);
const OUT = path.resolve(ROOT, args.get('out') ?? 'dist/assets');
const QUALITY = Number(args.get('quality') ?? 82);
const KEEP_MODELS = args.has('keep-models');

/**
 * Target edge length per map kind. Albedo carries the colour a player actually reads, so
 * it keeps the most resolution; normals and roughness are lower-frequency and tile at the
 * same scale, so they survive halving without a visible change. These match what the
 * terrain shader asks for at load time, so nothing is lost.
 */
const SIZE = {
  albedo: 1024,
  normal: 512,
  roughness: 512,
  ao: 512,
  displacement: 512,
};

const bytes = (n) => (n > 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} kB`);

async function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

if (!existsSync(SRC)) {
  console.log('• no public/assets — nothing to optimise (the game runs procedurally)');
  process.exit(0);
}

const before = await dirSize(SRC);
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const manifest = JSON.parse(await readFile(path.join(SRC, 'manifest.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Textures -> WebP at the resolution the shaders actually consume
// ---------------------------------------------------------------------------

let texIn = 0;
let texOut = 0;
let converted = 0;

for (const tex of manifest.textures ?? []) {
  for (const [kind, rel] of Object.entries(tex.maps ?? {})) {
    if (!rel) continue;
    const from = path.join(ROOT, 'public', rel.replace(/^\//, ''));
    if (!existsSync(from)) {
      tex.maps[kind] = null;
      continue;
    }
    const size = SIZE[kind] ?? 512;
    const relOut = rel.replace(/\.(jpe?g|png)$/i, '.webp');
    const to = path.join(ROOT, 'public', relOut).replace(path.join(ROOT, 'public', 'assets'), OUT);
    await mkdir(path.dirname(to), { recursive: true });

    texIn += (await stat(from)).size;
    await sharp(from)
      // `withoutEnlargement` matters: a few maps ship below 1K already and upscaling
      // them would add bytes for no detail.
      .resize(size, size, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: kind === 'albedo' ? QUALITY : Math.max(70, QUALITY - 8), effort: 5 })
      .toFile(to);
    texOut += (await stat(to)).size;
    converted++;
    tex.maps[kind] = relOut;
  }
  tex.resolutionPx = SIZE.albedo;
}

// ---------------------------------------------------------------------------
// HDRIs are copied verbatim. Radiance HDR is already compact for what it is, and
// re-encoding it to any 8-bit format would destroy the >1.0 radiance values that make
// it usable as a light source rather than a picture.
// ---------------------------------------------------------------------------

let hdrOut = 0;
for (const h of manifest.hdris ?? []) {
  const from = path.join(ROOT, 'public', h.path.replace(/^\//, ''));
  if (!existsSync(from)) continue;
  const to = path.join(OUT, path.relative(path.join(ROOT, 'public', 'assets'), from));
  await mkdir(path.dirname(to), { recursive: true });
  await copyFile(from, to);
  hdrOut += (await stat(to)).size;
}

// ---------------------------------------------------------------------------
// Models: dropped unless asked for. Kept in the manifest with a note so the
// provenance record stays honest about what shipped and what did not.
// ---------------------------------------------------------------------------

let modelOut = 0;
if (KEEP_MODELS) {
  for (const m of manifest.models ?? []) {
    const from = path.join(ROOT, 'public', m.path.replace(/^\//, ''));
    if (!existsSync(from)) continue;
    const to = path.join(OUT, path.relative(path.join(ROOT, 'public', 'assets'), from));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    modelOut += (await stat(to)).size;
  }
} else {
  const dropped = (manifest.models ?? []).length;
  manifest.models = [];
  manifest.modelsOmittedFromBuild = {
    count: dropped,
    reason:
      'No FBXLoader or GLTFLoader is constructed anywhere in src/. The terrain and unit ' +
      'pipelines are procedural, so these are never fetched at runtime. They remain in ' +
      'the repository and in ASSETS.md for provenance; pass --keep-models to include them.',
  };
}

manifest.optimisedForWeb = {
  albedoPx: SIZE.albedo,
  otherMapsPx: SIZE.normal,
  format: 'webp',
  quality: QUALITY,
};

await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

const after = await dirSize(OUT);
console.log(`• textures: ${converted} maps, ${bytes(texIn)} -> ${bytes(texOut)}`);
console.log(`• hdris:    ${bytes(hdrOut)} (copied verbatim, radiance must stay float)`);
console.log(`• models:   ${KEEP_MODELS ? bytes(modelOut) : 'omitted (never loaded at runtime)'}`);
console.log(`\n→ ${bytes(before)} → ${bytes(after)}  (${((1 - after / before) * 100).toFixed(0)}% smaller)`);
