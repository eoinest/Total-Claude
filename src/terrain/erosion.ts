import type { Rng } from '../util/rand';

/**
 * Droplet (particle) hydraulic erosion.
 *
 * fBm alone produces "noise with a colour ramp": every valley is symmetric, nothing
 * drains anywhere, and ridges have no sense of having been cut by water. Running a few
 * hundred thousand water particles downhill fixes all three — they cut V-profiles into
 * the steep ground, deposit what they carry as fans where the slope flattens, and
 * connect the drainage so a gully at the top of a hill actually leads somewhere.
 *
 * The model is the standard capacity-based one (Mei et al. / Beyer, as popularised by
 * Sebastian Lague): a particle carries sediment up to a capacity proportional to slope
 * × speed × water, erodes when under capacity and deposits when over.
 *
 * By-products are as valuable as the height change: the water-volume field tells the
 * splat map where the ground is permanently damp, the erosion field where bedrock is
 * exposed, and the deposition field where silt and sand have collected.
 */

export interface ErosionParams {
  droplets: number;
  /** Maximum steps before a particle is retired. */
  maxLifetime: number;
  /** 0 = follow the gradient exactly, 1 = ignore it. Low values carve, high values meander. */
  inertia: number;
  /** Sediment carried per unit of (slope × speed × water). */
  capacity: number;
  /** Floor on capacity so particles on flat ground still move a little material. */
  minCapacity: number;
  erodeRate: number;
  depositRate: number;
  evaporation: number;
  gravity: number;
  /** Radius in cells over which a particle's erosion is spread. 0 = single cell. */
  brushRadius: number;
  /** Fraction of particles spawned inside `hillRegion` instead of uniformly. */
  hillBias: number;
}

export const DEFAULT_EROSION: ErosionParams = {
  droplets: 110_000,
  maxLifetime: 44,
  inertia: 0.055,
  capacity: 3.4,
  minCapacity: 0.012,
  erodeRate: 0.34,
  depositRate: 0.32,
  evaporation: 0.021,
  gravity: 5.2,
  brushRadius: 2,
  hillBias: 0.62,
};

export interface ErosionMaps {
  /** Accumulated water volume that passed through each cell — a drainage/wetness proxy. */
  flow: Float32Array;
  /** Total material removed from each cell. */
  eroded: Float32Array;
  /** Total material deposited into each cell. */
  deposited: Float32Array;
}

/**
 * Erode `h` in place.
 *
 * `hillRegion(i, j)` returns 1 where particles should preferentially spawn (the sloping
 * ground) — biasing spawns there spends the particle budget where erosion is visible
 * instead of on the dead-flat flood plain.
 */
