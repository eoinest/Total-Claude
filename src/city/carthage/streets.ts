import * as THREE from 'three';
import type { Batch } from '../build';
import type { Lane } from '../cityPlan';
import type { WayClass } from '../layout';
import type { CityChunkSpec } from '../wall';
import { MONUMENTS, PUNIC_WAYS } from './layout';
import { PUN, tinted } from './palette';
import { clamp, lerp } from '../../util/math';
import { hash2 } from '../../util/rand';

/**
 * The street surfaces.
 *
 * ## Two lessons from Rome's streets are designed into this file
 *
 * **The quilt was a figure-ground inversion, not a palette problem.** Rome lays a district
 * floor under each quarter and then a carriageway on top of it, and the two ran within a
 * few per cent of each other in luminance — so no amount of greying the road could ever
 * have made the network legible, because there was nothing for it to be legible *against*.
 * Carthage lays **no quarter floor at all**. The ground under the fabric is the terrain,
 * and the paved carriageway is `PUN.paving` — a grey limestone at 0.32 linear against dry
 * North African ground at 0.45-0.55. The figure is lighter or darker than the ground by a
 * factor, not by a few per cent, and it stays that way whatever the terrain does.
 *
 * **The section is what makes a plan read as a street.** A flat quad of colour on the
 * ground is a stain. A carriageway between two raised kerbs is a road at any zoom, because
 * the kerb line is a continuous highlight that traces the route through the fabric. Punic
 * streets at the Byrsa have exactly this: a metalled centre between raised sandstone kerbs,
 * with the cross-streets *stepped* where the slope demands it.
 */

/** Kerb width, by rank. Never zero: the kerb is the thread the eye follows. */
function kerbWidth(cls: WayClass, width: number): number {
  return clamp(width * 0.12, 0.7, 2.6);
}

/** Is this point inside a monument that lays its own floor? Then do not pave over it. */
function onMonumentFloor(x: number, z: number): boolean {
  for (const m of MONUMENTS) {
    if (m.solid) continue;
    const cs = Math.cos(m.rot);
    const sn = Math.sin(m.rot);
    const dx = x - m.x;
    const dz = z - m.z;
    if (Math.abs(dx * cs + dz * sn) <= m.hw && Math.abs(-dx * sn + dz * cs) <= m.hd) return true;
  }
  return false;
}

interface Ribbon {
  path: readonly { x: number; z: number }[];
  width: number;
  cls: WayClass;
  paved: boolean;
  /** §5.3: the three streets up the Byrsa are stepped, and a formation breaks on them. */
  stepped?: boolean;
}

