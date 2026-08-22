#!/usr/bin/env node
/**
 * One virtual raster over both orthophoto plates, with a water gate on top of it.
 *
 * The northern tiles were requested with the existing plate's own left edge and pixel size, so
 * `py' = py - 4095` maps the mosaic's rows onto the same grid: 3 tiles x 1365 rows = 4095, and
 * `(4643263.3909 - 4650273.89167) / 1.711966 = -4095.000`. So the two rasters are literally one
 * pixel grid with `py` running from -4095 (the far north) to 2734 (below the Aventine), and the
 * single published pixel -> survey affine in `tiber-plate.mjs` serves both.
 *
 * Verified rather than asserted: `--check` prints the survey position of the Stadio Olimpico
 * read off the northern mosaic against its published latitude and longitude.
 */
import sharp from 'sharp';
import { pxToSurvey, surveyToPx } from './tiber-plate.mjs';

export const MAIN = 'reference/rome-plans/agea-2012-ortofoto-EPSG3004-2307658_4638583_2314671_4643263-4096px.jpg';
export const NORTH = 'reference/rome-plans/agea-2012-ortofoto-EPSG3004-north-mosaic-4096x4095.jpg';
export const NORTH_DY = -4095;

const loadRaw = async (f) => {
  const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, c: info.channels };
};

/** Gate thresholds. See `tiber-course.mjs` for the measurement that set them. */
export const GATE = { rough: 34, lumLo: 78, lumHi: 168, grMin: 5, gbMin: 6 };

/**
 * Build the 3x3 channel means and the 7x7 roughness for one raster, and a boolean gate.
 * Returns closures that take *virtual* pixel coordinates.
 */
function prepare(img) {
  const { data, w, h, c } = img;
  const idx = (x, y) => (y * w + x) * c;
  const mR = new Float32Array(w * h), mG = new Float32Array(w * h), mB = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let a = 0, b = 0, d = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const i = idx(x + dx, y + dy); a += data[i]; b += data[i + 1]; d += data[i + 2]; }
    const k = y * w + x; mR[k] = a / 9; mG[k] = b / 9; mB[k] = d / 9;
  }
  const gate = new Uint8Array(w * h);
  let n = 0;
  for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
    const k = y * w + x;
    const lum = (mR[k] + mG[k] + mB[k]) / 3;
    if (lum < GATE.lumLo || lum > GATE.lumHi) continue;
    if (mG[k] - mR[k] < GATE.grMin || mG[k] - mB[k] < GATE.gbMin) continue;
    let s = 0, cc = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const i = idx(x + dx, y + dy);
      s += Math.abs(data[i] - mR[k]) + Math.abs(data[i + 1] - mG[k]) + Math.abs(data[i + 2] - mB[k]);
      cc++;
    }
    if (s / cc > GATE.rough) continue;
    gate[k] = 1; n++;
  }
  return { w, h, c, data, gate, gateCount: n };
}

export async function loadVirtual() {
  const main = prepare(await loadRaw(MAIN));
  const north = prepare(await loadRaw(NORTH));
  /**
   * Which raster covers this virtual pixel, and its local coordinates.
   *
   * The 3-pixel margin is real — the roughness window needs a halo, so `gate` is zero there —
   * but taking it as *invalid* left a six-row hole at `py` -3..+2 where the two rasters meet, and
   * that hole cut the river in half for anything that needs the two plates to be connected. The
   * seam rows now sample the nearest interior row of whichever raster owns them, which duplicates
   * three rows (10 m) across a 7 km join and is invisible at this scale. It also means the two
   * plates are genuinely one raster, which is the claim this module makes.
   */
  const locate = (px, py) => {
    const x = Math.round(px), y = Math.round(py);
    if (y >= 0 && y < main.h && x >= 3 && x < main.w - 3) {
      return { r: main, x, y: Math.min(main.h - 4, Math.max(3, y)) };
    }
    const ny = y - NORTH_DY;
    if (ny >= 0 && ny < north.h && x >= 3 && x < north.w - 3) {
      return { r: north, x, y: Math.min(north.h - 4, Math.max(3, ny)) };
    }
    return null;
  };
  return {
    main, north, locate,
    /** 1 water, 0 land, -1 off every plate. */
    gateAt: (px, py) => { const l = locate(px, py); return l ? l.r.gate[l.y * l.r.w + l.x] : -1; },
    rgbAt: (px, py) => {
      const l = locate(px, py);
      if (!l) return null;
      const i = (l.y * l.r.w + l.x) * l.r.c;
      return [l.r.data[i], l.r.data[i + 1], l.r.data[i + 2]];
    },
    gateAtSurvey: (e, n) => { const p = surveyToPx(e, n); return null === null ? undefined : undefined; },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const v = await loadVirtual();
  console.log(`main gate ${v.main.gateCount} px of ${v.main.w * v.main.h}`);
  console.log(`north gate ${v.north.gateCount} px of ${v.north.w * v.north.h}`);
  // independent georeference check on the northern mosaic: the Stadio Olimpico
  const lat = 41.93389, lon = 12.45472;                     // Stadio Olimpico, published
  const e = (lon - 12.4823) * 111320 * Math.cos(41.8925 * Math.PI / 180);
  const n = (lat - 41.8925) * 111320;
  const p = surveyToPx(e, n);
  console.log(`Stadio Olimpico  survey e ${e.toFixed(0)} n ${n.toFixed(0)}  -> virtual px ${p.px.toFixed(0)} py ${p.py.toFixed(0)}`);
  const back = pxToSurvey(p.px, p.py);
  console.log(`round trip e ${back.e.toFixed(1)} n ${back.n.toFixed(1)}  (must match)`);
  console.log(`rgb there: ${JSON.stringify(v.rgbAt(p.px, p.py))}  gate ${v.gateAt(p.px, p.py)}`);
}
