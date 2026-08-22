#!/usr/bin/env node
/**
 * The plate frame, re-derived rather than imported — shared by the Tiber re-survey scripts.
 *
 * `src/city/overlay.ts` carries a 6-parameter affine from raster pixels to survey metres,
 * fitted against a full inverse of EPSG:3004 over a 13x13 grid and good to 1.26 m over 7 km.
 * The numbers are restated here on purpose: `MAP-METHOD.md` rule 6 says an instrument must
 * compare against something outside the thing it is grading, and the point of these scripts
 * is to grade the engine's river against the plate. Importing the engine's own copy of the
 * georeference would still be honest (it is upstream of the projection), but restating it
 * costs six lines and removes the question.
 *
 * Both rasters share one bbox, one size and one CRS, so pixel (px, py) is the same ground in
 * the Lanciani plan and in the AGEA orthophoto.
 */
export const PLATE = {
  widthPx: 4096,
  heightPx: 2734,
  ex: 1.70846149,
  ey: 0.05015993,
  e0: -3538.9517,
  nx: 0.05027504,
  ny: -1.71190121,
  n0: 2244.571,
};

/** Raster pixel -> survey metres east/north of the Temple of Jupiter OM. */
export const pxToSurvey = (px, py) => ({
  e: PLATE.ex * px + PLATE.ey * py + PLATE.e0,
  n: PLATE.nx * px + PLATE.ny * py + PLATE.n0,
});

const DET = PLATE.ex * PLATE.ny - PLATE.ey * PLATE.nx;

/** Survey metres -> raster pixel (float). */
export const surveyToPx = (e, n) => {
  const de = e - PLATE.e0;
  const dn = n - PLATE.n0;
  return {
    px: (de * PLATE.ny - PLATE.ey * dn) / DET,
    py: (PLATE.ex * dn - de * PLATE.nx) / DET,
  };
};

/** Metres of ground per pixel, from the affine's own column norms. */
export const M_PER_PX = Math.hypot(PLATE.ex, PLATE.nx);

/**
 * The world projection, re-derived from its two published anchors exactly as
 * `tools/scratch/rome-frame.mjs` does, so nothing here imports the module under test.
 * `GATE_X`/`GATE_Z` are the Porta Flaminia's world position; `PORTA_FLAMINIA_E/N` its survey
 * position. `KX` is fixed by the circuit; `KZ` is Phase 1's 0.35.
 */
export const KX = 0.443;
export const KZ = 0.35;
const GATE_X = 72.0;
const GATE_Z = 530.0;
const PORTA_FLAMINIA_E = -497;
const PORTA_FLAMINIA_N = 2045;
export const X0 = GATE_X - KX * PORTA_FLAMINIA_E;
export const Z0 = GATE_Z + KZ * PORTA_FLAMINIA_N;
export const worldOf = (e, n) => ({ x: X0 + KX * e, z: Z0 - KZ * n });
export const surveyOf = (x, z) => ({ e: (x - X0) / KX, n: (Z0 - z) / KZ });

export const HALF_EXTENT = 1400;

/** Latitude/longitude -> survey metres, the same two constants `survey.ts` uses. */
export const LAT0 = 41.8925;
export const LON0 = 12.4823;
export const MLAT = 111320;
export const MLON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
export const surveyOfLatLon = (lat, lon) => ({
  e: (lon - LON0) * MLON,
  n: (lat - LAT0) * MLAT,
});