function ribbon(
  b: Batch, r: Ribbon, detail: number, heightAt: (x: number, z: number) => number, salt: number
): void {
  const st = b.s('road');
  const trim = detail >= 1 ? b.s('stone') : st;
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const up = new THREE.Vector3(0, 1, 0);
  const foot = kerbWidth(r.cls, r.width);
  const road = r.width * 0.5 - foot;
  const kerbH = r.cls === 'vicus' ? 0.18 : 0.3;
  const surface = r.paved ? PUN.paving : PUN.earth;

  for (let s = 0; s + 1 < r.path.length; s++) {
    const a = r.path[s];
    const c = r.path[s + 1];
    const len = Math.sqrt((c.x - a.x) * (c.x - a.x) + (c.z - a.z) * (c.z - a.z));
    if (len < 0.5) continue;
    // A stepped street is sampled at its 1.2 m tread, so every riser is a real riser.
    const n = Math.max(1, Math.round(len / (r.stepped ? 1.2 : detail >= 1 ? 12 : 34)));
    const dx = (c.x - a.x) / len;
    const dz = (c.z - a.z) / len;
    const nx = -dz;
    const nz = dx;
    for (let i = 0; i < n; i++) {
      const ax = lerp(a.x, c.x, i / n);
      const az = lerp(a.z, c.z, i / n);
      const bx = lerp(a.x, c.x, (i + 1) / n);
      const bz = lerp(a.z, c.z, (i + 1) / n);
      if (onMonumentFloor((ax + bx) * 0.5, (az + bz) * 0.5)) continue;
      let ya = heightAt(ax, az) + 0.06;
      let yb = heightAt(bx, bz) + 0.06;
      /**
       * A stepped street is level treads and vertical risers, not a ramp with lines on it.
       *
       * §5.3 and §7.1: the Byrsa streets climb 45 m at a built 26% and carry in-situ flights
       * of steps; wheeled traffic and every siege engine is excluded, and a cohort going up
       * arrives as a mob. Quantising the ribbon's own height to a 0.17 m riser is what makes
       * that legible from above — a flight of treads catches the sun in bands where a ramp
       * is one flat tone, and it is the same 1.2 m tread the excavation measures.
       */
      if (r.stepped) {
        const RISER = 0.17;
        ya = Math.round(ya / RISER) * RISER;
        yb = Math.round(yb / RISER) * RISER;
        if (Math.abs(yb - ya) > 0.01) {
          // The riser face, spanning the whole carriageway.
          const rn = new THREE.Vector3(-dx, 0, -dz);
          p[0].set(bx - nx * road, Math.min(ya, yb), bz - nz * road);
          p[1].set(bx + nx * road, Math.min(ya, yb), bz + nz * road);
          p[2].set(bx + nx * road, Math.max(ya, yb), bz + nz * road);
          p[3].set(bx - nx * road, Math.max(ya, yb), bz - nz * road);
          trim.quadN(rn, p[0], p[1], p[2], p[3], tinted(PUN.sandstoneDark, 0.4, 0.12));
        }
        yb = ya;
      }
      const tint = tinted(surface, hash2(i, salt + s, 0x71), 0.13);
      // Carriageway.
      p[0].set(ax - nx * road, ya, az - nz * road);
      p[1].set(bx - nx * road, yb, bz - nz * road);
      p[2].set(bx + nx * road, yb, bz + nz * road);
      p[3].set(ax + nx * road, ya, az + nz * road);
      st.quadN(up, p[0], p[1], p[2], p[3], tint);
      // Kerbs, both sides, raised. This is the thread.
      for (const sgn of [-1, 1]) {
        const o0 = road * sgn;
        const o1 = (road + foot) * sgn;
        const kc = tinted(PUN.sandstonePale, hash2(i, salt + sgn, 0x72), 0.1);
        p[0].set(ax + nx * o0, ya + kerbH, az + nz * o0);
        p[1].set(bx + nx * o0, yb + kerbH, bz + nz * o0);
        p[2].set(bx + nx * o1, yb + kerbH, bz + nz * o1);
        p[3].set(ax + nx * o1, ya + kerbH, az + nz * o1);
        trim.quadN(up, p[0], p[1], p[2], p[3], kc);
        // The kerb face, which is the shadow line that makes the highlight read.
        const fn = new THREE.Vector3(-nx * sgn, 0, -nz * sgn);
        p[0].set(ax + nx * o0, ya, az + nz * o0);
        p[1].set(bx + nx * o0, yb, bz + nz * o0);
        p[2].set(bx + nx * o0, yb + kerbH, bz + nz * o0);
        p[3].set(ax + nx * o0, ya + kerbH, az + nz * o0);
        trim.quadN(fn, p[0], p[1], p[2], p[3], kc.clone().multiplyScalar(0.7));
      }
    }
  }
}

/**
 * Chunked so LOD fires: one chunk per 300 m band of x, which keeps every street chunk's
 * radius under 200 m. The whole network is two materials, so a band costs two draws at full
 * detail and one at range.
 */
export function buildStreets(
  heightAt: (x: number, z: number) => number,
  lanes: readonly Lane[]
): CityChunkSpec[] {
  const all: Ribbon[] = [];
  for (const w of PUNIC_WAYS) {
    all.push({ path: w.path, width: w.width, cls: w.cls, paved: w.paved, stepped: w.stepped });
  }
  for (const l of lanes) all.push({ path: l.path, width: l.width, cls: l.cls, paved: l.cls === 'local' });

  // Bin by the midpoint of each ribbon so a chunk's members are actually near each other.
  const BAND = 300;
  const bins = new Map<string, Ribbon[]>();
  for (const r of all) {
    let mx = 0;
    let mz = 0;
    for (const q of r.path) { mx += q.x; mz += q.z; }
    mx /= r.path.length;
    mz /= r.path.length;
    const key = `${Math.floor(mx / BAND)},${Math.floor(mz / BAND)}`;
    let list = bins.get(key);
    if (!list) bins.set(key, (list = []));
    list.push(r);
  }

  const chunks: CityChunkSpec[] = [];
  let salt = 0;
  for (const [key, list] of bins) {
    salt += 977;
    const mySalt = salt;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const r of list) {
      for (const q of r.path) {
        minX = Math.min(minX, q.x - r.width);
        maxX = Math.max(maxX, q.x + r.width);
        minZ = Math.min(minZ, q.z - r.width);
        maxZ = Math.max(maxZ, q.z + r.width);
      }
    }
    const cx = (minX + maxX) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    chunks.push({
      name: `streets-${key}`,
      cx, cz,
      radius: Math.sqrt((maxX - minX) * (maxX - minX) + (maxZ - minZ) * (maxZ - minZ)) * 0.5 + 4,
      castShadow: false,
      lodSwitch: [420, 1300],
      farMaterial: 'road',
      build: (b, detail) => {
        b.setUvOrigin(cx, 0, cz);
        let s = mySalt;
        for (const r of list) ribbon(b, r, detail, heightAt, s++);
      },
    });
  }
  return chunks;
}
