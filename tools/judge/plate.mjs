// Georeference helpers for the judge. Coefficients copied from src/city/overlay.ts
// (LANCIANI_1901) which states them fitted to 1.26 m worst residual over 7 km.
export const LANC = {
  w: 4096, h: 2734,
  ex: 1.70846149, ey: 0.05015993, e0: -3538.9517,
  nx: 0.05027504, ny: -1.71190121, n0: 2244.571,
};
const det = LANC.ex * LANC.ny - LANC.ey * LANC.nx;
/** survey metres -> raster pixel (top-left origin, y down) */
export const pxOf = (e, n) => {
  const de = e - LANC.e0, dn = n - LANC.n0;
  return { px: (LANC.ny * de - LANC.ey * dn) / det, py: (-LANC.nx * de + LANC.ex * dn) / det };
};
export const enOf = (px, py) => ({
  e: LANC.ex * px + LANC.ey * py + LANC.e0,
  n: LANC.nx * px + LANC.ny * py + LANC.n0,
});
// WGS84 -> survey metres, origin Temple of Jupiter OM 41.8925 N 12.4823 E.
// Local scale from the standard series at phi = 41.8925 deg.
export const ORIGIN = { lat: 41.8925, lon: 12.4823 };
export const M_PER_DEG_LAT = 111071.16;
export const M_PER_DEG_LON = 82972.6;
export const enOfLatLon = (lat, lon) => ({
  e: (lon - ORIGIN.lon) * M_PER_DEG_LON,
  n: (lat - ORIGIN.lat) * M_PER_DEG_LAT,
});
export const latLonOfEn = (e, n) => ({
  lat: ORIGIN.lat + n / M_PER_DEG_LAT,
  lon: ORIGIN.lon + e / M_PER_DEG_LON,
});
