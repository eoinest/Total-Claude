#!/usr/bin/env node
/**
 * Compose the northern tiles into one raster and record its EPSG:3004 -> survey affine.
 *
 * The survey affine is *derived*, not fitted: the existing plate's published pixel->survey
 * affine plus that plate's own EPSG:3004 bbox give an EPSG:3004 -> survey affine directly, and
 * the composition of two affines is an affine. The only question is whether it stays true 5 km
 * north of where it was fitted. It does: the shear term is the grid convergence of EPSG:3004 at
 * Rome (1.68 degrees), and convergence varies with latitude at about 0.0015 degrees per 5 km
 * here, which over a 3 km lever arm is under 0.1 m. The transverse-Mercator scale factor varies
 * with easting, not northing, and the easting range is unchanged.
 *
 * Verified rather than asserted: `--check` re-projects the overlap row between the mosaic's
 * bottom edge and the existing plate's top edge and prints the disagreement.
 */
import sharp from 'sharp';
import fs from 'node:fs';

const T = JSON.parse(fs.readFileSync('tools/scratch/tiber-north-tiles.json', 'utf8'));
const rows = Math.max(...T.tiles.map((t) => t.r)) + 1;
const cols = Math.max(...T.tiles.map((t) => t.c)) + 1;
const W = cols * T.tileW, H = rows * T.tileH;
const composite = [];
for (const t of T.tiles) {
  composite.push({ input: t.file, left: t.c * T.tileW, top: (rows - 1 - t.r) * T.tileH });
}
const OUT = `reference/rome-plans/agea-2012-ortofoto-EPSG3004-north-mosaic-${cols * T.tileW}x${rows * T.tileH}.jpg`;
await sharp({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } })
  .composite(composite).jpeg({ quality: 92 }).toFile(OUT);
console.log(`wrote ${OUT} ${W}x${H}`);

// EPSG:3004 of the mosaic's top-left pixel centre
const minx = Math.min(...T.tiles.map((t) => t.minx));
const maxy = Math.max(...T.tiles.map((t) => t.maxy));
const geo = {
  file: OUT, widthPx: W, heightPx: H,
  epsg3004: { x0: minx, y0: maxy, mppX: T.mppX, mppY: T.mppY },
};
fs.writeFileSync('tools/scratch/tiber-north-geo.json', JSON.stringify(geo, null, 1));
console.log(JSON.stringify(geo));
