import * as THREE from 'three';
import { clamp01 } from '../util/math';

/**
 * CPU mirror of `src/shaders/atmosphere.glsl.ts`.
 *
 * The sun colour, the sky fill colour and the fallback fog tint are all derived
 * here from the same Rayleigh/Mie/ozone integral the dome shader runs, so a low
 * sun automatically reddens the directional light by exactly as much as it
 * reddens the horizon. Anything hand-tuned instead of derived drifts apart the
 * first time somebody changes the time of day.
 *
 * Units: kilometres, per-kilometre. Only ever called when the sun moves, so
 * clarity beats allocation-free micro-optimisation.
 */

const PLANET_R = 6360;
const ATMOS_R = 6460;
const BETA_R = new THREE.Vector3(5.802e-3, 13.558e-3, 33.1e-3);
const BETA_M = 3.996e-3;
const BETA_MA = 4.4e-3;
const BETA_O = new THREE.Vector3(0.65e-3, 1.881e-3, 0.085e-3);
const H_R = 8.0;
const H_M = 1.2;

/**
 * Solar irradiance driving the model.
 *
 * Bruneton's table gives (1.474, 1.8504, 1.912) W/m^2/nm at 680/550/440 nm, but
 * those are three point samples of a spectrum, not a colorimetric integration:
 * used directly they hand the sun a green-blue cast, because the solar spectrum
 * peaks near 500 nm. Every renderer white-balances the sun anyway, so the
 * chromaticity is flattened to neutral and its luminance kept. All colour then
 * comes from the transmittance ratio, which is the part that is actually right.
 */
const SOLAR_IRRADIANCE = new THREE.Vector3(1.775, 1.775, 1.775);

/**
 * Radiance -> render-unit scale. Fixed, not recomputed per time of day, so the
 * sun genuinely dims at dusk instead of being normalised back to full strength.
 * Chosen so a clear noon sun lands on a directional intensity of ~3.0, which is
 * where `MeshStandardMaterial` + AgX at exposure 1 gives a correctly exposed
 * mid-grey ground.
 */
export const RADIANCE_SCALE = 2.1;

/** Peak solar elevation. Rome sits at 41.9 deg N; ~52 deg is a spring/autumn
 *  midday sun, which gives shadows long enough to read the formations. */
const MAX_ELEVATION = (52 * Math.PI) / 180;

export interface AtmosParams {
  /** Unit vector, ground -> sun. */
  sunDir: THREE.Vector3;
  turbidity: number;
  groundAlbedo: number;
  msScale: number;
  mieG: number;
}

export interface SkyPreset {
  hour: number;
  turbidity: number;
  groundAlbedo: number;
  msScale: number;
  /**
   * Cloud edge threshold in units of the noise's standard deviation, centred on
   * 0.5: 0.5 covers half the sky, 0.65 is +1 sigma (~16 %), 0.35 is -1 sigma
   * (~84 %). LOWER means more cloud.
   */
  cloudCoverage: number;
  cloudSoftness: number;
  cloudDensity: number;
  cirrusCoverage: number;
  /** Extinction coefficient of the ground haze, 1/m. */
  hazeDensity: number;
  /** Scale height of the ground haze, metres. */
  hazeHeight: number;
  /**
   * Tone-map exposure. Art direction, not physics. Calibrated so a lit dry-grass
   * ground (linear radiance ~0.24) lands near 0.5 sRGB, with the darker trampled
   * and river-plain materials still legible rather than crushed.
   */
  exposure: number;
  /** How much of the direct sun a full cloud removes. */
  cloudShadowStrength: number;
}

/**
 * Presets. Turbidity is the Linke turbidity factor: 1 is an impossible pristine
 * atmosphere, 2.2 a clear continental day, 4-6 a hazy summer afternoon over a
 * dusty plain, 8+ overcast, 11 a storm front.
 */
