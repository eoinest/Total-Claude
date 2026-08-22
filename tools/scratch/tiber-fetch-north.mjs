#!/usr/bin/env node
/**
 * Fetch the **northern extension** of the AGEA 2012 orthophoto, from the same service, layer,
 * CRS and licence as `ASSETS.md` item 8.
 *
 * Why: the georeferenced plate the repo already has spans survey n -2436..+2450, i.e. world
 * z 388..1400 at `KZ` = 0.35. The battlefield runs z -1400..+1400, so **1 788 world metres of
 * the map's river — including the ford at z -520 and the whole attacker's approach — is north
 * of every plate in `reference/`.** Phase 1's answer was a run-out on the mean bearing. That is
 * an extrapolation, and the whole point of this pass is that extrapolation between real points
 * is what bent the river the wrong way.
 *
 * Licence check re-run this pass against the live GetCapabilities before a byte was fetched:
 *   <Fees>Nessuna condizione applicata</Fees>
 *   <AccessConstraints>Nessuno</AccessConstraints>
 * which is verbatim what `ASSETS.md` item 8 records. Attribution: AGEA / Geoportale Nazionale
 * — MASE, CC BY 4.0. Nothing ships; `reference/` is gitignored and carries
 * `.metadata_never_index`.
 *
 * Tiling: the service caps WIDTH/HEIGHT at 2048. Tiles are laid out so that their left edge and
 * their pixel size match the existing plate exactly — X0 = 2307658.1627, 1.712209 m/px — so one
 * EPSG:3004 -> survey affine serves the whole mosaic. Each tile is held in memory and written
 * only after its leading and trailing container bytes both match JPEG.
 *
 *   node tools/scratch/tiber-fetch-north.mjs
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const HOST = 'http://wms.pcn.minambiente.it/ogc?map=/ms_ogc/WMS_v1.3/raster/ortofoto_colore_12.map';
const LAYER = 'OI.ORTOIMMAGINI.2012.33';
const X0 = 2307658.1627;
const MPP_X = 1.712209;
const MPP_Y = 1.711966;
const TILE_W = 2048;
const TILE_H = 1365;
const Y_BASE = 4643263.3909; // top edge of the existing plate
const COLS = Number(process.argv.find((a) => a.startsWith('--cols='))?.split('=')[1] ?? 1);
const ROWS = Number(process.argv.find((a) => a.startsWith('--rows='))?.split('=')[1] ?? 3);

const out = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    const minx = X0 + c * TILE_W * MPP_X;
    const maxx = minx + TILE_W * MPP_X;
    const miny = Y_BASE + r * TILE_H * MPP_Y;
    const maxy = miny + TILE_H * MPP_Y;
    const url = `${HOST}&service=WMS&version=1.1.1&request=GetMap&layers=${LAYER}`
      + `&styles=&srs=EPSG:3004&bbox=${minx},${miny},${maxx},${maxy}`
      + `&width=${TILE_W}&height=${TILE_H}&format=image/jpeg`;
    process.stderr.write(`r${r}c${c} bbox ${minx.toFixed(1)},${miny.toFixed(1)},${maxx.toFixed(1)},${maxy.toFixed(1)} ... `);
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
      && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
    if (!res.ok || !isJpeg) {
      console.error(`FAIL http ${res.status} ${buf.length} bytes, jpeg=${isJpeg}: ${buf.slice(0, 200).toString('latin1')}`);
      continue;
    }
    const name = `reference/rome-plans/agea-2012-ortofoto-EPSG3004-north-r${r}c${c}-${Math.round(minx)}_${Math.round(miny)}-2048px.jpg`;
    fs.writeFileSync(name, buf);
    const sha = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    console.error(`ok ${buf.length} bytes sha256 ${sha}`);
    out.push({ r, c, minx, miny, maxx, maxy, file: name, bytes: buf.length, sha256: sha });
  }
}
fs.writeFileSync('tools/scratch/tiber-north-tiles.json', JSON.stringify({
  service: HOST, layer: LAYER, srs: 'EPSG:3004', tileW: TILE_W, tileH: TILE_H,
  mppX: MPP_X, mppY: MPP_Y, tiles: out,
}, null, 1));
console.error(`wrote tools/scratch/tiber-north-tiles.json (${out.length} tiles)`);