export function hydraulicErode(
  h: Float32Array,
  res: number,
  rng: Rng,
  hillRegion: (i: number, j: number) => number,
  params: Partial<ErosionParams> = {}
): ErosionMaps {
  const p: ErosionParams = { ...DEFAULT_EROSION, ...params };
  const n = res * res;
  const flow = new Float32Array(n);
  const eroded = new Float32Array(n);
  const deposited = new Float32Array(n);

  // --- Erosion brush -------------------------------------------------------
  // Spreading each particle's bite over a disc stops single-cell pits, which show up
  // as sparkling black specks once normals are derived from the heightfield.
  const r = p.brushRadius;
  const offs: number[] = [];
  const wts: number[] = [];
  let wsum = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > r + 0.5) continue;
      const w = 1 - d / (r + 1);
      offs.push(dx, dy);
      wts.push(w);
      wsum += w;
    }
  }
  for (let i = 0; i < wts.length; i++) wts[i] /= wsum;
  const brushCount = wts.length;

  // --- Spawn table ---------------------------------------------------------
  // Precompute a list of candidate hill cells once so biased spawning is O(1).
  const hillCells: number[] = [];
  for (let j = 2; j < res - 2; j++) {
    for (let i = 2; i < res - 2; i++) {
      if (hillRegion(i, j) > 0.45) hillCells.push(j * res + i);
    }
  }
  const haveHills = hillCells.length > 32;

  const maxIdx = res - 2.001;

  for (let d = 0; d < p.droplets; d++) {
    let px: number;
    let py: number;
    if (haveHills && rng.next() < p.hillBias) {
      const c = hillCells[(rng.next() * hillCells.length) | 0];
      px = (c % res) + rng.next();
      py = ((c / res) | 0) + rng.next();
    } else {
      px = 2 + rng.next() * (res - 5);
      py = 2 + rng.next() * (res - 5);
    }

    let dirX = 0;
    let dirY = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let life = 0; life < p.maxLifetime; life++) {
      const nx = px | 0;
      const ny = py | 0;
      const cx = px - nx;
      const cy = py - ny;
      const base = ny * res + nx;

      const h00 = h[base];
      const h10 = h[base + 1];
      const h01 = h[base + res];
      const h11 = h[base + res + 1];

      // Bilinear height and its analytic gradient.
      const gx = (h10 - h00) * (1 - cy) + (h11 - h01) * cy;
      const gy = (h01 - h00) * (1 - cx) + (h11 - h10) * cx;
      const height =
        h00 * (1 - cx) * (1 - cy) + h10 * cx * (1 - cy) + h01 * (1 - cx) * cy + h11 * cx * cy;

      dirX = dirX * p.inertia - gx * (1 - p.inertia);
      dirY = dirY * p.inertia - gy * (1 - p.inertia);
      const dl = Math.hypot(dirX, dirY);
      if (dl < 1e-6) break;
      dirX /= dl;
      dirY /= dl;

      px += dirX;
      py += dirY;
      if (px < 1 || py < 1 || px > maxIdx || py > maxIdx) break;

      // Height at the new position, same bilinear scheme.
      const mx = px | 0;
      const my = py | 0;
      const fx = px - mx;
      const fy = py - my;
      const nb = my * res + mx;
      const newHeight =
        h[nb] * (1 - fx) * (1 - fy) +
        h[nb + 1] * fx * (1 - fy) +
        h[nb + res] * (1 - fx) * fy +
        h[nb + res + 1] * fx * fy;
      const deltaH = newHeight - height;

      const cap = Math.max(-deltaH * speed * water * p.capacity, p.minCapacity);

      if (sediment > cap || deltaH > 0) {
        // Uphill or over capacity: drop material. Going uphill it can only fill the
        // step it just tried to climb, which is what builds up valley floors and fans.
        const drop = deltaH > 0 ? Math.min(deltaH, sediment) : (sediment - cap) * p.depositRate;
        sediment -= drop;
        const w00 = (1 - cx) * (1 - cy);
        const w10 = cx * (1 - cy);
        const w01 = (1 - cx) * cy;
        const w11 = cx * cy;
        h[base] += drop * w00;
        h[base + 1] += drop * w10;
        h[base + res] += drop * w01;
        h[base + res + 1] += drop * w11;
        deposited[base] += drop * w00;
        deposited[base + 1] += drop * w10;
        deposited[base + res] += drop * w01;
        deposited[base + res + 1] += drop * w11;
      } else {
        // Under capacity on a downhill step: bite, but never more than the step itself
        // or the particle digs a shaft.
        const bite = Math.min((cap - sediment) * p.erodeRate, -deltaH);
        for (let b = 0; b < brushCount; b++) {
          const bx = nx + offs[b * 2];
          const by = ny + offs[b * 2 + 1];
          if (bx < 0 || by < 0 || bx >= res || by >= res) continue;
          const bi = by * res + bx;
          const amt = bite * wts[b];
          h[bi] -= amt;
          eroded[bi] += amt;
        }
        sediment += bite;
      }

      // Falling water speeds up; `deltaH` is negative downhill.
      speed = Math.sqrt(Math.max(0, speed * speed - deltaH * p.gravity));
      water *= 1 - p.evaporation;
      flow[base] += water;
    }
  }

  return { flow, eroded, deposited };
}

/** Small separable box blur, used to take the particle noise off the by-product maps. */
export function blurField(src: Float32Array, res: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const w = radius * 2 + 1;
  for (let j = 0; j < res; j++) {
    const row = j * res;
    for (let i = 0; i < res; i++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) {
        const x = i + k;
        s += src[row + (x < 0 ? 0 : x >= res ? res - 1 : x)];
      }
      tmp[row + i] = s / w;
    }
  }
  for (let i = 0; i < res; i++) {
    for (let j = 0; j < res; j++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) {
        const y = j + k;
        s += tmp[(y < 0 ? 0 : y >= res ? res - 1 : y) * res + i];
      }
      out[j * res + i] = s / w;
    }
  }
  return out;
}