export const SKY_PRESETS: Record<string, SkyPreset> = {
  dawn: {
    hour: 6.35, turbidity: 3.4, groundAlbedo: 0.11, msScale: 0.36,
    cloudCoverage: 0.5, cloudSoftness: 0.1, cloudDensity: 7.0, cirrusCoverage: 0.62,
    hazeDensity: 0.00062, hazeHeight: 430, exposure: 1.34, cloudShadowStrength: 0.34,
  },
  morning: {
    hour: 8.8, turbidity: 2.7, groundAlbedo: 0.13, msScale: 0.29,
    cloudCoverage: 0.54, cloudSoftness: 0.09, cloudDensity: 8.0, cirrusCoverage: 0.66,
    hazeDensity: 0.00029, hazeHeight: 640, exposure: 1.18, cloudShadowStrength: 0.34,
  },
  noon: {
    hour: 12.4, turbidity: 2.3, groundAlbedo: 0.14, msScale: 0.27,
    cloudCoverage: 0.57, cloudSoftness: 0.08, cloudDensity: 8.5, cirrusCoverage: 0.7,
    hazeDensity: 0.00024, hazeHeight: 780, exposure: 1.06, cloudShadowStrength: 0.36,
  },
  goldenHour: {
    hour: 17.0, turbidity: 3.1, groundAlbedo: 0.12, msScale: 0.34,
    cloudCoverage: 0.52, cloudSoftness: 0.1, cloudDensity: 7.5, cirrusCoverage: 0.6,
    hazeDensity: 0.00052, hazeHeight: 500, exposure: 1.08, cloudShadowStrength: 0.32,
  },
  overcast: {
    hour: 13.5, turbidity: 7.5, groundAlbedo: 0.12, msScale: 0.72,
    cloudCoverage: 0.2, cloudSoftness: 0.22, cloudDensity: 11.0, cirrusCoverage: 0.34,
    hazeDensity: 0.00085, hazeHeight: 900, exposure: 1.14, cloudShadowStrength: 0.5,
  },
  storm: {
    hour: 16.2, turbidity: 10.5, groundAlbedo: 0.1, msScale: 0.62,
    cloudCoverage: 0.1, cloudSoftness: 0.26, cloudDensity: 14.0, cirrusCoverage: 0.26,
    hazeDensity: 0.00125, hazeHeight: 800, exposure: 1.32, cloudShadowStrength: 0.62,
  },
};

export type SkyPresetName = keyof typeof SKY_PRESETS;

/** Sun direction for an hour of the day, on a Rome-latitude arc. */
export function sunDirectionForHour(hours: number, out: THREE.Vector3): THREE.Vector3 {
  const t = (hours - 6) / 12; // 0 at sunrise, 1 at sunset
  const elev = MAX_ELEVATION * Math.sin(Math.PI * t);
  // Azimuth sweeps east (t=0) -> south (t=0.5) -> west (t=1). In world axes
  // -Z is north (the Juthungi approach), so +Z is south and +X is east.
  const az = Math.PI * t;
  const ce = Math.cos(elev);
  return out.set(ce * Math.cos(az), Math.sin(elev), ce * Math.sin(az)).normalize();
}

function density(h: number): [number, number, number] {
  return [
    Math.exp(-h / H_R),
    Math.exp(-h / H_M),
    Math.max(0, 1 - Math.abs(h - 25) / 15),
  ];
}

function extinction(h: number, turbidity: number, out: THREE.Vector3): THREE.Vector3 {
  const [dr, dm, doz] = density(h);
  const mie = (BETA_M + BETA_MA) * turbidity * dm;
  return out.set(
    BETA_R.x * dr + mie + BETA_O.x * doz,
    BETA_R.y * dr + mie + BETA_O.y * doz,
    BETA_R.z * dr + mie + BETA_O.z * doz,
  );
}

function atmosTopFrom(px: number, py: number, pz: number, d: THREE.Vector3): number {
  const b = px * d.x + py * d.y + pz * d.z;
  const c = px * px + py * py + pz * pz - ATMOS_R * ATMOS_R;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b + Math.sqrt(disc);
}

function groundHitFrom(px: number, py: number, pz: number, d: THREE.Vector3): number {
  const b = px * d.x + py * d.y + pz * d.z;
  const c = px * px + py * py + pz * pz - PLANET_R * PLANET_R;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : -1;
}

const _ext = new THREE.Vector3();

/** Transmittance from a point to the sun. Mirrors `tcSunTransmittance`. */
function sunTransmittanceAt(
  px: number, py: number, pz: number, p: AtmosParams, out: THREE.Vector3,
): THREE.Vector3 {
  if (groundHitFrom(px, py, pz, p.sunDir) > 0) return out.set(0, 0, 0);
  const tTop = atmosTopFrom(px, py, pz, p.sunDir);
  if (tTop <= 0) return out.set(1, 1, 1);
  const ds = tTop / 6;
  let ox = 0;
  let oy = 0;
  let oz = 0;
  for (let i = 0; i < 6; i++) {
    const s = ds * (i + 0.5);
    const qx = px + p.sunDir.x * s;
    const qy = py + p.sunDir.y * s;
    const qz = pz + p.sunDir.z * s;
    const h = Math.sqrt(qx * qx + qy * qy + qz * qz) - PLANET_R;
    extinction(h, p.turbidity, _ext);
    ox += _ext.x * ds;
    oy += _ext.y * ds;
    oz += _ext.z * ds;
  }
  return out.set(Math.exp(-ox), Math.exp(-oy), Math.exp(-oz));
}

const _tr = new THREE.Vector3();

/**
 * Sun irradiance reaching the ground, in render units. Feeds the directional
 * light directly: `sun.color` is this normalised, `sun.intensity` its luminance.
 */
export function sunIrradiance(p: AtmosParams, altitudeMetres: number, out: THREE.Color): number {
  sunTransmittanceAt(0, PLANET_R + altitudeMetres * 0.001, 0, p, _tr);
  const r = SOLAR_IRRADIANCE.x * _tr.x * RADIANCE_SCALE;
  const g = SOLAR_IRRADIANCE.y * _tr.y * RADIANCE_SCALE;
  const b = SOLAR_IRRADIANCE.z * _tr.z * RADIANCE_SCALE;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum <= 1e-5) {
    out.setRGB(0.4, 0.5, 0.8);
    return 0;
  }
  out.setRGB(r / lum, g / lum, b / lum);
  return lum;
}

function phaseR(mu: number): number {
  return (3 / (16 * Math.PI)) * (1 + mu * mu);
}

function phaseM(mu: number, g: number): number {
  const g2 = g * g;
  const d = 1 + g2 - 2 * g * mu;
  return (1 - g2) / (4 * Math.PI * Math.max(1e-4, d * Math.sqrt(Math.max(1e-4, d))));
}

const _sunT = new THREE.Vector3();

/**
 * Sky radiance along `dir` from an origin at `altitudeMetres`, in render units.
 * Mirrors `tcSkyRadiance` (20 view steps, 6 light steps).
 */
export function skyRadiance(
  dir: THREE.Vector3, p: AtmosParams, altitudeMetres: number, out: THREE.Color,
): THREE.Color {
  const oy = PLANET_R + Math.max(0, altitudeMetres) * 0.001;
  const tTop = atmosTopFrom(0, oy, 0, dir);
  if (tTop <= 0) return out.setRGB(0, 0, 0);
  const tGround = groundHitFrom(0, oy, 0, dir);
  const hitGround = tGround > 0;
  const tMax = hitGround ? tGround : tTop;

  const mu = dir.y * p.sunDir.y + dir.x * p.sunDir.x + dir.z * p.sunDir.z;
  const phR = phaseR(mu);
  const phM = phaseM(mu, p.mieG);
  const isoMs = p.msScale / Math.PI; // matches the GLSL: msScale * (1/4pi) * 4

  const steps = 20;
  const ds = tMax / steps;
  let lr = 0;
  let lg = 0;
  let lb = 0;
  let tr = 1;
  let tg = 1;
  let tb = 1;

  for (let i = 0; i < steps; i++) {
    const s = ds * (i + 0.5);
    const px = dir.x * s;
    const py = oy + dir.y * s;
    const pz = dir.z * s;
    const h = Math.sqrt(px * px + py * py + pz * pz) - PLANET_R;
    const [dr, dm, doz] = density(h);

    const sRr = BETA_R.x * dr;
    const sRg = BETA_R.y * dr;
    const sRb = BETA_R.z * dr;
    const sM = BETA_M * p.turbidity * dm;
    const mieExt = (BETA_M + BETA_MA) * p.turbidity * dm;
    const er = sRr + mieExt + BETA_O.x * doz;
    const eg = sRg + mieExt + BETA_O.y * doz;
    const eb = sRb + mieExt + BETA_O.z * doz;

    sunTransmittanceAt(px, py, pz, p, _sunT);
    const srcR = ((sRr * phR + sM * phM) + (sRr + sM) * isoMs) * _sunT.x;
    const srcG = ((sRg * phR + sM * phM) + (sRg + sM) * isoMs) * _sunT.y;
    const srcB = ((sRb * phR + sM * phM) + (sRb + sM) * isoMs) * _sunT.z;

    const str = Math.exp(-er * ds);
    const stg = Math.exp(-eg * ds);
    const stb = Math.exp(-eb * ds);
    lr += (tr * (srcR - srcR * str)) / Math.max(er, 1e-7);
    lg += (tg * (srcG - srcG * stg)) / Math.max(eg, 1e-7);
    lb += (tb * (srcB - srcB * stb)) / Math.max(eb, 1e-7);
    tr *= str;
    tg *= stg;
    tb *= stb;
  }

  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  if (hitGround) {
    const px = dir.x * tGround;
    const py = oy + dir.y * tGround;
    const pz = dir.z * tGround;
    const inv = 1 / Math.sqrt(px * px + py * py + pz * pz);
    const ndl = Math.max(0, (px * inv) * p.sunDir.x + (py * inv) * p.sunDir.y + (pz * inv) * p.sunDir.z);
    sunTransmittanceAt(px, py, pz, p, _sunT);
    const k = p.groundAlbedo;
    bgR = k * SOLAR_IRRADIANCE.x * ((ndl * _sunT.x) / Math.PI + 0.02);
    bgG = k * SOLAR_IRRADIANCE.y * ((ndl * _sunT.y) / Math.PI + 0.02);
    bgB = k * SOLAR_IRRADIANCE.z * ((ndl * _sunT.z) / Math.PI + 0.02);
  }

  return out.setRGB(
    (lr * SOLAR_IRRADIANCE.x + bgR * tr) * RADIANCE_SCALE,
    (lg * SOLAR_IRRADIANCE.y + bgG * tg) * RADIANCE_SCALE,
    (lb * SOLAR_IRRADIANCE.z + bgB * tb) * RADIANCE_SCALE,
  );
}

const _dir = new THREE.Vector3();
const _rad = new THREE.Color();

/**
 * Cosine-weighted average sky radiance over the upper hemisphere — the correct
 * value for a `HemisphereLight`'s sky colour. Sampled on a 4x8 Fibonacci-ish
 * grid; 32 samples is plenty for a function this smooth.
 */
export function skyFillRadiance(p: AtmosParams, altitudeMetres: number, out: THREE.Color): void {
  let r = 0;
  let g = 0;
  let b = 0;
  let wsum = 0;
  const rings = 4;
  const spokes = 8;
  for (let i = 0; i < rings; i++) {
    // Equal-area rings in cos(theta) so the weighting is already cosine-correct.
    const cz = (i + 0.5) / rings;
    const st = Math.sqrt(Math.max(0, 1 - cz * cz));
    for (let j = 0; j < spokes; j++) {
      const a = ((j + 0.5) / spokes) * Math.PI * 2;
      _dir.set(Math.cos(a) * st, cz, Math.sin(a) * st);
      skyRadiance(_dir, p, altitudeMetres, _rad);
      r += _rad.r;
      g += _rad.g;
      b += _rad.b;
      wsum += 1;
    }
  }
  out.setRGB(r / wsum, g / wsum, b / wsum);
}

/** Average horizon radiance — the fallback `FogExp2` colour. */
export function horizonRadiance(p: AtmosParams, altitudeMetres: number, out: THREE.Color): void {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = 8;
  for (let j = 0; j < n; j++) {
    const a = (j / n) * Math.PI * 2;
    // 1.5 deg above the horizon: exactly at 0 the ray grazes the planet and the
    // ground-bounce term makes the result jump.
    _dir.set(Math.cos(a) * 0.9997, 0.0262, Math.sin(a) * 0.9997).normalize();
    skyRadiance(_dir, p, altitudeMetres, _rad);
    r += _rad.r;
    g += _rad.g;
    b += _rad.b;
  }
  out.setRGB(r / n, g / n, b / n);
}

/** Interpolate two presets so `setTimeOfDay` between named times stays coherent. */
export function blendPresets(a: SkyPreset, b: SkyPreset, t: number): SkyPreset {
  const k = clamp01(t);
  const mix = (x: number, y: number): number => x + (y - x) * k;
  return {
    hour: mix(a.hour, b.hour),
    turbidity: mix(a.turbidity, b.turbidity),
    groundAlbedo: mix(a.groundAlbedo, b.groundAlbedo),
    msScale: mix(a.msScale, b.msScale),
    cloudCoverage: mix(a.cloudCoverage, b.cloudCoverage),
    cloudSoftness: mix(a.cloudSoftness, b.cloudSoftness),
    cloudDensity: mix(a.cloudDensity, b.cloudDensity),
    cirrusCoverage: mix(a.cirrusCoverage, b.cirrusCoverage),
    hazeDensity: mix(a.hazeDensity, b.hazeDensity),
    hazeHeight: mix(a.hazeHeight, b.hazeHeight),
    exposure: mix(a.exposure, b.exposure),
    cloudShadowStrength: mix(a.cloudShadowStrength, b.cloudShadowStrength),
  };
}
